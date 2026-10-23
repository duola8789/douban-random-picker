## Why

在豆瓣标记了上百个「想看 / 想读」之后，选择本身变成了负担：列表越长，越难决定下一部看什么。本 change 建立一个个人用的 Chrome 扩展，打开就能从自己的待看 / 待读里随机抽一个，把「决定看什么」的成本降到一次点击。

豆瓣没有公开 API，且 v1 的候选必须是本人标记的数据（包含仅自己可见的条目），因此必须以复用浏览器已有登录态为前提。技术调研已完成并记录在 `HANDOFF.md`，本 change 将调研结论固化为可实现的规格。

## What Changes

- 新建 Chrome MV3 扩展，主界面为**侧边栏**（不使用 popup），点击工具栏图标直接展开。
- 通过 `*.douban.com` 的 content script 复用浏览器已有豆瓣会话，拉取本人 `status=mark` 的电影与图书收藏。
- 同步循环完整运行在 content script 内，service worker 仅做编排，避免 MV3 生命周期问题。
- 候选池由三个独立开关（电影 / 剧集 / 图书）定义，默认全选；多选时**先等概率抽类别，再在类别内抽条目**。
- 抽中后以卡片展示封面、标题、年份、豆瓣评分、我的评分、我的短评与豆瓣链接。
- 本地保存抽取历史，并据此在后续抽取中避开最近 N 条。
- 缓存按 `type:status` 维度存储，24 小时 TTL，打开时 stale-while-revalidate，支持手动同步。
- 明确不做：任何写操作（不改豆瓣上的标记状态）、账号密码登录、向第三方发送数据。

## Capabilities

### New Capabilities

- `douban-session`: 复用浏览器已有豆瓣登录态、获取用户 uid、判定登录有效性并在失效时给出可操作的提示。
- `interest-sync`: 从豆瓣拉取本人「想看 / 想读」条目，串行分页、受限频控制、按维度缓存并在过期后重新同步。
- `random-pick`: 由类别开关定义候选池，按类别等权抽取条目，避开最近抽过的记录，并渲染结果卡片。
- `draw-history`: 记录每次抽取的结果与时间，在侧边栏展示，并作为去重窗口的数据来源。

### Modified Capabilities

无。项目此前没有任何已建立的 spec。

## Impact

- **新增代码**：完整的 MV3 扩展工程（`manifest.json`、service worker、content script、侧边栏页面、storage 层）。项目当前只有文档，无既有代码受影响。
- **权限**：`storage`、`sidePanel`、`tabs`、`scripting`、`host_permissions: https://*.douban.com/*`。不申请 `cookies` 权限。
- **外部依赖**：豆瓣非公开接口 `m.douban.com/rexxar/api/v2/user/{uid}/interests`，其行为可能随时变更，需要保留错误提示与手动重试路径。
- **浏览器兼容**：以 Chrome 114+（`chrome.sidePanel` 可用版本）为基线，Edge 同源 Chromium 预期可用；不支持 Firefox。
- **隐私**：所有数据仅存于本地 `chrome.storage.local`，无后端、无遥测、不向任何第三方发送 cookie 或收藏内容。
- **未验证项**（实现前需实测，详见 `design.md`）：未登录时 interests 接口的返回形态、豆列相关接口（v2 依赖，本 change 不实现）。
