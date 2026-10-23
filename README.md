# 豆瓣随机一部

从你标记的「想看 / 想读」里随机抽一个的 Chrome 扩展。点一下工具栏图标，侧边栏打开，抽一部电影、一部剧，或者一本书。

## 它做什么

- 候选来自你本人的豆瓣收藏：标记为**想看**的电影与剧集、标记为**想读**的图书。
- 电影 / 剧集 / 图书三个开关，默认全选；多选时每个类别被抽中的概率相同。
- 抽中后展示封面、标题、年份、豆瓣评分、你的评分与短评，一键跳到豆瓣条目页。
- 记住抽过什么，最近的不会重复抽到。
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
npm test        # 纯逻辑单测（抽取算法、去重窗口、冷却期、归一化、缓存判定）
npm run check   # 语法检查
node scripts/verify.mjs   # 静态自检：manifest 引用、权限、import、禁用 API
npm run verify  # 上面三件事一起跑
npm run icons   # 重新生成扩展图标（不依赖图形库）
npm run package # 打包成可上传 Chrome Web Store 的 zip
```

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
- `openspec/changes/v1-random-picker/`：v1 的 proposal、design、specs、tasks。
- `CLAUDE.md`：给 agent 会话的项目上下文。

## 许可证

MIT，见 [LICENSE](LICENSE)。

本项目是非官方工具，与豆瓣（北京豆网科技有限公司）无任何关联。
