/**
 * 候选池页。
 *
 * 这里不是一个「抽过什么」的记录页，而是候选集的编辑器：
 * 勾选 = 会参与抽取，取消勾选并保存 = 移出候选池。
 *
 * 来源可以按需加载：第一次勾上另一半时会从豆瓣拉一次，加载后这些条目
 * 直接进入候选池。底层的「移出」仍然记在本地 hidden 集合里，不写豆瓣。
 */

import { UI, SW_EVENT } from '../lib/messages.js'
import { CATEGORY_LABEL, sourceTag } from '../lib/labels.js'
import { sourceOf, SCOPE_LABEL } from '../lib/scope.js'

/** 超过这个数量才启用渲染虚拟化；几百条不需要，开了反而会让滚动条与鼠标脱节 */
const LONG_LIST_THRESHOLD = 800

const $ = (sel) => document.querySelector(sel)

const el = {
  meta: $('#meta'),
  tabs: [...document.querySelectorAll('.tab')],
  filterSource: $('#filter-source'),
  scopeHint: $('#scope-hint'),
  syncStatus: $('#sync-status'),
  syncStatusText: $('#sync-status-text'),
  filterTime: $('#filter-time'),
  filterStatus: $('#filter-status'),
  filterComment: $('#filter-comment'),
  selectAll: $('#select-all'),
  invertPool: $('#invert-pool'),
  poolCount: $('#pool-count'),
  savePool: $('#save-pool'),
  list: $('#list'),
  empty: $('#empty'),
  loadPanel: $('#load-panel'),
  loadTitle: $('#load-title'),
  loadOk: $('#load-ok'),
  loadCancel: $('#load-cancel'),
  helpPanel: $('#help-panel'),
  helpOpen: $('#help'),
  helpClose: $('#help-close'),
}

const state = {
  items: { movie: [], tv: [], book: [] },
  hidden: {},
  pendingKeys: new Set(),
  active: 'movie',
  /** 查看条件，都不持久化 */
  filters: { time: '', comment: false, status: '' },
  /** 来源筛选的值：all / mark / done */
  sourceValue: 'mark',
  /** 来源筛选实际包含的来源 */
  sources: ['mark'],
  /** 已经加载过（有缓存）的来源 */
  loaded: [],
  /** 已加载来源都有完整同步结果时，才敢判断「已从豆瓣消失」 */
  complete: false,
  syncing: false,
  loadingLabel: '',
  pendingLoad: null,
  /** 未保存的勾选改动：key -> 是否放进候选池 */
  changes: new Map(),
  notice: '',
  noticeTimer: null,
  initialized: false,
}

const DAY = 24 * 60 * 60 * 1000

