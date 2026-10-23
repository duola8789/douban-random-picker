/**
 * 同步编排。
 *
 * service worker 只负责协调，不跑分页循环：
 *   找/开豆瓣标签页 -> 下发 FETCH_ALL -> 等待 content script 回传 -> 写缓存 -> 关临时标签页
 */

import { CS, FROM_CS, SW_EVENT, ERROR } from '../lib/messages.js'
import { DIMENSIONS, dimensionsForScopes, isFresh } from '../lib/cache.js'
import { CONFIG } from '../lib/config.js'
import { cooldownRemaining } from '../lib/cooldown.js'
import { normalizeInterests } from '../lib/model.js'
import { readAll, writeCache } from './storage.js'

const READY_TIMEOUT_MS = 15000
const SYNC_TIMEOUT_MS = 180000

/** @type {Map<string, (v: any) => void>} 等待中的维度 */
const pending = new Map()

/** 进行中的同步，用于 in-flight 去重 */
let inFlight = null

export function isSyncing() {
  return inFlight !== null
}

function broadcast(message) {
  // 侧边栏可能未打开，忽略 "Receiving end does not exist"
  chrome.runtime.sendMessage(message).catch(() => {})
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 找一个能通信的豆瓣标签页；没有就临时开一个「我的豆瓣」 */
async function ensureDoubanTab() {
  const tabs = await chrome.tabs.query({ url: 'https://*.douban.com/*' })
  // 优先 www.douban.com：/mine/ 探测在同源下不会被 CORS 拦
  tabs.sort((a, b) => scoreTab(b.url) - scoreTab(a.url))

  for (const tab of tabs) {
    if (await pingTab(tab.id)) return { tabId: tab.id, temporary: false }
  }

  return createMineTab()
}

/** 开一个后台标签页停在「我的豆瓣」——登录探测最可靠的上下文 */
async function createMineTab() {
  const created = await chrome.tabs.create({
    url: 'https://www.douban.com/mine/',
    active: false,
  })
  const ready = await waitForReady(created.id)
  if (!ready) {
    chrome.tabs.remove(created.id).catch(() => {})
    throw Object.assign(new Error('content script not ready'), { code: ERROR.NO_DOUBAN_TAB })
  }
  return { tabId: created.id, temporary: true }
}

function scoreTab(url = '') {
  if (/^https:\/\/www\.douban\.com\/people\//.test(url)) return 3
  if (/^https:\/\/www\.douban\.com\/mine/.test(url)) return 2
  if (url.startsWith('https://www.douban.com/')) return 1
  return 0
}

async function pingTab(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: CS.PING })
    return pong?.ok === true
  } catch {
    return false
  }
}

async function waitForReady(tabId) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await pingTab(tabId)) return true
    await sleep(250)
  }
  return false
}

async function probeLogin(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: CS.PROBE_LOGIN })
  } catch {
    return { ok: false, reason: 'no-tab' }
  }
}

/**
 * 探测登录态。
 *
 * 复用已有标签页时，如果它不在个人主页或「我的豆瓣」上，
 * probeLogin 可能给不出确定答案（比如豆瓣不再重定向 /mine/）。
 * 这时换一个停在 /mine/ 的后台标签页再确认一次——这是本方法存在的理由。
 */
async function probeWithFallback() {
  const tab = await ensureDoubanTab()
  let login = await probeLogin(tab.tabId)

  if (login?.ok || tab.temporary) {
    return { login, tabId: tab.tabId, temporary: tab.temporary }
  }

  try {
    const mine = await createMineTab()
    const retry = await probeLogin(mine.tabId)
    if (retry?.ok) return { login: retry, tabId: mine.tabId, temporary: true }
    chrome.tabs.remove(mine.tabId).catch(() => {})
    return { login: retry ?? login, tabId: tab.tabId, temporary: false }
  } catch {
    return { login, tabId: tab.tabId, temporary: false }
  }
}

/** 下发一个维度的拉取任务，等待 content script 回传结果 */
function fetchDimension(tabId, { uid, type: mediaType, dimension }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(dimension)
      resolve({ items: [], total: 0, partial: true, error: { code: ERROR.NETWORK } })
    }, SYNC_TIMEOUT_MS)

    pending.set(dimension, (result) => {
      clearTimeout(timer)
      resolve(result)
    })

    chrome.tabs.sendMessage(
      tabId,
      {
        type: CS.FETCH_ALL,
        uid,
        // 注意别写成 type，会和消息类型同名互相覆盖
        mediaType,
        status: 'mark',
        dimension,
        // 请求参数由这里下发，content script 不自己维护一份
        config: {
          pageSize: CONFIG.pageSize,
          pageIntervalMs: CONFIG.pageIntervalMs,
          maxPages: CONFIG.maxPages,
        },
      },
      () => {
        if (chrome.runtime.lastError) {
          clearTimeout(timer)
          pending.delete(dimension)
          resolve({
            items: [],
            total: 0,
            partial: true,
            error: { code: ERROR.NO_DOUBAN_TAB },
          })
        }
      },
    )
  })
}

