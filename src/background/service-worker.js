/**
 * Service worker —— 只做编排与路由，不跑分页循环。
 */

import { UI, FROM_CS, SW_EVENT, ERROR } from '../lib/messages.js'
import { CONFIG } from '../lib/config.js'
import { ALL_CATEGORIES, buildPools, pick } from '../lib/picker.js'
import {
  allSyncedSinceFor,
  dimensionKeysFor,
  isFresh,
  loadedDimensionKeys,
  loadedSources,
} from '../lib/cache.js'
import { SOURCES } from '../lib/scope.js'
import {
  appendRecord,
  makeRecord,
  pendingFor,
  resolveRecord,
  deleteRecord,
  clearResolved,
  canSkip,
} from '../lib/history.js'
import { pruneHidden } from '../lib/hidden.js'
import { readAll, writeSettings, writeRecords, writeHidden } from './storage.js'
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
  const { settings, caches, records, hidden } = await readAll()
  return {
    ok: true,
    settings,
    caches: summarizeCaches(caches),
    counts: countEligible(caches, records, hidden),
    records: enrichRecords(records, caches).slice(-RECENT_RECORDS),
    syncing: isSyncing(),
  }
}

/**
 * 各类别还能抽多少条。
 *
 * 和页签上「这一类的条目数」不是一回事：已移出和本地标记完成的条目
 * 不会再被抽到，计数要把它们减掉，否则空态文案会和实际对不上。
 */
