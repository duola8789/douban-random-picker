/**
 * 侧边栏界面。
 *
 * 三个类别各是一个页签，抽取、待看、记录都按类别独立。
 * 只负责展示与发消息；长任务都在 content script / service worker 里。
 */

import { UI, SW_EVENT } from '../lib/messages.js'
import { allDimensionKeys, isFresh } from '../lib/cache.js'
import { pendingFor, canSkip } from '../lib/history.js'

const $ = (sel) => document.querySelector(sel)

const el = {
  stage: $('#stage'),
  draw: $('#draw'),
  actions: $('#actions'),
  sync: $('#sync'),
  tabs: [...document.querySelectorAll('.tab')],
  historyList: $('#history-list'),
  clearHistory: $('#clear-history'),
  resetAccount: $('#reset-account'),
  toast: $('#toast'),
  help: $('#help'),
  helpPanel: $('#help-panel'),
  helpClose: $('#help-close'),
}

const CATEGORY_LABEL = { movie: '电影', tv: '剧集', book: '图书' }
const CATEGORY_UNIT = { movie: '部电影', tv: '部剧集', book: '本书' }

const state = {
  settings: null,
  caches: {},
  records: [],
  active: 'movie',
  intro: '',
  introLoading: false,
  introKey: null,
  introExpanded: false,
  syncing: false,
  drawing: false,
  needsSetup: false,
  probeReason: null,
  toast: null,
  blocking: null,
  progress: null,
  cooldownUntil: 0,
}

let cardRefs = null
let cooldownTimer = null
let skipArmed = false
let skipTimer = null

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
    state.blocking = { text: '扩展状态读取失败，请重新打开侧边栏。' }
    render()
    return
  }

  state.settings = res.settings
  state.caches = res.caches ?? {}
  state.records = res.records ?? []
  state.active = res.settings?.category ?? 'movie'
  state.syncing = Boolean(res.syncing)
  render()

  // 首次使用：直接同步。同步过程本身会做登录探测并顺手拿到 uid，
  // 不必先单独探测一次再同步——那会多开一个标签页、多等一次页面加载。
  if (!state.settings.uid) {
    const result = await runSync({ force: true })
    if (!result?.ok) {
      state.needsSetup = true
      state.probeReason = result?.error?.reason ?? result?.error?.code ?? 'unknown'
    }
    render()
    return
  }

  await ensureFresh()
  render()
}

async function detectUid() {
  const probe = await send({ type: UI.PROBE_LOGIN })
  const uid = probe?.login?.ok ? probe.login.uid : ''
  if (!uid) {
    const reason = probe?.login?.reason ?? probe?.error?.code ?? 'unknown'
    console.warn(`[豆瓣随机] 自动识别 uid 失败 reason=${reason}`, probe)
    state.probeReason = reason
    state.needsSetup = true
    render()
    return
  }
  await send({ type: UI.SET_UID, uid })
  state.settings.uid = uid
  state.needsSetup = false
  state.probeReason = null
}

async function ensureFresh() {
  const stale = allDimensionKeys().filter((key) => !isFresh(state.caches[key]))
  if (stale.length === 0) return
  await runSync({ force: false })
}

async function runSync({ force = false } = {}) {
  if (state.syncing) return
  state.syncing = true
  state.progress = null
  state.blocking = null
  state.toast = null
  render()

  const res = await send({ type: UI.SYNC, force })

  state.syncing = false
  state.progress = null

  if (res?.error) applyError(res.error)
  await refreshState()
  render()
  return res
}

function applyError(error, scope = '同步') {
  logFailure(scope, error)
  const notice = noticeFor(error)
  if (!notice) return
  if (notice.blocking) state.blocking = notice
  else state.toast = notice.text
  if (notice.cooldownMs) setCooldown(notice.cooldownMs)
}

/** 直接把对象丢给 console 只会显示 [object Object]，把关键字段拼进文本 */
function logFailure(scope, error) {
  const code = error?.code ?? 'NETWORK'
  const reason = error?.reason ? ` reason=${error.reason}` : ''
  console.warn(`[豆瓣随机] ${scope}失败 code=${code}${reason}`, error)
}

async function refreshState() {
  const res = await send({ type: UI.GET_STATE })
  if (!res?.ok) return
  state.settings = res.settings
  state.caches = res.caches ?? {}
  state.records = res.records ?? []
}

function currentPending() {
  return pendingFor(state.records, state.active)
}

