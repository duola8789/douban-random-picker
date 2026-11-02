/**
 * 纯逻辑：缓存新鲜度与同步维度。
 */

import { CONFIG } from './config.js'
import { DEFAULT_SCOPE, SOURCES, normalizeScope } from './scope.js'

export const TTL_MS = CONFIG.cacheTtlMs

/**
 * 同步维度。豆瓣的 type=movie 同时覆盖电影与剧集，
 * 因此 movie / tv 两个类别共享一份 movie:mark 缓存。
 *
 * 状态分两档：mark（想看 / 想读）与 done（看过 / 读过）。
 * 两者是独立的接口维度，分别缓存、分别刷新。
 */
export const DIMENSIONS = [
  { key: 'movie:mark', type: 'movie', status: 'mark', categories: ['movie', 'tv'] },
  { key: 'book:mark', type: 'book', status: 'mark', categories: ['book'] },
  { key: 'movie:done', type: 'movie', status: 'done', categories: ['movie', 'tv'] },
  { key: 'book:done', type: 'book', status: 'done', categories: ['book'] },
]

/** 全部维度的缓存键。缓存结构始终是四个，范围只决定同步与抽取取哪几个。 */
export function allDimensionKeys() {
  return DIMENSIONS.map((d) => d.key)
}

/** 已经加载过（有同步记录）的来源。未加载的来源，数据根本不在本地。 */
export function loadedSources(caches) {
  return SOURCES.filter((source) =>
    DIMENSIONS.some((d) => d.status === source && (caches?.[d.key]?.syncedAt ?? 0) > 0),
  )
}

/** 已加载来源对应的维度键 */
export function loadedDimensionKeys(caches) {
  return dimensionKeysFor(loadedSources(caches))
}

/** 来源对应的维度键 */
export function dimensionKeysFor(scope = DEFAULT_SCOPE) {
  const sources = normalizeScope(scope)
  return DIMENSIONS.filter((d) => sources.includes(d.status)).map((d) => d.key)
}

/**
 * 缓存是否新鲜。
 *
 * 不完整或带错误的同步结果不算新鲜——否则一次分页中断会让这份数据
 * 在 24 小时内不再重试，界面上也看不出它是残缺的。
 *
 * @param {{syncedAt?: number, partial?: boolean, error?: string}|undefined} entry
 */
export function isFresh(entry, now = Date.now(), ttl = TTL_MS) {
  if (!entry || typeof entry.syncedAt !== 'number') return false
  if (entry.partial || entry.error) return false
  return now - entry.syncedAt < ttl
}

/**
 * 四个维度是否都在某个时间点之后完整同步过。
 *
 * 「条目已从豆瓣消失」这种判断只在这个前提下成立：范围不完整、或本次同步
 * 有维度失败时，没拉到的条目本来就不在结果里，不代表它消失了。
 */
export function allSyncedSince(caches, startedAt) {
  return DIMENSIONS.every((d) => {
    const entry = caches?.[d.key]
    return Boolean(entry) && !entry.partial && !entry.error && entry.syncedAt >= startedAt
  })
}

/** 指定的维度是否都在某个时间点之后完整同步过 */
export function allSyncedSinceFor(caches, keys, startedAt) {
  if (!Array.isArray(keys) || keys.length === 0) return false
  return keys.every((key) => {
    const entry = caches?.[key]
    return Boolean(entry) && !entry.partial && !entry.error && entry.syncedAt >= startedAt
  })
}

/**
 * 最近一次完整同步的时间。
 *
 * 只看干净结果：失败或只拉到一半的那次不算「同步过」，否则界面会
 * 拿一个没成功的尝试当成数据的年龄。
 */
export function latestSyncedAt(caches) {
  let latest = 0
  for (const entry of Object.values(caches ?? {})) {
    if (entry?.partial || entry?.error) continue
    const at = entry?.syncedAt ?? 0
    if (at > latest) latest = at
  }
  return latest
}

export function emptyCache() {
  /** @type {Record<string, any>} */
  const caches = {}
  for (const d of DIMENSIONS) {
    caches[d.key] = { items: [], total: 0, syncedAt: 0, partial: false }
  }
  return caches
}
