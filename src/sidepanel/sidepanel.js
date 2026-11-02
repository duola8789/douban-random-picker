/**
 * 侧边栏界面。
 *
 * 三个类别各是一个页签，抽取、待看、记录都按类别独立。
 * 只负责展示与发消息；长任务都在 content script / service worker 里。
 */

import { UI, SW_EVENT } from '../lib/messages.js'
import { latestSyncedAt } from '../lib/cache.js'
import { pendingFor, canSkip } from '../lib/history.js'
import { CATEGORY_LABEL, CATEGORY_UNIT, sourceTag, stateTag, renderTag } from '../lib/labels.js'

/** 抽取按钮：统一叫「开始吧」，正好接住 slogan 的后半句 */
const DRAW_LABEL = '开始吧'

/** 提示语里的量词：挑一部 / 挑一本 */
const DRAW_UNIT = { movie: '一部', tv: '一部', book: '一本' }

const $ = (sel) => document.querySelector(sel)

const el = {
  stage: $('#stage'),
  draw: $('#draw'),
  actions: $('#actions'),
  pendingActions: $('#pending-actions'),
  markDone: $('#mark-done'),
  openDouban: $('#open-douban'),
  skip: $('#skip'),
  sync: $('#sync'),
  syncStatus: $('#sync-status'),
  syncBar: $('#sync-bar'),
  tabs: [...document.querySelectorAll('.tab')],
  historyList: $('#history-list'),
  historyCount: $('#history-count'),
  backdrop: $('#backdrop'),
  clearHistory: $('#clear-history'),
  viewAll: $('#view-all'),
  viewCandidates: $('#view-candidates'),
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
  scopePanel: $('#scope-panel'),
  scopeMark: $('#scope-mark'),
  scopeDone: $('#scope-done'),
  scopeError: $('#scope-error'),
  scopeStart: $('#scope-start'),
  scopeCancel: $('#scope-cancel'),
}

const state = {
  settings: null,
  caches: {},
  /** 各类别还能抽多少条（已减去屏蔽与本地标记完成） */
  counts: { movie: 0, tv: 0, book: 0 },
  records: [],
  active: 'movie',
  intro: '',
  introLoading: false,
  detailKey: null,
  syncing: false,
  drawing: false,
  needsSetup: false,
  toast: null,
  /** 标记完成后的一次性提示：{ text, url } */
  hint: null,
  blocking: null,
  /** 同步完成后的短暂状态：「更新完成」 */
  syncNotice: '',
  noticeTimer: null,
}

let cardRefs = null

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
  state.counts = res.counts ?? state.counts
  state.records = res.records ?? []
  state.active = res.settings?.category ?? 'movie'
  state.syncing = Boolean(res.syncing)
  render()

  // 首次使用：本地没有任何数据。先识别账号，再让用户挑一开始加载哪一半。
  const firstRun = !hasAnyCache(state.caches)
  if (firstRun) {
    if (!state.settings.uid) await detectUid()
    render()
    if (state.settings.uid) openFirstLoad()
    return
  }

  // 之后的打开只读缓存，不主动同步。想更新就点同步按钮。
  render()
}

async function detectUid() {
  const probe = await send({ type: UI.PROBE_LOGIN })
  const uid = probe?.login?.ok ? probe.login.uid : ''
  if (!uid) {
    const reason = probe?.login?.reason ?? probe?.error?.code ?? 'unknown'
    console.warn(`[豆瓣随机] 自动识别 uid 失败 reason=${reason}`, probe)
    state.needsSetup = true
    render()
    return
  }
  await send({ type: UI.SET_UID, uid })
  state.settings.uid = uid
  state.needsSetup = false
}

/** 缓存里有没有任何同步结果（含同步过但是空结果的情况） */
function hasAnyCache(caches) {
  return Object.values(caches ?? {}).some(
    (entry) => (entry?.count ?? 0) > 0 || (entry?.syncedAt ?? 0) > 0,
  )
}

async function runSync({ force = false } = {}) {
  if (state.syncing) return
  state.syncing = true
  state.syncNotice = ''
  state.blocking = null
  state.toast = null
  render()

  const res = await send({ type: UI.SYNC, force })

  state.syncing = false

  if (res?.error) applyError(res.error)
  else if (res?.ok && !res?.skipped) showSyncNotice()

  await refreshState()
  render()
  return res
}

/** 同步完成后的状态行：手动与自动都展示，自动那次不额外弹提示 */
function showSyncNotice() {
  state.syncNotice = '更新完成'
  clearTimeout(state.noticeTimer)
  state.noticeTimer = setTimeout(() => {
    state.syncNotice = ''
    // 只收起状态行，不重建舞台：待看卡片正在展示时不该被重绘
    renderSyncStatus()
  }, 2400)
}

