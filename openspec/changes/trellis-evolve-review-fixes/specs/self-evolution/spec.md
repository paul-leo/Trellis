# Spec Delta

## ADDED Requirements

### Requirement: 批准即应用与显式应用入口
提案被批准后,系统 SHALL 在同一管理面命令调用内立即应用其全部编辑(经托管备份会话写入,运行档案记录备份会话标识),SHALL NOT 滞留等待下一次作业的应用阶段。应用 SHALL 幂等:已应用的提案不重复写入。当次应用失败或部分失败时,提案 SHALL 保持 `approved` 状态;系统 SHALL 提供显式应用入口(`trellis evolve apply`),只应用已批准未应用的提案,失败批次按编辑幂等语义重放,无事可做时零副作用(不开备份会话、不写档案);后续作业的应用阶段 SHALL 仍可消费滞留的已批准提案。批准输出、显式应用输出与自动采纳通知 SHALL 指明含真实备份会话标识的回滚命令,SHALL NOT 只有泛化回滚指引。应用 SHALL 与作业运行互斥:已有作业运行时,批准仍可完成决策,应用 SHALL 被暂缓并如实告知,由显式应用入口或后续作业的应用阶段收尾。

#### Scenario: 批准即应用
- **WHEN** 用户在交互式终端批准一条提案,且当前没有作业在运行
- **THEN** 该提案的编辑在同一命令内经备份会话写入,输出指明备份会话标识与真实回滚命令,提案不滞留待应用

#### Scenario: 应用失败保持已批准
- **WHEN** 批准后的应用写入部分失败
- **THEN** 提案保持 `approved` 状态,输出指明可回滚的真实备份会话标识,显式应用入口可重试(编辑幂等重放)

#### Scenario: 显式应用幂等
- **WHEN** 执行显式应用命令且不存在已批准未应用的提案
- **THEN** 零副作用:不开备份会话、不写档案、不触发同步

#### Scenario: 作业运行中暂缓应用
- **WHEN** 批准时恰有作业在运行
- **THEN** 决策照常完成,应用被暂缓并如实告知,提案保持 `approved` 等待显式应用或作业应用阶段

#### Scenario: 自动采纳通知含真实回滚标识
- **WHEN** auto-A 自动采纳一条 Class A 提案且作业应用阶段完成写入
- **THEN** 该提案的自动采纳通知中回滚命令含本次备份会话标识

## MODIFIED Requirements

### Requirement: 采纳的生效边界
采纳 SHALL 在 runtime 投递的 agent 上于其后续会话读取 canonical 时自然生效,无需额外同步;仅依赖原生渲染的 agent SHALL 在采纳后触发同步。系统 SHALL 在应用后向用户说明各 agent 的生效时点;该生效时点说明 SHALL 同时写入运行档案(应用运行条目),`trellis evolve report` 时间线 SHALL 可回放。

#### Scenario: runtime agent 下个会话读到新版本
- **WHEN** 一条 skill 编辑被采纳,随后某 runtime agent 开启新会话
- **THEN** 该会话读取到编辑后的 skill,无需用户运行同步

#### Scenario: 原生渲染 agent 触发同步
- **WHEN** 一条编辑被采纳且某 agent 仅有原生渲染产物
- **THEN** 系统为其触发同步并报告结果

#### Scenario: 生效说明入档可回放
- **WHEN** 一次应用运行向用户输出了各 agent 的生效时点说明
- **THEN** 同一说明存在于应用运行档案,`trellis evolve report` 的提案时间线可回放
