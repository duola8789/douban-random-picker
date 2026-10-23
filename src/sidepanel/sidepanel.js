/**
 * 侧边栏界面。
 *
 * 它只负责展示与发消息，所有长时间任务都在 content script / service worker 里，
 * 所以侧边栏关掉不会打断同步。
 */

import { UI, SW_EVENT } from '../lib/messages.js'
import { dimensionsForScopes, isFresh } from '../lib/cache.js'

const $ = (sel) => document.querySelector(sel)

const el = {
  stage: $('#stage'),
  draw: $('#draw'),
  sync: $('#sync'),
  syncAll: $('#sync-all'),
  historyList: $('#history-list'),
  clearHistory: $('#clear-history'),
  toast: $('#toast'),
  scopes: [...document.querySelectorAll('.scopes input')],
}

const state = {
  settings: null,
  caches: {},
  history: [],
  item: null,
  syncing: false,
  needsSetup: false,
  notice: null,
  progress: null,
}

const LOGIN_URL = 'https://www.douban.com/'

// ---------------------------------------------------------------- 通信

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch {
    return { ok: false, error: { code: 'NETWORK' } }
  }
}

// ---------------------------------------------------------------- 生命周期

async function boot() {
  const res = await send({ type: UI.GET_STATE })
  if (!res?.ok) {
    state.notice = { text: '扩展状态读取失败，请重新打开侧边栏。' }
    render()
    return
  }

  state.settings = res.settings
  state.caches = res.caches ?? {}
  state.history = res.history ?? []
  state.syncing = Boolean(res.syncing)
  syncScopeInputs()
  render()

  if (!state.settings.uid) await detectUid()
  if (state.needsSetup) return

  await ensureFresh()
  render()
}

/** 首次使用：尝试自动拿到 uid，失败则要求手动填写 */
async function detectUid() {
  const probe = await send({ type: UI.PROBE_LOGIN })
  const uid = probe?.login?.ok ? probe.login.uid : ''
  if (!uid) {
    state.needsSetup = true
    render()
    return
  }
  await send({ type: UI.SET_UID, uid })
  state.settings.uid = uid
}

/** 打开侧边栏时：缓存过期就后台刷新，先用旧数据渲染 */
async function ensureFresh() {
  const wanted = dimensionsForScopes(state.settings.scopes)
  const stale = wanted.filter((key) => !isFresh(state.caches[key]))
  if (stale.length === 0) return
  await runSync({ force: false })
}

async function runSync({ force = false, all = false } = {}) {
  state.syncing = true
  state.progress = null
  state.notice = null
  render()

  const res = await send({ type: UI.SYNC, force, all })

  state.syncing = false
  state.progress = null

  if (res?.error) state.notice = noticeFor(res.error)
  await refreshState()
  render()
  return res
}

async function refreshState() {
  const res = await send({ type: UI.GET_STATE })
  if (!res?.ok) return
  state.settings = res.settings
  state.caches = res.caches ?? {}
  state.history = res.history ?? []
  syncScopeInputs()
}

async function draw() {
  el.draw.disabled = true
  const res = await send({ type: UI.PICK })
  el.draw.disabled = false

  if (!res?.ok) {
    state.notice = noticeFor(res?.error)
    render()
    return
  }

  state.item = res.item
  if (Array.isArray(res.history)) state.history = res.history
  state.notice = null
  render()
}

// ---------------------------------------------------------------- 错误文案

function noticeFor(error) {
  const code = error?.code ?? 'NETWORK'
  switch (code) {
    case 'NO_UID':
      state.needsSetup = true
      return { text: '还没有设置豆瓣账号。' }
    case 'AUTH_REQUIRED':
      return {
        text: '登录已失效。请先在豆瓣网页登录，再回来同步。',
        action: { label: '打开豆瓣', kind: 'login' },
      }
    case 'NO_DOUBAN_TAB':
      return { text: '无法打开豆瓣页面，请先在浏览器里打开任意豆瓣页面后再同步。' }
    case 'RATE_LIMITED':
      return { text: '豆瓣请求过于频繁，已暂停。请过一会儿再试。' }
    case 'TOO_SOON': {
      const minutes = Math.max(1, Math.ceil((error?.retryAfterMs ?? 0) / 60000))
      return { text: `刚同步过，${minutes} 分钟后才能再同步。` }
    }
    case 'NO_SCOPE':
      return { text: '至少选择一类才能抽。' }
    case 'NO_CANDIDATES':
      return { text: '选中的范围里还没有可抽的条目。可以先同步，或去豆瓣标记一些。' }
    case 'POOL_EXHAUSTED':
      return {
        text: '最近的都抽过一遍了。清空历史可以重新开始。',
        action: { label: '清空历史', kind: 'clear' },
      }
    case 'SYNCING':
      return { text: '正在同步，稍等一下。' }
    default:
      return { text: '出了点问题，请稍后重试。' }
  }
}