function countEligible(caches, records, hidden) {
  const pools = buildPools(caches)
  const doneKeys = new Set(
    (records ?? []).filter((r) => r.state === 'done').map((r) => r.key),
  )
  const counts = { movie: 0, tv: 0, book: 0 }
  for (const [category, items] of Object.entries(pools)) {
    counts[category] = items.filter(
      (item) => !doneKeys.has(item.key) && !(item.key in (hidden ?? {})),
    ).length
  }
  return counts
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
async function startSync({ force = false, sources } = {}) {
  const startedAt = Date.now()
  const result = await runSync({ force, sources })
  if (result?.ok && !result.partial) {
    await cleanHiddenIfComplete(result.dimensions, startedAt).catch(() => {})
  }
  chrome.runtime.sendMessage({ type: SW_EVENT.SYNC_FINISHED, result }).catch(() => {})
  return result
}

/**
 * 只在本次同步覆盖到的维度全部完整成功时清理。
 *
 * 否则会把这次没拉到的条目误判成「已从豆瓣消失」，进而删掉本来还有效的
 * 移出记录。未加载的来源本来就没有本地记录，不参与判断。
 */
async function cleanHiddenIfComplete(dimensions, startedAt) {
  const { caches } = await readAll()
  if (!allSyncedSinceFor(caches, dimensions, startedAt)) return []
  return cleanHidden()
}

/** 清理失效的屏蔽记录：屏蔽超过 90 天，且条目已不在同步结果里 */
async function cleanHidden() {
  const { caches, hidden } = await readAll()

  const existing = new Set()
  for (const entry of Object.values(caches ?? {})) {
    for (const item of entry?.items ?? []) existing.add(item.key)
  }

  const { next, removed } = pruneHidden(hidden, existing)
  if (removed.length) await writeHidden(next)
  return removed
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

  const { caches, records, hidden } = await readAll()

  const pending = pendingFor(records, category)
  if (pending) {
    return { ok: false, error: { code: ERROR.PENDING_EXISTS, key: pending.key } }
  }

  const pools = buildPools(caches)
  const result = pick({
    pools,
    enabled: [category],
    history: records,
    hidden,
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

/**
 * 标记完成：把待看改判为「看过」。
 *
 * 不检查跳过额度——看完一部片子是正常流程，不该为「想抽下一部」付费。
 * 也不自动续抽：跳过是「现在就要换」，看完了是「这段时间结束了」。
 */
async function handleMarkDone(key) {
  const { records } = await readAll()

  const target = records.find((r) => r.key === key && r.state === 'pending')
  if (!target) return { ok: false, error: { code: ERROR.PENDING_EXISTS } }

  const next = resolveRecord(records, key, 'done')
  await writeRecords(next)
  return { ok: true, records: next.slice(-RECENT_RECORDS) }
}

/** 删除单条记录。待看不可删，否则删除就成了重新抽取的后门。 */
async function handleDeleteRecord(key) {
  const { records } = await readAll()

  const target = records.find((r) => r.key === key)
  if (!target) return { ok: false, error: { code: ERROR.NOT_FOUND } }
  if (target.state === 'pending') {
    return { ok: false, error: { code: ERROR.PENDING_CANNOT_DELETE } }
  }

  const next = deleteRecord(records, key)
  await writeRecords(next)
  return { ok: true, records: next }
}

/**
 * 候选池页的数据。
 *
 * 和 GET_STATE 分开：这个要一次传几百条完整条目，而 GET_STATE 每次打开
 * 侧边栏都会调，不该背这个量。
 */
async function handleGetCandidates() {
  const { caches, hidden, records } = await readAll()

  // 同一条目可能暂时同时留在旧的 mark 与新的 done 缓存里，按 done 优先合并。
  // 返回全部条目：列表由界面按来源、时间、状态筛选；池外记录里
  // 可能包含已经不在缓存中的条目，界面需要靠 hidden 自己补出来。
  const byKey = new Map()
  for (const entry of Object.values(caches ?? {})) {
    for (const item of entry?.items ?? []) {
      const prev = byKey.get(item.key)
      if (!prev || (prev.status !== 'done' && item.status === 'done')) byKey.set(item.key, item)
    }
  }

  const items = { movie: [], tv: [], book: [] }
  for (const item of byKey.values()) {
    if (items[item.category]) items[item.category].push(item)
  }

  const pendingKeys = records.filter((r) => r.state === 'pending').map((r) => r.key)

  // 已加载的来源都有新鲜、完整的结果时，才敢判断某条已经不在豆瓣收藏里。
  const loaded = loadedSources(caches)
  const loadedDims = dimensionKeysFor(loaded)
  const complete = loadedDims.length > 0 && loadedDims.every((key) => isFresh(caches[key]))

  return {
    ok: true,
    items,
    hidden,
    pendingKeys,
    loaded,
    complete,
  }
}

/**
 * 批量屏蔽。
 *
 * 待看的那条不能屏蔽——否则它就成了重新抽取的后门。
 * 这条裁决放在写存储这一侧，界面禁用只是第二道。
 */
async function handleHideCandidates(keys) {
  const { records, hidden } = await readAll()

  const pending = new Set(records.filter((r) => r.state === 'pending').map((r) => r.key))
  const now = Date.now()
  const next = { ...hidden }
  const applied = []
  const skipped = []

  for (const key of Array.isArray(keys) ? keys : []) {
    if (typeof key !== 'string' || !key) continue
    if (pending.has(key)) {
      skipped.push(key)
      continue
    }
    if (!(key in next)) next[key] = now
    applied.push(key)
  }

  if (applied.length) {
    await writeHidden(next)
    // 屏蔽会改变侧边栏的可抽数量
    chrome.runtime.sendMessage({ type: SW_EVENT.STATE_CHANGED }).catch(() => {})
  }
  return { ok: true, hidden: next, applied, skipped }
}

/**
 * 保存候选集的勾选改动。
 *
 * hide = 这次被取消勾选的条目，unhide = 重新勾上的条目。
 * 待看的条目不能移出——这条裁决放在写存储这一侧，界面禁用只是第二道。
 */
async function handleSavePool({ hide = [], unhide = [] } = {}) {
  // 同步期间不接受候选集改动：列表马上会被刷新，写 hidden 也可能和清理重叠
  if (isSyncing()) return { ok: false, error: { code: ERROR.SYNCING } }

  const { records, hidden } = await readAll()
  const pending = new Set(records.filter((r) => r.state === 'pending').map((r) => r.key))
  const next = { ...hidden }
  const now = Date.now()
  const appliedHide = []
  const appliedUnhide = []
  const skipped = []

  for (const key of Array.isArray(unhide) ? unhide : []) {
    if (typeof key === 'string' && key in next) {
      delete next[key]
      appliedUnhide.push(key)
    }
  }

  for (const key of Array.isArray(hide) ? hide : []) {
    if (typeof key !== 'string' || !key) continue
    if (pending.has(key)) {
      skipped.push(key)
      continue
    }
    if (!(key in next)) next[key] = now
    appliedHide.push(key)
  }

  if (appliedHide.length || appliedUnhide.length) {
    await writeHidden(next)
    chrome.runtime.sendMessage({ type: SW_EVENT.STATE_CHANGED }).catch(() => {})
  }

  return { ok: true, hidden: next, appliedHide, appliedUnhide, skipped }
}

async function handleUnhideCandidates(keys) {
  const { hidden } = await readAll()
  const next = { ...hidden }
  const applied = []

  for (const key of Array.isArray(keys) ? keys : []) {
    if (typeof key === 'string' && key in next) {
      delete next[key]
      applied.push(key)
    }
  }

  if (applied.length) {
    await writeHidden(next)
    chrome.runtime.sendMessage({ type: SW_EVENT.STATE_CHANGED }).catch(() => {})
  }
  return { ok: true, hidden: next, applied }
}

/**
 * 加载来源。
 *
 * 只拉指定的那一半；加载回来的条目默认就在候选池里（没有被 hidden 记录）。
 * 同步失败时数据没到，界面要还原来源勾选并提示重试。
 */
async function handleLoadSources(raw) {
  const requested = Array.isArray(raw) ? raw : []
  const sources = SOURCES.filter((source) => requested.includes(source))
  if (sources.length === 0) {
    return { ok: false, error: { code: ERROR.SCOPE_EMPTY } }
  }

  const result = await startSync({ force: false, sources })
  const { caches } = await readAll()
  return { ok: true, sources, loaded: loadedSources(caches), sync: result, error: result?.error }
}

/**
 * 更换账号。
 *
 * 扩展不处理登录：用户必须先在豆瓣网页里切换账号。这里只清掉旧账号
 * 留在本机的缓存、移出记录与抽取历史，再清 uid，让界面重新探测。
 * 同步进行中不允许执行，避免和缓存写入打架。
 */
async function handleResetAccount() {
  if (isSyncing()) return { ok: false, error: { code: ERROR.SYNCING } }

  await chrome.storage.local.set({ caches: {}, records: [], hidden: {} })
  const settings = await writeSettings({ uid: '' })
  chrome.runtime.sendMessage({ type: SW_EVENT.ACCOUNT_RESET }).catch(() => {})
  return { ok: true, settings }
}

/** 清空历史，但保留仍在待看的记录——否则清空就成了重新抽的后门 */async function handleClearHistory() {
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

    case UI.MARK_DONE:
      handleMarkDone(message.key).then(sendResponse)
      return true

    case UI.DELETE_RECORD:
      handleDeleteRecord(message.key).then(sendResponse)
      return true

    case UI.GET_CANDIDATES:
      handleGetCandidates().then(sendResponse)
      return true

    case UI.HIDE_CANDIDATES:
      handleHideCandidates(message.keys).then(sendResponse)
      return true

    case UI.SAVE_POOL:
      handleSavePool(message).then(sendResponse)
      return true

    case UI.UNHIDE_CANDIDATES:
      handleUnhideCandidates(message.keys).then(sendResponse)
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

    case UI.RESET_ACCOUNT:
      handleResetAccount().then(sendResponse)
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

    case UI.LOAD_SOURCES:
      handleLoadSources(message.sources).then(sendResponse)
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
