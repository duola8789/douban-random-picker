## MODIFIED Requirements

### Requirement: 记录状态流转

一条待看记录 SHALL 只能被改判为「跳过」或「看过」一次，并记录处理时间。

改判 MUST NOT 删除或复制该记录。

「看过」由「标记完成」操作产生，改判为「看过」MUST NOT 受跳过额度限制。

#### Scenario: 标记为跳过

- **WHEN** 用户跳过一条待看
- **THEN** 该记录状态 SHALL 变为「跳过」并写入处理时间
- **AND** 记录 SHALL 保留在历史中

#### Scenario: 标记为看过

- **WHEN** 用户把一条待看标记为完成
- **THEN** 该记录状态 SHALL 变为「看过」并写入处理时间
- **AND** 记录 SHALL 保留在历史中

#### Scenario: 已处理的记录不再变化

- **WHEN** 对一条已不是待看的记录执行跳过或标记完成
- **THEN** 状态 SHALL 保持不变

## ADDED Requirements

### Requirement: 删除单条记录

完整记录页 SHALL 提供删除单条记录的操作。

删除 SHALL 经过二次确认。

状态为「待看」的记录 MUST NOT 被删除——否则删除就会成为重新抽取的绕过路径。

删除一条「看过」记录后，对应条目 SHALL 重新回到候选池。

#### Scenario: 删除已处理记录

- **WHEN** 用户在完整记录页删除一条状态为「跳过」或「看过」的记录
- **THEN** 该记录 SHALL 从历史中移除
- **AND** 其他记录 MUST NOT 受影响

#### Scenario: 待看不可删除

- **WHEN** 用户尝试删除一条状态为「待看」的记录
- **THEN** 系统 MUST NOT 删除该记录
- **AND** SHALL 说明它需要先被完成或跳过

#### Scenario: 删除后回到候选池

- **WHEN** 用户删除一条状态为「看过」的记录
- **THEN** 该条目 SHALL 重新成为候选