// ---------------------------------------------------------------- 渲染

function render() {
  renderToast()
  renderStage()
  renderHistory()
  el.draw.disabled = state.syncing
  el.sync.disabled = state.syncing
  el.syncAll.disabled = state.syncing
  el.sync.textContent = state.syncing ? '同步中' : '同步'
}

function renderToast() {
  if (state.notice) {
    el.toast.hidden = false
    el.toast.textContent = state.notice.text
  } else {
    el.toast.hidden = true
    el.toast.textContent = ''
  }
}

function renderStage() {
  const stage = el.stage
  stage.replaceChildren()

  if (state.needsSetup) {
    stage.append(setupView())
    return
  }

  if (state.syncing && !state.item) {
    if (countByCategory().total === 0) {
      const skeleton = document.createElement('div')
      skeleton.className = 'skeleton'
      stage.append(skeleton)
      return
    }
    stage.append(placeholderView())
    return
  }

  if (state.item) {
    stage.append(cardView(state.item))
    return
  }

  stage.append(placeholderView())
}

function setupView() {
  const wrap = document.createElement('div')
  wrap.className = 'placeholder'

  const title = document.createElement('strong')
  title.textContent = '先告诉我在哪儿找你'
  const hint = document.createElement('span')
  hint.textContent = '粘贴你的豆瓣个人主页地址，例如 https://www.douban.com/people/123456/'

  const form = document.createElement('form')
  form.className = 'setup'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'https://www.douban.com/people/...'
  input.autocomplete = 'off'
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'primary'
  submit.textContent = '保存并同步'

  form.append(input, submit)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const uid = parseUid(input.value)
    if (!uid) {
      state.notice = { text: '这个地址里没有找到用户 ID。' }
      render()
      return
    }
    state.needsSetup = false
    state.notice = null
    await send({ type: UI.SET_UID, uid })
    state.settings.uid = uid
    await runSync({ force: true })
  })

  wrap.append(title, hint, form)
  queueMicrotask(() => input.focus())
  return wrap
}

