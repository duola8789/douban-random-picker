/**
 * 侧边栏界面。
 *
 * 三个类别各是一个页签，抽取、待看、记录都按类别独立。
 * 只负责展示与发消息；长任务都在 content script / service worker 里。
 */

import { UI, SW_EVENT } from '../lib/messages.js'
import { allDimensionKeys, isFresh } from '../lib/cache.js'
import { pendingFor, canSkip, skipsLeft } from '../lib/history.js'
import { CATEGORY_LABEL, CATEGORY_UNIT, sourceTag, stateTag, renderTag } from '../lib/labels.js'

/** 抽取按钮：统一叫「开始吧」，正好接住 slogan 的后半句 */
const DRAW_LABEL = '开始吧'

/** 提示语里的量词：挑一部 / 挑一本 */
const DRAW_UNIT = { movie: '一部', tv: '一部', book: '一本' }
const COUNT_UNIT = { movie: '部', tv: '部', book: '本' }

const $ = (sel) => document.querySelector(sel)

const el = {
  stage: $('#stage'),
  draw: $('#draw'),
  actions: $('#actions'),
  pendingActions: $('#pending-actions'),
  openDouban: $('#open-douban'),
  skip: $('#skip'),
  sync: $('#sync'),
  tabs: [...document.querySelectorAll('.tab')],
  historyList: $('#history-list'),
  historyCount: $('#history-count'),
  backdrop: $('#backdrop'),
  clearHistory: $('#clear-history'),
  viewAll: $('#view-all'),
  resetAccount: $('#reset-account'),
  toast: $('#toast'),
  help: $('#help'),
  helpPanel: $('#help-panel'),
  confirmPanel: $('#confirm-panel'),
  confirmTitle: $('#confirm-title'),
  confirmText: $('#confirm-text'),
  confirmOk: $('#confirm-ok'),
  confirmCancel: $('#confirm-cancel'),
  helpClose: $('#help-close'),
}

const state = {
  settings: null,
  caches: {},
  records: [],
  active: 'movie',
  intro: '',
  introLoading: false,
  detailKey: null,
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

/** 侧边栏只展示最近几条，完整列表在独立页面 */
const RECENT_IN_PANEL = 3

/** 记录没变化时跳过重建，避免切页签时整列闪一下 */
let historySignature = null

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

  const startedAt = Date.now()
  const res = await send({ type: UI.PICK, category: state.active })

  if (!res?.ok) {
    state.drawing = false
    applyError(res?.error, '抽取')
    render()
    return
  }

  if (Array.isArray(res.records)) state.records = res.records

  // 结果已经定了，详情请求不必等动画结束——和动画并行跑
  const pendingDetail = prefetchDetail(res.record)

  // 动画时长与 .rolling img 的 animation-duration 保持一致
  const minDuration = 3000
  const elapsed = Date.now() - startedAt
  if (elapsed < minDuration) await new Promise((r) => setTimeout(r, minDuration - elapsed))
  await pendingDetail

  state.drawing = false
  state.detailKey = null
  state.intro = ''
  render()
}

/**
 * 抽中后立刻预取详情（简介、出版信息），趁动画在播。
 * 卡片出现时数据已就位，不用再等一两百毫秒。
 */
async function prefetchDetail(record) {
  if (!record) return
  const res = await send({
    type: UI.DETAIL,
    subjectId: record.subjectId,
    category: record.category,
  })
  const patch = detailPatch(res?.detail ?? {})
  if (!Object.keys(patch).length) return
  patch.detailAt = Date.now()

  const target = state.records.find((r) => r.key === record.key)
  if (target) Object.assign(target, patch)
  send({ type: UI.SAVE_DETAIL, key: record.key, patch })
}

function skip(event) {
  if (event?.currentTarget?.getAttribute('aria-disabled') === 'true') return
  const pending = currentPending()
  if (!pending) return
  if (!canSkip(state.records, state.active)) return

  openConfirm({
    title: '不想看它？',
    text: `今天只能给你一次重新选「${CATEGORY_LABEL[state.active] ?? '条目'}」的机会哦`,
    okLabel: '真不想看',
    onOk: () => doSkip(pending.key),
  })
}

