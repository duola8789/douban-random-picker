/**
 * 纯逻辑：抽取历史的追加与裁剪。
 */

import { CONFIG } from './config.js'

export const HISTORY_LIMIT = CONFIG.historyLimit

/**
 * 追加一条记录并裁剪超限的最旧记录。
 * @param {object[]} history 由旧到新
 * @param {object} record
 * @param {number} limit
 */
export function appendHistory(history, record, limit = HISTORY_LIMIT) {
  const next = [...(history ?? []), record]
  if (next.length <= limit) return next
  return next.slice(next.length - limit)
}

/**
 * @param {object} item    抽中的条目
 * @param {number} drawnAt
 */
export function makeRecord(item, drawnAt = Date.now()) {
  return {
    key: item.key,
    title: item.title,
    coverUrl: item.coverUrl,
    category: item.category,
    url: item.url,
    drawnAt,
  }
}

/** 界面用：由新到旧 */
export function recentFirst(history, max = 20) {
  return [...(history ?? [])].reverse().slice(0, max)
}
