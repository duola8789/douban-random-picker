/**
 * 全部记录页。
 *
 * 从侧边栏「查看全部记录」打开，是一个普通的扩展页面（新标签页）。
 * 侧边栏放不下完整列表，这里也不抢侧边栏的高度。
 */

import { UI } from '../lib/messages.js'

const CATEGORY_LABEL = { movie: '电影', tv: '剧集', book: '图书' }

const list = document.getElementById('list')
const empty = document.getElementById('empty')
const meta = document.getElementById('meta')

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

function render(records) {
  const rows = [...records].reverse()

  if (!rows.length) {
    empty.hidden = false
    meta.textContent = ''
    return
  }

  const pending = rows.filter((r) => r.state === 'pending').length
  meta.textContent = `共 ${rows.length} 条${pending ? `，${pending} 条待处理` : ''}`

  const frag = document.createDocumentFragment()
  for (const record of rows) {
    const row = document.createElement('div')
    row.className = 'rec'

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

    row.append(dot, main, chip)
    frag.append(row)
  }

  list.replaceChildren(frag)
}

async function boot() {
  try {
    const res = await chrome.runtime.sendMessage({ type: UI.GET_STATE })
    render(res?.records ?? [])
  } catch {
    empty.hidden = false
    empty.textContent = '读取记录失败，请回到侧边栏重试。'
  }
}

boot()