const ERROR_TEXT = {
  AUTH_REQUIRED: '登录状态失效了，先在豆瓣网页登录，再回来加载。',
  RATE_LIMITED: '豆瓣请求过于频繁，过一会儿再试。',
  NO_DOUBAN_TAB: '没能打开豆瓣页面，请手动打开一个豆瓣页面再试。',
  TOO_SOON: '刚同步过，稍后再试。',
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------- 数据

async function boot() {
  const res = await send({ type: UI.GET_CANDIDATES })
  if (!res?.ok) {
    el.empty.hidden = false
    el.empty.textContent = '读取候选失败，请回到侧边栏重试。'
    return
  }

  applyData(res)

  const cat = new URLSearchParams(location.search).get('cat')
  if (cat && state.items[cat]) state.active = cat

  render()
}

function applyData(res) {
  state.items = res.items ?? state.items
  state.hidden = res.hidden ?? {}
  state.pendingKeys = new Set(res.pendingKeys ?? [])
  state.loaded = Array.isArray(res.loaded) ? res.loaded : []
  state.complete = Boolean(res.complete)

  // 第一次打开：来源筛选跟随已经加载的来源；之后保留用户的选择
  if (!state.initialized) {
    state.sourceValue = defaultSourceValue(state.loaded)
    state.sources = sourcesFor(state.sourceValue)
    state.initialized = true
  } else if (sourcesFor(state.sourceValue).some((source) => !state.loaded.includes(source))) {
    state.sourceValue = defaultSourceValue(state.loaded)
    state.sources = sourcesFor(state.sourceValue)
  }
}

/** 来源下拉的三个取值 */
function sourcesFor(value) {
  return value === 'all' ? ['mark', 'done'] : [value]
}

function defaultSourceValue(loaded) {
  if (loaded.includes('mark') && loaded.includes('done')) return 'all'
  return loaded[0] ?? 'mark'
}

async function reload() {
  const res = await send({ type: UI.GET_CANDIDATES })
  if (res?.ok) applyData(res)
}

/** YYYY-MM-DD -> 本地当天零点的毫秒数 */
function dayTimestamp(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '')
  if (!m) return NaN
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

/** 查看条件。来源、时间、评论、状态都是纯查看，不改候选集。 */
function matchesFilters(item, { ignoreSource = false } = {}) {
  if (!ignoreSource && !state.sources.includes(sourceOf(item))) return false

  const { time, comment, status } = state.filters
  if (comment && !item.myComment) return false
  if (time) {
    const cutoff = Date.now() - Number(time) * DAY
    // markedOn 是 YYYY-MM-DD；按本地零点解析，避免 UTC 造成的边界差一天
    const ts = dayTimestamp(item.markedOn)
    if (Number.isNaN(ts) || ts < cutoff) return false
  }
  // 状态按已保存的池子算：未保存的取消勾选不会让行从眼前消失
  if (status === 'in' && state.hidden[item.key]) return false
  if (status === 'out' && !state.hidden[item.key]) return false
  return true
}

function visibleItems(category) {
  return (state.items[category] ?? [])
    .filter((item) => matchesFilters(item))
    .sort((a, b) => String(b.markedOn ?? '').localeCompare(String(a.markedOn ?? '')))
}

/** 移出记录里已经不在缓存中的条目（豆瓣上可能删了，也可能还没完整同步） */
function missingHidden(category) {
  const known = new Set((state.items[category] ?? []).map((item) => item.key))
  return Object.entries(state.hidden)
    .filter(([key]) => key.startsWith(`${category}:`) && !known.has(key))
    .map(([key, at]) => ({ key, at }))
    .sort((a, b) => b.at - a.at)
}

function tagLabel(item) {
  return sourceTag({ markStatus: item.status, category: item.category }).label
}

/** 勾选状态：优先看未保存的改动，再回落到持久化的 hidden 集合 */
function isIncluded(item) {
  if (state.changes.has(item.key)) return state.changes.get(item.key)
  return !state.hidden[item.key]
}

function setIncluded(item, included) {
  const persisted = !state.hidden[item.key]
  if (included === persisted) state.changes.delete(item.key)
  else state.changes.set(item.key, included)
}

// ---------------------------------------------------------------- 渲染

function render() {
  renderSourceSelect()
  renderFilters()
  renderSyncStatus()
  renderTabs()
  renderList()
}

/** 筛选控件的值以 state 为准，重置账号后也能回正 */
function renderFilters() {
  el.filterTime.value = state.filters.time
  el.filterStatus.value = state.filters.status
  el.filterComment.value = state.filters.comment ? 'yes' : ''
}

function renderSourceSelect() {
  el.filterSource.value = state.sourceValue
  el.filterSource.disabled = state.syncing
}

function renderSyncStatus() {
  if (state.syncing) {
    el.syncStatus.hidden = false
    el.syncStatus.classList.remove('is-done')
    el.syncStatusText.textContent = state.loadingLabel
      ? `正在加载 ${state.loadingLabel}…`
      : '正在同步'
    return
  }
  el.syncStatus.hidden = true
}

function renderTabs() {
  for (const tab of el.tabs) {
    const cat = tab.dataset.cat
    tab.classList.toggle('active', cat === state.active)
    tab.setAttribute('aria-selected', String(cat === state.active))
    // 页签计数跟随当前查看条件：切过去看到多少，就显示多少
    const n = visibleItems(cat).length
    tab.querySelector('.tab-count').textContent = n ? String(n) : ''
  }
}

function renderList() {
  const items = visibleItems(state.active)
  const missing = state.filters.status === 'in' ? [] : missingHidden(state.active)
  const inPool = items.filter(isIncluded).length

  el.meta.textContent = `${items.length + missing.length} 条 · 池里 ${inPool}`

  if (!items.length && !missing.length) {
    el.list.replaceChildren()
    el.empty.hidden = false
    el.empty.textContent = emptyMessage()
    updateBulk()
    return
  }

  el.empty.hidden = true
  const frag = document.createDocumentFragment()
  for (const item of items) frag.append(rowView(item))
  for (const entry of missing) frag.append(missingRow(entry))
  el.list.replaceChildren(frag)
  el.list.classList.toggle('is-long', items.length > LONG_LIST_THRESHOLD)
  updateBulk()
}

function rowView(item) {
  const row = document.createElement('div')
  row.className = 'cand'

  const pending = state.pendingKeys.has(item.key)
  const included = pending ? true : isIncluded(item)

  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = included
  box.disabled = pending || state.syncing
  box.dataset.pending = pending ? '1' : ''
  box.title = pending
    ? '这条正在待看，不能移出候选池'
    : state.syncing
      ? '正在同步，稍后再改'
      : ''
  box.addEventListener('change', () => {
    setIncluded(item, box.checked)
    row.classList.toggle('is-out', !box.checked)
    renderTabs()
    updateBulk()
  })

  const main = document.createElement('div')
  main.className = 'cand-main'

  const title = document.createElement(item.url ? 'a' : 'span')
  title.className = 'cand-title'
  title.textContent = item.title
  title.title = item.title
  if (item.url) {
    title.href = item.url
    title.target = '_blank'
    title.rel = 'noopener'
  }

  const sub = document.createElement('span')
  sub.className = 'cand-sub'
  sub.textContent = [tagLabel(item), item.markedOn, item.myComment ? `「${item.myComment}」` : '']
    .filter(Boolean)
    .join(' · ')
  sub.title = sub.textContent

  main.append(title, sub)

  row.classList.toggle('is-out', !included)
  row.append(box, main)
  return row
}

function missingRow(entry) {
  const row = document.createElement('div')
  row.className = 'cand is-out'

  const main = document.createElement('div')
  main.className = 'cand-main'

  const title = document.createElement('span')
  title.className = 'cand-title'
  title.textContent = entry.key

  const sub = document.createElement('span')
  sub.className = 'cand-sub'
  sub.textContent = state.complete
    ? `移出于 ${formatDate(entry.at)} · 已不在豆瓣的收藏里`
    : `移出于 ${formatDate(entry.at)} · 尚未完整同步，无法判断`

  main.append(title, sub)

  const actions = document.createElement('span')
  actions.className = 'cand-actions'

  // 没有完整同步的证据时不下「已消失」的结论，也就不给清除入口
  if (state.complete) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mini'
    btn.textContent = '清除'
    btn.addEventListener('click', () => unhideKeys([entry.key]))
    actions.append(btn)
  }

  row.append(main, actions)
  return row
}