async function doSkip(key) {
  const res = await send({ type: UI.SKIP, key })
  if (!res?.ok) {
    if (res?.error) applyError(res.error, '跳过')
    render()
    return
  }

  state.records = res.records ?? state.records
  state.detailKey = null
  state.intro = ''
  render()

  // 跳过的目的就是再挑一部。额度已经用完一次，这里直接续抽；
  // 若这一类的候选也空了，draw() 会给出对应的提示。
  await draw()
}

/**
 * 补简介。
 *
 * 简介不在收藏接口里，只能单独请求详情。取到之后写回记录并保存在本地，
 * 所以切换页签、关掉侧边栏再打开都不会重复请求。
 */
function ensureDetail(record) {
  if (!record || state.detailKey === record.key) return
  state.detailKey = record.key

  // 用显式标记判断，而不是「有没有简介」：老记录可能拿过简介但没有出版信息
  const hasDetail = Boolean(record.detailAt)
  if (hasDetail) {
    state.intro = record.intro ?? ''
    state.introLoading = false
    fillIntro()
    return
  }

  state.intro = ''
  state.introLoading = true
  fillIntro()

  const key = record.key
  send({ type: UI.DETAIL, subjectId: record.subjectId, category: record.category }).then((res) => {
    if (state.detailKey !== key) return

    const detail = res?.detail ?? {}
    state.introLoading = false
    state.intro = typeof detail.intro === 'string' ? detail.intro.trim() : ''
    fillIntro()

    const patch = detailPatch(detail)
    patch.detailAt = Date.now()
    if (Object.keys(patch).length <= 1) return

    const target = state.records.find((r) => r.key === key)
    if (target) {
      Object.assign(target, patch)
      // 出版信息到位后就地补上，不重放整张卡片的动画
      if (cardRefs?.infoSlot) fillInfoInto(cardRefs.infoSlot, target)
    }
    send({ type: UI.SAVE_DETAIL, key, patch })
  })
}

/** 详情响应里可以写回记录的字段 */
function detailPatch(detail) {
  const patch = {}
  if (detail.intro) patch.intro = detail.intro
  if (detail.author) patch.author = detail.author
  if (detail.translator) patch.translator = detail.translator
  if (detail.press) patch.press = detail.press
  if (detail.pubdate) patch.bookPubdate = detail.pubdate
  if (detail.pages) patch.pages = detail.pages
  return patch
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
    // 没有简介时整块下半部分收起来，避免留一条空白
    if (cardRefs.body) cardRefs.body.hidden = true
    return
  }
  slot.hidden = false
  if (cardRefs.body) cardRefs.body.hidden = false

  // 豆瓣简介用单个换行分段，拆成真正的段落，段间才有间距
  const paragraphs = state.intro
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const text of paragraphs.length ? paragraphs : [state.intro]) {
    const p = document.createElement('p')
    p.className = 'intro'
    p.textContent = text
    slot.append(p)
  }

  syncScrollFade()
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
      return { text: '这一部还没了结。看完它，或者点「不想看它」。', blocking: false }
    case 'SKIP_LIMIT':
      return {
        text: `今天已经把「${CATEGORY_LABEL[state.active] ?? '条目'}」的额度用完了，明天再来。`,
        blocking: false,
      }
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
  syncScrollFade()
}

/** 卡片内容超出时，底部渐隐，避免文字直接切在卡片底边上 */
function syncScrollFade() {
  requestAnimationFrame(() => {
    const card = el.stage.querySelector('.card')
    if (!card) return
    const body = card.querySelector('.card-body')
    const overflows =
      card.scrollHeight > card.clientHeight + 2 ||
      (body && body.scrollHeight > body.clientHeight + 2)
    card.classList.toggle('is-scrollable', Boolean(overflows))
  })
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
  el.sync.disabled = false
}

// ---------------------------------------------------------------- 渲染

function render() {
  renderToast()
  renderTabs()
  renderHistoryCount()
  renderStage()
  renderHistory()
  renderActions()
  updateSyncButton()
}

