/**
 * 端到端：/mine/ 不重定向时，从「我的豆瓣」页面 DOM 里认出 uid。
 *
 * 这是真实环境里最容易出问题的一条路径——已实测未登录时 /mine/ 返回 403，
 * 但已登录时是否一定 302 到 /people/<uid>/ 尚未确认。若豆瓣改成原地渲染，
 * 旧实现会判定「未登录」，用户看到的就是「打开了豆瓣页面但没有数据」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEnv } from './harness/env.js'

const env = createEnv({
  uid: '778899',
  loggedIn: true,
  mineRedirect: false,
  domLinks: {
    '.nav-user-account a[href*="/people/"]': [
      { getAttribute: () => 'https://www.douban.com/people/778899/' },
    ],
  },
})
globalThis.chrome = env.chrome

await import('../src/background/service-worker.js')

test('/mine/ 不重定向时仍能从 DOM 拿到 uid', async () => {
  const res = await env.uiSend({ type: 'ui:probeLogin' })
  assert.equal(res.login.ok, true, '应当识别为已登录')
  assert.equal(res.login.uid, '778899')
  assert.equal(res.login.via, 'mine-dom')
})

test('识别到 uid 后同步仍然可用', async () => {
  await env.uiSend({ type: 'ui:setUid', uid: '778899' })
  const res = await env.uiSend({ type: 'ui:sync', force: true })
  assert.equal(res.ok, true, `同步失败：${JSON.stringify(res.error)}`)

  const state = await env.uiSend({ type: 'ui:getState' })
  assert.ok(state.caches['movie:mark'].count > 0)
  assert.ok(state.caches['book:mark'].count > 0)
})
