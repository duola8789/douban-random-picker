/**
 * 纯逻辑：候选池与随机抽取。
 *
 * 规则（见 specs/random-pick）：
 *   1. 类别开关定义候选池，空类别自动排除。
 *   2. 多类别时先等概率选类别，再在类别内均匀选条目。
 *   3. 每个类别独立计算去重窗口 Wc = min(N, floor(n_c * 0.8))，
 *      避免「电影只有 15 条、全局窗口 20 条」把整个类别排空。
 */

/** @typedef {'movie'|'tv'|'book'} Category */

import { CONFIG } from './config.js'

export const ALL_CATEGORIES = /** @type {Category[]} */ (['movie', 'tv', 'book'])

export const DEFAULT_WINDOW = CONFIG.dedupeWindow

export const PICK_ERROR = {
  NO_SCOPE: 'NO_SCOPE',
  NO_CANDIDATES: 'NO_CANDIDATES',
  POOL_EXHAUSTED: 'POOL_EXHAUSTED',
}

/**
 * 某个类别的去重窗口大小。
 * @param {number} itemCount
 * @param {number} windowSize
 */
export function windowSizeFor(itemCount, windowSize = DEFAULT_WINDOW) {
  if (!Number.isFinite(itemCount) || itemCount <= 0) return 0
  return Math.min(windowSize, Math.floor(itemCount * 0.8))
}

/**
 * 扣除去重窗口后，某个类别仍然可抽的条目。
 * @param {any[]} items           该类别的全部条目
 * @param {any[]} categoryHistory 该类别的历史记录（由旧到新）
 * @param {number} windowSize
 */
export function remainingFor(items, categoryHistory, windowSize = DEFAULT_WINDOW) {
  const w = windowSizeFor(items.length, windowSize)
  if (w <= 0) return items.slice()
  const recent = categoryHistory.slice(-w)
  const excluded = new Set(recent.map((h) => h.key))
  return items.filter((it) => !excluded.has(it.key))
}

/**
 * 抽取一条。
 *
 * 三层排除：
 *   1. 去重窗口（最近抽过）
 *   2. 本地已标记完成的条目（看过，不再抽）
 *   3. 本地屏蔽的条目（候选池页里剔除的）
 *
 * @param {object} params
 * @param {Record<Category, any[]>} params.pools        按类别分好的候选条目
 * @param {Category[]} params.enabled                   被勾选的类别
 * @param {object[]} params.history                     全部历史（由旧到新）
 * @param {Record<string, number>} [params.hidden]      屏蔽集合
 * @param {number} [params.windowSize]
 * @param {() => number} [params.random]                便于测试注入
 * @returns {{item: any} | {error: string}}
 */
export function pick({
  pools,
  enabled,
  history,
  hidden,
  windowSize = DEFAULT_WINDOW,
  random = Math.random,
}) {
  const scoped = enabled.filter((c) => (pools?.[c]?.length ?? 0) > 0)
  if (scoped.length === 0) {
    return { error: enabled.length === 0 ? PICK_ERROR.NO_SCOPE : PICK_ERROR.NO_CANDIDATES }
  }

  const historyByCategory = groupHistoryByCategory(history ?? [])
  // 本地标记完成的条目永久退出候选，不受去重窗口限制。
  // 删除对应记录即撤销排除——见 specs/draw-history 的「删除单条记录」。
  const doneKeys = new Set(
    (history ?? []).filter((h) => h.state === 'done').map((h) => h.key),
  )
  // 屏蔽只表达「不想抽」，与记录互不替代
  const hiddenKeys = new Set(Object.keys(hidden ?? {}))

  /** @type {Record<string, any[]>} */
  const eligible = {}
  for (const category of scoped) {
    const remaining = remainingFor(pools[category], historyByCategory[category] ?? [], windowSize).filter(
      (it) => !doneKeys.has(it.key) && !hiddenKeys.has(it.key),
    )
    if (remaining.length > 0) eligible[category] = remaining
  }

  const categories = Object.keys(eligible)
  // 全部条目要么在去重窗口里、要么已标记完成时，统一返回 POOL_EXHAUSTED。
  // 界面不需要区分这两种情况：处理方式都是清空记录。
  if (categories.length === 0) return { error: PICK_ERROR.POOL_EXHAUSTED }

  // 第一层：类别等权
  const category = categories[Math.floor(clamp(random()) * categories.length)]
  const items = eligible[category]
  // 第二层：类内均匀
  const item = items[Math.floor(clamp(random()) * items.length)]

  return { item }
}

/** 把 random() 的返回值夹到 [0,1)，避免注入的随机源越界 */
function clamp(r) {
  if (!Number.isFinite(r) || r < 0) return 0
  return r >= 1 ? 0.9999999999 : r
}

/** @param {object[]} history */
export function groupHistoryByCategory(history) {
  /** @type {Record<string, object[]>} */
  const map = {}
  for (const h of history) {
    if (!h?.category) continue
    ;(map[h.category] ??= []).push(h)
  }
  return map
}

/**
 * 把缓存条目按类别分桶，供 pick 使用。
 * @param {Record<string, {items: any[]}>} caches  形如 { "movie:mark": {...}, "book:mark": {...} }
 */
export function buildPools(caches) {
  /** @type {Record<Category, any[]>} */
  const pools = { movie: [], tv: [], book: [] }
  for (const entry of Object.values(caches ?? {})) {
    for (const item of entry?.items ?? []) {
      if (pools[item.category]) pools[item.category].push(item)
    }
  }
  return pools
}
