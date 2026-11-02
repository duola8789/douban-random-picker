/**
 * 分页中途失败：旧缓存不能被清空，部分结果不能算新鲜，
 * 也不能在这种「证据不完整」的同步之后清理屏蔽记录。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEnv } from './harness/env.js'
import { isFresh } from '../src/lib/cache.js'

const OLD_ITEM = {
  key: 'movie:1',
  subjectId: '1',
  category: 'movie',
  title: '旧的完整缓存里的条目',
  status: 'mark',
}

const env = createEnv({
  uid: '20250101',
  loggedIn: true,
  failDimension: 'movie:mark',
  failAfterPage: 1,
})
globalThis.chrome = env.chrome

const sw = await import('../src/background/service-worker.js')
void sw

const send = (message) => env.uiSend(message)

test('分页中途失败保留旧条目，且不算新鲜', async () => {
  const longAgo = Date.now() - 200 * 864e5
  await chrome.storage.local.set({
    settings: { uid: '20250101', category: 'movie' },
    caches: {
      'movie:mark': { items: [OLD_ITEM], total: 1, syncedAt: 0, partial: false },
      'book:mark': { items: [], total: 0, syncedAt: 0, partial: false },
      'movie:done': { items: [], total: 0, syncedAt: 0, partial: false },
      'book:done': { items: [], total: 0, syncedAt: 0, partial: false },
    },
    hidden: { 'movie:99999': longAgo },
  })

  const res = await send({ type: 'ui:sync', force: true })
  assert.equal(res.ok, true, `同步不应整体失败：${JSON.stringify(res.error)}`)
  assert.equal(res.partial, true, '应当报告部分成功')

  const { caches, hidden } = await chrome.storage.local.get(['caches', 'hidden'])
  const entry = caches['movie:mark']

  assert.equal(entry.partial, true)
  assert.ok(entry.items.some((it) => it.key === OLD_ITEM.key), '旧条目必须保留')
  assert.ok(entry.items.length > 1, '已取到的分页应当并入')
  assert.equal(isFresh(entry), false, '部分结果不算新鲜')

  assert.equal(
    hidden['movie:99999'] != null,
    true,
    '同步不完整时不能清理屏蔽记录',
  )
})
