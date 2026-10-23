/**
 * 纯逻辑：最短更新频率（冷却期）判定。
 *
 * 规则见 design.md 决策 13：
 *   - 只统计「干净」的同步结果（非 partial、无 error）；
 *   - 冷却期内不发起任何请求，即使调用方要求强制同步；
 *   - 上次失败时允许立即重试。
 */

/**
 * @param {Record<string, any>} caches       { "movie:mark": { syncedAt, partial, error } }
 * @param {string[]} dimensions             本次准备同步的维度
 * @param {number} now
 * @param {number} minRefreshMs
 * @returns {number} 还需等待的毫秒数，0 表示可以同步
 */
export function cooldownRemaining(caches, dimensions, now, minRefreshMs) {
  const lastCleanAt = dimensions.reduce((max, key) => {
    const entry = caches?.[key]
    if (!entry || entry.partial || entry.error) return max
    const syncedAt = entry.syncedAt ?? 0
    return syncedAt > max ? syncedAt : max
  }, 0)

  if (lastCleanAt <= 0) return 0

  const elapsed = now - lastCleanAt
  if (elapsed < 0) return minRefreshMs
  return Math.max(0, minRefreshMs - elapsed)
}
