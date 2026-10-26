/**
 * 纯逻辑：本地屏蔽集合。
 *
 * 「屏蔽」表达的是「不想抽它」，和抽取记录（「抽过什么」）是两套数据。
 * 扩展不写豆瓣，所以名单页的「删除」只是记在这里，同步之后照样过滤。
 */

/** 屏蔽记录的保留期：超过这个时长且条目已从豆瓣消失，就可以清掉 */
export const HIDDEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** @param {Record<string, number>} hidden @param {string} key */
export function isHidden(hidden, key) {
  return Object.prototype.hasOwnProperty.call(hidden ?? {}, key)
}

/**
 * 清理失效的屏蔽记录：屏蔽超过 TTL，且条目已经不在当前同步结果里。
 *
 * 只做「已消失」的一半——条目还在豆瓣收藏里，屏蔽就该一直有效，
 * 哪怕已经过去很久，用户随时可能想恢复。
 *
 * @param {Record<string, number>} hidden
 * @param {Iterable<string>} existingKeys 当前同步结果中的全部 key
 * @returns {{ next: Record<string, number>, removed: string[] }}
 */
export function pruneHidden(hidden, existingKeys, now = Date.now(), ttl = HIDDEN_TTL_MS) {
  const exists = existingKeys instanceof Set ? existingKeys : new Set(existingKeys ?? [])
  const next = {}
  const removed = []

  for (const [key, at] of Object.entries(hidden ?? {})) {
    const expired = typeof at === 'number' && now - at > ttl
    if (expired && !exists.has(key)) {
      removed.push(key)
      continue
    }
    next[key] = at
  }

  return { next, removed }
}
