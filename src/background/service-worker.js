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
    records: enrichRecords(records, caches).slice(-RECENT_RECORDS),
    syncing: isSyncing(),
  }
}

/**
 * 用缓存里的完整条目补全记录。
 *
 * 早期版本的记录没有 directors / actors / genres / pubdate 等字段，
 * 直接渲染会只剩一行副标题。这里读的时候从缓存补，不用迁移存储。
 */
/** 只补空缺的静态字段：导演、主演等不会因为用户操作而变化 */
const FILL_FIELDS = [
  'directors',
  'actors',
  'genres',
  'pubdate',
  'subtitle',
  'markedOn',
  'author',
  'translator',
  'press',
  'bookPubdate',
  'pages',
]

/**
 * 用户可编辑的字段：以缓存为准，直接覆盖。
 *
 * 用户在豆瓣改评语、改评分之后，同步会更新缓存；如果这里只补空缺，
 * 记录里那份旧快照就会一直赢，界面看起来「改了没反应」。
 */
const REFRESH_FIELDS = ['myComment', 'myRating', 'markStatus', 'doubanRating']

function enrichRecords(records, caches) {
  const index = new Map()
  for (const entry of Object.values(caches ?? {})) {
    for (const item of entry?.items ?? []) index.set(item.key, item)
  }

  return records.map((record) => {
    const item = index.get(record.key)
    if (!item) return record

    const patch = {}
    for (const field of FILL_FIELDS) {
      if (record[field] == null && item[field] != null) patch[field] = item[field]
    }
    for (const field of REFRESH_FIELDS) {
      // 字段在条目里存在就采用，包括用户把它清空的情况
      if (field in item && item[field] !== record[field]) patch[field] = item[field]
    }

    return Object.keys(patch).length ? { ...record, ...patch } : record
  })
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

/** 把取到的详情（简介、出版信息）写回记录，避免重复请求 */
const DETAIL_FIELDS = ['intro', 'author', 'translator', 'press', 'bookPubdate', 'pages', 'detailAt']

async function handleSaveDetail(key, patch) {
  if (!key || !patch) return { ok: false }
  const clean = {}
  for (const field of DETAIL_FIELDS) {
    if (patch[field] != null && patch[field] !== '') clean[field] = patch[field]
  }
  if (!Object.keys(clean).length) return { ok: false }

  const { records } = await readAll()
  const next = records.map((r) => (r.key === key ? { ...r, ...clean } : r))
  await writeRecords(next)
  return { ok: true }
}

/**
 * 取封面的主色调，用来铺侧边栏两侧的背景。
 *
 * 扩展的 service worker 有 doubanio 的 host 权限，可以直接读跨域图片；
 * 用 OffscreenCanvas 缩到 24x24 再统计，避免把整张图解码进内存。
 */
const COLOR_CACHE_LIMIT = 300

async function coverColor(url) {
  if (!url) return null

  const { coverColors = {} } = await chrome.storage.local.get('coverColors')
  if (coverColors[url]) return coverColors[url]

  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const bitmap = await createImageBitmap(await res.blob())

    const size = 24
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0, size, size)
    const { data } = ctx.getImageData(0, 0, size, size)
    bitmap.close?.()

    // 按 4bit 量化分桶，取出现最多的那一桶的平均值
    const buckets = new Map()
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = data[i + 3]
      if (a < 200) continue
      if (r > 240 && g > 240 && b > 240) continue
      if (r < 20 && g < 20 && b < 20) continue
      const key = `${r >> 4},${g >> 4},${b >> 4}`
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
      bucket.n += 1
      bucket.r += r
      bucket.g += g
      bucket.b += b
      buckets.set(key, bucket)
    }
    if (!buckets.size) return null

    // 只按数量选，容易选中大片深灰；乘上饱和度，偏向真正有颜色的一块
    let best = null
    let bestScore = -1
    for (const bucket of buckets.values()) {
      const r = bucket.r / bucket.n
      const g = bucket.g / bucket.n
      const b = bucket.b / bucket.n
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const sat = max === 0 ? 0 : (max - min) / max
      const score = bucket.n * (0.25 + sat)
      if (score > bestScore) {
        bestScore = score
        best = bucket
      }
    }
    const hex = (v) => Math.round(v / best.n).toString(16).padStart(2, '0')
    const color = `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`

    const entries = Object.entries({ ...coverColors, [url]: color })
    const trimmed = entries.slice(-COLOR_CACHE_LIMIT)
    await chrome.storage.local.set({ coverColors: Object.fromEntries(trimmed) })
    return color
  } catch {
    return null
  }
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

    case UI.COVER_COLOR:
      coverColor(String(message.url ?? ''))
        .then((color) => sendResponse({ ok: Boolean(color), color }))
        .catch(() => sendResponse({ ok: false }))
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

    case UI.SAVE_DETAIL:
      handleSaveDetail(message.key, message.patch).then(sendResponse)
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
