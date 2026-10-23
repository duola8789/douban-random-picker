## Context

项目当前只有调研文档，没有任何代码，因此本 change 是全新工程，不存在兼容与迁移负担。约束来自两处：已实测的豆瓣接口行为（见 `HANDOFF.md` 第 3 节），以及用户的形态选择（Chrome MV3 扩展 + 侧边栏）。

影响技术选择的四条硬约束：

- v1 候选是本人标记的「想看 / 想读」，**必须带登录态**，而扩展的 service worker 对 `douban.com` 属跨站，`SameSite=Lax` 的会话 cookie 不保证携带。
- 豆瓣接口要求请求带非空 `Referer`，而扩展内的 `fetch` 无法设置该 header。
- MV3 的 service worker 空闲约 30 秒即休眠，不宜承载长任务。
- 侧边栏页面与 popup 一样，关闭即销毁其 JS 环境。

## Goals / Non-Goals

**Goals:**

- 让「打开扩展 → 拿到一个结果」在绝大多数情况下是本地操作，不发网络请求。
- 在浏览器会话自然过期或被用户登出时，能给出可操作的提示，而不是静默显示空列表。
- 同步过程不受侧边栏开关的影响，也不受 service worker 休眠的影响。
- 为 v2 的多样候选来源（豆列等）预留结构，使新增来源不需要改动界面与抽取逻辑。

**Non-Goals:**

- 不实现任何写操作（标记在看 / 读过、改评分、写短评）。
- 不实现 v2 的豆列来源，本 change 只预留抽象边界。
- 不实现 HTML 解析兜底与离线快照导入，作为未来降级路径保留。
- 不兼容 Firefox。
- 不做多账号支持，uid 只有一个。

## Decisions

### 决策 1：形态选扩展 + 侧边栏，而非 popup

**选择**：Chrome MV3 扩展，`chrome.sidePanel` 作为唯一界面，通过 `setPanelBehavior({ openPanelOnActionClick: true })` 让点击工具栏图标直接展开侧边栏，不注册 popup。

**理由**：用户的实际流程是「抽中 → 点进豆瓣看详情 → 可能再抽一次」。popup 在焦点转移时立即关闭，这个流程会被反复打断；侧边栏可以常驻在主页面旁边，点击链接后在另一侧对照。用户几乎不使用其他扩展的侧边栏，因此「一个窗口只能开一个侧边栏」的冲突代价可以接受。

**备选**：popup 轻量但流程断裂；Tauri 桌面端 UI 自由但需要在应用内重新登录豆瓣，且验证码与风控行为未验证；网页/小程序无法直接获得会话，必须自建后端。

### 决策 2：登录态只能走 content script，不走 service worker

**选择**：所有豆瓣数据请求都在 `https://*.douban.com/*` 的 content script 中发起，使用 `credentials: 'include'`。

**理由**：content script 运行在豆瓣页面上下文，请求天然是同站请求，会话 cookie 由浏览器自动携带，`Referer` 也自动设置为豆瓣域，同时满足接口的两条校验。相比之下：

- service worker 中 `credentials: 'include'` 属于跨站请求，`SameSite=Lax` cookie 不保证发送，还会受浏览器第三方 cookie 策略影响；
- 用 `declarativeNetRequest` 补 `Referer` 只能解决 header 校验，解决不了 cookie 的跨站问题；
- 申请 `cookies` 权限读值后自行拼装 `Cookie` 头，会把凭证明文带进内存，也触发了「读取你的 cookie」的安装警告。

因此 v1 **不申请 `cookies` 权限**。

### 决策 3：同步循环放在 content script，service worker 只做编排

**选择**：service worker 负责「找或开标签页 → 下发同步指令 → 接收结果 → 写存储 → 关标签页」；完整的分页循环、限频等待、重试判断都在 content script 内完成，结果一次性回传。

**理由**：service worker 空闲约 30 秒即休眠，长连接也只能有限延长；而 content script 依附于真实标签页，标签页存活期间不受 SW 生命周期影响。把循环放进去，同步的可靠性就从「和 SW 生命周期赛跑」变成「有标签页就行」。

```
侧边栏 --PICK/SYNC--> service worker
                          |
                          | 1. 找已打开的 douban 标签页
                          |    没有则 tabs.create({active:false})
                          | 2. 通过 port 下发 {uid, type, status}
                          v
                    content script
                      for page in pages:
                        fetch(credentials:'include')
                        await sleep(pageIntervalMs)
                      port.postMessage({items, total})
                          |
                          v
                    service worker
                      写 chrome.storage.local
                      关闭临时标签页（仅自己创建的）
                      通知侧边栏刷新
```

