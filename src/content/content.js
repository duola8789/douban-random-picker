/**
 * Content script —— 运行在 *.douban.com 页面内。
 *
 * 它承担两件 service worker 做不了的事：
 *   1. 同站请求：cookie 由浏览器自动携带，Referer 天然是豆瓣域；
 *   2. 长任务：分页循环跑在真实标签页里，不受 MV3 service worker 休眠影响。
 *
 * 约束：content script 不能使用 ES module import，因此本文件保持自包含。
 */

;(() => {
  // 只在顶层文档工作，避免 iframe 重复响应
  if (window.top !== window) return

  const CS = {
    PING: 'cs:ping',
    PROBE_LOGIN: 'cs:probeLogin',
    FETCH_ALL: 'cs:fetchAll',
  }
  const FROM_CS = {
    SYNC_RESULT: 'cs:syncResult',
    SYNC_PROGRESS: 'cs:syncProgress',
  }

  // 兜底默认值；正常由 service worker 通过消息下发（见 src/lib/config.js）
  const DEFAULT_CONFIG = { pageSize: 50, pageIntervalMs: 1200, maxPages: 200 }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 统一的可序列化错误 */
  function fail(code, extra = {}) {
    return { code, ...extra }
  }

  /**
   * 从 /mine/ 或页面 DOM 中确认登录态并拿到 uid。
   * 未登录访问 /mine/ 返回 403 且不重定向；已登录会重定向到 /people/<uid>/。
   */
  async function probeLogin() {
    try {
      const res = await fetch('https://www.douban.com/mine/', {
        credentials: 'include',
        redirect: 'follow',
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: 'not-logged-in' }
      }
      const uid = matchUid(res.url)
      if (uid) return { ok: true, uid, via: 'mine' }
      if (res.ok) return { ok: false, reason: 'not-redirected' }
    } catch {
      // 跨子域时 /mine/ 可能被 CORS 拦下，退化到页面 DOM 判断
    }

    const uid = uidFromDom()
    if (uid) return { ok: true, uid, via: 'dom' }
    return { ok: false, reason: 'unknown' }
  }

  function matchUid(url) {
    if (!url) return ''
    const m = /\/people\/([^/?#]+)/.exec(url)
    return m ? m[1] : ''
  }

  function uidFromDom() {
    const links = document.querySelectorAll('a[href*="/people/"]')
    for (const a of links) {
      const uid = matchUid(a.getAttribute('href') || '')
      // 过滤掉 /people/<uid>/collect、"我的豆瓣" 之外的子路径已被正则截断
      if (uid && uid !== '0') return uid
    }
    return ''
  }

  /**
   * 串行分页拉取一个维度的全部条目。
   * 结果通过 runtime 消息回传给 service worker，而不是靠 sendResponse，
   * 以免 service worker 休眠导致响应通道失效。
   */
  async function fetchAll({ uid, type, status, dimension, config }) {
    const { pageSize, pageIntervalMs, maxPages } = { ...DEFAULT_CONFIG, ...(config ?? {}) }
    const raws = []
    let start = 0
    let total = null
    let pages = 0

    try {
      while (pages < maxPages) {
        const url =
          `https://m.douban.com/rexxar/api/v2/user/${encodeURIComponent(uid)}/interests` +
          `?type=${encodeURIComponent(type)}&status=${encodeURIComponent(status)}` +
          `&start=${start}&count=${pageSize}`

        const res = await fetch(url, {
          credentials: 'include',
          redirect: 'follow',
          headers: { Accept: 'application/json' },
        })

        if (res.status === 429) {
          throw fail('RATE_LIMITED')
        }
        if (res.status === 401 || res.status === 403) {
          throw fail('AUTH_REQUIRED', { status: res.status })
        }
        if (!res.ok) {
          throw fail('HTTP_ERROR', { status: res.status })
        }

        const json = await res.json()
        const page = Array.isArray(json?.interests) ? json.interests : []
        if (typeof json?.total === 'number') total = json.total

        raws.push(...page)
        pages += 1

        chrome.runtime.sendMessage({
          type: FROM_CS.SYNC_PROGRESS,
          dimension,
          fetched: raws.length,
          total: total ?? raws.length,
        })

        if (page.length === 0) break
        if (total != null && raws.length >= total) break

        start += pageSize
        await sleep(pageIntervalMs)
      }

      chrome.runtime.sendMessage({
        type: FROM_CS.SYNC_RESULT,
        dimension,
        items: raws,
        total: total ?? raws.length,
        partial: false,
      })
    } catch (err) {
      const code = err?.code ?? 'NETWORK'
      chrome.runtime.sendMessage({
        type: FROM_CS.SYNC_RESULT,
        dimension,
        items: raws,
        total: total ?? raws.length,
        partial: true,
        error: { code, status: err?.status },
      })
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return

    if (msg.type === CS.PING) {
      sendResponse({ ok: true, href: location.href })
      return
    }

    if (msg.type === CS.PROBE_LOGIN) {
      probeLogin().then(sendResponse)
      return true
    }

    if (msg.type === CS.FETCH_ALL) {
      // 立即确认，真正的工作异步进行
      sendResponse({ ok: true, accepted: true })
      fetchAll(msg)
      return
    }
  })
})()
