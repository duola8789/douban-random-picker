import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendRecord,
  makeRecord,
  pendingFor,
  resolveRecord,
  clearResolved,
  recentFirst,
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
