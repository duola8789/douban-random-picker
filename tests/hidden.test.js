import test from 'node:test'
import assert from 'node:assert/strict'

import { pruneHidden, isHidden, HIDDEN_TTL_MS } from '../src/lib/hidden.js'

const DAY = 24 * 60 * 60 * 1000

test('隐藏超过 90 天且条目已消失时清理', () => {
  const now = Date.now()
  const hidden = { 'movie:1': now - 91 * DAY, 'movie:2': now - 10 * DAY }
  const { next, removed } = pruneHidden(hidden, ['movie:2'], now)
  assert.deepEqual(removed, ['movie:1'])
  assert.deepEqual(Object.keys(next), ['movie:2'])
})

test('仍在同步结果中的隐藏记录不清理', () => {
  const now = Date.now()
  const hidden = { 'movie:1': now - 200 * DAY }
  const { next, removed } = pruneHidden(hidden, ['movie:1'], now)
  assert.deepEqual(removed, [])
  assert.equal(next['movie:1'], hidden['movie:1'])
})

test('未到期的隐藏记录不清理', () => {
  const now = Date.now()
  const hidden = { 'movie:1': now - 30 * DAY }
  const { removed } = pruneHidden(hidden, [], now)
  assert.deepEqual(removed, [])
})

test('TTL 默认为 90 天', () => {
  assert.equal(HIDDEN_TTL_MS, 90 * DAY)
})

test('isHidden 只认自有键', () => {
  const hidden = { 'movie:1': 1 }
  assert.equal(isHidden(hidden, 'movie:1'), true)
  assert.equal(isHidden(hidden, 'movie:2'), false)
  assert.equal(isHidden(hidden, 'toString'), false)
})