/** 空列表时尽量说清楚为什么空 */
function emptyMessage() {
  if (state.filters.status === 'out') return '候选池外没有条目。'

  const all = Object.values(state.items).flat()

  if (state.filters.time && all.some((it) => !it.markedOn)) {
    return '这些条目没有标记日期，可能是旧版本同步的数据。同步一次之后再筛。'
  }

  const otherCat = Object.keys(state.items).find(
    (cat) => cat !== state.active && (state.items[cat] ?? []).some((it) => matchesFilters(it)),
  )
  if (otherCat) {
    const label = CATEGORY_LABEL[otherCat] ?? '其它类别'
    const n = (state.items[otherCat] ?? []).filter((it) => matchesFilters(it)).length
    return `这个条件下「${label}」里有 ${n} 条，切到「${label}」页签看看。`
  }

  const otherSource = state.loaded.find((source) => !state.sources.includes(source))
  if (otherSource) {
    const n = all.filter(
      (it) => sourceOf(it) === otherSource && matchesFilters(it, { ignoreSource: true }),
    ).length
    if (n) return `「${SCOPE_LABEL[otherSource]}」里有 ${n} 条，勾上这个来源就能看到。`
  }

  return '这个筛选条件下没有条目。换个条件试试。'
}

function updateBulk() {
  const selectable = visibleItems(state.active).filter((it) => !state.pendingKeys.has(it.key))

  el.selectAll.disabled = state.syncing || selectable.length === 0
  el.invertPool.disabled = state.syncing || selectable.length === 0
  el.savePool.disabled = state.syncing || state.changes.size === 0

  if (state.notice) {
    el.poolCount.textContent = state.notice
  } else if (state.changes.size) {
    el.poolCount.textContent = `未保存 ${state.changes.size} 项改动`
  } else {
    el.poolCount.textContent = ''
  }
}

