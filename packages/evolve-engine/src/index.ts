// @trellis/evolve-engine — harness2 引擎的 TypeScript 移植(阶段一内部包,不发 npm)。
// 移植顺序见 openspec/changes/trellis-evolve/tasks.md。
export * from "./tree.js";
export * from "./substrate.js";
export * from "./runmark.js";
export * from "./ledger.js";
export * from "./judge.js";
export * from "./spec.js";
export * from "./prompts.js";
// prompt-text.js 是 prompts 的生成物内部细节(常量经 prompts.ts 组装使用),不从根入口导出。
export * from "./context.js";
export * from "./library.js";
export * from "./sandbox.js";
export * from "./proposer.js";
// difflib.js 是 context 的 pool harness.diff 渲染内部细节,不从根入口导出。
export * from "./pyutil.js";
// pyrand.js 是 selection 的确定性 id_map 内部细节(随机数语义不进公开面),不从根入口导出。
export * from "./selection.js";
// pool.js 是 schedule/recursion 的并发原语(pool.map 对应物),不从根入口导出。
export * from "./recursion.js";
export * from "./report.js";
export * from "./schedule.js";
export * from "./demo.js";
