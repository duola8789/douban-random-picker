/**
 * 纯逻辑：缓存新鲜度与同步维度。
 */

import { CONFIG } from './config.js'

export const TTL_MS = CONFIG.cacheTtlMs

/**
 * 同步维度。豆瓣的 type=movie 同时覆盖电影与剧集，
 * 因此 movie / tv 两个类别共享一份 movie:mark 缓存。
 */
export const DIMENSIONS = [
  { key: 'movie:mark', type: 'movie', categories: ['movie', 'tv'] },
  { key: 'book:mark', type: 'book', categories: ['book'] },
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
