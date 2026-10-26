/**
 * 候选池页。
 *
 * 这是「候选池」的页面，不是「抽过什么」的页面——后者是 record 页。
 * 这里的「删除」只是本地屏蔽，扩展不写豆瓣。
 */

import { UI } from '../lib/messages.js'
import { sourceTag } from '../lib/labels.js'

/** 超过这个数量才启用渲染虚拟化；几百条不需要，开了反而会让滚动条与鼠标脱节 */
const LONG_LIST_THRESHOLD = 800

const $ = (sel) => document.querySelector(sel)

const el = {
  meta: $('#meta'),
  tabs: [...document.querySelectorAll('.tab')],
  toggleHidden: $('#toggle-hidden'),
  listView: $('#list-view'),
  hiddenView: $('#hidden-view'),
  filterSource: $('#filter-source'),
  filterTime: $('#filter-time'),
  filterComment: $('#filter-comment'),
  selectAll: $('#select-all'),
  selectionCount: $('#selection-count'),
  hideSelected: $('#hide-selected'),
  hideFiltered: $('#hide-filtered'),
  list: $('#list'),
  empty: $('#empty'),
  hiddenList: $('#hidden-list'),
  hiddenEmpty: $('#hidden-empty'),
  confirmPanel: $('#confirm-panel'),
  confirmTitle: $('#confirm-title'),
  confirmText: $('#confirm-text'),
  confirmOk: $('#confirm-ok'),
  confirmCancel: $('#confirm-cancel'),
  helpPanel: $('#help-panel'),
  helpOpen: $('#help'),
  helpClose: $('#help-close'),
}

const state = {
  items: { movie: [], tv: [], book: [] },
  hidden: {},
  pendingKeys: new Set(),
  active: 'movie',
  filters: { source: '', time: '', comment: false },
  selection: new Set(),
  view: 'list',
}

const DAY = 24 * 60 * 60 * 1000

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

  state.items = res.items ?? state.items
  state.hidden = res.hidden ?? {}
  state.pendingKeys = new Set(res.pendingKeys ?? [])

  const cat = new URLSearchParams(location.search).get('cat')
  if (cat && state.items[cat]) state.active = cat

  render()
}

/** 当前类别下、经过筛选且未被屏蔽的条目，按标记时间由新到旧 */
function visibleItems(category) {
  const { source, time, comment } = state.filters
  const cutoff = time ? Date.now() - Number(time) * DAY : 0

  return (state.items[category] ?? [])
    .filter((item) => {
      if (state.hidden[item.key]) return false
      if (source && item.status !== source) return false
      if (comment && !item.myComment) return false
      if (cutoff) {
        const ts = Date.parse(item.markedOn ?? '')
        if (Number.isNaN(ts) || ts < cutoff) return false
      }
      return true
    })
    .sort((a, b) => String(b.markedOn ?? '').localeCompare(String(a.markedOn ?? '')))
}

function hasFilters() {
  return Boolean(state.filters.source || state.filters.time || state.filters.comment)
}

function tagLabel(item) {
  return sourceTag({ markStatus: item.status, category: item.category }).label
}

// ---------------------------------------------------------------- 渲染

function render() {
  const hiddenMode = state.view === 'hidden'
  el.listView.hidden = hiddenMode
  el.hiddenView.hidden = !hiddenMode
  el.toggleHidden.textContent = hiddenMode ? '返回候选' : '已屏蔽'

  renderTabs()
  if (hiddenMode) renderHidden()
  else renderList()
}

function renderTabs() {
  for (const tab of el.tabs) {
    const cat = tab.dataset.cat
    tab.classList.toggle('active', cat === state.active)
    tab.setAttribute('aria-selected', String(cat === state.active))
    const n = visibleItems(cat).length
    tab.querySelector('.tab-count').textContent = n ? String(n) : ''
  }
}

function renderList() {
  const items = visibleItems(state.active)
  const hiddenCount = Object.keys(state.hidden).length
  el.meta.textContent = `${items.length} 条${hiddenCount ? ` · 已屏蔽 ${hiddenCount}` : ''}`

  if (!items.length) {
    el.list.replaceChildren()
    el.empty.hidden = false
    el.empty.textContent = hasFilters()
      ? '这个筛选条件下没有条目。换个条件试试。'
      : '这一类还空着。回到侧边栏同步一次。'
    updateBulk()
    return
  }

  el.empty.hidden = true
  const frag = document.createDocumentFragment()
  for (const item of items) frag.append(rowView(item))
  el.list.replaceChildren(frag)
  el.list.classList.toggle('is-long', items.length > LONG_LIST_THRESHOLD)
  updateBulk()
}

