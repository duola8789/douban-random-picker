## MODIFIED Requirements

### Requirement: 展示历史

侧边栏 SHALL 只展示最近 3 条记录，三个类别共用同一份列表，按时间倒序排列。

侧边栏 SHALL 提供入口，在新标签页打开完整的记录页；完整记录页 SHALL 展示全部记录（上限由保留上限决定），并支持筛选。

每条记录 SHALL 显示类别、标题、来源、决定状态与精确到分钟的抽取时间。

来源 SHALL 以「来自想看 / 来自想读」的形式写入副标题，与类别、时间并列；
决定状态 SHALL 以标签呈现。

来源不采用标签，是因为记录行同时出现来源与状态两个标签时，读者无法区分二者含义。

每条记录 SHALL 可点击跳转至对应的豆瓣条目页。

当记录内容未发生变化时，侧边栏 MUST NOT 重建列表——否则切换类别页签时列表会闪烁。

#### Scenario: 侧边栏查看最近记录

- **WHEN** 用户打开侧边栏且已有记录
- **THEN** 侧边栏 SHALL 只展示最近 3 条，标明类别与「待看 / 跳过 / 看过」
- **AND** 时间 SHALL 显示为「今天 HH:mm」或「MM-DD HH:mm」

#### Scenario: 查看全部记录

- **WHEN** 用户点击「查看全部记录」
- **THEN** 系统 SHALL 在新标签页打开完整记录页
- **AND** 该页面 SHALL 展示全部记录与总数

#### Scenario: 切换类别页签

- **WHEN** 用户在类别页签之间切换，而记录内容没有变化
- **THEN** 记录列表 MUST NOT 重新渲染或闪烁

#### Scenario: 尚无历史

- **WHEN** 用户从未抽取过
- **THEN** 历史区域 SHALL 显示空状态提示，MUST NOT 显示空白区块

## ADDED Requirements

### Requirement: 记录页筛选

完整记录页 SHALL 支持按类别与来源筛选。

筛选后 SHALL 显示筛选结果的数量，并保留一个清除筛选的入口。

筛选结果为空时 SHALL 显示说明性的空状态，MUST NOT 展示空白列表。

#### Scenario: 按类别筛选

- **WHEN** 用户选择「图书」
- **THEN** 列表 SHALL 只包含图书类别的记录

#### Scenario: 按来源筛选

- **WHEN** 用户选择「来自想看」
- **THEN** 列表 SHALL 只包含在豆瓣标记为想看 / 想读的记录

#### Scenario: 清除筛选

- **WHEN** 用户清除筛选条件
- **THEN** 列表 SHALL 恢复为全部记录

### Requirement: 导出记录

完整记录页 SHALL 提供导出操作，把当前列表导出为 JSON 文件。

导出内容 SHALL 与当前筛选结果一致；没有筛选时即为全部记录。

导出内容 MUST NOT 包含任何豆瓣账号凭证、cookie 或页面内容。

导出文件名 SHALL 包含日期。

#### Scenario: 导出全部记录

- **WHEN** 用户在未筛选状态下执行导出
- **THEN** 系统 SHALL 下载一个包含全部记录的 JSON 文件
- **AND** 文件名 SHALL 带当日日期

#### Scenario: 导出筛选结果

- **WHEN** 用户在筛选后执行导出
- **THEN** 导出的内容 SHALL 只包含当前筛选结果
