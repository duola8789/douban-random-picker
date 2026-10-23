/**
 * chrome.storage.local 的读写封装与默认值。
 *
 * 存储结构：
 *   settings { uid, scopes, windowSize }
 *   caches   { "movie:mark": { items, total, syncedAt, partial }, "book:mark": ... }
 *   history  [ { key, title, coverUrl, category, url, drawnAt } ]  由旧到新
 */

import { emptyCache } from '../lib/cache.js'

export const DEFAULT_SETTINGS = {
  uid: '',
  scopes: { movie: true, tv: true, book: true },
  windowSize: 20,
}

const KEYS = ['settings', 'caches', 'history']

/** @returns {Promise<{settings: any, caches: any, history: any[]}>} */
export async function readAll() {
  const raw = await chrome.storage.local.get(KEYS)
  const settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
  settings.scopes = { ...DEFAULT_SETTINGS.scopes, ...(raw.settings?.scopes ?? {}) }
  const caches = { ...emptyCache(), ...(raw.caches ?? {}) }
  return { settings, caches, history: raw.history ?? [] }
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

export async function writeHistory(history) {
  await chrome.storage.local.set({ history })
}

export async function clearHistory() {
  await chrome.storage.local.set({ history: [] })
}