// ---------------------------------------------------------------- 抽取

async function draw() {
  if (state.drawing || currentPending()) return
  state.drawing = true
  state.blocking = null
  state.toast = null
  render()

  const res = await send({ type: UI.PICK, category: state.active })
  state.drawing = false

  if (!res?.ok) {
    applyError(res?.error, '抽取')
    render()
    return
  }

  if (Array.isArray(res.records)) state.records = res.records
  state.introKey = null
  state.intro = ''
  state.introExpanded = false
  render()
}

async function skip() {
  const pending = currentPending()
  if (!pending) return

  if (!skipArmed) {
    skipArmed = true
    clearTimeout(skipTimer)
    skipTimer = setTimeout(() => {
      skipArmed = false
      render()
    }, 3000)
    render()
    return
  }

  skipArmed = false
  const res = await send({ type: UI.SKIP, key: pending.key })
  if (res?.ok) {
    state.records = res.records ?? state.records
    state.introKey = null
    state.intro = ''
  } else if (res?.error) {
    applyError(res.error, '跳过')
  }
  render()
}

/** 抽中后补简介：收藏接口不返回 intro，要单独请求一次详情 */
function ensureIntro(record) {
  if (!record || state.introKey === record.key) return
  state.introKey = record.key
  state.intro = ''
  state.introLoading = true
  fillIntro()

  send({ type: UI.DETAIL, subjectId: record.subjectId, category: record.category }).then((res) => {
    if (state.introKey !== record.key) return
    state.introLoading = false
    state.intro = res?.detail?.intro?.trim?.() ?? ''
    fillIntro()
  })
}

function fillIntro() {
  if (!cardRefs?.introSlot) return
  const slot = cardRefs.introSlot
  slot.replaceChildren()

  if (state.introLoading) {
    const loading = document.createElement('p')
    loading.className = 'intro-loading'
    loading.textContent = '正在读取简介…'
    slot.append(loading)
    return
  }

  if (!state.intro) {
    slot.hidden = true
    return
  }
  slot.hidden = false

  const p = document.createElement('p')
  p.className = state.introExpanded ? 'intro' : 'intro clamped'
  p.textContent = state.intro
  slot.append(p)

  if (p.scrollHeight > p.clientHeight + 2 || state.introExpanded) {
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'intro-toggle'
    toggle.textContent = state.introExpanded ? '收起' : '展开'
    toggle.addEventListener('click', () => {
      state.introExpanded = !state.introExpanded
      fillIntro()
    })
    slot.append(toggle)
  }
}

// ---------------------------------------------------------------- 错误文案

function noticeFor(error) {
  const code = error?.code ?? 'NETWORK'
  switch (code) {
    case 'NO_UID':
      state.needsSetup = true
      return { text: '还没有设置豆瓣账号。', blocking: true }
    case 'AUTH_REQUIRED': {
      const reason = error?.reason ? `（${error.reason}）` : ''
      return {
        text: `没能确认登录状态。请先在豆瓣网页登录，再回来同步。${reason}`,
        action: { label: '打开豆瓣', kind: 'login' },
        blocking: true,
      }
    }
    case 'NO_DOUBAN_TAB':
      return { text: '没能打开豆瓣页面。请先手动打开一个豆瓣页面，再回来同步。', blocking: true }
    case 'RATE_LIMITED':
      return { text: '豆瓣请求过于频繁，已暂停。请过一会儿再试。', blocking: false }
    case 'TOO_SOON':
      return {
        text: '刚同步过，稍后再试。已有的数据没有受影响。',
        blocking: false,
        cooldownMs: error?.retryAfterMs ?? 0,
      }
    case 'PENDING_EXISTS':
      return { text: '这一类还有没处理的片子，先看完或跳过再抽。', blocking: false }
    case 'SKIP_LIMIT':
      return { text: '今天已经跳过 1 次了，明天再来。', blocking: false }
    case 'NO_CANDIDATES':
      return { text: '这一类的候选是空的。可以先同步，或去豆瓣标记一些。', blocking: true }
    case 'POOL_EXHAUSTED':
      return {
        text: '这一类最近都抽过了，先清空记录再试。',
        action: { label: '清空记录', kind: 'clear' },
        blocking: true,
      }
    default:
      return { text: `出了点问题（${code}），请稍后重试。`, blocking: false }
  }
}

// ---------------------------------------------------------------- 冷却

