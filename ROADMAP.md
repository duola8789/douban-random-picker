# 路线图与遗留需求

本文件只放**还没做、但已经想清楚**的东西，避免它们散落在对话里被忘掉。
做过的、做完了的，记录在 `openspec/changes/archive/` 和 `openspec/specs/` 里。

## 已完成

### v1 · 0.5.0

抽取、同步、缓存、记录。规格见 `openspec/specs/`，
设计与 13 条技术决策见 `openspec/changes/archive/2026-10-23-v1-random-picker/`。

### v2 · 0.7.0

两个 change，2026-10-26 归档：

| Change | 内容 |
|---|---|
| `2026-10-26-v2-4-mark-done` | 待看可以「看完了」结束，不消耗跳过额度；记录可单条删除；窄屏动作栏 |
| `2026-10-26-v2-remaining-features` | 看过 / 读过进入候选池并标「重温」；候选池页（筛选、屏蔽、恢复）；记录页筛选与导出；封面适配 |

行为契约在 `openspec/specs/` 的五个能力里：
`douban-session`、`interest-sync`、`random-pick`、`draw-history`、`candidate-list`。

v2 明确没做：片单 / 书单、关注的官方榜单、公开列表、手动粘贴来源。
这些接口已经调研过，结论见下一节，将来捡起来时不必重走。

## 待做

没有。下一个版本要做什么，先在这里列清楚再开 change。

---

## 已验证但暂不做的接口（2026-10-24 探针）

候选来源只做到「看过 / 读过」，以下接口当时验过、暂时不用。
记下来是为了将来捡起片单 / 书单来源时不必重走。

**豆列条目**（片单、书单底层是同一个资源，URL 都是 `/doulist/{id}/`）

```
GET https://m.douban.com/rexxar/api/v2/doulist/{id}/items?start=0&count=50
GET https://m.douban.com/rexxar/api/v2/doulist/{id}
```

- 公开豆列无需登录；在 `*.douban.com` 页面里可跨域读取（实测 `type: cors`）。
- `count=50` 生效，`start` 步进有效，非法 id 返回 400。
- 条目字段是扁平的：`target_id`（条目 id）、`title`、`type`、`url`、`cover_url`、
  `subtitle`、`rating`、`comment`（豆列评语，不是我的短评）、`create_time`。
- `type` 实测取值：`movie`、`tv`、`book`、`music`、`note`、`topic`、`review`。
  后三者不是条目，做来源时必须过滤。

**官方榜单**

```
GET https://m.douban.com/rexxar/api/v2/subject_collection/{id}/items?start=0&count=
GET https://m.douban.com/rexxar/api/v2/subject_collection/{id}
```

条目在 `subject_collection_items` 里，字段比豆列接口更全（含 `id`、`type`、`interest`）。

**个人列表没有 JSON 接口**

- `/v2/user/{uid}/doulists`、`/v2/user/{uid}/doulist`、`/v2/doulist?user_id=` 均失败。
- 只能解析 HTML：
  - 自己创建的：`https://www.douban.com/people/{uid}/doulists/all`
  - 关注的：`https://www.douban.com/people/{uid}/doulists/collect`
  - 片单：`/people/{uid}/subject_doulists/movie`，书单：`/people/{uid}/subject_doulists/book`
- 列表项结构：`li` 下的 `h3 a`（标题 + 链接）、`.meta`（更新时间、条数）、
  `.doulist-category-icon` 的 class 带类别。
- 「关注的」列表混着两种资源：普通 `doulist` 和官方 `subject_collection`
  （后者链接包在 `doubanapp/dispatch?uri=/subject_collection/{id}/` 里）。

**登录探测**

- 已登录时 `https://www.douban.com/mine/` 重定向到 `/people/{uid}/`，v1 的推断成立。

## 兜底路径（接口失效时启用）

1. **公开收藏 HTML 解析**
   `https://movie.douban.com/people/{uid}/collect?start=0&sort=time&...` 仍可匿名访问；
   页面显示 `1-15 / 218`，可解析出 `total`，随机 `idx` 后只取一页。
   条目结构 `div.item.comment-item` 与 `Marvae/douban-cli` 的解析器兼容（MIT）。
2. **离线快照导入**
   用 `douban export` 生成含评分、短评、私密条目的 JSON，再由扩展导入。
   优点是不受改版影响，缺点是需要手动或定时导出。

二者 v1 均未实现。

## 关于 `Marvae/douban-cli`

MIT，Node 22 CLI。本项目**没有引入它的任何代码**，只借用了调研结论：

| 部分 | 结论 |
|---|---|
| `src/api/collection.ts` 的 HTML 解析函数 | 将来做兜底时可移植 |
| `src/api/common.ts` 的 `cleanText` / `decodeHtml` | 同上 |
| `src/auth/*` | 不可用于浏览器（依赖 node:crypto、node:fs、读浏览器 cookie 库） |
| 移动端接口规律、限流策略 | 已借鉴，体现在 v1 的同步设计里 |

若将来真的移植解析器：保留原作者版权声明，并在仓库加 `THIRD_PARTY_NOTICES.md`。

需要划清的一点：douban-cli 靠读取本机浏览器的 cookie 库拿登录态，本项目**刻意不这么做**——
扩展有页面上下文，走 content script 同站请求即可，不需要也不应该碰 cookie 值。

## 发布前清单

- [x] 选定本项目自己的 LICENSE（MIT）
- [x] 隐私政策文本（`PRIVACY.md`）
- [x] 法律与平台风险梳理（`docs/compliance.md`）
- [x] 扩展图标（自绘，不使用第三方商标）
- [x] 请求频率硬下限（10 分钟最短更新 + 1200ms 分页间隔）
- [x] 初始化 git 仓库并推送到远程
- [x] Chrome Web Store 上架材料（`docs/store-listing.md`）
- [x] 打包自动处理：`npm run package` 会用 `src/lib/config.prod.js`
      覆盖配置（10 分钟冷却、dailySkipLimit 1），并删除标记为 `dev-only`
      的界面与样式，生产包里不含「重置全部数据」
- [ ] 在真实 Chrome 里验收，并截图（1280×800 或 640×400）
- [ ] 商店后台填写「数据使用」表单
- [ ] 评估风险：豆瓣接口为非公开接口，公开发布会放大被限流与被改的概率