function applyError(error, scope = '同步') {
  logFailure(scope, error)
  const notice = noticeFor(error)
  if (!notice) return
  if (notice.blocking) state.blocking = notice
  else state.toast = notice.text
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
  state.counts = res.counts ?? state.counts
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
  state.hint = null
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
    okLabel: '换一个',
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
 * 标记完成。
 *
 * 和跳过不同：不自动续抽。跳过是「现在就要换」，看完了是「这段时间结束了」，
 * 下一次抽取本来就是一个新的开始。
 */
async function markDone() {
  const pending = currentPending()
  if (!pending) return

  const res = await send({ type: UI.MARK_DONE, key: pending.key })
  if (!res?.ok) {
    if (res?.error) applyError(res.error, '标记')
    render()
    return
  }

  state.records = res.records ?? state.records
  state.detailKey = null
  state.intro = ''
  await refreshState()

  // 只对「看新」的条目提示去豆瓣标记；重温条目本来就是看过的
  state.hint =
    pending.markStatus === 'done' || !pending.url
      ? null
      : {
          text: state.active === 'book' ? '去豆瓣上标记已读过' : '去豆瓣上标记已看过',
          url: pending.url,
        }

  render()
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
    case 'AUTH_REQUIRED':
      return {
        text: '没能确认登录状态。请先在豆瓣网页登录，再回来同步。',
        highlight: '在豆瓣网页登录',
        action: { label: '打开豆瓣', kind: 'login' },
        blocking: true,
      }
    case 'NO_DOUBAN_TAB':
      return { text: '没能打开豆瓣页面。请先手动打开一个豆瓣页面，再回来同步。', blocking: true }
    case 'RATE_LIMITED':
      return { text: '豆瓣请求过于频繁，已暂停。请过一会儿再试。', blocking: false }
    case 'TOO_SOON': {
      const minutes = Math.max(1, Math.ceil((error?.retryAfterMs ?? 0) / 60000))
      return {
        text: `刚同步过，${minutes} 分钟后再来。已有的数据没有受影响。`,
        blocking: false,
      }
    }
    case 'SCOPE_EMPTY':
      return { text: '候选池至少要留一个来源。', blocking: false }
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

// ---------------------------------------------------------------- 状态

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
  if (state.syncing) {
    el.sync.textContent = '同步中'
    el.sync.disabled = true
    return
  }
  // 冷却期不把按钮变成倒计时：按钮保持可点，点了再说明还要等多久
  el.sync.textContent = '同步'
  el.sync.disabled = false
}

/** 提示文案里需要强调的短语（目前是登录指引）用加粗主色显示 */
function appendNoticeText(el, text, highlight) {
  if (!highlight || !text.includes(highlight)) {
    el.textContent = text
    return
  }
  const [before, after] = text.split(highlight)
  if (before) el.append(document.createTextNode(before))
  const strong = document.createElement('strong')
  strong.className = 'notice-strong'
  strong.textContent = highlight
  el.append(strong)
  if (after) el.append(document.createTextNode(after))
}

/** 同步状态放在同步按钮左边：空闲时是上次同步日期，同步中是进行状态。 */
function renderSyncStatus() {
  if (!el.syncStatus) return

  if (state.syncing) {
    el.syncStatus.textContent = '正在同步'
    el.syncStatus.title = ''
    if (el.syncBar) el.syncBar.hidden = false
    return
  }

  if (el.syncBar) el.syncBar.hidden = true

  if (state.syncNotice) {
    el.syncStatus.textContent = state.syncNotice
    el.syncStatus.title = ''
    return
  }

  const at = latestSyncedAt(state.caches)
  if (!at) {
    el.syncStatus.textContent = '还没同步过'
    el.syncStatus.title = ''
    return
  }

  // 顶栏空间有限：只显示到天，完整时间放进 title
  el.syncStatus.textContent = `上次同步 ${formatDay(at)}`
  el.syncStatus.title = `上次同步：${formatTime(at)}`
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
  renderSyncStatus()
}

function renderActions() {
  const pending = currentPending()
  el.draw.hidden = Boolean(pending)
  el.pendingActions.hidden = !pending

  el.draw.disabled =
    state.syncing ||
    state.drawing ||
    state.needsSetup ||
    Boolean(state.blocking)
  el.draw.textContent = DRAW_LABEL

  if (!pending) return

  const book = state.active === 'book'
  const allowed = canSkip(state.records, state.active)

  el.markDone.disabled = false
  el.markDone.querySelector('.wide-label').textContent = book ? '读完了' : '看完了'
  el.markDone.querySelector('.narrow-label').textContent = book ? '读完' : '看完'

  el.openDouban.disabled = false

  // 用 aria-disabled 而不是 disabled：原生禁用态下浏览器会接管光标，样式管不住
  el.skip.classList.toggle('is-disabled', !allowed)
  el.skip.setAttribute('aria-disabled', String(!allowed))
  el.pendingActions.classList.toggle('is-locked', !allowed)
  // 不在按钮上写剩余次数：「· 2」这种表达没人看得懂，额度用尽时按钮自己会变成「今天就它了」
  el.skip.querySelector('.wide-label').textContent = allowed ? '不想看' : '今天就它了'
  el.skip.querySelector('.narrow-label').textContent = allowed ? '跳过' : '就它了'
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
    // 掷骰期间不允许切页签：那一抽是针对当前类别的，
    // 切走会让结果落在别的页签上，用户看不到自己抽中了什么
    tab.disabled = state.drawing
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
  appendNoticeText(hint, notice.text, notice.highlight)
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
  appendNoticeText(
    hint,
    '没能自动识别你的豆瓣账号。请先在豆瓣网页登录；也可以粘贴你自己的个人主页地址——扩展只从里面取用户 ID，不会替你登录。',
    '在豆瓣网页登录',
  )

  const form = document.createElement('form')
  form.className = 'setup'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'https://www.douban.com/people/你的ID/'
  input.autocomplete = 'off'
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'primary'
  submit.textContent = '保存并继续'

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

    // 首次使用：账号刚确定，接下来先挑一开始加载哪一半
    if (!hasAnyCache(state.caches)) {
      openFirstLoad()
      render()
      return
    }

    await runSync({ force: true })
  })

  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'link'
  retry.textContent = '再自动识别一次'
  retry.addEventListener('click', async () => {
    retry.disabled = true
    await detectUid()
    if (state.settings.uid && !hasAnyCache(state.caches)) openFirstLoad()
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

/**
 * 第一次使用：挑一开始加载哪一半。
 *
 * 加载回来的条目会直接进入候选池；另一半以后可以在候选池页按需加载。
 */
function openFirstLoad() {
  el.scopeMark.checked = true
  el.scopeDone.checked = false
  el.scopeError.hidden = true
  el.scopeError.textContent = ''
  el.scopePanel.hidden = false
  queueMicrotask(() => el.scopeStart.focus())
}

function closeFirstLoad() {
  el.scopePanel.hidden = true
}

async function submitFirstLoad() {
  const sources = []
  if (el.scopeMark.checked) sources.push('mark')
  if (el.scopeDone.checked) sources.push('done')

  if (sources.length === 0) {
    el.scopeError.hidden = false
    el.scopeError.textContent = '先选一半开始，不然没有数据可抽。'
    return
  }

  closeFirstLoad()
  state.syncing = true
  state.syncNotice = ''
  state.toast = null
  render()

  const res = await send({ type: UI.LOAD_SOURCES, sources })
  state.syncing = false

  if (!res?.ok) {
    applyError(res?.error, '加载')
    render()
    return
  }

  if (res.sync?.error) applyError(res.sync.error, '加载')
  else if (res.sync?.ok && !res.sync?.skipped) showSyncNotice()

  await refreshState()
  render()
}

function placeholderView() {
  const wrap = document.createElement('div')
  wrap.className = 'placeholder'

  const title = document.createElement('strong')
  const hint = document.createElement('span')

  if (state.syncing) {
    title.textContent = '正在同步'
    hint.textContent = '正在读取你在豆瓣的标记…'
  } else if (countByCategory()[state.active] === 0) {
    title.textContent = '这一类还空着'
    hint.textContent = '候选池里还没有这一类的条目。点右上角同步一次，或者去候选池里加载另一个来源。'
  } else {
    const n = countByCategory()[state.active]
    title.textContent = '少一点选择，多一点开始'
    hint.textContent = `${n} ${CATEGORY_UNIT[state.active]}，挑${DRAW_UNIT[state.active]}开始。`
  }

  wrap.append(title, hint)

  if (!state.syncing && countByCategory()[state.active] === 0) {
    wrap.append(scopeAdjustLink())
  }
  if (state.hint) wrap.append(hintNote())
  return wrap
}

/** 池子空了，给一个能去候选池的入口，而不是让用户去猜 */
function scopeAdjustLink() {
  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'link'
  link.textContent = '打开候选池 →'
  link.addEventListener('click', () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`src/candidates/index.html?cat=${state.active}`),
    })
  })
  return link
}

