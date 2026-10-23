# 路线图与遗留需求

v1 的规格、设计与实现记录在 `openspec/changes/v1-random-picker/`。
本文件只放**还没做、但已经想清楚**的东西，避免它们散落在对话里被忘掉。

## v1 状态

已实现，待真机验收。剩余一条任务：完整走一遍首次安装流程（`tasks.md` 7.1）。

## v2：候选来源

v1 的候选只有一种：本人标记为「想看 / 想读」的电影 / 剧集 / 图书。
v2 要让候选范围可选，来源分四类：

| 来源 | 获取方式 | 状态 |
|---|---|---|
| 我标记为看过 / 读过的条目 | 与 v1 同一个接口，只是 `status=done` | 接口已实测，实现成本最低 |
| 我自己创建的片单 / 书单（豆列） | 需自行枚举列表 + 拉条目 | 接口**未验证** |
| 我收藏 / 关注的别人的豆列 | 同上 | 接口与权限均**未验证** |
| 公开豆列 | 用户粘贴链接或 ID | 接口**未验证** |
| 任意拿不到的来源 | 由用户粘贴 URL 手动登记 | 兜底策略，已在 v1 设计中预留 |

用户明确要求：自己的来源由系统自动获取；系统拿不到的，允许手工粘贴 URL。

### 抽象结构（v1 已在 design.md 决策 9 预留）

```
Layer 1  SourceCatalog   —— 「有哪些候选来源可用？」
   +-- myInterests(status, type)      v1 唯一实现
   +-- myDoulists()                   v2
   +-- followedDoulists()             v2
   +-- manualDoulist(url)             v2

Layer 2  CandidateSource —— 「这个来源里有哪些条目？」
   fetchAll(): InterestItem[]          // 豆列量级支持全量缓存
```

`storage` 里已预留 `sources` 表的位置，用 `addedBy: auto | manual` 区分自动发现与手工登记。

## v2：历史记录增强

v1 已经有历史记录（写入、展示、去重窗口、清空）。v2 可考虑：

- 按类别 / 来源筛选历史
- 导出历史到文件

## v2：对抽取结果的操作

用户看完之后的下一步动作，v1 只提供了「去豆瓣标记」这个外链。

- **系统内标记「看过了 / 读过了」**：只写本地，不碰豆瓣
- **删除单条历史**：抽错了或者不想留痕
- **去豆瓣标记**：保持现在的行为，打开条目页由用户自己操作（扩展不代写）

设计时要先定清楚：系统内的「看过了」和豆瓣上的「看过」是两份数据，
不同步、不互相推断，避免让用户以为扩展改了豆瓣。

## 待验证的豆瓣接口

以下都需要 1–2 个只读请求确认，**尚未实测**：

1. 我创建的豆列列表页结构：`https://www.douban.com/people/{uid}/doulists`
2. 收藏 / 关注的豆列入入口页
3. 豆列条目是否存在 JSON 接口（候选：`m.douban.com/rexxar/api/v2/doulist/{id}/items`）
4. 公开豆列是否需要登录才能访问
5. 已登录时 `https://www.douban.com/mine/` 的重定向行为（v1 按常规语义实现，未用真实登录态实测）

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
- [ ] 在真实 Chrome 里验收，并截图（1280×800 或 640×400）
- [ ] 商店后台填写「数据使用」表单
- [ ] 评估风险：豆瓣接口为非公开接口，公开发布会放大被限流与被改的概率
