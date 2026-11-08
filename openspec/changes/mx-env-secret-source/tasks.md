# Tasks

## 1. `@morphixai/mxenv-core` SDK 出口（前置，独立发版 0.12.0）

- [x] 1.1 `src/index.ts` 导出 refs 机制（`MxEnvReference`/`findMxEnvReferences`/`hasMxEnvReference`/`ReferenceResolver`/`ReferenceResolution`/`UnresolvedReference`）+ 既有 index 测试覆盖导出面；验证：`npm test` 全绿（**已由 morphix-env Wave A 三包发布满足，2026-11-07**：refs 机制落 `packages/mxenv-core/src/refs.ts`，`@morphixai/mxenv-core@0.12.0` dist 具名导出实测含全部六个符号）
- [x] 1.2 CHANGELOG（Added：SDK 引用 API）+ 版本 0.12.0 发版（发版 PR → tag → publish → 本机双安装）；验证：`npm view morphix-env@0.12.0` 可见（**已满足，2026-11-07**：`@morphixai/mxenv-core@0.12.0` 已发布可解析；注意依赖名以 scoped 为准——原 `morphix-env`/unscoped `mxenv-core` 已 deprecate 指向新名）

## 2. Trellis 核心（src/lib/secretEnv.ts 及类型）

- [x] 2.1 `parseEnvEntry(entry)`：整串匹配 `mxenv://<profile>/<KEY>`（复用 `@morphixai/mxenv-core` 导出的语法）→ `{ kind: 'ref', profile, key, delivered }`，裸名 → `{ kind: 'name', delivered }`，含 `mxenv://` 但不合法（含被 SDK 拒绝的旧 scheme 形态）→ `{ kind: 'invalid' }`；验证：单元测试三类
- [x] 2.2 `resolveSecretEnv` 异步化：ref 条目经 `@morphixai/mxenv-core` SDK（`loadConfigLayers({cwd: homedir(), homeDir: homedir()})` + `composeEnvironment`，每次调用组合一次）解析，按 delivered name 记账；裸名保持 env_file/ambient 既有语义（含 env_file sole-source 规则）；验证：单测覆盖 ref 解析、ambient 不遮蔽 ref、缺失 → undefined、env_file 不变
- [x] 2.3 全部调用点 `await` 化与 delivered-name 记账（mcpPlan/mcpConnect/workspaceDoctor/oauth store/secretsAudit/mcpAuth/pi-bridge）；验证：`npm run build` + 既有测试全绿

## 3. 消费面

- [x] 3.1 `resolveMcpPlan` 预检与渲染：ref 条目按 delivered name 生成 `${KEY}` 引用（原生客户端渲染）+ 预检经 SDK 验证可解析；invalid 条目产生 scoped conflict；验证：mcpPlan 单测（含 Codex/Claude 渲染断言）
- [x] 3.2 pi bridge stdio 注入：ref 值按 delivered name 注入子进程 env，绝不以 ref 文本作变量名；验证：bridge 单测
- [x] 3.3 `trellis secrets audit`：收集 ref/invalid 条目并出对应 findings（missing-env-value / malformed-reference）；验证：audit 单测

## 4. 文档与本机迁移

- [x] 4.1 `schema/servers.example.yaml` + `secrets.policy.example.yaml` 文档引用形态与 delivered-name 规则；`secrets.policy.example.yaml` 的 env_file 警告补充"更推荐 mxenv:// 引用"；验证：文档与 spec 一致
- [x] 4.2 本机迁移：`~/.trellis/secrets.policy.yaml` 移除悬空 `env_file`；`minimax` 条目改 `env: ["mxenv://legacy/MINIMAX_API_KEY"]`；验证：`trellis secrets audit` 无 missing、`mcp sync` dry-run 不拒 MINIMAX_API_KEY、minimax MCP 实调一个工具成功
- [x] 4.3 `scripts/sandbox.sh` 夹具补 ref 场景跑通；全量测试 + 双视角 review；发版 `agent-trellis` 0.21.0
