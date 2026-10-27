# Runtime 基建调研议程

> **状态:方向已定(2026-10-23)。** 网关层采用开源 Magpie 且 Trellis 零投入
> (不内置、不托管、不代管升级);自我进化(第 4 项)是实施主线;网络两线
> (代理、多机互通)按用户决定后置。调研 1 成果沉淀在
> [magpie-gateway-research.md](magpie-gateway-research.md)。自我进化已有
> 完整草案,见 `docs/self-evolution.md` 与 `openspec/changes/trellis-evolve/`。

## 顺序:网关线已收口 → 自我进化 tasks → 网络(2 → 3)最后

网关层的结论(2026-10-23,用户两步裁决):**采用开源 Magpie,且 Trellis 不做
任何 magpie 的事**——不内置、不托管接入、不动其生命周期与版本;magpie 完全
外部,用法由 skills 文档化(`$local-model-gateway`、`$mac-air-usage`、
`$ai-workstation-setup`)。进化按既有 tasks 推进,是当前主线;网络调研在主线
稳定后再做。

## 1. 大模型网关(Magpie)——✅ 已收口:采用开源 + Trellis 零投入

状态(2026-10-23):
- Magpie 已在 Air 两层实测运行(macOS 与 OrbStack worker 各自 `127.0.0.1:3425/v1`;
  用法见 `$local-model-gateway`、`$mac-air-usage`);部署迁移走 `$ai-workstation-setup`。
- Magpie 源码已定位:上游 [github.com/yetone/magpie](https://github.com/yetone/magpie)
  (Go,MIT,活跃);本机以研究副本形态浅克隆在 `~/www/morphix-research/sources/magpie`
  (v0.1.161 时点;Air 生产装 v0.1.1332)。
- **决策 1:不自研网关**,模型接入层直接用开源 Magpie。
- **决策 2(同日):Trellis 不做 magpie 的事情。** 曾评估过托管接入(探测/状态
  并入/清单声明),用户裁决不做——magpie 的配置域、生命周期、版本升级全部归
  magpie 自己;Trellis 侧不写代码、不改其配置。排障知识(调研文档)仅作参考,
  不维护联动。
- 五问深挖成果见 [magpie-gateway-research.md](magpie-gateway-research.md)
  (运维视角快照,行号随时点漂移,不持续维护)。

本线无待办。Air 上 0.1.1332 → 上游 0.1.161 的提级**搁置**(属"magpie 的事",
用户裁决不做;将来需要时由用户在 magpie 自己的更新机制里完成)。

## 2. 代理——稳定访问层(**后置**,网关采用开源后此线降级为运维议题)

magpie 侧已有现成参照(调研文档第 5 节):`internal/netproxy` 是**出站代理
决策层**(per-provider `With(ctx, choice)`、transport 按{代理,协议,校验}
三元组克隆隔离连接池、IPv4 回退、HTTP/2 健康探测、GUI→CLI 用 `EnvWith` 合成
`*_PROXY`);`internal/netguard` 是 SSRF 地址判定纯函数。我们的代理层调研应
以此为基线,再论证是否需要独立组件。

调研问题:
- Magpie 到各上游 provider 的代理路由(per-provider 配置、failover 策略);
- npm/git 等开发工具链的代理;
- 与网关层的边界:重试/切换由代理层还是网关层负责;
- 与 Nore 的职责区分(设备互联 vs 外网代理,别混为一谈)。

已有数据点:2026-10-22 npm publish 上传连接 ECONNRESET,IPv4-first + 单 socket 解决;
GET/ping 正常、仅上传路径异常。

## 3. 多机互通——相互委派任务的网络底座(**后置**)

已知锚点:
- Pro↔Air 私网由 Nore 设备互联提供(`ssh morphix-air-private` → `100.127.171.120`);
- 本机有 `~/www/nore/` 与 `~/www/nore-next/` 两个仓库,调研以 Nore 源码为主对象之一;
- 现网痛点:SSH 中继偶发超时(Air doctor 详情两次读取均超时)。

委派已有雏形(分散,未统一):Trellis `tasks_handoff`(MCP)、Air 侧 Dagu
(`morphix-air-tasks`,当前已禁用)、agent-collab mailbox。

调研问题:网络可靠性(重连/唤醒)、服务发现、委派语义与安全边界。

## 4. 自我进化——已是实施轨道

不在本文重复。接手入口:`docs/self-evolution.md` 的"接手指南";下一步是其
tasks 第 1 组的三个只读前置验证(元数据信号采样、provider 读取路径、扩展加载机制),
之后才是托管扩展点(P1)。

## 对照样本(见记忆 research-subjects-backlog)

Raven(harness of harnesses)、Octop(腾讯云多 Agent,coordinator 调度与 workspace
分层)、asyar(轻量启动器,仅交互效率参照)。