**备选**：把循环写在 SW 里，实现更集中，但需要靠 port keep-alive 续命，大列表（数百条、20 秒以上）存在被中断的风险。

### 决策 4：临时标签页的生命周期与归属

**选择**：同步时优先复用用户已打开的 `*.douban.com` 标签页；没有则创建一个 `active: false` 的后台标签页，同步结束后只关闭自己创建的那一个。

**理由**：`active: false` 不抢占焦点，用户几乎无感；复用已有标签页可以避免额外开销且能立刻拿到已登录的上下文。

**风险点**：如果用户此时正在关闭标签页，指令可能发不出去。处理方式是发送前二次确认标签页存在，失败则回退到新建。

### 决策 5：缓存按维度存储，读取先本地后刷新

**选择**：以 `movie:mark` 和 `book:mark` 为缓存键，每份缓存记录 `items`、`total`、`syncedAt`、`partial`。TTL 24 小时。界面打开时立即用缓存渲染，再判断是否需要在后台刷新。

**理由**：个人收藏通常在数百条量级，一次全量同步约消耗 30–40 秒与若干请求；而抽取本身应该是瞬时的。stale-while-revalidate 让首屏永不等待网络。

**同步范围**：只同步当前类别开关涉及的维度；另提供独立的「全部同步」入口。

### 决策 6：候选池与抽取算法

类别开关直接定义候选池，多选时**先等权选类别、再在类内均匀选条目**。

```
非空类别集合 = { c | c 已勾选 且 c 有可用条目 }
        |
        v
以 1/|非空类别集合| 的概率选出一个类别      <- 等权，与条目数无关
        |
        v
在该类别剩余条目中均匀选一条               <- 剩余 = 全部 - 去重窗口
```

去重窗口按**类别**独立计算：

```
Wc = min(N, floor(n_c * 0.8))     // N 默认 20，n_c 为该类别条目总数
```

按类别而非全局计算，是为了避免「电影只有 15 条、全局窗口 20 条」时整个类别被排除。每个类别至少保留 20% 可抽，保证非空类别一定有解。

**备选**：合并成单一池子后均匀抽，实现更简单，但条目多的类别会按数量占比淹没其他类别——样本账号下图书会占约 63%，与「等权」的期望不符。

### 决策 7：历史记录兼作洗牌袋

**选择**：每次抽取写入一条历史记录，同时用「最近 Wc 条」作为排除集。不再单独维护洗牌袋。

**理由**：避免重复抽到与「我抽过什么」本质是同一份数据。一个机制同时满足体验需求与回顾需求，也省掉了一层需要跨会话维护的状态。

**存储形态**：记录轻量快照（条目标识、标题、封面、类别、时间），不存完整条目，几百条记录约数百 KB，远低于 `storage.local` 配额。

### 决策 8：数据模型

```ts
type Category = 'movie' | 'tv' | 'book'
type CacheKey = 'movie:mark' | 'book:mark'

interface InterestItem {
  key: string          // `${subject.type}:${subject.id}`，天然去重键
  category: Category
  subjectId: string
  title: string
  year?: string
  coverUrl?: string
  url: string
  doubanRating?: number
  myRating?: number      // 可缺失
  myComment?: string     // 可缺失
  subtitle?: string
  markedAt?: number
  isPrivate?: boolean
}
```

`myRating` 与 `myComment` 的可选性是由 v2 决定的：豆列来源的条目没有「我的评分/短评」。v1 虽然全部来自本人收藏，仍按可选处理，界面依此省略区域，避免 v2 改动界面结构。

### 决策 9：为 v2 预留的两层来源抽象

v1 不实现豆列，但 source 枚举的结构要现在就留好，否则 v2 需要改动同步层：

```
Layer 1  SourceCatalog   —— 「有哪些候选来源可用？」
   +-- myInterests(status, type)      v1 唯一实现
   +-- myDoulists()                   v2
   +-- followedDoulists()             v2
   +-- manualDoulist(url)             v2，用户粘贴链接

Layer 2  CandidateSource —— 「这个来源里有哪些条目？」
   fetchAll(): InterestItem[]          // 豆列量级支持全量缓存
```

v1 只落地 Layer 1 的一个实现和 Layer 2 的通用形态，不引入豆列相关代码。

### 决策 10：错误分类与提示

请求结果按下列四类处理，界面上给出不同的动作：

| 情况 | 判定 | 界面动作 |
|---|---|---|
| 网络错误 / 超时 | 可重试 | 保留旧数据，提示重试 |
| 429 | 限流 | 停止同步，提示稍后重试 |
| 401 / 403 | 登录失效 | 提示重新登录，给登录入口 |
| 200 且 `total = 0` | 无条目 | 提示该类别下没有标记 |

