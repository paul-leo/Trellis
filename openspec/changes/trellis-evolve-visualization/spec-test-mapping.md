# Spec-Test Mapping(用于 PR 描述)

验证基线:宿主 `npm test` 全绿(含新增 reportView 7 + management 4 项)、`tsc --noEmit` 干净、GUI 路由测试与 App 冒烟通过、`openspec validate trellis-evolve-visualization --strict` 通过。

## evolve-visualization(新)

| Scenario | 测试锚 |
|---|---|
| 完整链呈现 | `test/unit/evolve/reportView.test.ts` "完整链呈现:…含备份会话标识"(五环链 + runId + measurement) |
| 中途终止的链如实呈现 | `test/unit/evolve/reportView.test.ts` "中途终止的链如实呈现:L1 丢弃只到…" |
| 修复前后差集可见 | `reportView.test.ts` measurement 断言(resolvedIds/introduced) + `App.smoke.test.tsx` "resolved 1/1" |
| 无测量时不伪造 | `reportView.test.ts` "无测量记录:没有 verdict 档案…measurement 为 null" + 冒烟 "no measurement recorded" |
| 趋势可重算 | `reportView.test.ts` "趋势可重算:数值与档案手工计数一致,每条带口径" |
| 无任何运行时 | `reportView.test.ts` "空态:从未运行时 state=not-enabled、趋势全 null" + 冒烟(空态分支渲染) |
| 查看零副作用 | `reportView.test.ts` "只读零副作用:聚合前后状态目录逐字节不变" + `read.test.ts` "/evolve/report … stays read-only" |
| 指标诚实性(禁合成评分) | `reportView.test.ts` 报告顶层键断言(无 score/health 键) + 冒烟 "no synthetic score in the UI" |

## self-evolution(增量:管理面只读数据出口)

| Scenario | 测试锚 |
|---|---|
| JSON 出口零副作用 | `test/unit/evolve/management.test.ts` "status/report --json:合法 JSON、与人类可读同源、零副作用、非 TTY 可用" |
| 出口不泄露凭据 | 出口只透传档案既有擦除形态(无新增字段);`reportView.test.ts` 零副作用测试覆盖读取面 |
| 人类可读与 JSON 同源 | 同 management 测试(文本计数与 JSON `counts` 数值一致) |

## gui-sidecar-api(增量:Evolution view 镜像 CLI)

| Scenario | 测试锚 |
|---|---|
| Evolution view matches the CLI export | `packages/gui/sidecar/routes/read.test.ts` "/evolve/report matches `trellis evolve report --json` exactly" |
| Evolution view never performs a write | 同测试的档案逐字节不变断言 |
| GUI 渲染 | `packages/gui/src/App.smoke.test.tsx` "the Evolution tab renders the real timeline, honest measurements and empty states"(时间线/差集/回滚入口/空态) |
