# douban-session Specification

## Purpose
复用用户浏览器中已有的豆瓣登录态，让扩展能够读取本人标记的收藏，并在登录失效时给出明确、可操作的提示，同时不索取、不存储任何凭证。

## Requirements

### Requirement: 通过页面上下文复用登录态

The system SHALL 在 `*.douban.com` 页面的上下文内发起**需要登录态**的豆瓣数据请求（收藏列表、登录探测），使浏览器自动携带同站凭证。

不需要登录态的公开数据（条目详情）MAY 直接从扩展发出：此时由 `declarativeNetRequest` 补上 `Referer`，
并由 host 权限允许读取跨域响应；直连失败时 SHALL 退回页面上下文重试。

The system MUST NOT 读取、缓存、记录或重新拼装任何 cookie 值，MUST NOT 模拟登录表单，MUST NOT 处理用户的账号密码。

#### Scenario: 复用已登录的浏览器会话

- **WHEN** 用户已在浏览器中登录豆瓣，且同步被触发
- **THEN** 系统 SHALL 在一个 `*.douban.com` 页面上下文中发出数据请求
- **AND** 请求 SHALL 携带与直接访问豆瓣网页一致的登录态，无需用户额外操作

#### Scenario: 当前没有豆瓣标签页

- **WHEN** 同步被触发且浏览器中没有任何 `*.douban.com` 标签页
- **THEN** 系统 SHALL 临时创建一个不抢占焦点的后台标签页用于执行同步
- **AND** 同步结束或失败后 SHALL 关闭该临时标签页

#### Scenario: 不向用户索取凭证

- **WHEN** 用户在任意界面中使用本扩展
- **THEN** 系统 MUST NOT 出现粘贴 cookie、输入豆瓣账号或密码的入口
- **AND** 扩展的权限清单 MUST NOT 包含 `cookies`

### Requirement: 获取用户 uid

系统 SHALL 获取并持久化用户的豆瓣 uid，用于构造收藏请求。

系统 MUST NOT 通过解析 cookie 内容推断 uid。

#### Scenario: 自动探测成功

- **WHEN** 用户已登录豆瓣且尚未配置 uid
- **THEN** 系统 SHALL 通过访问豆瓣的「我的」入口并读取最终重定向地址来获得 uid
- **AND** SHALL 将 uid 持久化，后续不再重复探测

#### Scenario: 自动探测失败

- **WHEN** 自动探测未能得到合法的 uid
- **THEN** 系统 SHALL 引导用户粘贴其豆瓣个人主页链接
- **AND** 粘贴的链接无法解析出 uid 时 SHALL 提示格式错误且不保存

### Requirement: 判定登录状态并提示失效

系统 SHALL 区分「登录态无效」与「用户确实没有标记任何条目」两种情况。

当数据请求返回未认证状态码，或返回空结果而登录态无法确认时，系统 SHALL 提示「登录已失效，请在豆瓣网页重新登录」并提供打开豆瓣登录页的操作。

系统 MUST NOT 将登录失效导致的空结果呈现为「没有可抽取的条目」。

#### Scenario: 接口返回未认证

- **WHEN** 数据请求返回未认证状态码
- **THEN** 系统 SHALL 在界面上显示登录失效提示与重新登录入口
- **AND** SHALL NOT 清空已有的历史缓存

#### Scenario: 请求成功但结果为空

- **WHEN** 数据请求成功返回，条目数为零
- **THEN** 系统 SHALL 提示该类别下没有标记条目，并引导用户前往豆瓣添加
- **AND** 若同时无法确认登录态，SHALL 优先呈现登录相关的提示

### Requirement: 更换账号

系统 SHALL 提供更换账号的入口。更换账号 MUST NOT 在扩展内登录或退出豆瓣，SHALL 依赖用户在浏览器里切换登录态。

用户确认更换账号时，系统 SHALL 清空本地旧账号的同步缓存、移出记录与抽取历史，并清除已保存的 uid，然后重新探测当前登录的账号。

清空 SHALL 在重新探测之前完成，MUST NOT 在同步进行中执行。

确认前，系统 SHALL 说明需要先在豆瓣网页切换账号，并说明旧账号的本地数据会被清空。

粘贴个人主页地址 SHALL 只用于确定 uid，MUST NOT 被当作登录手段；提示文案 SHALL 说明登录状态仍由浏览器里的豆瓣会话决定。

#### Scenario: 确认更换

- **WHEN** 用户点击更换账号并确认
- **THEN** 系统 SHALL 清空缓存、移出记录与抽取历史
- **AND** SHALL 清除 uid 并重新探测
- **AND** 探测成功后 SHALL 重新进入首次加载选择

#### Scenario: 同步进行中

- **WHEN** 同步正在进行时用户尝试更换账号
- **THEN** 系统 MUST NOT 清空任何数据
- **AND** SHALL 提示稍后再试

#### Scenario: 粘贴地址只确定用户 ID

- **WHEN** 自动探测失败，用户粘贴自己的个人主页地址
- **THEN** 系统 SHALL 只从中解析 uid
- **AND** MUST NOT 因此认为用户已经登录
- **AND** 登录状态仍 SHALL 由浏览器里的豆瓣会话决定
