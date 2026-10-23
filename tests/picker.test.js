import test from 'node:test'
import assert from 'node:assert/strict'

import {
  pick,
  remainingFor,
  windowSizeFor,
  buildPools,
  PICK_ERROR,
} from '../src/lib/picker.js'

function makeItems(category, n) {
  return Array.from({ length: n }, (_, i) => ({
    key: `${category}:${i}`,
    category,
    title: `${category}-${i}`,
  }))
}

function lcg(seed = 1) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

test('去重窗口取 min(N, floor(n*0.8))', () => {
  assert.equal(windowSizeFor(100, 20), 20)
  assert.equal(windowSizeFor(15, 20), 12)
  assert.equal(windowSizeFor(2, 20), 1)
  assert.equal(windowSizeFor(1, 20), 0)
  assert.equal(windowSizeFor(0, 20), 0)
})

test('小类别不会被窗口排空', () => {
  const items = makeItems('movie', 15)
  const history = items.map((it, i) => ({ key: it.key, category: 'movie', drawnAt: i }))
  const remaining = remainingFor(items, history, 20)
  assert.equal(remaining.length, 3, '15 条时窗口为 12，应剩 3 条')
})

test('最近 N 条被排除，更早的重新可用', () => {
  const items = makeItems('movie', 100)
  const history = items.slice(0, 25).map((it, i) => ({ key: it.key, category: 'movie', drawnAt: i }))
  const remaining = remainingFor(items, history, 20)
  // 25 条历史里只排除最近 20 条（即第 5..24 条）
  assert.equal(remaining.length, 80)
  assert.ok(remaining.some((it) => it.key === 'movie:0'), '最早那批应回到候选池')
  assert.ok(!remaining.some((it) => it.key === 'movie:24'))
})

test('多类别时类别等权，与条目数量无关', () => {
  const pools = {
    movie: makeItems('movie', 100),
    tv: makeItems('tv', 10),
    book: makeItems('book', 500),
  }
  const random = lcg(42)
  const counts = { movie: 0, tv: 0, book: 0 }
  const rounds = 30000

  for (let i = 0; i < rounds; i += 1) {
    const { item } = pick({ pools, enabled: ['movie', 'tv', 'book'], history: [], random })
    counts[item.category] += 1
  }

  for (const [category, n] of Object.entries(counts)) {
    const share = n / rounds
    assert.ok(
      Math.abs(share - 1 / 3) < 0.02,
      `${category} 占比 ${share.toFixed(3)}，应接近 1/3`,
    )
  }
})

test('只勾选一类时只从该类抽取', () => {
  const pools = { movie: makeItems('movie', 10), tv: makeItems('tv', 10), book: makeItems('book', 10) }
  const random = lcg(7)
  for (let i = 0; i < 200; i += 1) {
    const { item } = pick({ pools, enabled: ['book'], history: [], random })
    assert.equal(item.category, 'book')
  }
})

test('空类别被排除，不参与等权', () => {
  const pools = { movie: makeItems('movie', 10), tv: [], book: [] }
  const random = lcg(3)
  const { item } = pick({ pools, enabled: ['movie', 'tv', 'book'], history: [], random })
  assert.equal(item.category, 'movie')
})

test('全部类别都空时返回 NO_CANDIDATES', () => {
  const result = pick({ pools: { movie: [], tv: [], book: [] }, enabled: ['movie'], history: [] })
  assert.equal(result.error, PICK_ERROR.NO_CANDIDATES)
})

test('一个类别都没勾时返回 NO_SCOPE', () => {
  const result = pick({ pools: { movie: makeItems('movie', 10) }, enabled: [], history: [] })
  assert.equal(result.error, PICK_ERROR.NO_SCOPE)
})

test('连续抽取在窗口内不重复', () => {
  const pools = { movie: makeItems('movie', 30), tv: [], book: [] }
  const history = []
  const random = lcg(99)
  const seen = []

  for (let i = 0; i < 20; i += 1) {
    const { item } = pick({ pools, enabled: ['movie'], history, windowSize: 20, random })
    seen.push(item.key)
    history.push({ key: item.key, category: item.category, drawnAt: Date.now() })
  }

  const window = 20
  const recent = seen.slice(-window)
  assert.equal(new Set(recent).size, recent.length, '最近 20 条不应重复')
})

test('buildPools 按类别分桶', () => {
  const pools = buildPools({
    'movie:mark': { items: [...makeItems('movie', 2), ...makeItems('tv', 3)] },
    'book:mark': { items: makeItems('book', 4) },
  })
  assert.equal(pools.movie.length, 2)
  assert.equal(pools.tv.length, 3)
  assert.equal(pools.book.length, 4)
})
