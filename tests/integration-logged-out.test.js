/**
 * 端到端：未登录时的行为。
 *
 * 要求（specs/douban-session）：
 *   - 探测失败时不能把空结果当成「没有收藏」；
 *   - 同步必须返回 AUTH_REQUIRED，界面据此提示去登录。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEnv } from './harness/env.js'

const env = createEnv({ uid: '20250101', loggedIn: false })
globalThis.chrome = env.chrome

await import('../src/background/service-worker.js')

test('未登录时探测失败并给出原因', async () => {
  const res = await env.uiSend({ type: 'ui:probeLogin' })
  assert.equal(res.ok, true, '探测动作本身应成功执行')
  assert.equal(res.login.ok, false, '应判定为未登录')
  assert.equal(res.login.reason, 'mine-403')
})

test('未登录时同步返回 AUTH_REQUIRED 且不写入缓存', async () => {
  await env.uiSend({ type: 'ui:setUid', uid: '20250101' })

  const res = await env.uiSend({ type: 'ui:sync', force: true })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'AUTH_REQUIRED')
  assert.equal(res.error.reason, 'mine-403')

  const state = await env.uiSend({ type: 'ui:getState' })
  assert.equal(state.caches['movie:mark'].count, 0, '未登录时不应产生候选数据')
})

test('未登录时抽取给出「没有候选」而不是假装成功', async () => {
  const res = await env.uiSend({ type: 'ui:pick', category: 'movie' })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'NO_CANDIDATES')
})
