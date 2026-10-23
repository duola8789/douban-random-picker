import test from 'node:test'
import assert from 'node:assert/strict'

import { appendHistory, makeRecord, recentFirst, HISTORY_LIMIT } from '../src/lib/history.js'
import { isFresh, dimensionsForScopes, emptyCache, TTL_MS } from '../src/lib/cache.js'

test('追加记录保持时间顺序', () => {
  let history = []
  history = appendHistory(history, { key: 'movie:1', drawnAt: 1 })
  history = appendHistory(history, { key: 'movie:2', drawnAt: 2 })
  assert.deepEqual(
    history.map((h) => h.key),
    ['movie:1', 'movie:2'],
  )
})

test('超过上限时裁掉最旧的', () => {
  let history = []
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    history = appendHistory(history, { key: `movie:${i}`, drawnAt: i })
  }
  assert.equal(history.length, HISTORY_LIMIT)
  assert.equal(history[0].key, 'movie:5')
  assert.equal(history[history.length - 1].key, `movie:${HISTORY_LIMIT + 4}`)
})

test('makeRecord 只存轻量快照', () => {
  const record = makeRecord({
    key: 'book:1',
    title: '人类简史',
    coverUrl: 'https://img/x.jpg',
    category: 'book',
    url: 'https://book.douban.com/subject/1/',
    myComment: '不该进历史',
  })
  assert.equal(record.key, 'book:1')
  assert.equal(record.myComment, undefined)
  assert.equal(typeof record.drawnAt, 'number')
})

test('recentFirst 返回由新到旧', () => {
  const history = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
  assert.deepEqual(
    recentFirst(history).map((h) => h.key),
    ['c', 'b', 'a'],
  )
})

test('缓存新鲜度按 24h 判定', () => {
  const now = 1_000_000_000_000
  assert.equal(isFresh({ syncedAt: now - 1000 }, now), true)
  assert.equal(isFresh({ syncedAt: now - TTL_MS + 1 }, now), true)
  assert.equal(isFresh({ syncedAt: now - TTL_MS - 1 }, now), false)
  assert.equal(isFresh(undefined, now), false)
  assert.equal(isFresh({ syncedAt: 0 }, now), false)
})

test('维度由类别开关推导', () => {
  assert.deepEqual(dimensionsForScopes({ movie: true, tv: true, book: true }), [
    'movie:mark',
    'book:mark',
  ])
  assert.deepEqual(dimensionsForScopes({ movie: false, tv: true, book: false }), ['movie:mark'])
  assert.deepEqual(dimensionsForScopes({ movie: false, tv: false, book: true }), ['book:mark'])
  assert.deepEqual(dimensionsForScopes({ movie: false, tv: false, book: false }), [])
})

test('空缓存结构包含两个维度', () => {
  const caches = emptyCache()
  assert.deepEqual(Object.keys(caches).sort(), ['book:mark', 'movie:mark'])
  assert.equal(caches['movie:mark'].items.length, 0)
})