function rowView(item) {
  const row = document.createElement('div')
  row.className = 'cand'

  const pending = state.pendingKeys.has(item.key)

  const box = document.createElement('input')
  box.type = 'checkbox'
  box.disabled = pending
  box.checked = state.selection.has(item.key)
  box.title = pending ? '这条正在待看，先看完或跳过它' : ''
  box.addEventListener('change', () => {
    if (box.checked) state.selection.add(item.key)
    else state.selection.delete(item.key)
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

  const actions = document.createElement('span')
  actions.className = 'cand-actions'

  const hide = document.createElement('button')
  hide.type = 'button'
  hide.className = 'mini'
  hide.textContent = '屏蔽'
  hide.disabled = pending
  hide.addEventListener('click', () => confirmHide([item.key]))
  actions.append(hide)

  row.append(box, main, actions)
  return row
}

function renderHidden() {
  const entries = Object.entries(state.hidden)
    .filter(([key]) => key.startsWith(`${state.active}:`))
    .sort((a, b) => b[1] - a[1])

  el.meta.textContent = `${entries.length} 条已屏蔽`

  if (!entries.length) {
    el.hiddenList.replaceChildren()
    el.hiddenEmpty.hidden = false
    return
  }

  el.hiddenEmpty.hidden = true
  const byKey = new Map()
  for (const item of state.items[state.active] ?? []) byKey.set(item.key, item)

  const frag = document.createDocumentFragment()
  for (const [key, at] of entries) frag.append(hiddenRow(key, at, byKey.get(key)))
  el.hiddenList.replaceChildren(frag)
}

function hiddenRow(key, at, item) {
  const row = document.createElement('div')
  row.className = 'cand'

  const main = document.createElement('div')
  main.className = 'cand-main'

  const title = document.createElement('span')
  title.className = 'cand-title'
  title.textContent = item ? item.title : key

  const sub = document.createElement('span')
  sub.className = 'cand-sub'
  sub.textContent = item
    ? `屏蔽于 ${formatDate(at)}`
    : `屏蔽于 ${formatDate(at)} · 已不在豆瓣的收藏里`

  main.append(title, sub)

  const actions = document.createElement('span')
  actions.className = 'cand-actions'

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'mini'
  btn.textContent = item ? '恢复' : '清除'
  btn.addEventListener('click', () => unhideKeys([key]))
  actions.append(btn)

  row.append(main, actions)
  return row
}

function updateBulk() {
  const selectable = visibleItems(state.active).filter((it) => !state.pendingKeys.has(it.key))
  const chosen = selectable.filter((it) => state.selection.has(it.key))

  el.selectionCount.textContent = state.selection.size ? `已选 ${state.selection.size} 项` : ''
  el.hideSelected.disabled = state.selection.size === 0
  el.hideFiltered.disabled = selectable.length === 0

  el.selectAll.checked = selectable.length > 0 && chosen.length === selectable.length
  el.selectAll.indeterminate = chosen.length > 0 && chosen.length < selectable.length
}

function formatDate(ts) {
  const d = new Date(ts)
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mo}-${dd}`
}

// ---------------------------------------------------------------- 操作

let confirmAction = null

function openConfirm({ title, text, okLabel = '确定', onOk }) {
  el.confirmTitle.textContent = title
  el.confirmText.textContent = text
  el.confirmOk.textContent = okLabel
  confirmAction = onOk
  el.confirmPanel.hidden = false
}

function closeConfirm() {
  el.confirmPanel.hidden = true
  confirmAction = null
}

function confirmHide(keys) {
  const usable = keys.filter((k) => !state.pendingKeys.has(k))
  const pending = keys.length - usable.length

  if (!usable.length) {
    openConfirm({
      title: '这一条不能屏蔽',
      text: '它正在待看。先看完或跳过它，再回来处理。',
      okLabel: '知道了',
      onOk: async () => {},
    })
    return
  }

  openConfirm({
    title: '屏蔽这些条目？',
    text:
      `${usable.length} 条不会再出现在抽取和候选池里。` +
      (pending ? `另有 ${pending} 条正在待看，会被跳过。` : ''),
    okLabel: `屏蔽 ${usable.length} 条`,
    onOk: () => hideKeys(usable),
  })
}

async function hideKeys(keys) {
  const res = await send({ type: UI.HIDE_CANDIDATES, keys })
  if (!res?.ok) return

  state.hidden = res.hidden ?? state.hidden
  for (const key of keys) state.selection.delete(key)
  render()
}

async function unhideKeys(keys) {
  const res = await send({ type: UI.UNHIDE_CANDIDATES, keys })
  if (!res?.ok) return

  state.hidden = res.hidden ?? state.hidden
  render()
}

// ---------------------------------------------------------------- 事件

for (const tab of el.tabs) {
  tab.addEventListener('click', () => {
    if (tab.dataset.cat === state.active) return
    state.active = tab.dataset.cat
    state.selection.clear()
    render()
  })
}

el.toggleHidden.addEventListener('click', () => {
  state.view = state.view === 'list' ? 'hidden' : 'list'
  render()
})

el.filterSource.addEventListener('change', () => {
  state.filters.source = el.filterSource.value
  state.selection.clear()
  render()
})

el.filterTime.addEventListener('change', () => {
  state.filters.time = el.filterTime.value
  state.selection.clear()
  render()
})

el.filterComment.addEventListener('change', () => {
  state.filters.comment = el.filterComment.checked
  state.selection.clear()
  render()
})

el.selectAll.addEventListener('change', () => {
  const selectable = visibleItems(state.active).filter((it) => !state.pendingKeys.has(it.key))
  if (el.selectAll.checked) for (const it of selectable) state.selection.add(it.key)
  else for (const it of selectable) state.selection.delete(it.key)
  renderList()
})

el.hideSelected.addEventListener('click', () => confirmHide([...state.selection]))

el.hideFiltered.addEventListener('click', () => {
  confirmHide(visibleItems(state.active).map((it) => it.key))
})

el.confirmCancel.addEventListener('click', closeConfirm)

el.confirmPanel.addEventListener('click', (event) => {
  if (event.target === el.confirmPanel) closeConfirm()
})

el.confirmOk.addEventListener('click', async () => {
  const action = confirmAction
  closeConfirm()
  if (action) await action()
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
  if (!el.helpPanel.hidden) {
    el.helpPanel.hidden = true
    return
  }
  if (!el.confirmPanel.hidden) closeConfirm()
})

boot()