「登录失效」的判定**不再依赖 interests 接口的返回形态**，而是由一个独立的登录探测决定（见下）。这样即使该接口在未登录时返回 200 + 空列表，也不会被误报成「你还没标记任何条目」。

### 决策 11：登录探测走 `/mine/`，不靠空结果推断

**实测（2026-10-23）**：未登录访问 `https://www.douban.com/mine/` 返回 **403 且不重定向**。已登录时该地址会重定向到 `/people/<uid>/`。

因此登录探测与 uid 获取是同一个动作：在 `*.douban.com` 的 content script 中请求 `/mine/`，若最终 URL 落在 `/people/<uid>/` 则判定已登录并同时拿到 uid；若返回 403 或停留在登录页，则判定未登录。这一步不需要任何 cookie 读取权限，判定结果也不依赖收藏接口的行为。

### 决策 12：CORS 已验证，content script 方案成立

**实测（2026-10-23）**：带 `Origin: https://www.douban.com` 请求 interests 接口，响应包含

```
access-control-allow-origin: https://www.douban.com     <- 回显来源，不是 *
access-control-allow-credentials: true
```

这一点很关键：若服务端固定返回 `*`，浏览器会拒绝一切携带凭证的跨源请求，content script 方案将无法成立。实测确认它回显 `Origin` 并允许凭证，因此从豆瓣页面发起的 `credentials: 'include'` 请求可用。

同时复测确认：不带 `Referer` 的请求仍返回 400。

### 决策 13：最短更新频率压过手动同步

**问题**：v1 原本把「手动同步绕过 TTL」当作无条件能力。个人自用时这没问题；一旦公开分发，使用者点击同步的次数就与作者无关，请求密度不再可控。

**选择**：在 `src/lib/config.js` 里引入 `minRefreshMs`（默认 10 分钟），并在同步入口处检查：距离该维度**上次成功同步**不足该间隔时，即使 `force: true` 也不发起任何请求，直接返回 `TOO_SOON` 与剩余等待时间。

**为什么是「成功」同步**：失败或仅部分成功时若也冷却，用户遇到网络抖动就只能干等十分钟。因此只统计 `!partial && !error` 的缓存条目，失败后的重试不受约束。

**附带调整**：
- 分页间隔从 800ms 上调到 1200ms；
- 请求参数集中到 `config.js`，由 service worker 通过消息下发给 content script，避免两处各写一份。

**权衡**：10 分钟对个人使用几乎无感（缓存本身 24 小时才过期），但它给公开分发后的请求密度设了一个与作者无关的硬下限。代价是同步失败后如果用户反复点击，仍可能产生密集请求——这由 429 停止逻辑兜底。

**备选**：把冷却做成可配置项。否决，因为公开版本里“可配置”等于“可关闭”。

## Risks / Trade-offs

- **豆瓣非公开接口变更** → 提示与重试路径已覆盖；HTML 解析兜底与快照导入留作后续降级方案，不在本 change 内实现。
- **临时标签页可能闪现** → 使用 `active: false` 创建；创建失败时提示用户手动打开一个豆瓣页面后再同步。
- **侧边栏与其他扩展互斥** → 用户几乎不用其他侧边栏，接受该限制；不做 popup 备份入口以保持入口唯一。
- **分页限频（1200ms）使大列表同步较慢** → 数百条约 30–40 秒；界面显示进度，且首屏用缓存兜底，用户不必等待。
- **等权抽取可能与直觉不符** → 图书条目多时，用户会感到「抽到图书的次数偏多」，但这是等权设计的必然结果；若日后需要，可增加权重设置，不影响现有结构。
- **会话在后台静默过期** → 只能在下一次同步时发现；不做定时探测以免打扰用户。
- **`storage.local` 配额** → 数千条目的 JSON 约数百 KB，默认配额足够；不申请 `unlimitedStorage`。
- **卸载即丢数据** → 历史与缓存随扩展卸载消失，属预期行为，不做导出。

## Migration Plan

全新安装，无迁移。首次启动流程：探测 uid → 检测登录态 → 首次同步当前勾选维度 → 具备抽取能力。回滚方式为卸载扩展，无服务端状态需要清理。

## Open Questions

- 侧边栏在 Edge 上的表现预期与 Chrome 一致（同源 Chromium），未实测，不影响 v1 交付。
- 未来是否需要「HTML 解析兜底」与「快照导入」，可在接口失效后按需追加，不影响当前结构。
- 已登录时 `/mine/` 的重定向行为按豆瓣常规语义实现（推断，未用真实登录态实测）；若实际不重定向，登录探测需退化为读取页面导航中的个人主页链接。
