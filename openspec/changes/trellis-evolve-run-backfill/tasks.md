# Tasks

## 1. 手动触发入口

- [ ] 1.1 抽共享作业壳 `runJobShell(homeDir, { trigger: "event"|"manual"|"chain", ... })`:抢锁/释放、job-run 档案落盘(含 trigger 字段)、错误收口,jobMain 改为调用该壳;旧档案无 trigger 字段时消费端视作 `event`。
- [ ] 1.2 `evaluateTrigger` 增 `bypass: { threshold, cooldown }` 纯输入(缺省 false,事件路径语义逐字不变);`tryLaunchJob` 透传并把判定档案记来源。
- [ ] 1.3 `trellis evolve run [--dry-run]`:前台调 runJobShell(`trigger: "manual"`);dry-run 打印将消费的信号数/护栏判定而不抢锁不写档案;observe 及以下零副作用早退并在输出说明;USAGE 更新;TTY 门不设(只读语义之外的手动触发是显式动作,但输出走 stdout)。
- [ ] 1.4 单元测试:bypass 组合矩阵、run 的护栏跳过记因、dry-run 零副作用(状态目录逐字节不变)、observe 早退说明、job-run 带 trigger 字段。

## 2. 补跑标记(单槽 coalesce)

- [ ] 2.1 `evolve/run-request.json` 置位幂等 + CAS 读后删消费(与 isJobRunning 的 compare-and-delete 同款,0600/0700 一致);`setRunRequest`/`consumeRunRequest` 落在 trigger.ts。
- [ ] 2.2 接线:运行中触发(手动或事件)→ 置标记 + 记 trigger-decision(already-running 照旧,附 note);任何作业启动即清标记;runJobShell 收尾释锁后消费标记 → spawn 下一 jobMain(`trigger: "chain"`)。
- [ ] 2.3 测试:多次请求塌缩为一个标记、收尾链起至多一跳、无标记不链、标记残留/丢失的崩溃语义、chain 作业同受预算护栏。

## 3. 历史数据导入

- [ ] 3.1 `src/evolve/importHistory.ts` 适配器契约(`sniff`/`extract`)与首个适配器 `claude-code-jsonl`:transcript 记录 → 白名单元数据(timestamp/agent/session/tool/结果类别;缺字段缺省 null),坏行跳过计数;`ImportedEntry` 经 `eraseSecrets` 后写入。
- [ ] 3.2 台账幂等:`evolve/imports/<sha256>.json` 记 `{ sourceDigest, entries, importedAtMs, layer }`;已记账源再导入为空操作;stableId `import:<digest12>:<序号>`、source `history-import`(types.ts 枚举放宽);`--workspace` 可选层归属。
- [ ] 3.3 `trellis evolve import <path>...`:仅显式路径、源只读;整批先 extract 校验后写入,sniff 不匹配非零退出零写入;导入不拉起任何作业;USAGE 更新。
- [ ] 3.4 测试:白名单(载荷不入库)、凭据擦除、重复导入空操作、不可解析零写入、导入后 run 消费导入信号产提案、重复消费提案 id 稳定不重复进 pending。

## 4. 报告透传与收口

- [ ] 4.1 reportView/jobRuns 透传 `trigger` 字段(缺省 `event`);CLI 报告文本标注手动/补跑运行;GUI 不改(EvolutionView 已忽略未知字段,冒烟补一条 trigger 标注断言即可)。
- [ ] 4.2 `openspec validate trellis-evolve-run-backfill --strict`;宿主 `npm test` + `tsc --noEmit`;GUI `test:smoke`;引擎不涉。
- [ ] 4.3 文档:`docs/self-evolution.md` 增"手动触发与历史回填"节(门语义、补跑语义、导入边界);spec-test-mapping:场景 → 测试映射表(沿用既有格式)。
