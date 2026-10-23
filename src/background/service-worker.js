/**
 * Service worker —— 只做编排与路由，不跑分页循环。
 */

import { UI, FROM_CS, SW_EVENT, ERROR } from '../lib/messages.js'
import { CONFIG } from '../lib/config.js'
import { ALL_CATEGORIES, buildPools, pick } from '../lib/picker.js'
import {
  appendRecord,
  makeRecord,
  pendingFor,
  resolveRecord,
  clearResolved,
  canSkip,
} from '../lib/history.js'
import { readAll, writeSettings, writeRecords } from './storage.js'
import {
  runSync,
  handleSyncResult,
  handleSyncProgress,
  isSyncing,
  checkLogin,
  fetchDetail,
} from './sync.js'

// 点击工具栏图标直接展开侧边栏，不注册 popup
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

/** 返回给侧边栏的记录条数上限——足以渲染历史，又不至于传太多 */
const RECENT_RECORDS = 200

async function getState() {
  const { settings, caches, records } = await readAll()
  return {
    ok: true,
    settings,
    caches: summarizeCaches(caches),
    records: records.slice(-RECENT_RECORDS),
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
async function startSync({ force = false } = {}) {
  const result = await runSync({ force })
  chrome.runtime.sendMessage({ type: SW_EVENT.SYNC_FINISHED, result }).catch(() => {})
  return result
}

/**
 * 抽一个。
 *
 * 关键规则：某个类别已有待看条目时不再抽——
 * 否则「再抽一个」就等于没做决定。
 */
async function handlePick(category) {
  if (!ALL_CATEGORIES.includes(category)) {
    return { ok: false, error: { code: ERROR.NO_SCOPE } }
  }

  const { caches, records } = await readAll()

  const pending = pendingFor(records, category)
  if (pending) {
    return { ok: false, error: { code: ERROR.PENDING_EXISTS, key: pending.key } }
  }

  const pools = buildPools(caches)
  const result = pick({
    pools,
    enabled: [category],
    history: records,
    windowSize: CONFIG.dedupeWindow,
  })
  if (result.error) return { ok: false, error: { code: result.error } }

  const record = makeRecord(result.item)
  const next = appendRecord(records, record)
  await writeRecords(next)

  return { ok: true, item: result.item, record, records: next.slice(-RECENT_RECORDS) }
}

/** 跳过当前待看：记录保留，只是改判状态。每天每类有次数上限。 */
async function handleSkip(key) {
  const { records } = await readAll()

  const target = records.find((r) => r.key === key && r.state === 'pending')
  if (!target) return { ok: false, error: { code: ERROR.PENDING_EXISTS } }

  if (!canSkip(records, target.category)) {
    return { ok: false, error: { code: ERROR.SKIP_LIMIT } }
  }

  const next = resolveRecord(records, key, 'skipped')
  await writeRecords(next)
  return { ok: true, records: next.slice(-RECENT_RECORDS) }
}

/** 清空历史，但保留仍在待看的记录——否则清空就成了重新抽的后门 */
async function handleClearHistory() {
  const { records } = await readAll()
  const next = clearResolved(records)
  await writeRecords(next)
  return { ok: true, records: next }
}

/** 把取到的简介写回记录，避免下次打开或切换页签时重复请求 */
async function handleSaveIntro(key, intro) {
  if (!key || !intro) return { ok: false }
  const { records } = await readAll()
  const next = records.map((r) => (r.key === key ? { ...r, intro } : r))
  await writeRecords(next)
  return { ok: true }
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
      handlePick(message.category).then(sendResponse)
      return true

    case UI.SKIP:
      handleSkip(message.key).then(sendResponse)
      return true

    case UI.SYNC:
      startSync({ force: Boolean(message.force) })
        .then(sendResponse)
        .catch((err) =>
          sendResponse({ ok: false, error: { code: ERROR.NETWORK, message: String(err) } }),
        )
      return true

    case UI.DETAIL:
      fetchDetail({ subjectId: message.subjectId, category: message.category })
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: { code: ERROR.NETWORK } }))
      return true

    case UI.SET_UID:
      writeSettings({ uid: String(message.uid ?? '').trim() }).then((settings) =>
        sendResponse({ ok: true, settings }),
      )
      return true

    case UI.SET_CATEGORY:
      writeSettings({ category: message.category }).then((settings) =>
        sendResponse({ ok: true, settings }),
      )
      return true

    case UI.SAVE_INTRO:
      handleSaveIntro(message.key, message.intro).then(sendResponse)
      return true

    case UI.CLEAR_HISTORY:
      handleClearHistory().then(sendResponse)
      return true

    case UI.PROBE_LOGIN:
      checkLogin().then(sendResponse)
      return true

    default:
      return
  }
})