/** 标记完成后的轻提示：整行就是入口，点一下去条目页，不弹窗、不自动打开 */
function hintNote() {
  const note = document.createElement('div')
  note.className = 'hint-note'

  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'link'
  link.textContent = `${state.hint.text} →`
  link.addEventListener('click', () => chrome.tabs.create({ url: state.hint.url }))

  note.append(link)
  return note
}

function countByCategory() {
  return state.counts ?? { movie: 0, tv: 0, book: 0 }
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
    // 来源和标记时间都是「我」和这部片子的关系，放在一起。
    // 看过的条目在卡片上叫「重温」——记录页那边仍然说「来自看过」。
    const origin = record.markStatus === 'done' ? '重温' : `来自「${sourceTag(record).label}」`
    eyebrow.textContent = ['我的标记', origin, record.markedOn].filter(Boolean).join(' · ')
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

/** 顶栏用：今天 / 10-28 */
function formatDay(ts) {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return '今天'
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mo}-${dd}`
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
    if (state.drawing) return
    if (tab.dataset.cat === state.active) return
    state.active = tab.dataset.cat
    state.blocking = null
    state.toast = null
    state.hint = null
    render()
    await send({ type: UI.SET_CATEGORY, category: state.active })
  })
}

el.draw.addEventListener('click', draw)
el.sync.addEventListener('click', () => {
  // 还没有任何数据时，先挑一半加载；否则就是一次普通的手动同步
  if (!hasAnyCache(state.caches)) openFirstLoad()
  else runSync({ force: true })
})
el.skip.addEventListener('click', skip)
el.markDone.addEventListener('click', markDone)

el.openDouban.addEventListener('click', () => {
  const pending = currentPending()
  if (pending?.url) chrome.tabs.create({ url: pending.url })
})

el.viewAll.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/history/index.html') })
})

el.viewCandidates.addEventListener('click', () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL(`src/candidates/index.html?cat=${state.active}`),
  })
})

el.resetAccount.addEventListener('click', () => {
  openConfirm({
    title: '更换豆瓣账号？',
    text: '先在豆瓣网页切换账号。确认后会清空旧账号在本机的缓存、候选池和记录。',
    okLabel: '继续',
    onOk: async () => {
      const res = await send({ type: UI.RESET_ACCOUNT })
      if (!res?.ok) {
        state.toast =
          res?.error?.code === 'SYNCING' ? '正在同步，稍后再试。' : '没能清空旧账号的数据，请重试。'
        render()
        return
      }

      state.settings = res.settings ?? { ...state.settings, uid: '' }
      state.caches = {}
      state.counts = { movie: 0, tv: 0, book: 0 }
      state.records = []
      state.toast = null
      state.blocking = null
      state.needsSetup = false
      state.syncNotice = ''
      state.detailKey = null
      state.intro = ''
      historySignature = null
      render()

      await detectUid()
      if (state.settings.uid && !hasAnyCache(state.caches)) openFirstLoad()
      render()
    },
  })
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

el.scopeStart.addEventListener('click', () => submitFirstLoad())
el.scopeCancel.addEventListener('click', closeFirstLoad)
el.scopePanel.addEventListener('click', (event) => {
  if (event.target === el.scopePanel) closeFirstLoad()
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
    title: '重置业务记录？',
    text: '抽取记录会清空。同步缓存保留，不会重新请求豆瓣，也不用重新登录。',
    okLabel: '重置',
    onOk: async () => {
      await chrome.storage.local.set({ records: [] })
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
  if (!el.scopePanel.hidden) closeFirstLoad()
  else if (!el.confirmPanel.hidden) closeConfirm()
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
  if (message?.type === SW_EVENT.STATE_CHANGED) {
    // 候选池页改了范围：即便不触发同步，计数与空态也要跟着变
    refreshState().then(() => render())
    return
  }
  if (message?.type === SW_EVENT.SYNC_PROGRESS) {
    // 进度数值不用，只当作「同步还在进行」的信号
    state.syncing = true
    if (!currentPending() && !state.blocking) renderStage()
    renderActions()
    updateSyncButton()
    renderSyncStatus()
    return
  }
  if (message?.type === SW_EVENT.SYNC_FINISHED) {
    state.syncing = false
    if (message.result?.error) applyError(message.result.error)
    else if (message.result?.ok && !message.result?.skipped) showSyncNotice()
    refreshState().then(() => render())
  }
})

boot()