/** content script 回传结果：无论是否有等待者都写缓存 */
export async function handleSyncResult(message) {
  const { dimension, items, total, partial, error } = message
  const normalized = normalizeInterests(items)

  await writeCache(dimension, {
    items: normalized,
    total: typeof total === 'number' ? total : normalized.length,
    syncedAt: Date.now(),
    partial: Boolean(partial),
    error: error?.code,
  })

  const resolve = pending.get(dimension)
  if (resolve) {
    pending.delete(dimension)
    resolve({ items: normalized, total, partial, error })
  }

  broadcast({ type: SW_EVENT.SYNC_PROGRESS, dimension, fetched: normalized.length, total })
}

export function handleSyncProgress(message) {
  broadcast({ type: SW_EVENT.SYNC_PROGRESS, ...message })
}

/**
 * 执行一次同步。
 * @param {{force?: boolean, all?: boolean}} options
 */
export async function runSync(options = {}) {
  if (inFlight) return inFlight

  inFlight = doSync(options).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doSync({ force = false, all = false } = {}) {
  const { settings, caches } = await readAll()

  if (!settings.uid) return { ok: false, error: { code: ERROR.NO_UID } }

  const wanted = all ? DIMENSIONS.map((d) => d.key) : dimensionsForScopes(settings.scopes)
  const targets = force ? wanted : wanted.filter((key) => !isFresh(caches[key]))
  if (targets.length === 0) return { ok: true, skipped: true, dimensions: [] }

  // 最短更新频率：优先级高于手动同步。
  // 只统计「干净」的同步结果——上次失败或只是部分成功时允许重试。
  const wait = cooldownRemaining(caches, targets, Date.now(), CONFIG.minRefreshMs)
  if (wait > 0) {
    return { ok: false, error: { code: ERROR.TOO_SOON, retryAfterMs: wait } }
  }

  let tabId
  let temporary = false
  let login
  try {
    const probed = await probeWithFallback()
    tabId = probed.tabId
    temporary = probed.temporary
    login = probed.login
  } catch (err) {
    return { ok: false, error: { code: err.code ?? ERROR.NO_DOUBAN_TAB } }
  }

  try {
    if (!login?.ok) {
      return {
        ok: false,
        error: { code: ERROR.AUTH_REQUIRED, reason: login?.reason ?? 'unknown' },
      }
    }

    const results = []
    for (const key of targets) {
      const dimension = DIMENSIONS.find((d) => d.key === key)
      if (!dimension) continue
      broadcast({ type: SW_EVENT.SYNC_PROGRESS, dimension: key, fetched: 0, total: 0, started: true })

      const result = await fetchDimension(tabId, {
        uid: settings.uid,
        type: dimension.type,
        dimension: key,
      })
      results.push({ key, ...result })

      if (result.error?.code === ERROR.AUTH_REQUIRED) break
      if (result.error?.code === ERROR.RATE_LIMITED) break
    }

    const authFailed = results.some((r) => r.error?.code === ERROR.AUTH_REQUIRED)
    const rateLimited = results.some((r) => r.error?.code === ERROR.RATE_LIMITED)
    const partial = results.some((r) => r.partial)

    return {
      ok: !authFailed,
      partial,
      error: authFailed
        ? { code: ERROR.AUTH_REQUIRED }
        : rateLimited
          ? { code: ERROR.RATE_LIMITED }
          : undefined,
      dimensions: results.map((r) => r.key),
    }
  } finally {
    if (temporary && tabId != null) {
      chrome.tabs.remove(tabId).catch(() => {})
    }
    pending.clear()
  }
}

/** 供侧边栏检查登录状态时使用 */
export async function checkLogin() {
  let probed
  try {
    probed = await probeWithFallback()
  } catch (err) {
    return { ok: false, error: { code: err.code ?? ERROR.NO_DOUBAN_TAB } }
  }

  try {
    return { ok: true, login: probed.login }
  } finally {
    if (probed.temporary) chrome.tabs.remove(probed.tabId).catch(() => {})
  }
}