function renderActions() {
  const pending = currentPending()
  el.draw.hidden = Boolean(pending)
  el.pendingActions.hidden = !pending

  el.draw.disabled =
    state.syncing || state.drawing || state.needsSetup || Boolean(state.blocking)
  el.draw.textContent = DRAW_LABEL

  if (pending) {
    const allowed = canSkip(state.records, state.active)
    el.openDouban.disabled = false
    // 用 aria-disabled 而不是 disabled：原生禁用态下浏览器会接管光标，样式管不住
    el.skip.classList.toggle('is-disabled', !allowed)
    el.skip.setAttribute('aria-disabled', String(!allowed))
    el.pendingActions.classList.toggle('is-locked', !allowed)
    const left = skipsLeft(state.records, state.active)
    el.skip.textContent = allowed ? `不想看它（还剩 ${left} 次）` : '今天就它了'
  }
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

  if (state.drawing) {
    cardRefs = null
    stage.replaceChildren(rollingView())
    return
  }

  if (pending) {
    const { el: card, refs } = cardView(pending)
    cardRefs = refs
    updateBackdrop(pending.coverUrl)
    stage.replaceChildren(card)
    // 卡片是新建的，简介总要重新铺一次；但只有没缓存时才发请求
    if (state.detailKey === pending.key) fillIntro()
    else ensureDetail(pending)
    return
  }

  cardRefs = null
  updateBackdrop('')

  if (state.syncing && countByCategory()[state.active] === 0) {
    const skeleton = document.createElement('div')
    skeleton.className = 'skeleton'
    stage.replaceChildren(skeleton)
    return
  }

  stage.replaceChildren(placeholderView())
}

let backdropUrl = null

/** 背景用封面主色调，而不是模糊图：竖版海报在两侧只会剩一块认不出的色斑 */
function updateBackdrop(url) {
  if (!el.backdrop) return

  if (!url) {
    backdropUrl = null
    el.backdrop.classList.remove('on')
    return
  }

  backdropUrl = url
  el.backdrop.classList.add('on')

  send({ type: UI.COVER_COLOR, url }).then((res) => {
    if (backdropUrl !== url) return
    if (res?.color) document.documentElement.style.setProperty('--backdrop-color', res.color)
  })
}

/** 抽取中的掷骰动画 */
function rollingView() {
  const wrap = document.createElement('div')
  wrap.className = 'rolling'

  const img = document.createElement('img')
  img.src = '../../icons/icon128.png'
  img.alt = ''
  img.width = 64
  img.height = 64
  wrap.append(img)

  return wrap
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
    title.textContent = '这一类还空着'
    hint.textContent = `点右上角同步拉一次，或者先去豆瓣添几${COUNT_UNIT[state.active]}。`
  } else {
    const n = countByCategory()[state.active]
    title.textContent = '少一点选择，多一点开始'
    hint.textContent = `${n} ${CATEGORY_UNIT[state.active]}，挑${DRAW_UNIT[state.active]}开始。`
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

  // 上半部分：左海报、右基本信息（参考豆瓣条目页）
  const head = document.createElement('div')
  head.className = 'card-head'

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

  const info = document.createElement('div')
  info.className = 'card-info'

  const title = document.createElement('h2')
  title.className = 'card-title'
  title.textContent = record.title

  // 类别不再显示：当前页签已经说明了是哪一类
  const meta = document.createElement('div')
  meta.className = 'card-meta'
  if (record.year) meta.append(tag(record.year))
  if (typeof record.doubanRating === 'number') {
    const score = document.createElement('span')
    score.className = 'rating-douban'
    score.textContent = `豆瓣 ${record.doubanRating.toFixed(1)}`
    meta.append(score)
  }
  info.append(title, meta)

  const infoSlot = document.createElement('div')
  infoSlot.className = 'info-body'
  info.append(infoSlot)
  fillInfoInto(infoSlot, record)

  // 我的标记：右栏底部的批注块
  const hasMine =
    typeof record.myRating === 'number' || Boolean(record.myComment) || Boolean(record.markedOn)
  if (hasMine) {
    const mine = document.createElement('div')
    mine.className = 'my-mark'

    const eyebrow = document.createElement('div')
    eyebrow.className = 'my-mark-eyebrow'
    // 来源和标记时间都是「我」和这部片子的关系，放在一起
    eyebrow.textContent = ['我的标记', `来自「${sourceTag(record).label}」`, record.markedOn]
      .filter(Boolean)
      .join(' · ')
    mine.append(eyebrow)

    if (typeof record.myRating === 'number') {
      const stars = document.createElement('div')
      stars.className = 'my-rating'
      stars.textContent = '★'.repeat(record.myRating) + '☆'.repeat(Math.max(0, 5 - record.myRating))
      mine.append(stars)
    }

    const comment = document.createElement('p')
    if (record.myComment) {
      comment.className = 'my-comment'
      comment.textContent = record.myComment
      comment.title = record.myComment
    } else {
      // 用户没写评语时放一句自己的话，署名区分来源
      comment.className = 'my-comment is-placeholder'
      comment.textContent = '「少一点选择，多一点开始。」'
    }
    mine.append(comment)

    info.append(mine)
  }

  head.append(cover, info)

  // 下半部分：简介横跨整张卡片
  const body = document.createElement('div')
  body.className = 'card-body'

  const introSlot = document.createElement('div')
  introSlot.className = 'intro-wrap'
  body.append(introSlot)

  card.append(head, body)
  return { el: card, refs: { introSlot, infoSlot, body } }
}

