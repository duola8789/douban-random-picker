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
  assert.equal(res.login.ok, true)
  assert.equal(res.login.uid, '20250101')
})

test('同步后缓存里有电影、剧集、图书三类', async () => {
  await env.uiSend({ type: 'ui:setUid', uid: '20250101' })

  const res = await env.uiSend({ type: 'ui:sync', force: true })
  assert.equal(res.ok, true, `同步失败：${JSON.stringify(res.error)}`)

  const state = await env.uiSend({ type: 'ui:getState' })
  const movieCache = state.caches['movie:mark']
  const bookCache = state.caches['book:mark']

  assert.equal(movieCache.count, 120, '电影维度应拉到 120 条')
  assert.equal(movieCache.byCategory.movie, 90, '其中 90 条是电影')
  assert.equal(movieCache.byCategory.tv, 30, '其余 30 条应被识别为剧集')
  assert.equal(bookCache.count, 80, '图书维度应拉到 80 条')
  assert.ok(movieCache.syncedAt > 0, '应记录同步时间')
  assert.equal(movieCache.partial, false)
})

test('抽取返回合法条目并写入历史', async () => {
  const res = await env.uiSend({ type: 'ui:pick' })
  assert.equal(res.ok, true, `抽取失败：${JSON.stringify(res.error)}`)
  assert.ok(['movie', 'tv', 'book'].includes(res.item.category))
  assert.ok(res.item.title)
  assert.ok(res.item.url.startsWith('https://'))
  assert.equal(res.item.status, 'mark', '应带上标记状态，界面据此显示「来自想看」')
  assert.equal(res.history.length, 1, '历史应有一条记录')
  assert.equal(res.history[0].key, res.item.key)
})

test('抽中后能补到简介', async () => {
  const picked = await env.uiSend({ type: 'ui:pick' })
  assert.equal(picked.ok, true)

  const res = await env.uiSend({
    type: 'ui:detail',
    subjectId: picked.item.subjectId,
    category: picked.item.category,
  })
  assert.equal(res.ok, true)
  assert.equal(res.detail.ok, true)
  assert.ok(res.detail.intro.includes(picked.item.subjectId), '简介应来自详情接口')
})

test('连抽 10 次不会重复', async () => {
  const seen = new Set()
  for (let i = 0; i < 10; i += 1) {
    const res = await env.uiSend({ type: 'ui:pick' })
    assert.equal(res.ok, true)
    assert.equal(seen.has(res.item.key), false, `第 ${i + 1} 次抽到了重复条目 ${res.item.key}`)
    seen.add(res.item.key)
  }
})

test('最短更新频率拦住手动同步', async () => {
  const res = await env.uiSend({ type: 'ui:sync', force: true })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'TOO_SOON')
  assert.ok(res.error.retryAfterMs > 0, '应告知还要等多久')
  assert.ok(res.error.retryAfterMs <= 10 * 60 * 1000)
})

test('只勾图书时只从图书里抽', async () => {
  await env.uiSend({ type: 'ui:setScopes', scopes: { movie: false, tv: false, book: true } })
  for (let i = 0; i < 5; i += 1) {
    const res = await env.uiSend({ type: 'ui:pick' })
    assert.equal(res.ok, true)
    assert.equal(res.item.category, 'book')
  }
})

test('清空历史后去重窗口失效', async () => {
  await env.uiSend({ type: 'ui:clearHistory' })
  const state = await env.uiSend({ type: 'ui:getState' })
  assert.equal(state.history.length, 0)
})