function setCooldown(ms) {
  if (!ms || ms <= 0) return
  state.cooldownUntil = Date.now() + ms
  clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    if (Date.now() >= state.cooldownUntil) {
      state.cooldownUntil = 0
      clearInterval(cooldownTimer)
    }
    updateSyncButton()
  }, 1000)
  updateSyncButton()
}

function updateSyncButton() {
  const left = state.cooldownUntil - Date.now()
  if (state.syncing) {
    el.sync.textContent = '同步中'
    el.sync.disabled = true
    el.sync.title = ''
    return
  }
  if (left > 0) {
    const s = Math.ceil(left / 1000)
    const mm = Math.floor(s / 60)
    const ss = String(s % 60).padStart(2, '0')
    el.sync.textContent = `同步 ${mm}:${ss}`
    el.sync.disabled = true
    el.sync.title = '刚同步过，稍后再试'
    return
  }
  el.sync.textContent = '同步'
  el.sync.disabled = false
  el.sync.title = '同步你在豆瓣的标记'
}

// ---------------------------------------------------------------- 渲染

function render() {
  renderToast()
  renderTabs()
  renderStage()
  renderHistory()

  const canDraw = !currentPending() && !state.needsSetup && !state.blocking && !state.syncing
  el.actions.hidden = !canDraw
  el.draw.disabled = state.drawing
  el.draw.textContent = '抽一个'
  updateSyncButton()
}

function renderToast() {
  if (state.toast) {
    el.toast.hidden = false
    el.toast.textContent = state.toast
  } else {
    el.toast.hidden = true
    el.toast.textContent = ''
  }
}

function renderTabs() {
  const counts = countByCategory()
  for (const tab of el.tabs) {
    const cat = tab.dataset.cat
    const on = cat === state.active
    tab.classList.toggle('active', on)
    tab.setAttribute('aria-selected', String(on))
    const badge = tab.querySelector('.tab-count')
    badge.textContent = counts[cat] ? String(counts[cat]) : ''
  }
}

function renderStage() {
  const stage = el.stage
  const pending = currentPending()

  if (state.needsSetup) {
    cardRefs = null
    stage.replaceChildren(setupView())
    return
  }

  if (state.blocking) {
    cardRefs = null
    stage.replaceChildren(errorView(state.blocking))
    return
  }

  if (pending) {
    const { el: card, refs } = cardView(pending)
    cardRefs = refs
    const row = document.createElement('div')
    row.className = 'skip-row'

    if (canSkip(state.records, state.active)) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'link'
      btn.textContent = skipArmed ? '确认跳过这一部？' : '不想看？跳过这一部（今天还剩 1 次）'
      btn.addEventListener('click', skip)
      row.append(btn)
    } else {
      const note = document.createElement('span')
      note.className = 'skip-note'
      note.textContent = '今天已经跳过 1 次了，明天再来。'
      row.append(note)
    }

    stage.replaceChildren(card, row)
    ensureIntro(pending)
    return
  }

  cardRefs = null

  if (state.syncing && countByCategory()[state.active] === 0) {
    const skeleton = document.createElement('div')
    skeleton.className = 'skeleton'
    stage.replaceChildren(skeleton)
    return
  }

  stage.replaceChildren(placeholderView())
}

function errorView(notice) {
  const wrap = document.createElement('div')
  wrap.className = 'placeholder'

  const title = document.createElement('strong')
  title.textContent = '暂时抽不了'
  const hint = document.createElement('span')
  hint.textContent = notice.text
  wrap.append(title, hint)

  if (notice.action) {
    const row = document.createElement('div')
    row.className = 'actions-row'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ghost'
    btn.textContent = notice.action.label
    btn.addEventListener('click', () => runNoticeAction(notice.action.kind))
    row.append(btn)
    wrap.append(row)
  }
  return wrap
}

function setupView() {
  const wrap = document.createElement('div')
  wrap.className = 'placeholder'

  const title = document.createElement('strong')
  title.textContent = '先告诉我在哪儿找你'
  const hint = document.createElement('span')
  const base = '没能自动识别。请先在豆瓣网页登录，或直接粘贴个人主页地址。'
  hint.textContent = state.probeReason ? `${base}（${state.probeReason}）` : base

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
      state.toast = '这个地址里没有找到用户 ID。'
      render()
      return
    }
    state.needsSetup = false
    state.toast = null
    await send({ type: UI.SET_UID, uid })
    state.settings.uid = uid
    await runSync({ force: true })
  })

  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'link'
  retry.textContent = '再自动识别一次'
  retry.addEventListener('click', async () => {
    retry.disabled = true
    await detectUid()
    render()
  })

  wrap.append(title, hint, form, retry)
  queueMicrotask(() => input.focus())
  return wrap
}

