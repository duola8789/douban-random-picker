import test from 'node:test'
import assert from 'node:assert/strict'

import { cooldownRemaining } from '../src/lib/cooldown.js'

const MIN = 10 * 60 * 1000
const NOW = 1_700_000_000_000

test('从没同步过时不冷却', () => {
  assert.equal(cooldownRemaining({}, ['movie:mark'], NOW, MIN), 0)
  assert.equal(cooldownRemaining({ 'movie:mark': { syncedAt: 0 } }, ['movie:mark'], NOW, MIN), 0)
})

test('刚同步完要等满整个间隔', () => {
  const caches = { 'movie:mark': { syncedAt: NOW - 60_000, partial: false } }
  assert.equal(cooldownRemaining(caches, ['movie:mark'], NOW, MIN), MIN - 60_000)
})

test('超过间隔后不再冷却', () => {
  const caches = { 'movie:mark': { syncedAt: NOW - MIN - 1, partial: false } }
  assert.equal(cooldownRemaining(caches, ['movie:mark'], NOW, MIN), 0)
})

test('多个维度取最近的一次成功同步', () => {
  const caches = {
    'movie:mark': { syncedAt: NOW - MIN - 1000, partial: false },
    'book:mark': { syncedAt: NOW - 1000, partial: false },
  }
  assert.equal(cooldownRemaining(caches, ['movie:mark', 'book:mark'], NOW, MIN), MIN - 1000)
})

test('上次部分成功不触发冷却，允许重试', () => {
  const caches = { 'movie:mark': { syncedAt: NOW - 1000, partial: true } }
  assert.equal(cooldownRemaining(caches, ['movie:mark'], NOW, MIN), 0)
})

test('上次报错不触发冷却，允许重试', () => {
  const caches = { 'movie:mark': { syncedAt: NOW - 1000, partial: false, error: 'RATE_LIMITED' } }
  assert.equal(cooldownRemaining(caches, ['movie:mark'], NOW, MIN), 0)
})

test('只检查本次要同步的维度', () => {
  const caches = {
    'movie:mark': { syncedAt: NOW - 1000, partial: false },
    'book:mark': { syncedAt: NOW - MIN - 1, partial: false },
  }
  // 只同步 book 维度时，不该被 movie 的最近同步拖住
  assert.equal(cooldownRemaining(caches, ['book:mark'], NOW, MIN), 0)
})

test('系统时间回拨时不返回负数', () => {
  const caches = { 'movie:mark': { syncedAt: NOW + 60_000, partial: false } }
  assert.equal(cooldownRemaining(caches, ['movie:mark'], NOW, MIN), MIN)
})