/** 右侧的结构化信息行；图书走出版信息，电影走演职员 */
function infoRows(record) {
  const rows = []

  if (record.category === 'book') {
    if (record.author) rows.push(['作者', record.author])
    if (record.translator) rows.push(['译者', record.translator])
    if (record.press) rows.push(['出版社', record.press])
    const year = record.bookPubdate || record.pubdate
    if (year) rows.push(['出版年', year])
    if (record.pages) rows.push(['页数', record.pages])
    return rows
  }

  if (record.directors) rows.push(['导演', record.directors])
  if (record.actors) rows.push(['主演', record.actors])
  if (record.genres) rows.push(['类型', record.genres])
  if (record.pubdate) rows.push([record.category === 'tv' ? '首播' : '上映', record.pubdate])
  return rows
}

function fillInfoInto(slot, record) {
  slot.replaceChildren()

  const rows = infoRows(record)
  if (rows.length) {
    const list = document.createElement('div')
    list.className = 'info-rows'
    for (const [label, value] of rows) {
      const k = document.createElement('span')
      k.className = 'info-label'
      k.textContent = label
      const v = document.createElement('span')
      v.className = 'info-value'
      v.textContent = value
      list.append(k, v)
    }
    slot.append(list)
    syncScrollFade()
    return
  }

  if (record.subtitle) {
    const sub = document.createElement('p')
    sub.className = 'subtitle'
    sub.textContent = record.subtitle
    slot.append(sub)
  }
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

function renderHistoryCount() {
  const total = state.records.length
  el.historyCount.textContent = total ? `最近 ${Math.min(RECENT_IN_PANEL, total)} 条` : ''
}

function renderHistory() {
  const rows = state.records.slice(-RECENT_IN_PANEL).reverse()
  const signature = rows.map((r) => `${r.key}:${r.state}:${r.drawnAt}`).join('|')

  if (signature === historySignature) return
  historySignature = signature

  const list = el.historyList
  list.replaceChildren()

  if (!rows.length) {
    const li = document.createElement('li')
    li.className = 'empty-line'
    li.textContent = '还没开始过。'
    list.append(li)
    return
  }

  for (const record of rows) {
    const li = document.createElement('li')

    if (record.url) {
      li.classList.add('clickable')
      li.tabIndex = 0
      li.setAttribute('role', 'link')
      const open = () => chrome.tabs.create({ url: record.url })
      li.addEventListener('click', open)
      li.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      })
    }

    const dot = document.createElement('span')
    dot.className = `dot ${record.category}`

    const main = document.createElement('div')
    main.className = 'row-main'

    const title = document.createElement('span')
    title.className = 'row-title'
    title.textContent = record.title
    title.title = record.title

    const sub = document.createElement('span')
    sub.className = 'row-sub'
    // 来源写进副标题，避免和状态标签并排后分不清
    sub.textContent = [CATEGORY_LABEL[record.category] ?? '条目', `来自${sourceTag(record).label}`, formatTime(record.drawnAt)]
      .filter(Boolean)
      .join(' · ')

    main.append(title, sub)

    const tags = document.createElement('span')
    tags.className = 'tag-row'
    tags.append(renderTag(stateTag(record)))

    li.append(dot, main, tags)
    if (record.url) {
      const arrow = document.createElement('span')
      arrow.className = 'row-arrow'
      arrow.textContent = '↗'
      li.append(arrow)
    }
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
    state.blocking = null
    state.toast = null
    render()
    await send({ type: UI.SET_CATEGORY, category: state.active })
  })
}

