/**
 * 侧边栏界面。
 *
 * 只负责展示与发消息；长任务都在 content script / service worker 里，
 * 所以侧边栏关掉不会打断同步。
 */

import { UI, SW_EVENT } from '../lib/messages.js'
import { dimensionsForScopes, isFresh } from '../lib/cache.js'

const $ = (sel) => document.querySelector(sel)

const el = {
  stage: $('#stage'),
  draw: $('#draw'),
  sync: $('#sync'),
  historyList: $('#history-list'),
  clearHistory: $('#clear-history'),
  resetAccount: $('#reset-account'),
  toast: $('#toast'),
  help: $('#help'),
  helpPanel: $('#help-panel'),
  helpClose: $('#help-close'),
  scopes: [...document.querySelectorAll('.scopes input')],
}

const CATEGORY_LABEL = { movie: '电影', tv: '剧集', book: '图书' }

const state = {
  settings: null,
  caches: {},
  history: [],
  item: null,
  intro: '',
  introLoading: false,
  introExpanded: false,
  syncing: false,
  needsSetup: false,
  probeReason: null,
  toast: null,
  blocking: null,
  progress: null,
  cooldownUntil: 0,
  hasDrawn: false,
}

/** 当前卡片的 DOM 引用，用于只更新简介而不重播动画 */
let cardRefs = null
let cooldownTimer = null

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
    console.warn('[豆瓣随机] 自动识别 uid 失败', probe)
    state.probeReason = probe?.login?.reason ?? probe?.error?.code ?? 'unknown'
    state.needsSetup = true
    render()
    return
  }
  await send({ type: UI.SET_UID, uid })
  state.settings.uid = uid
  state.needsSetup = false
  state.probeReason = null
}

/** 打开侧边栏时：缓存过期就后台刷新，先用旧数据渲染 */
async function ensureFresh() {
  const wanted = dimensionsForScopes(state.settings.scopes)
  const stale = wanted.filter((key) => !isFresh(state.caches[key]))
  if (stale.length === 0) return
  await runSync({ force: false })
}

async function runSync({ force = false, all = false } = {}) {
  if (state.syncing) return
  state.syncing = true
  state.progress = null
  state.blocking = null
  state.toast = null
  render()

  const res = await send({ type: UI.SYNC, force, all })

  state.syncing = false
  state.progress = null

  if (res?.error) applyError(res.error)
  await refreshState()
  render()
  return res
}

/** 把错误分成两类：挡住整个舞台的，和只提示一下的 */
function applyError(error) {
  const notice = noticeFor(error)
  if (!notice) return

  if (notice.blocking) state.blocking = notice
  else state.toast = notice.text

  if (notice.cooldownMs) setCooldown(notice.cooldownMs)
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
  if (state.syncing) return
  state.blocking = null
  state.toast = null
  state.drawBusy = true
  render()

  const res = await send({ type: UI.PICK })
  state.drawBusy = false

  if (!res?.ok) {
    applyError(res?.error)
    render()
    return
  }

  state.item = res.item
  state.hasDrawn = true
  state.intro = ''
  state.introLoading = true
  state.introExpanded = false
  if (Array.isArray(res.history)) state.history = res.history
  render()
  loadIntro(res.item)
}

/** 抽中后补简介：收藏接口不返回 intro，要单独请求一次详情 */
async function loadIntro(item) {
  const res = await send({ type: UI.DETAIL, subjectId: item.subjectId, category: item.category })
  if (state.item?.key !== item.key) return // 已经换了新的一条

  state.introLoading = false
  state.intro = res?.detail?.intro?.trim?.() ?? ''
  fillIntro()
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

  const p = document.createElement('p')
  p.className = state.introExpanded ? 'intro' : 'intro clamped'
  p.textContent = state.intro
  slot.append(p)

  // 只有真的被截断时才显示展开按钮
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
      return {
        text: '没能打开豆瓣页面。请先手动打开一个豆瓣页面，再回来同步。',
        blocking: true,
      }
    case 'RATE_LIMITED':
      return { text: '豆瓣请求过于频繁，已暂停。请过一会儿再试。', blocking: false }
    case 'TOO_SOON':
      return {
        text: '刚同步过，稍等一会儿才能再同步。已有的数据没有受影响。',
        blocking: false,
        cooldownMs: error?.retryAfterMs ?? 0,
      }
    case 'NO_SCOPE':
      return { text: '至少选择一类才能抽。', blocking: false }
    case 'NO_CANDIDATES':
      return {
        text: '选中的范围里还没有可抽的条目。可以先同步，或去豆瓣标记一些。',
        blocking: true,
      }
    case 'POOL_EXHAUSTED':
      return {
        text: '最近的都抽过一遍了。清空历史可以重新开始。',
        action: { label: '清空历史', kind: 'clear' },
        blocking: true,
      }
    default:
      return { text: '出了点问题，请稍后重试。', blocking: false }
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
    return
  }
  if (left > 0) {
    const s = Math.ceil(left / 1000)
    const mm = Math.floor(s / 60)
    const ss = String(s % 60).padStart(2, '0')
    el.sync.textContent = `同步 ${mm}:${ss}`
    el.sync.disabled = true
    return
  }
  el.sync.textContent = '同步'
  el.sync.disabled = state.syncing
}

// ---------------------------------------------------------------- 渲染

