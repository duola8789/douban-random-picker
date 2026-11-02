## ADDED Requirements

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
