# Proposal

## Why

`trellis` 在一台机器上经常有多个可执行入口（volta shim、`npm -g` 的 bin、`~/.local/bin` 下的包装脚本）。升级其中一个并不会升级其他入口，PATH 最前面的那个才是实际运行的版本。2026-10-16 的真实事故：全局包已升到 0.16.0，用户终端里跑的仍是 0.12.0，于是新版才认识的 `auth.client_name` 被旧版拒绝，报错指向 `servers.yaml`，看起来像配置错误，实际是版本分叉。定位花了两轮，因为没有任何一个 Trellis 命令能提示"PATH 上有多个版本不一致的 trellis"。

这与此前 workspace TOML 事故同类：问题静默存在，用户事后才发现。doctor 本来就是做这件事的。

## What Changes

- `trellis doctor` 增加只读检查：遍历 `PATH`，找出所有名为 `trellis` 的可执行文件，按真实路径去重，对每个执行 `--version`，解析语义化版本。
- 若出现两个及以上不同版本，产出新 finding `cli-version-split`，列出每个入口的路径与版本，标明 PATH 上排在最前（实际生效）的入口，并给出修复指引。
- 该 finding 使 doctor 非零退出。
- 只读：绝不修改、删除或重写任何入口文件，也不尝试升级。包装脚本可能由用户有意维护（例如转发 `mcp-gateway`），Trellis 无权处置。
- 检查位于 CLI 层（`runDoctor`），不放进 `collectDoctorReport`，避免库级调用和单测在真实 PATH 上派生子进程。

## Capabilities

### New Capabilities

### Modified Capabilities
- `capability-drift-detection`: 新增需求，doctor 检测并报告 PATH 上多个版本不一致的 `trellis` 入口。

## Impact

- 代码：新增 `src/lib/cliEntrypoints.ts`；`src/commands/doctor.ts` 接入并把新 kind 加入非零退出集合。
- 无新依赖。
- 行为变化：此前在版本分叉的机器上 exit 0 的 `trellis doctor` 现在会 exit 1。这正是目的。
- 范围外：自动修复、对包装脚本内容的解析、跨 Node 版本管理器的升级建议。
