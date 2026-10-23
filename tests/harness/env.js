/**
 * 测试用假浏览器环境。
 *
 * 目的：在没有 Chrome 的情况下，把真实的 service worker 与 content script
 * 接起来跑一条完整链路（探测登录 → 同步 → 写缓存 → 抽取 → 冷却）。
 *
 * 它模拟的是 chrome.* 的语义，不是豆瓣：requests 由 mockFetch 应答。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTENT_SRC = fs.readFileSync(path.join(HERE, '../../src/content/content.js'), 'utf8')

/** 生成符合豆瓣接口形状的原始条目 */
function rawItem(id, type, title) {
  return {
    status: 'mark',
    comment: `短评 ${id}`,
    rating: { value: (id % 5) + 1 },
    create_time: 1_700_000_000 + id,
    is_private: false,
    subject: {
      id: String(id),
      title,
      url: `https://movie.douban.com/subject/${id}/`,
      cover_url: `https://img.example/${id}.jpg`,
      year: '2020',
      type,
      rating: { value: 8.5 },
      card_subtitle: '副标题',
    },
  }
}

function buildDataset() {
  const movie = []
  for (let i = 1; i <= 90; i += 1) movie.push(rawItem(i, 'movie', `电影 ${i}`))
  for (let i = 1; i <= 30; i += 1) movie.push(rawItem(1000 + i, 'tv', `剧集 ${i}`))
  const book = []
  for (let i = 1; i <= 80; i += 1) book.push(rawItem(2000 + i, 'book', `图书 ${i}`))
  return { movie, book }
}

function fakeResponse(status, url, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

export function createEnv({ uid = '20250101', loggedIn = true, mineRedirect = true, domLinks = null } = {}) {
  const dataset = buildDataset()

  // ---------------------------------------------------------------- storage
  const store = {}
  const storageLocal = {
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {})
      const out = {}
      for (const k of list) if (k in store) out[k] = store[k]
      return out
    },
    async set(obj) {
      Object.assign(store, obj)
    },
  }

  // ---------------------------------------------------------------- runtime
  const swListeners = []
  const pageListeners = []

  const runtimeOnMessage = {
    addListener: (fn) => swListeners.push(fn),
  }

  const swRuntime = {
    onMessage: runtimeOnMessage,
    onInstalled: { addListener() {} },
    // SW 发出的广播：没有界面接收时必须 reject，代码里靠 .catch 兜住
    sendMessage(message) {
      if (pageListeners.length === 0) {
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
      }
      return dispatchTo(pageListeners, message)
    },
    lastError: undefined,
  }

  // ---------------------------------------------------------------- tabs
  const tabs = new Map()
  let nextTabId = 1

  function makeTabChrome(tab) {
    return {
      runtime: {
        onMessage: { addListener: (fn) => tab.contentListeners.push(fn) },
        // content script 发回 service worker
        sendMessage: (message) => dispatchTo(swListeners, message, { tab: { id: tab.id } }),
      },
    }
  }

  function loadContentScript(tab) {
    tab.contentListeners = []
    const tabChrome = makeTabChrome(tab)
    const windowObj = { top: null }
    const location = {
      href: tab.url,
      pathname: new URL(tab.url).pathname,
    }
    const document = {
      querySelectorAll: (selector) => tab.domLinks?.[selector] ?? domLinks?.[selector] ?? [],
    }

    const factory = new Function(
      'window',
      'document',
      'location',
      'fetch',
      'chrome',
      'console',
      'setTimeout',
      CONTENT_SRC,
    )
    windowObj.top = windowObj

    factory(
      windowObj,
      document,
      location,
      (url) => mockFetch(url, tab),
      tabChrome,
      console,
      // 让分页间隔不真的等待
      (fn) => setTimeout(fn, 0),
    )
  }

  async function mockFetch(url, tab) {
    const href = String(url)

    if (href === 'https://www.douban.com/mine/') {
      tab.fetchedMine = true
      if (!loggedIn) return fakeResponse(403, 'https://www.douban.com/mine/', '')
      // 真实豆瓣不保证一定重定向：mineRedirect=false 模拟「直接渲染我的豆瓣」
      const finalUrl = mineRedirect
        ? `https://www.douban.com/people/${uid}/`
        : 'https://www.douban.com/mine/'
      return fakeResponse(200, finalUrl, '<html></html>')
    }

    const u = new URL(href)
    const type = u.searchParams.get('type')
    const start = Number(u.searchParams.get('start') ?? 0)
    const count = Number(u.searchParams.get('count') ?? 50)
    const all = type === 'movie' ? dataset.movie : dataset.book
    const page = all.slice(start, start + count)
    return fakeResponse(200, href, { start, count, total: all.length, interests: page })
  }

  const tabsApi = {
    async query(filter) {
      const all = [...tabs.values()]
      if (filter?.url) return all.filter((t) => t.url.includes('douban.com'))
      return all
    },
    async create({ url }) {
      const tab = { id: nextTabId++, url, contentListeners: [] }
      tabs.set(tab.id, tab)
      loadContentScript(tab)
      return { id: tab.id, url: tab.url }
    },
    async remove(tabId) {
      tabs.delete(tabId)
    },
    sendMessage(tabId, message, callback) {
      const tab = tabs.get(tabId)
      const run = dispatchTo(tab?.contentListeners ?? [], message, {})

      if (typeof callback === 'function') {
        run.then(
          (value) => {
            delete swRuntime.lastError
            callback(value)
          },
          () => {
            swRuntime.lastError = { message: 'Receiving end does not exist.' }
            callback(undefined)
            delete swRuntime.lastError
          },
        )
        return
      }
      return run
    },
  }

  const chrome = {
    storage: { local: storageLocal },
    runtime: swRuntime,
    tabs: tabsApi,
    sidePanel: {
      setPanelBehavior: () => Promise.resolve(),
    },
  }

  return {
    chrome,
    store,
    tabs,
    /** 模拟侧边栏向 service worker 发消息 */
    uiSend: (message) => dispatchTo(swListeners, message, {}),
    /** 在某个标签页上挂 DOM 链接，用于测试 DOM 兜底 */
    setTabDomLinks(locationUrl, selector, links) {
      for (const tab of tabs.values()) {
        if (tab.url !== locationUrl) continue
        tab.domLinks = { ...(tab.domLinks ?? {}), [selector]: links }
      }
    },
    closeAllTabs() {
      tabs.clear()
    },
  }
}

/** 按 chrome 的语义分发消息：监听器返回 true 表示异步响应 */
function dispatchTo(listeners, message, sender = {}) {
  if (process.env.DRP_DEBUG === '1') {
    console.log('[dispatch]', message?.type, 'listeners=', listeners.length)
  }
  return new Promise((resolve, reject) => {
    if (listeners.length === 0) {
      reject(new Error('Could not establish connection. Receiving end does not exist.'))
      return
    }

    let settled = false
    let keepOpen = false
    const sendResponse = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    for (const fn of listeners) {
      try {
        const result = fn(message, sender, sendResponse)
        if (result === true) keepOpen = true
      } catch (err) {
        settled = true
        reject(err)
        return
      }
    }

    if (!keepOpen && !settled) {
      settled = true
      resolve(undefined)
    }
  })
}