function parseUid(value) {
  const trimmed = (value || '').trim()
  if (!trimmed) return ''
  const m = /\/people\/([^/?#\s]+)/.exec(trimmed)
  if (m) return m[1]
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
  } else if (countByCategory()[state.active] === 0) {
    title.textContent = '这一类还没有候选'
    hint.textContent = '点右上角「同步」拉一次，或者去豆瓣标记一些。'
  } else {
    const n = countByCategory()[state.active]
    title.textContent = '准备好了'
    hint.textContent = `从 ${n} ${CATEGORY_UNIT[state.active]}里抽一个。`
  }

  wrap.append(title, hint)
  return wrap
}

function countByCategory() {
  const counts = { movie: 0, tv: 0, book: 0 }
  for (const entry of Object.values(state.caches)) {
    counts.movie += entry?.byCategory?.movie ?? 0
    counts.tv += entry?.byCategory?.tv ?? 0
    counts.book += entry?.byCategory?.book ?? 0
  }
  return counts
}

// ---------------------------------------------------------------- 卡片

function cardView(record) {
  const card = document.createElement('article')
  card.className = 'card'

  const cover = document.createElement('div')
  cover.className = 'card-cover'
  if (record.coverUrl) {
    const img = document.createElement('img')
    img.src = record.coverUrl
    img.alt = record.title
    img.loading = 'lazy'
    img.addEventListener('error', () => cover.replaceChildren(noCover(record.category)))
    cover.append(img)
  } else {
    cover.append(noCover(record.category))
  }

  const body = document.createElement('div')
  body.className = 'card-body'

  const title = document.createElement('h2')
  title.className = 'card-title'
  title.textContent = record.title

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  const pill = document.createElement('span')
  pill.className = 'pill'
  pill.textContent = CATEGORY_LABEL[record.category] ?? '条目'
  meta.append(pill)
  if (record.year) meta.append(tag(record.year))
  if (typeof record.doubanRating === 'number') {
    const score = document.createElement('span')
    score.className = 'rating-douban'
    score.textContent = `豆瓣 ${record.doubanRating.toFixed(1)}`
    meta.append(score)
  }

  body.append(title, meta)

  if (record.subtitle) {
    const sub = document.createElement('p')
    sub.className = 'subtitle'
    sub.textContent = record.subtitle
    body.append(sub)
  }

  const introSlot = document.createElement('div')
  introSlot.className = 'intro-wrap'
  body.append(introSlot)

  if (typeof record.myRating === 'number' || record.myComment) {
    const divider = document.createElement('div')
    divider.className = 'divider'
    body.append(divider)

    const mine = document.createElement('div')
    mine.className = 'my'
    if (typeof record.myRating === 'number') {
      const stars = document.createElement('div')
      stars.className = 'my-rating'
      stars.textContent = '★'.repeat(record.myRating) + '☆'.repeat(Math.max(0, 5 - record.myRating))
      mine.append(stars)
    }
    if (record.myComment) {
      const comment = document.createElement('p')
      comment.className = 'my-comment'
      comment.textContent = `「${record.myComment}」`
      mine.append(comment)
    }
    body.append(mine)
  }

  const foot = document.createElement('div')
  foot.className = 'card-foot'
  const source = document.createElement('span')
  source.className = 'source'
  source.textContent = `来自「${markLabel(record)}」`
  const open = document.createElement('button')
  open.type = 'button'
  open.textContent = '去豆瓣看看'
  open.addEventListener('click', () => chrome.tabs.create({ url: record.url }))
  foot.append(source, open)
  body.append(foot)

  card.append(cover, body)
  return { el: card, refs: { introSlot } }
}

function markLabel(record) {
  const book = record.category === 'book'
  switch (record.markStatus) {
    case 'doing':
      return book ? '在读' : '在看'
    case 'done':
      return book ? '读过' : '看过'
    default:
      return book ? '想读' : '想看'
  }
}

function stateLabel(record) {
  const book = record.category === 'book'
  switch (record.state) {
    case 'done':
      return book ? '读过' : '看过'
    case 'skipped':
      return '跳过'
    default:
      return book ? '待读' : '待看'
  }
}

function noCover(category) {
  const div = document.createElement('div')
  div.className = 'no-cover'
  const glyph = document.createElement('span')
  glyph.className = 'glyph'
  glyph.textContent = category === 'book' ? '书' : '影'
  const text = document.createElement('span')
  text.textContent = '暂无封面'
  div.append(glyph, text)
  return div
}

function tag(text) {
  const span = document.createElement('span')
  span.textContent = text
  return span
}

// ---------------------------------------------------------------- 记录

function renderHistory() {
  const list = el.historyList
  list.replaceChildren()

  // 记录是共用的：三个类别抽过的都在这里，按时间倒序
  const rows = state.records.slice(-30).reverse()

  if (!rows.length) {
    const li = document.createElement('li')
    li.className = 'empty-line'
    li.textContent = '还没有抽过。'
    list.append(li)
    return
  }

  for (const record of rows) {
    const li = document.createElement('li')

    const dot = document.createElement('span')
    dot.className = `dot ${record.category}`

    const main = document.createElement('div')
    main.className = 'row-main'

    const title = document.createElement('button')
    title.type = 'button'
    title.className = 'row-title'
    title.textContent = record.title
    title.title = record.title
    if (record.url) title.addEventListener('click', () => chrome.tabs.create({ url: record.url }))

    const sub = document.createElement('span')
    sub.className = 'row-sub'
    sub.textContent = `${CATEGORY_LABEL[record.category] ?? '条目'} · ${formatTime(record.drawnAt)}`

    main.append(title, sub)

    const chip = document.createElement('span')
    chip.className = `state state-${record.state}`
    chip.textContent = stateLabel(record)

    li.append(dot, main, chip)
    list.append(li)
  }
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mo}-${dd} ${hh}:${mm}`
}

// ---------------------------------------------------------------- 事件

for (const tab of el.tabs) {
  tab.addEventListener('click', async () => {
    if (tab.dataset.cat === state.active) return
    state.active = tab.dataset.cat
    state.introKey = null
    state.intro = ''
    state.introExpanded = false
    state.blocking = null
    state.toast = null
    skipArmed = false
    render()
    await send({ type: UI.SET_CATEGORY, category: state.active })
  })
}

el.draw.addEventListener('click', draw)
el.sync.addEventListener('click', () => runSync({ force: true }))

el.resetAccount.addEventListener('click', async () => {
  await send({ type: UI.SET_UID, uid: '' })
  state.settings.uid = ''
  state.toast = null
  state.blocking = null
  state.probeReason = null
  state.needsSetup = false
  render()
  await detectUid()
  render()
})

let clearArmed2 = false
el.clearHistory.addEventListener('click', async () => {
  if (!clearArmed2) {
    clearArmed2 = true
    el.clearHistory.textContent = '确认清空？'
    setTimeout(() => {
      clearArmed2 = false
      el.clearHistory.textContent = '清空'
    }, 3000)
    return
  }
  clearArmed2 = false
  el.clearHistory.textContent = '清空'
  const res = await send({ type: UI.CLEAR_HISTORY })
  if (res?.ok) state.records = res.records ?? []
  render()
})

el.help.addEventListener('click', () => {
  el.helpPanel.hidden = false
})
el.helpClose.addEventListener('click', () => {
  el.helpPanel.hidden = true
})
el.helpPanel.addEventListener('click', (event) => {
  if (event.target === el.helpPanel) el.helpPanel.hidden = true
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') el.helpPanel.hidden = true
})

async function runNoticeAction(kind) {
  if (kind === 'login') {
    chrome.tabs.create({ url: LOGIN_URL })
    return
  }
  if (kind === 'clear') {
    const res = await send({ type: UI.CLEAR_HISTORY })
    if (res?.ok) state.records = res.records ?? []
    state.blocking = null
    render()
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === SW_EVENT.SYNC_PROGRESS) {
    state.progress = { fetched: message.fetched ?? 0, total: message.total ?? 0 }
    state.syncing = true
    if (!currentPending() && !state.blocking) renderStage()
    el.actions.hidden = true
    el.sync.disabled = true
    return
  }
  if (message?.type === SW_EVENT.SYNC_FINISHED) {
    state.syncing = false
    state.progress = null
    if (message.result?.error) applyError(message.result.error)
    refreshState().then(() => render())
  }
})

boot()
