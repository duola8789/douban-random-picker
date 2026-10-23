# douban-random-picker

Chrome MV3 扩展：从个人豆瓣收藏（电影 / 剧集 / 图书）中随机抽一个。
主界面是**侧边栏**（`chrome.sidePanel`），点击工具栏图标直接展开，不注册 popup。

## 当前阶段

v1 已实现，等待真机验收（`openspec/changes/v1-random-picker/tasks.md` 7.1）。
改动前先看 `openspec/changes/v1-random-picker/design.md`，那里有 12 条已定的技术决策。

## 版本策略

版本号 `x.y.z`，按语义化版本：

| 变更 | 升级 |
|---|---|
| 修 bug、调样式、改文案等用户可感知的变化 | patch（z） |
| 功能添加、行为变更 | minor（y） |
| 不兼容的改动；正式上线 | major（x） |

补充约定：

- 扩展以 unpacked 方式加载，`chrome://extensions` 里的版本号是判断"有没有装上新版"的唯一依据，
  所以用户可感知的改动应当升 patch；纯内部重构可以不动版本号。
- **0.x 期间从简**：功能一律 minor，其他一律 patch，不追究兼容性。
- **1.0.0 作为首次正式发布**；此后严格守 semver。

## 已实测的事实（2026-10-23）

- 数据源：移动端收藏接口

  ```
  GET https://m.douban.com/rexxar/api/v2/user/{uid}/interests
      ?type=movie|book&status=done|doing|mark&start=0&count=50
  Referer: 任意非空值
  ```

  - 无 Referer → `400 invalid_request_1284`。
  - `type=movie` 含剧集，用 `subject.type === 'tv'` 区分。
  - `count=50` 生效；`status=wish` 会被忽略并返回全部。
  - 响应回显 `Origin` 且 `access-control-allow-credentials: true`，
    因此 content script 里 `credentials: 'include'` 可用（已实测）。

- 登录探测：未登录访问 `https://www.douban.com/mine/` 返回 **403 且不重定向**；
  已登录时预期重定向到 `/people/<uid>/`（后者为推断，未用真实登录态实测）。

## 设计约束

- **所有豆瓣请求走 `*.douban.com` 的 content script**：同站 cookie 自动携带、
  Referer 天然合规。不要在 service worker 里发带凭证的跨站请求。
- **不申请 `cookies` 权限**，不读、不存、不拼 cookie 值；不模拟登录。
- **同步循环跑在 content script 里**，service worker 只做编排——
  MV3 的 SW 空闲约 30 秒就休眠，不能承载长任务。
- 缓存按 `type:status` 维度，24h TTL，打开时 stale-while-revalidate，手动同步绕过 TTL。
- 请求串行，分页间隔 800ms，遇 429 停止并提示。
- 不做任何写操作（不改标记、不打分、不写短评）。
- 不要向任何第三方发送 cookie、收藏或用户数据。

## 代码组织

无构建步骤，原生 ES Module。纯逻辑放在 `src/lib/`，可以直接被 `node --test` 导入；
content script 不能用 import，保持自包含。

```bash
npm run verify   # 语法检查 + 单测 + 静态自检
```

## 文档

- `README.md`：项目概览、安装、架构说明。
- `ROADMAP.md`：v2 候选来源、待验证的豆列接口、兜底路径。
- `openspec/changes/v1-random-picker/`：v1 的 proposal / design / specs / tasks。
