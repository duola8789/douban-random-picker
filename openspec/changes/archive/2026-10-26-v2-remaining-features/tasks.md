## 1. 同步维度

- [x] 1.1 `cache.js` 的 `DIMENSIONS` 增加 `movie:done`、`book:done`，`allDimensionKeys()` 返回四个键；验证 `npm test` 通过且维度断言为 4
- [x] 1.2 `sync.js` 的 `fetchDimension()` 改为下发 `status: dimension.status`，去掉写死的 `'mark'`；验证首次同步后 `caches` 中出现四个维度，且 done 维度有数据
- [x] 1.3 侧边栏页签计数与 `summarizeCaches()` 兼容四个维度；验证页签数字等于该类别 mark 与 done 之和

## 2. 候选池与卡片

- [x] 2.1 `picker.js` 的 `pick()` 接受 `hidden` 参数，在去重窗口与 done 排除之后过滤；新增单测覆盖「屏蔽的条目不被抽中」
- [x] 2.2 `service-worker.js` 的 `handlePick()` 读取 `hidden` 并传入 `pick()`；验证屏蔽后抽取不再命中该条目
- [x] 2.3 待看卡片的 eyebrow 在 `markStatus === 'done'` 时显示「重温」；验证抽到看过的条目时卡片文案正确
- [x] 2.4 记录页保持「来自看过 / 来自想读」的来源措辞，不出现「来自重温」；验证两种状态各看一条

## 3. 屏蔽存储与消息

- [x] 3.1 `storage.js` 增加 `hidden` 的读取与写入，默认 `{}`；验证 `readAll()` 返回 `hidden`
- [x] 3.2 `messages.js` 增加 `GET_CANDIDATES`、`HIDE_CANDIDATES`、`UNHIDE_CANDIDATES`；验证 `npm run check` 通过
- [x] 3.3 `service-worker.js` 实现 `handleGetCandidates()`：返回按类别分组的条目、hidden、pendingKeys
- [x] 3.4 `service-worker.js` 实现 `handleHideCandidates(keys)`：跳过 `pending` 的 key，返回实际屏蔽与跳过两份 key
- [x] 3.5 `service-worker.js` 实现 `handleUnhideCandidates(keys)`：移除屏蔽记录
- [x] 3.6 `sync.js` 在同步成功后执行 `cleanHidden()`：删除屏蔽超过 90 天且不在任何缓存中的记录；单测覆盖「超过 90 天且已消失」「超过 90 天但仍存在」两个分支

## 4. 候选池页

- [x] 4.1 新建 `src/candidates/index.html`、`candidates.css`、`candidates.js`，三个页签与列表骨架；验证页面可打开且三个页签各自只有本类别条目
- [x] 4.2 行渲染：标题、标记时间、我的评论、来源标签、豆瓣跳转；验证有评论与无评论两种情况都不塌陷
- [x] 4.3 筛选：来源、标记时间范围、是否有评论，取交集并显示结果数量；验证组合筛选与空状态
- [x] 4.4 单条屏蔽、勾选多选、按当前筛选批量屏蔽；验证待看行不可勾选、批量确认框显示数量
- [x] 4.5 「已屏蔽」视图：列出屏蔽时间、支持恢复与清除失效记录；验证恢复后条目回到默认视图
- [x] 4.6 侧边栏增加入口，打开时停在当前类别；验证点击后新标签打开且页签正确
- [x] 4.7 候选池页的屏蔽操作完成后，回到侧边栏抽取不再命中被屏蔽条目

## 5. 历史筛选与导出

- [x] 5.1 记录页增加类别与来源筛选，显示结果数量与清除入口；验证组合筛选与空状态
- [x] 5.2 记录页增加导出按钮，导出当前列表为 JSON，文件名带日期；验证下载文件名与内容
- [x] 5.3 校验导出内容只含记录字段，不含任何凭证或页面数据

## 6. 封面适配

- [x] 6.1 竖排布局下封面水平居中；在 430px 以下验证右侧不再整块留白
- [x] 6.2 宽度小于 300px 时封面缩至 108×162；验证 240px 下卡片不出现横向溢出
- [x] 6.3 在 240 / 360 / 430px 三种宽度截图验收

## 7. 帮助与版本

- [x] 7.1 帮助内容补充「屏蔽 = 不再抽它，记录 = 抽过什么」；验证帮助面板可见该说明
- [x] 7.2 `manifest.json` 与 `package.json` 版本升到 `0.7.0`；验证 `chrome://extensions` 显示 0.7.0

## 8. 验收

- [x] 8.1 `npm run verify` 全部通过
- [x] 8.2 真机走一遍：同步完成后页签数字包含看过的条目；抽到看过的条目显示「重温」
- [x] 8.3 真机走一遍屏蔽：候选池页屏蔽若干条、恢复一条、批量屏蔽时待看条目被跳过
- [x] 8.4 真机走一遍历史：按类别筛选、导出 JSON、打开文件确认内容
