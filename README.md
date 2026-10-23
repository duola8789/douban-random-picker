# 豆瓣随机

少一点选择，多一点开始。

一个 Chrome 扩展：替你做一次决定，抽到哪部就看哪部。

## 它做什么

- 电影 / 剧集 / 图书三个页签，**互不混合**，抽哪类就是哪类。
- **一个类别同一时间只有一个待看。** 抽中之后要么去看，要么跳过，才能抽下一个——
  如果抽完还能一直重抽，等于没做决定。
- 抽中后展示封面、标题、年份、豆瓣评分、简介、你的评分与短评，并标明来自「想看」还是「想读」。
- 记录按类别保存，能看出每条是待看、跳过还是看过。
- 候选来自你本人的豆瓣收藏：标记为**想看**的电影与剧集、标记为**想读**的图书。
- 数据只存在本地浏览器里。没有后端，没有遥测，不向任何第三方发送任何内容。

## 安装

尚未上架，用开发者模式加载：

1. 打开 `chrome://extensions`
2. 打开右上角的「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库根目录
4. 在浏览器里登录豆瓣（扩展复用你已有的会话，不处理账号密码）
5. 点工具栏图标打开侧边栏

## 开发

```bash
npm test        # 45 个用例：纯逻辑单测 + 端到端（假 chrome 环境跑真实的 SW 与 content script）
npm run check   # 语法检查
node scripts/verify.mjs   # 静态自检：manifest 引用、权限、import、禁用 API
npm run verify  # 上面三件事一起跑
npm run icons   # 重新生成扩展图标（不依赖图形库）
npm run package # 打包成可上传 Chrome Web Store 的 zip（自动换成生产配置、剔除开发代码）
```

### 清空调试数据

在侧边栏里右键 → 检查 → Console，然后按需要执行：

```js
chrome.storage.local.get(null)                    // 看看当前存了什么
chrome.storage.local.clear().then(() => location.reload())  // 全部清空（含 uid，会重新探测登录）
chrome.storage.local.set({ caches: {} })          // 只清同步缓存
chrome.storage.local.set({ records: [] })         // 只清抽取记录
chrome.storage.local.set({ coverColors: {} })     // 只清封面主色缓存
```

界面上只有「清空」（只清已处理的记录，保留待看）和「更换账号」（只清 uid），
调试时用上面的命令更彻底。彻底重来也可以在 `chrome://extensions` 里移除扩展再加载。

`tests/harness/env.js` 是一个假的 `chrome.*` 环境，它让真实的后台脚本与
content script 能在 Node 里跑完整链路，不依赖浏览器和豆瓣账号。

没有构建步骤。源码是原生 ES Module，改完直接在 `chrome://extensions` 点刷新即可。

```
manifest.json
src/
  background/   service worker：编排同步、读写 storage
  content/      注入 *.douban.com：同站请求 + 分页循环
  sidepanel/    侧边栏界面
  lib/          纯逻辑：模型归一化、抽取、历史、缓存判定
tests/          node --test
scripts/        verify.mjs
```

## 它是怎么工作的

豆瓣没有公开 API。扩展用的是移动端的收藏接口：

```
GET https://m.douban.com/rexxar/api/v2/user/{uid}/interests
    ?type=movie|book&status=mark&start=0&count=50
Referer: 任意非空值（必须存在，否则 400）
```

关键约束与对策：

- **必须带登录态**。扩展在 `*.douban.com` 页面里注入 content script 发请求，同站 cookie 自动携带，Referer 天然合规。不申请 `cookies` 权限，也不碰 cookie 值。
- **service worker 会休眠**。所以分页循环跑在 content script 里，service worker 只负责开标签页、下指令、收结果。
- **`type=movie` 混着剧集**，用条目的 `type === 'tv'` 区分。
- 请求串行，页间隔 1200ms，遇 429 立即停止。
- **最短更新间隔 10 分钟**：即使点手动同步也不能突破，成功同步后才开始计时（失败可立即重试）。所有参数集中在 `src/lib/config.js`。

## 数据与隐私

- 只在 `chrome.storage.local` 里存：uid、候选条目、抽取历史。
- 权限只有 `storage`、`sidePanel`，以及 `https://*.douban.com/*` 的 host 权限。
- 不写入豆瓣：不改标记、不打分、不写短评。

## 文档

- `ROADMAP.md`：v2 的候选来源、待验证接口、兜底路径。
- `docs/compliance.md`：法律与平台风险说明（不构成法律意见）。
- `docs/store-listing.md`：Chrome Web Store 上架材料。
- `docs/promotion.md`：阮一峰周刊与小红书投稿文案。
- `PRIVACY.md`：隐私政策。
- `openspec/specs/`：四个能力的行为契约。
- `openspec/changes/archive/`：已归档的 change（含 v1 的设计与任务记录）。
- `CLAUDE.md`：给 agent 会话的项目上下文。

## 许可证

MIT，见 [LICENSE](LICENSE)。

本项目是非官方工具，与豆瓣（北京豆网科技有限公司）无任何关联。
