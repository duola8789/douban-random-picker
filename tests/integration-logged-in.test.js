/**
 * 端到端：已登录状态下的完整链路。
 *
 * 走的是真实的 service worker 与 content script，只把 chrome.* 换成假实现。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEnv } from './harness/env.js'

const env = createEnv({ uid: '20250101', loggedIn: true })
globalThis.chrome = env.chrome

const sw = await import('../src/background/service-worker.js')
void sw

test('探测登录态能拿到 uid', async () => {
  const res = await env.uiSend({ type: 'ui:probeLogin' })
  assert.equal(res.ok, true, '探测应当成功')
  assert.equal(res.login.uid, '20250101')
})

test('同步后缓存里有电影、剧集、图书三类', async () => {
  await env.uiSend({ type: 'ui:setUid', uid: '20250101' })

  const res = await env.uiSend({ type: 'ui:sync', force: true })
  assert.equal(res.ok, true, `同步失败：${JSON.stringify(res.error)}`)

  const state = await env.uiSend({ type: 'ui:getState' })
  const movieCache = state.caches['movie:mark']
  const bookCache = state.caches['book:mark']

  assert.equal(movieCache.count, 120)
  assert.equal(movieCache.byCategory.movie, 90)
  assert.equal(movieCache.byCategory.tv, 30)
  assert.equal(bookCache.count, 80)
  assert.ok(movieCache.syncedAt > 0)
})

test('抽取只从指定类别里取，并记为待看', async () => {
  const res = await env.uiSend({ type: 'ui:pick', category: 'book' })
  assert.equal(res.ok, true, `抽取失败：${JSON.stringify(res.error)}`)
  assert.equal(res.item.category, 'book')
  assert.equal(res.record.state, 'pending')
  assert.equal(res.record.markStatus, 'mark')
  assert.equal(res.records.length, 1)
})

test('该类别有未处理的待看时不能再抽', async () => {
  const res = await env.uiSend({ type: 'ui:pick', category: 'book' })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'PENDING_EXISTS')
})

test('别的类别不受影响', async () => {
  const res = await env.uiSend({ type: 'ui:pick', category: 'movie' })
  assert.equal(res.ok, true)
  assert.equal(res.item.category, 'movie')
})

test('跳过后可以再抽，且记录保留为跳过', async () => {
  const before = await env.uiSend({ type: 'ui:getState' })
  const pending = before.records.find((r) => r.category === 'book' && r.state === 'pending')
  assert.ok(pending, '图书类别应有一条待看')

  const skipped = await env.uiSend({ type: 'ui:skip', key: pending.key })
  assert.equal(skipped.ok, true)
  const after = skipped.records.find((r) => r.key === pending.key)
  assert.equal(after.state, 'skipped')
  assert.ok(after.resolvedAt > 0)

  const again = await env.uiSend({ type: 'ui:pick', category: 'book' })
  assert.equal(again.ok, true, '跳过后应可以再抽')
  assert.notEqual(again.item.key, pending.key, '不应立刻抽回刚跳过的那条')
})

test('同一类别当天第二次跳过被拒绝', async () => {
  const state = await env.uiSend({ type: 'ui:getState' })
  const pending = state.records.find((r) => r.category === 'book' && r.state === 'pending')
  assert.ok(pending, '图书类别应有一条新的待看')

  const res = await env.uiSend({ type: 'ui:skip', key: pending.key })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'SKIP_LIMIT')

  const after = await env.uiSend({ type: 'ui:getState' })
  const still = after.records.find((r) => r.key === pending.key)
  assert.equal(still.state, 'pending', '被拒绝时状态不应改变')
})

test('别的类别仍有跳过机会', async () => {
  const state = await env.uiSend({ type: 'ui:getState' })
  const pending = state.records.find((r) => r.category === 'movie' && r.state === 'pending')
  assert.ok(pending)

  const res = await env.uiSend({ type: 'ui:skip', key: pending.key })
  assert.equal(res.ok, true, '电影类别今天还没跳过')
})

test('抽中后能补到简介', async () => {
  const state = await env.uiSend({ type: 'ui:getState' })
  const pending = state.records.find((r) => r.state === 'pending')
  assert.ok(pending)

  const res = await env.uiSend({
    type: 'ui:detail',
    subjectId: pending.subjectId,
    category: pending.category,
  })
  assert.equal(res.ok, true)
  assert.equal(res.detail.ok, true)
  assert.ok(res.detail.intro.includes(pending.subjectId))
})

test('清空记录会保留待看', async () => {
  const res = await env.uiSend({ type: 'ui:clearHistory' })
  assert.equal(res.ok, true)
  assert.ok(res.records.length > 0, '待看不应被清空')
  assert.ok(res.records.every((r) => r.state === 'pending'))
})

test('最短更新频率拦住手动同步', async () => {
  const res = await env.uiSend({ type: 'ui:sync', force: true })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'TOO_SOON')
  assert.ok(res.error.retryAfterMs > 0)
})
