/**
 * Service worker —— 只做编排与路由，不跑分页循环。
 */

import { UI, FROM_CS, SW_EVENT, ERROR } from '../lib/messages.js'
import { ALL_CATEGORIES, buildPools, pick } from '../lib/picker.js'
import { appendHistory, makeRecord } from '../lib/history.js'
import { readAll, writeSettings, writeHistory, clearHistory } from './storage.js'
import {
  runSync,
  handleSyncResult,
  handleSyncProgress,
  isSyncing,
  checkLogin,
} from './sync.js'

// 点击工具栏图标直接展开侧边栏，不注册 popup
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

/**
 * 组装给侧边栏的完整状态。
 */
async function getState() {
  const { settings, caches, history } = await readAll()
  return {
    ok: true,
    settings,
    caches: summarizeCaches(caches),
    history: history.slice(-30).reverse(),
    syncing: isSyncing(),
  }
}

function summarizeCaches(caches) {
  const out = {}
  for (const [key, entry] of Object.entries(caches ?? {})) {
    const items = entry?.items ?? []
    const byCategory = { movie: 0, tv: 0, book: 0 }
    for (const item of items) {
      if (byCategory[item.category] != null) byCategory[item.category] += 1
    }
    out[key] = {
      count: items.length,
      byCategory,
      total: entry?.total ?? 0,
      syncedAt: entry?.syncedAt ?? 0,
      partial: Boolean(entry?.partial),
      error: entry?.error,
    }
  }
  return out
}

/** 跑一次同步并广播结束事件，UI 靠它刷新 */
async function startSync({ force = false, all = false } = {}) {
  const result = await runSync({ force, all })
  chrome.runtime.sendMessage({ type: SW_EVENT.SYNC_FINISHED, result }).catch(() => {})
  return result
}

async function handlePick() {
  const { settings, caches, history } = await readAll()
  const pools = buildPools(caches)
  const enabled = ALL_CATEGORIES.filter((c) => settings.scopes?.[c])

  const result = pick({ pools, enabled, history, windowSize: settings.windowSize })
  if (result.error) return { ok: false, error: { code: result.error } }

  const record = makeRecord(result.item)
  await writeHistory(appendHistory(history, record))

  return { ok: true, item: result.item, drawnAt: record.drawnAt, history: [record, ...summarizeHistory(history)] }
}

function summarizeHistory(history) {
  return history.slice(-29).reverse()
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return

  // ---- 来自 content script ----
  if (message.type === FROM_CS.SYNC_RESULT) {
    handleSyncResult(message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }))
    return true
  }
  if (message.type === FROM_CS.SYNC_PROGRESS) {
    handleSyncProgress(message)
    return
  }

  // ---- 来自侧边栏 ----
  switch (message.type) {
    case UI.GET_STATE:
      getState().then(sendResponse)
      return true

    case UI.PICK:
      handlePick().then(sendResponse)
      return true

    case UI.SYNC:
      startSync({ force: Boolean(message.force), all: Boolean(message.all) })
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: { code: ERROR.NETWORK, message: String(err) } }))
      return true

    case UI.SET_SCOPES:
      writeSettings({ scopes: message.scopes }).then((settings) => {
        // 立即回包，同步在后台跑，进度通过广播通知界面
        startSync({}).catch(() => {})
        sendResponse({ ok: true, settings })
      })
      return true

    case UI.SET_UID:
      writeSettings({ uid: String(message.uid ?? '').trim() }).then((settings) =>
        sendResponse({ ok: true, settings }),
      )
      return true

    case UI.CLEAR_HISTORY:
      clearHistory().then(() => sendResponse({ ok: true }))
      return true

    case UI.PROBE_LOGIN:
      checkLogin().then(sendResponse)
      return true

    default:
      return
  }
})
