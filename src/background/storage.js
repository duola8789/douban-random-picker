/**
 * chrome.storage.local 的读写封装与默认值。
 *
 * 存储结构：
 *   settings { uid, category }        category = 上次停留的类别页签
 *   caches   { "movie:mark": { items, total, syncedAt, partial }, "movie:done": ... }
 *   records  [ { key, category, title, ..., status, drawnAt, resolvedAt? } ]  由旧到新
 *   hidden   { [key]: removedAt }      候选池页的「删除」= 本地屏蔽，不写豆瓣
 */

import { emptyCache } from '../lib/cache.js'

export const DEFAULT_SETTINGS = {
  uid: '',
  category: 'movie',
}

const KEYS = ['settings', 'caches', 'records', 'history', 'hidden']

/** @returns {Promise<{settings: any, caches: any, records: any[], hidden: Record<string, number>}>} */
export async function readAll() {
  const raw = await chrome.storage.local.get(KEYS)

  const settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
  delete settings.scopes // v0.2 之前的类别开关，已废弃
  const caches = { ...emptyCache(), ...(raw.caches ?? {}) }

  return {
    settings,
    caches,
    records: migrateRecords(raw),
    hidden: raw.hidden ?? {},
  }
}

/**
 * 旧版本把抽取历史存在 `history` 里，没有状态概念。
 * 迁移成记录，并统一标为 skipped——它们都已经不再是「待看」了。
 */
function migrateRecords(raw) {
  if (Array.isArray(raw.records)) return raw.records
  if (Array.isArray(raw.history)) {
    return raw.history.map((h) => ({
      key: h.key,
      subjectId: h.key?.split(':')[1],
      category: h.category,
      title: h.title,
      coverUrl: h.coverUrl,
      url: h.url,
      markStatus: 'mark',
      state: 'skipped',
      drawnAt: h.drawnAt,
      resolvedAt: h.drawnAt,
    }))
  }
  return []
}

export async function writeSettings(patch) {
  const { settings } = await readAll()
  const next = { ...settings, ...patch }
  await chrome.storage.local.set({ settings: next })
  return next
}

export async function writeCache(dimension, entry) {
  const raw = await chrome.storage.local.get('caches')
  const caches = raw.caches ?? {}
  caches[dimension] = entry
  await chrome.storage.local.set({ caches })
  return caches
}

export async function writeRecords(records) {
  await chrome.storage.local.set({ records })
  return records
}

export async function writeHidden(hidden) {
  await chrome.storage.local.set({ hidden })
  return hidden
}