function render() {
  renderToast()
  renderStage()
  renderHistory()
  el.draw.disabled = state.syncing || Boolean(state.drawBusy)
  el.draw.textContent = state.hasDrawn || state.item ? '再抽一个' : '抽一个'
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

function renderStage() {
  const stage = el.stage

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

  if (state.item) {
    const card = cardView(state.item)
    cardRefs = card.refs
    stage.replaceChildren(card.el)
    fillIntro()
    return
  }

  cardRefs = null

  if (state.syncing && countByCategory().total === 0) {
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
  } else {
    const counts = countByCategory()
    if (counts.total > 0) {
      title.textContent = '准备好了'
      hint.textContent = '点下面的按钮，从这些条目里抽一个。'
      wrap.append(title, hint, countsView(counts))
      return wrap
    }
    title.textContent = '还没有候选'
    hint.textContent = '点右上角「同步」拉一次你在豆瓣的标记。'
  }

  wrap.append(title, hint)
  return wrap
}

function countsView(counts) {
  const row = document.createElement('div')
  row.className = 'counts'
  for (const [cat, label] of Object.entries(CATEGORY_LABEL)) {
    const span = document.createElement('span')
    span.append(label + ' ')
    const b = document.createElement('b')
    b.textContent = String(counts[cat] ?? 0)
    span.append(b)
    row.append(span)
  }
  return row
}

function cardView(item) {
  const card = document.createElement('article')
  card.className = 'card'

  // 封面
  const cover = document.createElement('div')
  cover.className = 'card-cover'
  if (item.coverUrl) {
    const img = document.createElement('img')
    img.src = item.coverUrl
    img.alt = item.title
    img.loading = 'lazy'
    img.addEventListener('error', () => cover.replaceChildren(noCover(item.category)))
    cover.append(img)
  } else {
    cover.append(noCover(item.category))
  }

  // 正文
  const body = document.createElement('div')
  body.className = 'card-body'

  const title = document.createElement('h2')
  title.className = 'card-title'
  title.textContent = item.title

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  const pill = document.createElement('span')
  pill.className = 'pill'
  pill.textContent = CATEGORY_LABEL[item.category] ?? '条目'
  meta.append(pill)
  if (item.year) meta.append(tag(item.year))
  if (typeof item.doubanRating === 'number') {
    const score = document.createElement('span')
    score.className = 'rating-douban'
    score.textContent = `豆瓣 ${item.doubanRating.toFixed(1)}`
    meta.append(score)
  }

  body.append(title, meta)

  if (item.subtitle) {
    const sub = document.createElement('p')
    sub.className = 'subtitle'
    sub.textContent = item.subtitle
    body.append(sub)
  }

  const introSlot = document.createElement('div')
  introSlot.className = 'intro-wrap'
  body.append(introSlot)

  // 我的评分 / 短评：缺失时整块不渲染
  if (typeof item.myRating === 'number' || item.myComment) {
    const divider = document.createElement('div')
    divider.className = 'divider'
    body.append(divider)

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

  const foot = document.createElement('div')
  foot.className = 'card-foot'
  const source = document.createElement('span')
  source.className = 'source'
  source.textContent = `来自「${sourceLabel(item)}」`
  const open = document.createElement('button')
  open.type = 'button'
  open.textContent = '去豆瓣标记'
  open.addEventListener('click', () => chrome.tabs.create({ url: item.url }))
  foot.append(source, open)
  body.append(foot)

  card.append(cover, body)
  return { el: card, refs: { introSlot } }
}

function sourceLabel(item) {
  const book = item.category === 'book'
  switch (item.status) {
    case 'doing':
      return book ? '在读' : '在看'
    case 'done':
      return book ? '读过' : '看过'
    default:
      return book ? '想读' : '想看'
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
    li.append(dot, main)
    list.append(li)
  }
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `今天 ${hh}:${mm}`
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mo}-${dd} ${hh}:${mm}`
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

function syncScopeInputs() {
  for (const input of el.scopes) {
    input.checked = Boolean(state.settings?.scopes?.[input.dataset.cat])
  }
}

for (const input of el.scopes) {
  input.addEventListener('change', async () => {
    const scopes = {}
    for (const i of el.scopes) scopes[i.dataset.cat] = i.checked
    state.settings.scopes = scopes
    state.syncing = true
    render()
    const res = await send({ type: UI.SET_SCOPES, scopes })
    if (res?.settings) state.settings = { ...state.settings, ...res.settings }
    if (!res?.ok) state.syncing = false
    render()
  })
}

el.draw.addEventListener('click', draw)
el.sync.addEventListener('click', () => runSync({ force: true }))

el.resetAccount.addEventListener('click', async () => {
  await send({ type: UI.SET_UID, uid: '' })
  state.settings.uid = ''
  state.item = null
  state.hasDrawn = false
  state.toast = null
  state.blocking = null
  state.probeReason = null
  state.needsSetup = false
  render()
  await detectUid()
  render()
})

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
    await send({ type: UI.CLEAR_HISTORY })
    state.history = []
    state.blocking = null
    render()
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === SW_EVENT.SYNC_PROGRESS) {
    state.progress = { fetched: message.fetched ?? 0, total: message.total ?? 0 }
    state.syncing = true
    if (!state.item && !state.blocking) renderStage()
    el.draw.disabled = true
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
