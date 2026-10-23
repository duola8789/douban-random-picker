## Purpose

记录用户每次抽取的结果，供随时回看，并作为「不连续抽到同一条」的去重依据；所有记录仅保存在本地。

## ADDED Requirements

### Requirement: 记录抽取事件

系统 SHALL 在每次成功抽取后追加一条历史记录。

每条记录 SHALL 包含条目标识、标题、封面地址、所属类别、来源类别开关状态与抽取时间。

系统 MUST NOT 在历史记录中保存任何豆瓣账号凭证或 cookie 内容。

#### Scenario: 成功抽取后写入

- **WHEN** 用户完成一次抽取并得到结果
- **THEN** 系统 SHALL 写入一条包含条目标识与时间的记录

#### Scenario: 抽取失败不写入

- **WHEN** 抽取因候选池为空或同步未完成而未能产出结果
- **THEN** 系统 MUST NOT 写入历史记录

### Requirement: 展示历史

侧边栏 SHALL 展示最近若干条抽取记录，按时间倒序排列。

每条记录 SHALL 可点击跳转至对应的豆瓣条目页。

#### Scenario: 查看历史

- **WHEN** 用户打开侧边栏且本地已有历史记录
- **THEN** 界面 SHALL 展示按时间倒序的记录列表
- **AND** 点击任一条目 SHALL 打开对应豆瓣页面

#### Scenario: 尚无历史

- **WHEN** 用户从未抽取过
- **THEN** 历史区域 SHALL 显示空状态提示，MUST NOT 显示空白区块

### Requirement: 提供去重窗口

系统 SHALL 向抽取能力提供最近 N 条记录的条目标识，N 默认为 20。

去重窗口的内容 SHALL 随新记录写入而更新。

#### Scenario: 窗口随记录滚动

- **WHEN** 新的抽取记录写入后，记录总数超过窗口大小
- **THEN** 去重窗口 SHALL 只包含最近的 N 条，最早的一条移出窗口

#### Scenario: 清空历史后窗口失效

- **WHEN** 用户清空全部历史
- **THEN** 去重窗口 SHALL 变为空，抽取不再排除任何条目

### Requirement: 容量与清理

历史记录 SHALL 有固定的保留上限，超出上限时移除最旧的记录。

用户 SHALL 能清空全部历史记录，清理为即时生效且不可撤销。

#### Scenario: 超出保留上限

- **WHEN** 记录数超过保留上限
- **THEN** 系统 SHALL 自动移除最旧的记录，使总数回到上限以内

#### Scenario: 用户清空历史

- **WHEN** 用户点击清空历史并确认
- **THEN** 全部记录 SHALL 被移除
- **AND** 界面 SHALL 立即反映空状态