/** 同步期间冻结候选池的编辑操作：列表马上会被刷新，边选边存容易乱 */
function renderLockState() {
  el.filterSource.disabled = state.syncing
  updateBulk()
  for (const box of el.list.querySelectorAll('.cand > input[type="checkbox"]')) {
    box.disabled = state.syncing || box.dataset.pending === '1'
  }
}

function formatDate(ts) {
  const d = new Date(ts)
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mo}-${dd}`
}

// ---------------------------------------------------------------- 操作

/** 保存勾选改动：新增的取消勾选 → 移出；重新勾上的 → 放回 */
async function savePool() {
  if (!state.changes.size) return

  const hide = []
  const unhide = []
  for (const [key, included] of state.changes) {
    if (included) unhide.push(key)
    else hide.push(key)
  }

  el.savePool.disabled = true
  const res = await send({ type: UI.SAVE_POOL, hide, unhide })
  if (!res?.ok) {
    state.notice =
      res?.error?.code === 'SYNCING' ? '正在同步，稍后再保存。' : '保存失败，请重试。'
    updateBulk()
    return
  }

  state.hidden = res.hidden ?? state.hidden
  state.changes.clear()
  state.notice = res.skipped?.length
    ? `已保存，${res.skipped.length} 条正在待看，没有移出`
    : '已保存'

  clearTimeout(state.noticeTimer)
  state.noticeTimer = setTimeout(() => {
    state.notice = ''
    updateBulk()
  }, 2000)

  render()
}

async function unhideKeys(keys) {
  const res = await send({ type: UI.UNHIDE_CANDIDATES, keys })
  if (!res?.ok) return

  state.hidden = res.hidden ?? state.hidden
  for (const key of keys) state.changes.delete(key)
  render()
}

// ---- 来源筛选与按需加载

function showScopeHint(text) {
  el.scopeHint.hidden = false
  el.scopeHint.textContent = text
}

function onSourceSelect() {
  const value = el.filterSource.value
  const required = sourcesFor(value)
  const missing = required.filter((source) => !state.loaded.includes(source))

  el.scopeHint.hidden = true
  el.scopeHint.textContent = ''

  // 选中的来源里还有没加载过的：先还原下拉，确认后再加载
  if (missing.length) {
    state.pendingLoad = { value, sources: missing }
    renderSourceSelect()
    openLoadPanel(missing)
    return
  }

  state.sourceValue = value
  state.sources = required
  render()
}

function openLoadPanel(sources) {
  el.loadTitle.textContent =
    sources.length === 1 ? `加载「${SCOPE_LABEL[sources[0]]}」？` : '加载另外两个来源？'
  el.loadPanel.hidden = false
  queueMicrotask(() => el.loadOk.focus())
}

function closeLoadPanel() {
  el.loadPanel.hidden = true
  state.pendingLoad = null
}

async function confirmLoad() {
  const pending = state.pendingLoad
  if (!pending) return

  closeLoadPanel()
  state.syncing = true
  state.loadingLabel =
    pending.sources.length === 1 ? SCOPE_LABEL[pending.sources[0]] : '另外两个来源'
  renderSyncStatus()
  renderLockState()

  const res = await send({ type: UI.LOAD_SOURCES, sources: pending.sources })
  state.syncing = false
  state.loadingLabel = ''

  if (!res?.ok) {
    showScopeHint('没能加载，请重试。')
    render()
    return
  }

  if (res.sync?.ok) {
    state.loaded = Array.isArray(res.loaded) ? res.loaded : state.loaded
    state.sourceValue = pending.value
    state.sources = sourcesFor(state.sourceValue)
    await reload()
    render()
    return
  }

  showScopeHint(ERROR_TEXT[res.sync?.error?.code ?? res.error?.code] ?? '加载失败，稍后再试。')
  render()
}

// ---------------------------------------------------------------- 事件

for (const tab of el.tabs) {
  tab.addEventListener('click', () => {
    if (tab.dataset.cat === state.active) return
    state.active = tab.dataset.cat
    render()
  })
}

el.filterSource.addEventListener('change', onSourceSelect)

el.filterTime.addEventListener('change', () => {
  state.filters.time = el.filterTime.value
  render()
})

el.filterStatus.addEventListener('change', () => {
  state.filters.status = el.filterStatus.value
  render()
})

el.filterComment.addEventListener('change', () => {
  state.filters.comment = el.filterComment.value === 'yes'
  render()
})

el.selectAll.addEventListener('click', () => {
  const selectable = visibleItems(state.active).filter((it) => !state.pendingKeys.has(it.key))
  for (const item of selectable) setIncluded(item, true)
  renderList()
  renderTabs()
})

el.invertPool.addEventListener('click', () => {
  const selectable = visibleItems(state.active).filter((it) => !state.pendingKeys.has(it.key))
  for (const item of selectable) setIncluded(item, !isIncluded(item))
  renderList()
  renderTabs()
})

el.savePool.addEventListener('click', savePool)

el.loadCancel.addEventListener('click', closeLoadPanel)
el.loadOk.addEventListener('click', confirmLoad)
el.loadPanel.addEventListener('click', (event) => {
  if (event.target === el.loadPanel) closeLoadPanel()
})

el.helpOpen.addEventListener('click', () => {
  el.helpPanel.hidden = false
})

el.helpClose.addEventListener('click', () => {
  el.helpPanel.hidden = true
})

el.helpPanel.addEventListener('click', (event) => {
  if (event.target === el.helpPanel) el.helpPanel.hidden = true
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (!el.loadPanel.hidden) {
    closeLoadPanel()
    return
  }
  if (!el.helpPanel.hidden) el.helpPanel.hidden = true
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === SW_EVENT.SYNC_PROGRESS) {
    state.syncing = true
    renderSyncStatus()
    renderLockState()
    return
  }
  if (message?.type === SW_EVENT.SYNC_FINISHED) {
    state.syncing = false
    state.loadingLabel = ''
    renderSyncStatus()
    reload().then(render)
    return
  }
  if (message?.type === SW_EVENT.ACCOUNT_RESET) {
    // 换账号了：旧账号的候选、改动与查看条件都不该留在页面上
    state.changes.clear()
    state.initialized = false
    state.filters = { time: '', comment: false, status: '' }
    reload().then(render)
  }
})

boot()
