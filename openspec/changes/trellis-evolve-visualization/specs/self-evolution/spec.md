# Spec Delta

## ADDED Requirements

### Requirement: 管理面只读数据出口
系统 SHALL 在管理面提供结构化 JSON 出口:`trellis evolve status --json` 输出级别、提案计数与最近自动采纳通知;`trellis evolve report [--json]` 输出聚合的进化报告(事件时间线、每条提案的前后测量、趋势指标)。出口数据 SHALL 只从运行档案、pending 存储与级别策略聚合,SHALL NOT 触发观察、提案、probe 或任何写入,SHALL NOT 包含凭据材料。同一份聚合逻辑 SHALL 同时服务人类可读输出与 JSON 输出,不维护第二份独立计算。

#### Scenario: JSON 出口零副作用
- **WHEN** 执行 `trellis evolve report --json`
- **THEN** 输出合法 JSON,且档案、信号目录、pending 存储与 evolve.yaml 在执行前后逐字节不变

#### Scenario: 出口不泄露凭据
- **WHEN** 档案或 pending 中存在含凭据形态内容的记录
- **THEN** JSON 出口中的相应字段保持档案内已擦除的形态,不引入任何新的明文

#### Scenario: 人类可读与 JSON 同源
- **WHEN** 分别执行 `trellis evolve status` 与 `trellis evolve status --json`
- **THEN** 两者呈现的级别、计数与通知来自同一次聚合,数值一致