el.draw.addEventListener('click', draw)
el.sync.addEventListener('click', () => runSync({ force: true }))
el.skip.addEventListener('click', skip)

el.openDouban.addEventListener('click', () => {
  const pending = currentPending()
  if (pending?.url) chrome.tabs.create({ url: pending.url })
})

el.viewAll.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/history/index.html') })
})

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

el.clearHistory.addEventListener('click', () => {
  openConfirm({
    title: '清空记录？',
    text: '已经处理过的记录都会消失。待看的那一部会保留——否则清空就成了重新抽的后门。',
    okLabel: '清空',
    onOk: async () => {
      const res = await send({ type: UI.CLEAR_HISTORY })
      if (res?.ok) state.records = res.records ?? []
      historySignature = null
      render()
    },
  })
})

// ---------------------------------------------------------------- 确认弹窗

let confirmAction = null

function openConfirm({ title, text, okLabel, onOk }) {
  confirmAction = onOk
  el.confirmTitle.textContent = title
  el.confirmText.textContent = text
  el.confirmOk.textContent = okLabel
  el.confirmPanel.hidden = false
  queueMicrotask(() => el.confirmCancel.focus())
}

function closeConfirm() {
  confirmAction = null
  el.confirmPanel.hidden = true
}

el.confirmCancel.addEventListener('click', closeConfirm)
el.confirmPanel.addEventListener('click', (event) => {
  if (event.target === el.confirmPanel) closeConfirm()
})
el.confirmOk.addEventListener('click', async () => {
  const action = confirmAction
  closeConfirm()
  if (action) await action()
})

el.help.addEventListener('click', () => {
  el.helpPanel.hidden = false
})

// dev-only:start
// 本地构建在标题上标出来，避免和生产包混淆
const brandTitle = document.querySelector('.brand h1')
if (brandTitle) brandTitle.textContent = '豆瓣随机-local'
document.title = '豆瓣随机-local'

const devSection = $('#dev-section')
if (devSection) devSection.hidden = false

// 全部重置：连账号一起清掉，刷新后会重新探测登录
$('#reset-all')?.addEventListener('click', () => {
  el.helpPanel.hidden = true
  openConfirm({
    title: '重置全部数据？',
    text: 'uid、缓存、记录、封面配色都会清空，回到全新安装的状态。',
    okLabel: '重置',
    onOk: async () => {
      await chrome.storage.local.clear()
      location.reload()
    },
  })
})

// 业务数据：只清同步结果与记录，保留账号
$('#reset-data')?.addEventListener('click', () => {
  el.helpPanel.hidden = true
  openConfirm({
    title: '重置业务数据？',
    text: '缓存、抽取记录、封面配色会清空，账号保留，不用重新登录。',
    okLabel: '重置',
    onOk: async () => {
      await chrome.storage.local.set({ caches: {}, records: [], coverColors: {} })
      location.reload()
    },
  })
})
// dev-only:end
el.helpClose.addEventListener('click', () => {
  el.helpPanel.hidden = true
})
el.helpPanel.addEventListener('click', (event) => {
  if (event.target === el.helpPanel) el.helpPanel.hidden = true
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (!el.confirmPanel.hidden) closeConfirm()
  else el.helpPanel.hidden = true
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
    historySignature = null
    render()
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === SW_EVENT.SYNC_PROGRESS) {
    state.progress = { fetched: message.fetched ?? 0, total: message.total ?? 0 }
    state.syncing = true
    if (!currentPending() && !state.blocking) renderStage()
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