function parseUid(value) {
  const trimmed = (value || '').trim()
  if (!trimmed) return ''
  const m = /\/people\/([^/?#\s]+)/.exec(trimmed)
  if (m) return m[1]
  // 允许直接粘贴纯 uid
  if (/^[\w.-]+$/.test(trimmed) && !trimmed.includes(' ')) return trimmed
  return ''
}

function placeholderView() {
  const wrap = document.createElement('div')
  wrap.className = 'placeholder'

  const title = document.createElement('strong')
  const hint = document.createElement('span')

  if (state.syncing) {
    title.textContent = '正在同步'
    hint.textContent = state.progress
      ? `已取回 ${state.progress.fetched} / ${state.progress.total} 条`
      : '正在读取你在豆瓣的标记…'
  } else if (state.notice) {
    title.textContent = '暂时没法抽'
    hint.textContent = state.notice.text
  } else {
    title.textContent = '准备好了'
    const counts = countByCategory()
    hint.textContent =
      counts.total > 0
        ? `候选：电影 ${counts.movie} · 剧集 ${counts.tv} · 图书 ${counts.book}`
        : '还没有候选条目，点「同步」拉一次。'
  }

  wrap.append(title, hint)

  if (state.notice?.action) {
    const row = document.createElement('div')
    row.className = 'actions-row'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ghost'
    btn.textContent = state.notice.action.label
    btn.addEventListener('click', () => runNoticeAction(state.notice.action.kind))
    row.append(btn)
    wrap.append(row)
  }

  return wrap
}

async function runNoticeAction(kind) {
  if (kind === 'login') {
    chrome.tabs.create({ url: LOGIN_URL })
    return
  }
  if (kind === 'clear') {
    await send({ type: UI.CLEAR_HISTORY })
    state.history = []
    state.notice = null
    render()
  }
}

function cardView(item) {
  const card = document.createElement('article')
  card.className = 'card'

  const cover = document.createElement('div')
  cover.className = 'card-cover'
  if (item.coverUrl) {
    const img = document.createElement('img')
    img.src = item.coverUrl
    img.alt = item.title
    img.loading = 'lazy'
    img.addEventListener('error', () => {
      cover.replaceChildren(noCover())
    })
    cover.append(img)
  } else {
    cover.append(noCover())
  }

  const body = document.createElement('div')
  body.className = 'card-body'

  const title = document.createElement('h2')
  title.className = 'card-title'
  title.textContent = item.title

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  meta.append(tag(CATEGORY_LABEL[item.category] ?? '条目'))
  if (item.year) meta.append(tag(item.year))
  if (typeof item.doubanRating === 'number') {
    const score = document.createElement('span')
    score.className = 'rating-douban'
    score.textContent = `豆瓣 ${item.doubanRating.toFixed(1)}`
    meta.append(score)
  }
  if (item.subtitle) {
    const sub = document.createElement('span')
    sub.textContent = item.subtitle
    meta.append(sub)
  }

  body.append(title, meta)

  // 我的评分 / 短评可能缺失（例如未来的豆列来源），缺失时整块不渲染
  if (typeof item.myRating === 'number' || item.myComment) {
    const mine = document.createElement('div')
    mine.className = 'my'
    if (typeof item.myRating === 'number') {
      const stars = document.createElement('div')
      stars.className = 'my-rating'
      stars.textContent = '★'.repeat(item.myRating) + '☆'.repeat(Math.max(0, 5 - item.myRating))
      stars.title = `我的评分 ${item.myRating}`
      mine.append(stars)
    }
    if (item.myComment) {
      const comment = document.createElement('p')
      comment.className = 'my-comment'
      comment.textContent = `「${item.myComment}」`
      mine.append(comment)
    }
    body.append(mine)
  }

  const links = document.createElement('div')
  links.className = 'card-links'
  const open = document.createElement('button')
  open.type = 'button'
  open.textContent = '去豆瓣看看'
  open.addEventListener('click', () => chrome.tabs.create({ url: item.url }))
  const again = document.createElement('button')
  again.type = 'button'
  again.textContent = '再抽一个'
  again.addEventListener('click', draw)
  links.append(open, again)
  body.append(links)

  card.append(cover, body)
  return card
}

function noCover() {
  const div = document.createElement('div')
  div.className = 'no-cover'
  div.textContent = '没有封面'
  return div
}

function tag(text) {
  const span = document.createElement('span')
  span.textContent = text
  return span
}

function renderHistory() {
  const list = el.historyList
  list.replaceChildren()

  if (!state.history.length) {
    const li = document.createElement('li')
    li.className = 'empty-line'
    li.textContent = '还没有抽过。'
    list.append(li)
    return
  }

  for (const record of state.history) {
    const li = document.createElement('li')

    const dot = document.createElement('span')
    dot.className = `dot ${record.category ?? ''}`

    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'name'
    name.textContent = record.title
    name.title = record.title
    if (record.url) name.addEventListener('click', () => chrome.tabs.create({ url: record.url }))

    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = formatDay(record.drawnAt)

    li.append(dot, name, when)
    list.append(li)
  }
}

function formatDay(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return sameDay ? '今天' : `${mm}-${dd}`
}

function countByCategory() {
  const counts = { movie: 0, tv: 0, book: 0, total: 0 }
  for (const entry of Object.values(state.caches)) {
    counts.movie += entry?.byCategory?.movie ?? 0
    counts.tv += entry?.byCategory?.tv ?? 0
    counts.book += entry?.byCategory?.book ?? 0
    counts.total += entry?.count ?? 0
  }
  return counts
}

// ---------------------------------------------------------------- 事件

const CATEGORY_LABEL = { movie: '电影', tv: '剧集', book: '图书' }

function syncScopeInputs() {
  for (const input of el.scopes) {
    const cat = input.dataset.cat
    input.checked = Boolean(state.settings?.scopes?.[cat])
  }
}

for (const input of el.scopes) {
  input.addEventListener('change', async () => {
    const scopes = {}
    for (const i of el.scopes) scopes[i.dataset.cat] = i.checked
    state.settings.scopes = scopes
    state.syncing = true
    render()
    // service worker 收到后会按新范围补拉缺失的维度
    const res = await send({ type: UI.SET_SCOPES, scopes })
    if (res?.settings) state.settings = { ...state.settings, ...res.settings }
    if (!res?.ok) state.syncing = false
    render()
  })
}

el.draw.addEventListener('click', draw)
el.sync.addEventListener('click', () => runSync({ force: true }))
el.syncAll.addEventListener('click', () => runSync({ force: true, all: true }))

let clearArmed = false
el.clearHistory.addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true
    el.clearHistory.textContent = '确认清空？'
    setTimeout(() => {
      clearArmed = false
      el.clearHistory.textContent = '清空'
    }, 3000)
    return
  }
  clearArmed = false
  el.clearHistory.textContent = '清空'
  await send({ type: UI.CLEAR_HISTORY })
  state.history = []
  render()
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === SW_EVENT.SYNC_PROGRESS) {
    state.progress = { fetched: message.fetched ?? 0, total: message.total ?? 0 }
    state.syncing = true
    if (!state.item) renderStage()
    el.draw.disabled = true
    el.sync.disabled = true
    el.syncAll.disabled = true
    return
  }
  if (message?.type === SW_EVENT.SYNC_FINISHED) {
    state.syncing = false
    state.progress = null
    state.notice = message.result?.error ? noticeFor(message.result.error) : null
    refreshState().then(() => render())
  }
})

boot()
