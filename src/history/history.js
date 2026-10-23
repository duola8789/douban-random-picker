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
    sub.textContent = `${CATEGORY_LABEL[record.category] ?? '条目'} · ${formatTime(record.drawnAt)}`

    main.append(title, sub)

    const tags = document.createElement('span')
    tags.className = 'tag-row'
    tags.append(renderTag(sourceTag(record)), renderTag(stateTag(record)))

    row.append(dot, main, tags)
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
