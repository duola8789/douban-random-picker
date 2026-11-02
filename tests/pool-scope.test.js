/**
 * 候选池：按需加载来源、候选集勾选与同步编排。
 *
 * 前半是 lib 的单测，后半用假 chrome 环境跑真实的 service worker，
 * 验证「加载一半只拉一半」「加载回来就进池」「保存移出/放回」
 * 以及部分结果与清理门控。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEnv } from './harness/env.js'
import { sourceOf, SCOPE_LABEL } from '../src/lib/scope.js'
import {
  dimensionKeysFor,
  allDimensionKeys,
  loadedSources,
  loadedDimensionKeys,
  allSyncedSinceFor,
  latestSyncedAt,
  isFresh,
  emptyCache,
} from '../src/lib/cache.js'
import { buildPools } from '../src/lib/picker.js'

// ---------------------------------------------------------------- 纯逻辑

test('来源判定：只有 done 算重温', () => {
  assert.equal(sourceOf({ status: 'mark' }), 'mark')
  assert.equal(sourceOf({ status: 'doing' }), 'mark')
  assert.equal(sourceOf({ status: 'done' }), 'done')
  assert.equal(sourceOf({}), 'mark')
})

test('标签文案', () => {
  assert.equal(SCOPE_LABEL.mark, '想看 / 想读')
  assert.equal(SCOPE_LABEL.done, '看过 / 读过')
})

test('维度按来源返回', () => {
  assert.deepEqual(dimensionKeysFor(['mark']), ['movie:mark', 'book:mark'])
  assert.deepEqual(dimensionKeysFor(['done']), ['movie:done', 'book:done'])
  assert.deepEqual(dimensionKeysFor(['mark', 'done']), allDimensionKeys())
  assert.equal(Object.keys(emptyCache()).length, 4, '缓存结构始终是四个维度')
})

test('加载过的来源由缓存推导', () => {
  const now = 1_000_000
  assert.deepEqual(loadedSources({}), [])
  assert.deepEqual(loadedSources({ 'movie:mark': { syncedAt: now } }), ['mark'])
  assert.deepEqual(
    loadedSources({ 'movie:mark': { syncedAt: now }, 'book:done': { syncedAt: 0 } }),
    ['mark'],
  )
  assert.deepEqual(
    loadedSources({ 'movie:mark': { syncedAt: now }, 'book:done': { syncedAt: now } }),
    ['mark', 'done'],
  )
  assert.deepEqual(loadedDimensionKeys({ 'movie:done': { syncedAt: now } }), [
    'movie:done',
    'book:done',
  ])
})

test('部分失败的结果不算新鲜', () => {
  const now = 1_000_000_000_000
  assert.equal(isFresh({ syncedAt: now - 1000 }, now), true)
  assert.equal(isFresh({ syncedAt: now - 1000, partial: true }, now), false)
  assert.equal(isFresh({ syncedAt: now - 1000, error: 'RATE_LIMITED' }, now), false)
})

test('上次同步时间只认完整同步', () => {
  assert.equal(latestSyncedAt({}), 0)
  assert.equal(latestSyncedAt({ a: { syncedAt: 500 }, b: { syncedAt: 900 } }), 900)
  assert.equal(latestSyncedAt({ a: { syncedAt: 500, partial: true }, b: { syncedAt: 900 } }), 900)
  assert.equal(latestSyncedAt({ a: { syncedAt: 500, error: 'X' } }), 0)
})

test('指定维度都在本次同步后完整成功，才允许清理', () => {
  const startedAt = 1000
  const good = { syncedAt: 1001 }
  assert.equal(allSyncedSinceFor({ 'movie:mark': good }, ['movie:mark'], startedAt), true)
  assert.equal(
    allSyncedSinceFor({ 'movie:mark': { ...good, partial: true } }, ['movie:mark'], startedAt),
    false,
  )
  assert.equal(
    allSyncedSinceFor({ 'movie:mark': { syncedAt: 999 } }, ['movie:mark'], startedAt),
    false,
  )
  assert.equal(allSyncedSinceFor({}, [], startedAt), false)
})

test('buildPools 合并所有已加载来源，并按 key 去重', () => {
  const caches = {
    'movie:mark': {
      items: [
        { key: 'movie:1', category: 'movie', status: 'mark', title: '旧' },
        { key: 'movie:2', category: 'movie', status: 'mark', title: '新' },
      ],
    },
    'movie:done': {
      items: [{ key: 'movie:1', category: 'movie', status: 'done', title: '看过' }],
    },
    'book:mark': { items: [{ key: 'book:3', category: 'book', status: 'mark' }] },
  }

  const pools = buildPools(caches)
  assert.equal(pools.movie.length, 2, '同 key 只保留一条')
  assert.equal(pools.movie.find((it) => it.key === 'movie:1').status, 'done', '看过优先')
  assert.equal(pools.movie.find((it) => it.key === 'movie:1').title, '看过')
  assert.equal(pools.book.length, 1)
})

// ---------------------------------------------------------------- 编排

const env = createEnv({ uid: '20250101', loggedIn: true })
globalThis.chrome = env.chrome

const sw = await import('../src/background/service-worker.js')
void sw
const sync = await import('../src/background/sync.js')

const send = (message) => env.uiSend(message)
const getState = () => send({ type: 'ui:getState' })
const getCandidates = () => send({ type: 'ui:getCandidates' })
const resetStats = () => env.stats.reset()

test('第一次加载：只拉指定的那一半', async () => {
  await send({ type: 'ui:setUid', uid: '20250101' })
  resetStats()

  const res = await send({ type: 'ui:loadSources', sources: ['mark'] })
  assert.equal(res.ok, true, `加载失败：${JSON.stringify(res)}`)
  assert.equal(res.sync.ok, true)

  assert.deepEqual(Object.keys(env.stats.byDimension).sort(), ['book:mark', 'movie:mark'])

  const candidates = await getCandidates()
  assert.deepEqual(candidates.loaded, ['mark'])
  assert.equal(candidates.complete, true, '已加载的那一半是完整的')
})

test('加载另一半：只补拉看过', async () => {
  resetStats()
  const res = await send({ type: 'ui:loadSources', sources: ['done'] })
  assert.equal(res.ok, true, `加载失败：${JSON.stringify(res)}`)
  assert.deepEqual(Object.keys(env.stats.byDimension).sort(), ['book:done', 'movie:done'])

  const candidates = await getCandidates()
  assert.deepEqual(candidates.loaded.sort(), ['done', 'mark'])
})

test('空来源被拒绝', async () => {
  const res = await send({ type: 'ui:loadSources', sources: [] })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'SCOPE_EMPTY')
})

test('加载回来的条目默认在候选池里', async () => {
  const state = await getState()
  assert.ok(state.counts.movie > 0, '电影池里应当有已加载的条目')
  assert.ok(state.counts.book > 0, '图书池里应当有已加载的条目')
})

test('抽取可以用不同来源的条目', async () => {
  await chrome.storage.local.set({ records: [] })
  const seen = new Set()
  for (let i = 0; i < 20; i += 1) {
    await chrome.storage.local.set({ records: [] })
    const res = await send({ type: 'ui:pick', category: 'movie' })
    assert.equal(res.ok, true, `抽取失败：${JSON.stringify(res.error)}`)
    seen.add(res.item.status)
  }
  assert.ok(seen.has('mark'), '应当能抽到想看')
})

test('保存候选集：取消勾选移出，重新勾上放回', async () => {
  const candidates = await getCandidates()
  const target = candidates.items.movie.find((it) => it.status === 'mark')
  assert.ok(target, '前置条件：应当有电影候选')

  const hidden = await send({ type: 'ui:savePool', hide: [target.key], unhide: [] })
  assert.equal(hidden.ok, true)
  assert.ok(hidden.hidden[target.key], '取消勾选后应记入本地集合')

  const after = await getCandidates()
  assert.ok(after.items.movie.some((it) => it.key === target.key), '条目仍留在列表里，只是未勾选')
  assert.ok(after.hidden[target.key])

  const back = await send({ type: 'ui:savePool', hide: [], unhide: [target.key] })
  assert.equal(back.hidden[target.key], undefined, '重新勾选后应放回')
})

test('待看的条目不能被保存移出', async () => {
  await chrome.storage.local.set({ records: [] })
  const picked = await send({ type: 'ui:pick', category: 'movie' })
  assert.equal(picked.ok, true, `抽取失败：${JSON.stringify(picked.error)}`)

  const res = await send({ type: 'ui:savePool', hide: [picked.record.key], unhide: [] })
  assert.deepEqual(res.skipped, [picked.record.key], '待看条目应被跳过')
  assert.equal(res.hidden[picked.record.key], undefined)
})

test('计数只算没被移出的条目', async () => {
  const before = await getState()
  const candidates = await getCandidates()
  const target = candidates.items.movie.find((it) => !candidates.hidden[it.key])
  assert.ok(target)

  await send({ type: 'ui:savePool', hide: [target.key], unhide: [] })
  const after = await getState()
  assert.equal(after.counts.movie, before.counts.movie - 1)

  await send({ type: 'ui:savePool', hide: [], unhide: [target.key] })
})

test('部分结果不覆盖完整缓存，也不算新鲜', async () => {
  const raw = (await chrome.storage.local.get('caches')).caches
  const oldCount = raw['movie:done'].items.length
  assert.ok(oldCount > 0, '前置条件：电影看过维度应当已加载')

  await sync.handleSyncResult({
    dimension: 'movie:done',
    items: [
      {
        status: 'done',
        subject: { id: '777777', title: '新拉到的', type: 'movie' },
      },
    ],
    total: oldCount + 1,
    partial: true,
    error: { code: 'NETWORK' },
  })

  const entry = (await chrome.storage.local.get('caches')).caches['movie:done']
  assert.ok(entry.items.length >= oldCount + 1, '旧条目应保留，新条目并入')
  assert.equal(entry.partial, true)
  assert.equal(isFresh(entry), false, '部分结果不应被视为新鲜')
})

test('本次同步完整成功后才清理已消失的移出记录', async () => {
  await chrome.storage.local.set({
    caches: {},
    hidden: { 'movie:99999': Date.now() - 200 * 864e5 },
  })

  const res = await send({ type: 'ui:loadSources', sources: ['mark'] })
  assert.equal(res.ok, true)
  assert.equal(res.sync.ok, true)

  const { hidden = {} } = await chrome.storage.local.get('hidden')
  assert.equal(hidden['movie:99999'], undefined, '完整加载后应清掉孤儿记录')
})
