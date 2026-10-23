/**
 * 纯逻辑：抽取记录。
 *
 * 一条记录同时承担四件事：
 *   1. 历史（抽过什么、什么时候）
 *   2. 决定状态（待看 / 跳过 / 看过）—— 字段 state
 *   3. 来源标记（想看 / 想读 / 看过…）—— 字段 markStatus，与 state 无关
 *   4. 去重窗口的数据源
 *
 * 「每类只能有一个待看」由 state === 'pending' 表达，
 * 同一类别最多存在一条 pending 记录。
 */

import { CONFIG } from './config.js'

export const RECORD_LIMIT = CONFIG.historyLimit

/**
 * 每个类别每天最多跳过几次。数值在 config.js 里调。
 *
 * 这是「不能无限抽」的最后一道闸：如果跳过可以随便点，
 * 它就会退化成新的「再抽一个」。
 */
export const DAILY_SKIP_LIMIT = CONFIG.dailySkipLimit

/** @typedef {'pending'|'skipped'|'done'} DecisionState */
/** @typedef {'mark'|'doing'|'done'} MarkStatus */

/**
 * 从抽中的条目生成一条记录。
 * 快照整条 item，这样侧边栏重新打开时不用回缓存里查。
 */
export function makeRecord(item, { state = 'pending', drawnAt = Date.now() } = {}) {
  return {
    key: item.key,
    subjectId: item.subjectId,
    category: item.category,
    title: item.title,
    coverUrl: item.coverUrl,
    url: item.url,
    year: item.year,
    subtitle: item.subtitle,
    doubanRating: item.doubanRating,
    directors: item.directors,
    actors: item.actors,
    genres: item.genres,
    pubdate: item.pubdate,
    markedOn: item.markedOn,
    myRating: item.myRating,
    myComment: item.myComment,
    // 这条在豆瓣里的标记状态：mark / doing / done
    markStatus: item.status ?? 'mark',
    // 这条在我们这边的决定状态
    state,
    drawnAt,
  }
}

/** 追加并按上限裁剪最旧的记录 */
export function appendRecord(records, record, limit = RECORD_LIMIT) {
  const next = [...(records ?? []), record]
  if (next.length <= limit) return next
  return next.slice(next.length - limit)
}

/** 某类别当前待看的记录；没有则 null */
export function pendingFor(records, category) {
  const list = records ?? []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const r = list[i]
    if (r.category === category && r.state === 'pending') return r
  }
  return null
}

/** 把一条 pending 记录改判为 skipped / done */
export function resolveRecord(records, key, state, now = Date.now()) {
  return (records ?? []).map((r) =>
    r.key === key && r.state === 'pending' ? { ...r, state, resolvedAt: now } : r,
  )
}

/** 同一天（本地时区） */
export function sameLocalDay(a, b) {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

/** 某类别今天已经跳过了几次 */
export function skipsToday(records, category, now = Date.now()) {
  return (records ?? []).filter(
    (r) => r.category === category && r.state === 'skipped' && sameLocalDay(r.resolvedAt ?? r.drawnAt, now),
  ).length
}

/** 今天还能不能跳过 */
export function canSkip(records, category, now = Date.now()) {
  return skipsToday(records, category, now) < DAILY_SKIP_LIMIT
}

/** 今天还剩几次跳过机会 */
export function skipsLeft(records, category, now = Date.now()) {
  return Math.max(0, DAILY_SKIP_LIMIT - skipsToday(records, category, now))
}

/**
 * 清空历史时保留仍在待看的记录。
 *
 * 否则「清空」就成了绕过「不能无限抽」的后门：
 * 点一下清空，待看消失，又能重新抽。
 */
export function clearResolved(records) {
  return (records ?? []).filter((r) => r.state === 'pending')
}

/** 界面用：由新到旧 */
export function recentFirst(items, max = 20) {
  return [...(items ?? [])].reverse().slice(0, max)
}
