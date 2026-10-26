/**
 * 全部记录页。
 *
 * 从侧边栏「查看全部记录」打开，是一个普通的扩展页面（新标签页）。
 * 只展示「抽过什么」，不展示候选——候选列表是另一件事。
 */

import { UI } from '../lib/messages.js'
import { CATEGORY_LABEL, sourceTag, stateTag, renderTag } from '../lib/labels.js'

const list = document.getElementById('list')
const empty = document.getElementById('empty')
const meta = document.getElementById('meta')
const filterCategory = document.getElementById('filter-category')
const filterSource = document.getElementById('filter-source')
const clearFilters = document.getElementById('clear-filters')
const exportButton = document.getElementById('export')

const state = {
  records: [],
  filters: { category: '', source: '' },
}

/** 正在等待二次确认的记录 key */
let confirmingKey = null

function hasFilters() {
  return Boolean(state.filters.category || state.filters.source)
}

/** 当前筛选条件下的记录，保持由旧到新的原序 */
function filteredRecords() {
  const { category, source } = state.filters
  return state.records.filter((r) => {
    if (category && r.category !== category) return false
    if (source && r.markStatus !== source) return false
    return true
  })
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

function render() {
  const rows = [...filteredRecords()].reverse()

  if (!rows.length) {
    empty.hidden = false
    empty.textContent = state.records.length ? '这个筛选条件下没有记录。' : '还没开始过。'
    meta.textContent = state.records.length ? `0 / ${state.records.length} 条` : ''
    list.replaceChildren()
    return
  }

  empty.hidden = true
  const total = state.records.length
  const pending = rows.filter((r) => r.state === 'pending').length
  meta.textContent = hasFilters()
    ? `${rows.length} / ${total} 条`
    : `共 ${total} 条${pending ? `，${pending} 条待处理` : ''}`

  const frag = document.createDocumentFragment()
  for (const record of rows) {
    const row = document.createElement('div')
    row.className = 'rec'

    if (record.url) {
      row.classList.add('clickable')
      row.tabIndex = 0
      row.setAttribute('role', 'link')
      row.title = '在豆瓣打开'
      const open = () => chrome.tabs.create({ url: record.url })
      row.addEventListener('click', open)
      row.addEventListener('keydown', (event) => {
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
    sub.textContent = [CATEGORY_LABEL[record.category] ?? '条目', `来自${sourceTag(record).label}`, formatTime(record.drawnAt)]
      .filter(Boolean)
      .join(' · ')

    main.append(title, sub)

    const tags = document.createElement('span')
    tags.className = 'tag-row'
    tags.append(renderTag(stateTag(record)))

    row.append(dot, main, tags)
    // 待看不能删：删了它，抽取限制就出现了后门
    if (record.state !== 'pending') row.append(deleteControls(record))
    if (record.url) {
      const arrow = document.createElement('span')
      arrow.className = 'row-arrow'
      arrow.textContent = '↗'
      row.append(arrow)
    }
    frag.append(row)
  }

  list.replaceChildren(frag)
}

/** 删除入口：先点「删除」，再在行内确认，不用弹层盖住列表 */
function deleteControls(record) {
  const wrap = document.createElement('span')
  wrap.className = 'row-actions'

  const stop = (handler) => (event) => {
    event.stopPropagation()
    handler()
  }

  if (confirmingKey === record.key) {
    const yes = document.createElement('button')
    yes.type = 'button'
    yes.className = 'mini danger'
    yes.textContent = '确定删除'
    yes.addEventListener('click', stop(() => removeRecord(record.key)))

    const no = document.createElement('button')
    no.type = 'button'
    no.className = 'mini'
    no.textContent = '取消'
    no.addEventListener(
      'click',
      stop(() => {
        confirmingKey = null
        render()
      }),
    )

    wrap.append(yes, no)
    return wrap
  }

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'mini'
  btn.textContent = '删除'
  btn.title = '从记录里删掉这条'
  btn.addEventListener(
    'click',
    stop(() => {
      confirmingKey = record.key
      render()
    }),
  )

  wrap.append(btn)
  return wrap
}

async function removeRecord(key) {
  const res = await chrome.runtime.sendMessage({ type: UI.DELETE_RECORD, key })
  confirmingKey = null

  if (!res?.ok) {
    meta.textContent = '这条没能删掉，请稍后再试。'
    return
  }

  await boot()
}

/**
 * 导出当前列表（未筛选时就是全部记录）。
 *
 * 记录里只有条目快照，不含登录凭证、cookie 或页面内容。
 */
function exportRecords() {
  const rows = filteredRecords()
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const a = document.createElement('a')
  a.href = url
  a.download = `douban-random-records-${stamp}.json`
  a.click()
  URL.revokeObjectURL(url)
}

async function boot() {
  try {
    const res = await chrome.runtime.sendMessage({ type: UI.GET_STATE })
    state.records = res?.records ?? []
    render()
  } catch {
    empty.hidden = false
    empty.textContent = '读取记录失败，请回到侧边栏重试。'
  }
}

// ---------------------------------------------------------------- 事件

function updateFilterUI() {
  clearFilters.hidden = !hasFilters()
}

filterCategory.addEventListener('change', () => {
  state.filters.category = filterCategory.value
  updateFilterUI()
  render()
})

filterSource.addEventListener('change', () => {
  state.filters.source = filterSource.value
  updateFilterUI()
  render()
})

clearFilters.addEventListener('click', () => {
  state.filters = { category: '', source: '' }
  filterCategory.value = ''
  filterSource.value = ''
  updateFilterUI()
  render()
})

exportButton.addEventListener('click', exportRecords)

// ---------------------------------------------------------------- 帮助

const helpPanel = document.getElementById('help-panel')
const helpOpen = document.getElementById('help')
const helpClose = document.getElementById('help-close')

helpOpen.addEventListener('click', () => {
  helpPanel.hidden = false
})

helpClose.addEventListener('click', () => {
  helpPanel.hidden = true
})

helpPanel.addEventListener('click', (event) => {
  if (event.target === helpPanel) helpPanel.hidden = true
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !helpPanel.hidden) helpPanel.hidden = true
})

boot()
