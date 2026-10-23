import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendRecord,
  makeRecord,
  pendingFor,
  resolveRecord,
  clearResolved,
  recentFirst,
  canSkip,
  skipsLeft,
  skipsToday,
  sameLocalDay,
  DAILY_SKIP_LIMIT,
  RECORD_LIMIT,
} from '../src/lib/history.js'
import { isFresh, allDimensionKeys, emptyCache, TTL_MS } from '../src/lib/cache.js'

function item(overrides = {}) {
  return {
    key: 'movie:1',
    subjectId: '1',
    category: 'movie',
    title: '暴裂无声',
    url: 'https://movie.douban.com/subject/1/',
    status: 'mark',
    ...overrides,
  }
}

test('记录同时保存决定状态与豆瓣标记状态', () => {
  const record = makeRecord(item())
  assert.equal(record.state, 'pending')
  assert.equal(record.markStatus, 'mark')
  assert.equal(record.key, 'movie:1')
  assert.equal(typeof record.drawnAt, 'number')
})

test('追加记录保持顺序，超限裁掉最旧的', () => {
  let records = []
  for (let i = 0; i < RECORD_LIMIT + 3; i += 1) {
    records = appendRecord(records, makeRecord(item({ key: `movie:${i}` })))
  }
  assert.equal(records.length, RECORD_LIMIT)
  assert.equal(records[0].key, 'movie:3')
})

test('每类只有一个待看', () => {
  const records = [
    makeRecord(item({ key: 'movie:1' })),
    makeRecord(item({ key: 'movie:2' })),
    makeRecord(item({ key: 'book:9', category: 'book' })),
  ]
  assert.equal(pendingFor(records, 'movie').key, 'movie:2', '应取最近的一条')
  assert.equal(pendingFor(records, 'book').key, 'book:9')
  assert.equal(pendingFor(records, 'tv'), null)
})

test('跳过后该类别不再有待看', () => {
  const records = [makeRecord(item({ key: 'movie:1' }))]
  const next = resolveRecord(records, 'movie:1', 'skipped')
  assert.equal(pendingFor(next, 'movie'), null)
  assert.equal(next[0].state, 'skipped')
  assert.ok(next[0].resolvedAt > 0, '应记录处理时间')
})

test('清空记录时保留待看，避免绕过「不能无限抽」', () => {
  const records = [
    makeRecord(item({ key: 'movie:1' })),
    { ...makeRecord(item({ key: 'movie:2' })), state: 'skipped' },
    makeRecord(item({ key: 'book:9', category: 'book' })),
  ]
  const kept = clearResolved(records)
  assert.deepEqual(
    kept.map((r) => r.key),
    ['movie:1', 'book:9'],
  )
})

test('recentFirst 由新到旧', () => {
  const list = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
  assert.deepEqual(
    recentFirst(list).map((x) => x.key),
    ['c', 'b', 'a'],
  )
})

test('每天每类只能跳过 1 次', () => {
  const now = new Date(2026, 9, 23, 15, 0, 0).getTime()
  const skippedToday = {
    ...makeRecord(item({ key: 'movie:1' })),
    state: 'skipped',
    resolvedAt: now - 60_000,
  }
  const records = [skippedToday]

  assert.equal(skipsToday(records, 'movie', now), 1)
  assert.equal(skipsLeft(records, 'movie', now), 0)
  assert.equal(canSkip(records, 'movie', now), false)

  // 别的类别不受影响
  assert.equal(canSkip(records, 'tv', now), true)

  // 昨天跳过的次数不算
  const yesterday = { ...skippedToday, resolvedAt: now - 24 * 60 * 60 * 1000 }
  assert.equal(canSkip([yesterday], 'movie', now), true)
})

test('同一天判定按本地时区', () => {
  const morning = new Date(2026, 9, 23, 0, 5, 0).getTime()
  const night = new Date(2026, 9, 23, 23, 55, 0).getTime()
  const nextDay = new Date(2026, 9, 24, 0, 5, 0).getTime()
  assert.equal(sameLocalDay(morning, night), true)
  assert.equal(sameLocalDay(night, nextDay), false)
})

test('默认上限为 1', () => {
  assert.equal(DAILY_SKIP_LIMIT, 1)
})

test('缓存新鲜度按 24h 判定', () => {
  const now = 1_000_000_000_000
  assert.equal(isFresh({ syncedAt: now - 1000 }, now), true)
  assert.equal(isFresh({ syncedAt: now - TTL_MS + 1 }, now), true)
  assert.equal(isFresh({ syncedAt: now - TTL_MS - 1 }, now), false)
  assert.equal(isFresh(undefined, now), false)
})

test('同步维度始终是两个', () => {
  assert.deepEqual(allDimensionKeys(), ['movie:mark', 'book:mark'])
  assert.deepEqual(Object.keys(emptyCache()).sort(), ['book:mark', 'movie:mark'])
})
