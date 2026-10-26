/**
 * 纯逻辑：缓存新鲜度与同步维度。
 */

import { CONFIG } from './config.js'

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

/** 全部维度的缓存键。三个类别始终都在，同步时全量拉取。 */
export function allDimensionKeys() {
  return DIMENSIONS.map((d) => d.key)
}

/**
 * @param {{syncedAt?: number}|undefined} entry
 */
export function isFresh(entry, now = Date.now(), ttl = TTL_MS) {
  if (!entry || typeof entry.syncedAt !== 'number') return false
  return now - entry.syncedAt < ttl
}

export function emptyCache() {
  /** @type {Record<string, any>} */
  const caches = {}
  for (const d of DIMENSIONS) {
    caches[d.key] = { items: [], total: 0, syncedAt: 0, partial: false }
  }
  return caches
}
