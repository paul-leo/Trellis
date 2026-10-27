# Design

## Context

现有执行面是 daemon-less 的:会话边界上 `tryLaunchJob` 过阈值/冷却/预算四道门后 spawn 一次性 `jobMain`,作业自持 `evolve/job.lock`(单飞,抢不到静默退出、不排队),收尾落 job-run 档案;信号以"上次作业的信号合并时刻"为水位线消费一次;提案 id `rule-<findingId>` 同源去重。观察信号是字段白名单 + secrets 擦除的元数据(见 self-evolution「观察只记录元数据」)。当前缺口:无手动触发入口;运行中的触发被丢弃(无补跑);观察面在扩展装载之前的历史会话不可见。动机见 proposal.md。

## Goals / Non-Goals

**Goals:**
- `trellis evolve run`:即刻跑一次作业体(或因护栏跳过并如实报因),可 `--dry-run` 预览。
- `trellis evolve import <path>...`:把用户选定的既有 session 数据幂等回填为观察信号,供后续作业消费。
- 补跑语义:运行中请求不丢、不重(单槽塌缩),全程无常驻进程。

**Non-Goals:**
- 入库任何入参/结果载荷或自由文本正文(白名单不变,老数据同样只取元数据)。
- 常驻队列/worker/FIFO 排队;多请求保序执行。
- 除 Claude Code 会话 JSONL 之外的源适配器(Kimi/Codex/ZCode 日志后置,契约先行)。
- 自动爬取家目录或未被显式选中的路径;GUI 新视图;引擎包改动。

## Decisions

**D1 手动 run:CLI 前台跑同一作业体,不另写执行路径。**
`run` 复用 `runEvolveJob` 与既有 shell 语义(抢锁 → 跑 → 落 job-run 档案 → 释锁),把 jobMain 的壳逻辑抽成共享 `runJobShell(homeDir, { trigger })` 供两个入口调用;job-run payload 增 `trigger: "event" | "manual" | "chain"`。前台执行让用户即刻看到摘要;弃"spawn 后盲等档案"方案(无处可流式输出)。jobMain 仍是唯一 detached 入口(链起用)。

**D2 手动触发的门:绕过阈值/冷却,不绕过锁与预算。**
`evaluateTrigger` 增 `bypass: { threshold, cooldown }` 纯输入(缺省全 false,事件路径不变):手动路径阈值/冷却视为通过;`jobRunning` → 不启动,置补跑标记(D3);日提案上限/editor 预算仍生效,超限 skip 并把 `trigger-decision` 记为 manual 来源。弃"完全绕过所有门"(预算护栏是硬承诺)与"新增 --force 旗标"(本期不放)。

**D3 补跑:单槽 coalesce 标记,不是队列。**
`evolve/run-request.json`(`{ reason, setAtMs, count }`):置位幂等(count 仅审计);消费 = CAS 读后删(与 `isJobRunning` 的 compare-and-delete 同款)。消费点:① `runJobShell` 收尾、释锁后——标记在则清标记并 spawn 下一个 `jobMain`(`trigger: "chain"`);② 任何一次作业启动(手动/事件)即清标记(请求已被满足)。无常驻消费方,崩溃丢失至多一次补跑请求(下次事件/手动自然补),残留标记至多多跑一次(提案去重兜底)。链起天然有界:每跳消费一个标记,无标记不链。弃 FIFO 队列(无人出队,违背 daemon-less)与"运行中阻塞等待"(CLI 挂死)。

**D4 导入:适配器契约 + 台账幂等,写入走既有信号存储。**
新增 `src/evolve/importHistory.ts`:适配器 `{ name, sniff(path): boolean, extract(path): Iterable<ImportedEntry> }`,首个适配器 `claude-code-jsonl`(transcript 每条记录 → 白名单元数据:timestamp/tool 名/is_error→结果类别/会话 id=文件名;无耗时字段则缺省 null)。台账 `evolve/imports/<sha256(内容)>.json`(`{ sourceDigest, entries, importedAtMs, layer }`):已记账的源再导入为空操作。信号 stableId `import:<digest 前 12 位>:<序号>`、source `history-import`(types 放宽枚举);层归属 `--workspace` 可选,缺省全局。写入复用 recorder 的 append(0600、并发安全、坏行跳过);整批先 extract 校验、后写入,不可解析即非零退出且零写入。弃"直接解析入库当新信号类型"(破坏白名单/擦除单点)与"只记源文件偏移不记摘要"(内容变化时偏移漂移)。

**D5 报告透传不改结构。**
job-run 的 `trigger` 字段由 reportView/jobRuns 原样透传(EvolutionView 已声明未知字段忽略);导入本身不进时间线(它不是进化动作),信号消费痕迹体现为提案链。弃"导入也进 timeline"(会让用户把数据加载误读为进化步骤)。

## Risks / Trade-offs

- [链起连跑] 大量补跑请求理论上逐跳消费 → 单槽塌缩保证至多"请求波次"次运行;日提案上限控产出;每跳均入 trigger-decision/job-run 档案可审计。
- [手动绕过冷却被滥用] 提案刷量 → 日提案上限/editor 预算硬拦,超限跳过记因;上限可由用户在 `trigger:` 段自行调整。
- [导入体量大(数千条 JSONL)] 一次命令写入慢/半途中断 → 逐条 append + 台账最后记账;中断重跑安全(未记账则重导,提案去重兜底)。
- [JSONL 坏行/异形] 解析异常 → 坏行跳过计数(与 recorder 容错一致),sniff 不匹配整批拒绝。
- [补跑标记语义与"超限不排队"条款的张力] 预算超限仍然跳过不排队(不变);补跑标记只覆盖"运行中"这一情形,spec 已分开措辞。
- [Claude Code transcript 格式漂移] 适配器以 sniff+字段缺省容忍;解析失败收口不写入。

## Migration Plan

无状态迁移:全部新文件/新档案 kind;旧 job-run 无 `trigger` 字段时报告视作 `event`。升级即用;回滚 = 不调用新命令,存量行为逐字节不变(补跑标记文件无消费方时自然闲置,删除即净)。

## Validation

单元:evaluateTrigger bypass 组合、coalesce 塌缩/CAS 消费、runJobShell 两入口共享语义、import 幂等/擦除/白名单/坏行/不可解析零写入、提案 id 跨重复消费稳定。集成:临时 HOME 下 `run` 全链(含 --dry-run 零副作用)、`import` 后 `run` 消费导入信号产提案且重跑无重复 pending。回归:管理面其余命令零副作用、事件触发路径断言不变。
