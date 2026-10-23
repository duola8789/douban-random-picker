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
    DETAIL: 'cs:detail',
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

  const log = (...args) => console.log('%c[豆瓣随机]', 'color:#2f6b4f;font-weight:600', ...args)

  /**
   * 确认登录态并拿到 uid。
   *
   * 分三层，前一层拿到就不再往下走：
   *   1. 当前页面地址本身就是 /people/<uid>/ —— 最可信；
   *   2. 请求 /mine/，看最终重定向地址；
   *   3. 仅在「我的豆瓣」或个人主页上抓 DOM 里的个人主页链接。
   *
   * 第 3 层刻意限制页面范围：在任意豆瓣页面上抓 /people/ 链接，
   * 很可能抓到别人的 uid，进而拉到别人的收藏。
   */
  async function probeLogin() {
    const here = matchUid(location.href)
    if (location.pathname.startsWith('/people/') && here) {
      log('登录态：从当前地址取到 uid', here)
      return { ok: true, uid: here, via: 'location' }
    }

    try {
      const res = await fetch('https://www.douban.com/mine/', {
        credentials: 'include',
        redirect: 'follow',
        headers: { Accept: 'text/html' },
      })
      log('/mine/ ->', res.status, res.url)

      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: `mine-${res.status}` }
      }

      const fromUrl = matchUid(res.url)
      if (fromUrl) return { ok: true, uid: fromUrl, via: 'mine-url' }

      if (res.ok) {
        // 没有重定向：豆瓣可能直接渲染了「我的豆瓣」，从页面里找自己的主页链接
        const domUid = await uidFromOwnPage()
        if (domUid) return { ok: true, uid: domUid, via: 'mine-dom' }
        return { ok: false, reason: 'mine-no-uid' }
      }

      return { ok: false, reason: `mine-${res.status}` }
    } catch (err) {
      // 跨子域时 /mine/ 可能被 CORS 拦下，退到 DOM
      log('/mine/ 请求失败', err?.name, err?.message)
    }

    const domUid = await uidFromOwnPage()
    if (domUid) return { ok: true, uid: domUid, via: 'dom' }

    return { ok: false, reason: 'unknown' }
  }

  function matchUid(url) {
    if (!url) return ''
    const m = /\/people\/([^/?#"'\s<]+)/.exec(url)
    return m ? m[1] : ''
  }

  /**
   * 只在「我的豆瓣」或个人主页上取链接，避免拿到别人的 uid。
   *
   * 豆瓣的导航可能由脚本渲染，document_idle 时链接还不存在，
   * 所以这里做几次短轮询，同时留意地址栏是否发生了客户端跳转。
   */
  async function uidFromOwnPage({ attempts = 4, interval = 400 } = {}) {
    const path = location.pathname
    if (!path.startsWith('/mine') && !path.startsWith('/people/')) {
      log('当前页面不是个人主页，跳过 DOM 探测', path)
      return ''
    }

    for (let i = 0; i < attempts; i += 1) {
      const fromLocation = matchUid(location.href)
      if (location.pathname.startsWith('/people/') && fromLocation) {
        log('地址栏跳转后取到 uid', fromLocation)
        return fromLocation
      }

      const fromDom = scanDomForUid()
      if (fromDom) {
        log('从 DOM 取到 uid', fromDom)
        return fromDom
      }

      await sleep(interval)
    }

    log('DOM 里没找到个人主页链接')
    return ''
  }

  function scanDomForUid() {
    const selectors = [
      '.nav-user-account a[href*="/people/"]',
      'a[href*="/people/"][href$="/"]',
      'a[href*="/people/"]',
    ]

    for (const selector of selectors) {
      for (const a of document.querySelectorAll(selector)) {
        const uid = matchUid(a.getAttribute('href') || '')
        if (uid) return uid
      }
    }
    return ''
  }

  /**
   * 串行分页拉取一个维度的全部条目。
   * 结果通过 runtime 消息回传给 service worker，而不是靠 sendResponse，
   * 以免 service worker 休眠导致响应通道失效。
   */
  async function fetchAll({ uid, mediaType, status, dimension, config }) {
    const { pageSize, pageIntervalMs, maxPages } = { ...DEFAULT_CONFIG, ...(config ?? {}) }
    const raws = []
    let start = 0
    let total = null
    let pages = 0

    try {
      while (pages < maxPages) {
        const url =
          `https://m.douban.com/rexxar/api/v2/user/${encodeURIComponent(uid)}/interests` +
          `?type=${encodeURIComponent(mediaType)}&status=${encodeURIComponent(status)}` +
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

  /**
   * 拉单个条目的详情，只为拿简介。
   *
   * 收藏接口里 subject.intro 是 null，简介只在详情接口里。
   * 每次抽中才会请求一次，不影响同步。
   */
  async function fetchDetail({ kind, subjectId }) {
    const type = kind === 'book' ? 'book' : 'movie'
    const url = `https://m.douban.com/rexxar/api/v2/${type}/${encodeURIComponent(subjectId)}`
    try {
      const res = await fetch(url, {
        credentials: 'include',
        redirect: 'follow',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        log('详情接口失败', res.status, subjectId)
        return { ok: false, status: res.status }
      }
      const json = await res.json()
      return {
        ok: true,
        intro: typeof json?.intro === 'string' ? json.intro.trim() : '',
        subtitle: typeof json?.card_subtitle === 'string' ? json.card_subtitle : '',
        authorIntro: typeof json?.author_intro === 'string' ? json.author_intro : '',
      }
    } catch (err) {
      log('详情接口异常', err?.message)
      return { ok: false, error: String(err?.message ?? err) }
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

    if (msg.type === CS.DETAIL) {
      fetchDetail(msg).then(sendResponse)
      return true
    }
  })
})()
