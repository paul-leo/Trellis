# Magpie 网关核心实现调研

> **调研快照,2026-10-23。** 对象:开源本地 LLM API 网关
> [yetone/magpie](https://github.com/yetone/magpie)(Go,MIT)。源码以研究副本形式
> 浅克隆在 `~/www/morphix-research/sources/magpie`(HEAD 时点 v0.1.161 一线,
> 197M;Air 生产装的是 v0.1.1332 二进制)。行号以该克隆为准,是快照不是稳定引用。
>
> 属于 [runtime-infra.md](runtime-infra.md) 议程第 1 项。目的:吃透**已在用的**
> 网关的内部机制,服务运维、排障与升级判断。方向上已决定不自研、直接采用
> 开源 Magpie(2026-10-23,用户裁决);本文不是自研参照。

## 0. 总览(一分钟地图)

- 入口 `internal/gateway/gateway.go`:`handle()`(:1440)识别入站协议 → `serve()`
  (:1606)构建候选 → `passthrough()`(:4215,同协议直通)或 `translate()`
  (:5853)/`streamTranslated()`(`continuation.go:369`,跨协议翻译)。
- 四种 wire protocol:`provider.Chat`(OpenAI Chat)/`provider.Responses`/
  `provider.Anthropic`/`provider.Gemini`;翻译枢纽是 `internal/gateway/ir.go` 的
  IR(`Request/Message/Part/Event/Usage`)。
- 路由与 failover:`internal/gateway/fallback.go`(candidate 展开、plan、
  holdWriter)+ `internal/gateway/routing.go`(失败分类、rest)+ `internal/routes`
  (纯排序策略)。
- 外设:`internal/netproxy`(出站代理决策)、`internal/netguard`(SSRF 地址判定)、
  `internal/budget`+`internal/gwbudget`(网关 key 限额)、`internal/gwmw`+
  `internal/middleware`(Go/JS 中间件)、`internal/gwtool`(工具 gate)、
  `internal/catalog`(models.dev 模型目录)。

## 1. Provider 路由与适配

### 核心数据流

请求 → 按 path 识别入站协议(`protoOfPath`,`key_limit.go:99`;handle 里也有按
body 特征的识别)→ `provider.Resolve` 解析出目标 `Provider` → `fallback.go` 把
该 provider 的全部 key/account(及其 Fallback 链、routing group)摊平成同构
`candidate` 列表 → `routes.Strategy` 只做排序 → serve 循环按序尝试。

### 关键文件与机制

- `internal/provider/provider.go:35-429` — `Provider` 结构体同时承载两类上游:
  API key(`Key`/`Keys []KeyAccount`/`KeyProtocol`)与订阅账号
  (`Account *Account`,json:"-" 不落盘);协议端点
  `Chat/Responses/Anthropic/Gemini/Decide` 各自 Base URL;`Fallback []string`
  (provider/model 链);`Routing`(""/smart/order/rotate/usage/pace/weight);
  `Sink`(429 限流沉底);`Affinity`;并发/限流
  (`MaxConcurrency/AccountConcurrency/QueueLimit/QueueWait/MaxRPM`);
  `QuotaRest/QuotaResetAt/RestCap`;per-account 覆盖
  (`AccountProxies/AccountModels/AccountCaps/AccountWindowCaps/AccountNames`)。
  方法:`APIs(model)`(该模型可走哪些协议,用户显式设置优先)、`Speaks()`、
  `Native(model)`、`Ready()`。
- `internal/provider/account.go:44-118` —
  `Account{Agent, User, Plan, Stream, Home}` + 行为函数闭包
  (`token/sign/renew/body/models/fetch/retry/unusable/explain/plugin/transport/
  clientFor`)。设计要点:**订阅账号不复制凭据**,而是读取对应 agent(Claude
  Code/Codex/Gemini CLI…)自身磁盘/Keychain 里的凭据,`Agent` 字段指向"谁的凭据"。
- `internal/gateway/fallback.go` — 统一抽象的落点:
  - `restKey()`(:102)= `p.ID@user`(账号)或 `p.ID#KeyID`(key),rest/记账/
    affinity 全用这个 id,两类上游在此同构;`restID()`(:124)=
    `restKey + /model`,支持 per-model rest。
  - `perKeyBarred()`(:175-289):账号侧先 Own 后 AlsoOn,按 LoginRanks 排序,
    `AccountServes` 过滤、capHeld 剔除;key 侧按 `keyFit()`
    (:293,0=协议匹配 1=需翻译 2=别家模型)稳定排序后按 KeyProtocol 分池。
    产出 out/aside/barred 三组 candidate。
  - `plan()`(:341):主 provider + `p.Fallback` 链,seen 去重,`restLast`
    (:831)把在休息的压到最后;`planGroup/planLevel`(:390/:431)把嵌套 group
    作为一个 unit(可 weightedUnits)。
  - `modelFamily()`(:317):claude*→Anthropic、gpt-/codex/o*→Chat,用于推断
    原生协议。
- `internal/routes/routes.go` — `Seat`(Key/Account/Known/Learns/Used/Soon/
  Pace/Weight/Resting/Tokens/Free/Credits)、`Strategy{Order func(pool string,
  seats []Seat) []int; Exact; ByUse; ByFree}`、`Register/Find`(同路由多注册,
  最后者生效)、`Apply`(:121,recover + 排列校验,**fail-open** 回 identity)。
  包注释明说分工:gateway 自己做 rest/affinity/failover,Strategy 只管顺序
  (这是 P3 插件点)。
- `internal/routes/strategies.go` — 内置策略:`Smart`(默认:
  tier(share≥UsedShare→2/≥90→1/else 0)分层,fine 层按 Soon 最早截断到小时、
  Learns 未知者排前一次、spent 按 creditsBefore)、`Ordered`、`Rotate`
  (per-pool 轮转)、`LeastUsed`、`Pace`(分带排序,防"十分之一内互等"造成的
  循环不等)、`Weighted`、`FreeFirst`。
- `internal/routes/round.go` — `Round()`:NGINX 式平滑加权轮询
  (`cur[k]+=w; 选中者 -=total`),resting 者排除出轮;`MoveRound`(:67)在
  affinity 换人时把这次请求记到 kept 名下,保证轮询记账真实。
- `internal/gateway/routing.go` — `weigh/weighRouted`(:1405/:1434):从
  `provider.KeyAllowance/allowances(agent)` 读各账号用量窗口,组装 `[]Seat`
  交给 `routes.Find(p.Routing)`;`routingOf`(:1429):策略未注册时回落 Ordered。
- `internal/catalog/catalog.go` — "knows which models exist",读 models.dev
  目录 + Codex 模型缓存 + 内置兜底表;模型选择器的数据源,不参与请求路由。
- `internal/provider/account_order.go` — **只是 UI 层**账号展示顺序,与请求
  路由顺序无关,勿混淆。

### 值得借鉴

- **key 与订阅账号统一为 candidate**,用 `restKey` 字符串做全生命周期身份
  (rest、记账、affinity、concurrency 都以它为键)——一套代码处理两类上游。
- **策略插件点只暴露"排序"**,recover+校验+fail-open 做在框架侧,第三方策略
  写错不致命。
- 账号凭据"借用"而非"托管"(不存两份),避免凭据同步与撤销问题。
- `APIs(model)` 让"同一模型可走多种协议"成为一等公民,翻译层据此选最短路径
  (能 passthrough 就不翻译)。

### 取舍

- 路由状态(轮转计数、rest、affinity、Sink)分散在 gateway 内全局 map
  (`rounds`/`restingUntil`/`routed`),单进程内存态、重启即清,换来实现简单。
- Smart 策略里大量特例(Learns、credits、auto-use renew)是真实运维问题
  (#576/#718)驱动的,复杂度集中在这一处。

## 2. 流式转发与格式双向翻译

### 核心数据流

同协议:`passthrough` 直接字节转发。跨协议:`streamTranslated`(流式)/
`translate`(非流式)做 IR 往返:`readSSEAlive` 收上游 SSE →
`decoderFor(p, actual)` 译成 `Event` → 业务过滤/计费/续传 →
`encoder(from, …)`(`streamEncoder{event/finish/keepalive}`,gateway.go:6218)
按客户端协议写出。

### 关键文件与机制

- `internal/gateway/ir.go` — IR 全集:`Part{Kind; ID/Name/Args/CallID/
  IsError/Images/Loads; Signature; Sealed/SealedBy}`、
  `Event{Kind,Status,Text,ID,Name,MsgID,Model,Stop,Code,RequestID,Usage,Hits,…}`、
  `EventKind`(KStart/KText/KThink/KSig/KToolStart/KToolArgs/KStop/KUsage/
  KError/KSearch/KImage/KThinkStart/KSealed/KTextSig/KAlive)、`Usage`(含
  `Deferred` 处理续传多 try 的合并)。协议四件套分派在
  `gateway.go: parse/build/decoder/encoder`(:6109/:6164/:6200/:6261)。
- `internal/gateway/sse.go` —
  - `readSSE/readSSEAlive`(:15/:22):bufio.Scanner 64KB 起步、上限 32MB;
    空行 flush 一个 event;**`:` 注释行触发 alive 回调**而不算事件——这是
    "上游还活着"的感知通道。
  - `sseWriter`(:63):`begin()` 设流头 + WriteHeader(200) + flush;
    `comment()` 写 `": text\n"` **不带尾随空行**(openai-go v2 会把空行当
    事件);`event()` 才是 `event:/data:` + 双换行 + flush。
- `internal/gateway/gateway.go` — `relayEvents`(:6239):
  select{事件 chan, 15s ticker};只有 `sw.quiet() >= keepaliveEvery/2` 才补
  keepalive(避免刷屏),超过 `keepaliveLongest=5m` 无事件则放弃;
  `keepaliveGap=1s`(透传上游心跳的间隔,:6229-6234)。
- `internal/gateway/fallback.go` — **holdWriter(:1573-2408)是本问题的心脏**,
  backpressure/failover/心跳全部在此:
  - 语义:头与体扣住(内存 buffer),直到 release 或为下一个候选丢弃;流式
    回复**扣到第一个内容事件为止**——之前的错误/拒绝都还能换人重试。
  - `writeHeader`(:1736):hold 时 4xx 只记录不发;SSE→`stream=true`;
    JSON→`whole=true`(整读供 settle 判断拒绝)。
  - `scan()`(:2021):对 held buffer 逐事件扫描:
    `eventError/eventRefusalError` → 记 failure 并 `h.stop()` **主动掐断上游
    请求**(否则上游 429 事件会让客户端干等),`eventThinking` → 延长持有;
    见内容 → `flow()` 放行。持有上限:`holdLongest=15s`、`holdMost=1MB`、
    `holdBuffered=4m`(ChatGPT safety_buffering)、`holdThinking=4m`、
    `holdLead=holdThinking`。
  - `keepAlive()`(:2150):持有超过 keepHeldAfter 时,**先把 try 的响应头拷到
    真 ResponseWriter 并 WriteHeader(200)**,之后每 15s 写 `": keepalive\n"`
    ——客户端拿到合法流头但没有内容;此时若失败,failover 的下一个候选
    **在同一条 HTTP 响应里继续写流**(头部只发一次)。Gemini 协议不支持注释
    (#934),直接排除。
  - `keptAlive`(:2114):`{proto, sent, at, told, streams}` 共享于一次请求的
    多个 try;`agentQuietMost=4m`(:2136):**Codex(Responses)只把真事件算进
    idle timeout,注释不算**——`tooQuiet()`(:2140)检测到快超时就强制放行。
  - `watch`/`watchEvery=1s`(:2410)/`keepQueued`(:2427):排队等并发槽期间同样
    先扣住、发心跳、转 hold;慢启动(firstWait)超时以 `errSlowStart` 放弃。
  - `see()/streamEnds`(:1948/:1938):扫各协议流终止 marker
    (`response.completed`/`message_stop`/`data:[DONE]`)——agent 收到终止可能
    立即挂断(#1978)。
  - `settle()`(:2300):try 结束后对整读回复判安全拒绝,`handBack()`(:2364)
    把成形的拒绝作为 vendor 原样 200 交回;`release()`(:2383)无人可换时最终
    放出;`failed()`(:2338)= `!passing && code>=400 && retryable` 即可换人。
  - 附带:`loopGuard`(推理死循环检测 #1359)、`wantWhole`(:1693,压缩摘要类
    回复扣到底,防止中途 429 变成唯一答案)。
- `internal/gateway/continuation.go` — `streamTranslated`(:369-670):
  - 主循环 `for again`:每次 `forwardTranslated` 发上游;`readSSEAlive` 逐事件
    喂 decoder;`alive` 回调(:458)在 `sw.quiet()>=keepaliveGap` 时
    `enc.keepalive()`,把上游心跳转成对客户端的心跳(#436)。
  - **断流续传**:上游中途断(cut)时,`continuation{mode: prefillHow}` 构造
    `cont.request()`:把已发给客户端的 thinking+text 作为 assistant prefill、
    `r.Resume=true` 向**同一对话**重问,`unecho`(:347)剥掉模型对 prefill 的
    复读;重试间隔 `retryPause<<again` 指数退避。
  - 错误扣发:KError 且 `cont.possible()` 时先记下不发,确认续不上才发给
    客户端——**客户端永远看不到中间失败**。
  - 计费合并:KStart/KUsage 时 `this + before`(各次 try 的 usage 相加)。
  - 空回复重试(:599):`empty && !said` 时先原地重问 `emptyRetries` 次
    (Gemini 长对话偶发只回推理,#667)。
  - 截断判定(:558):Anthropic 流无 stop_reason/message_stop、Responses 无
    response.completed → `errEndedShort` 视为被 relay 截断(#1643)。
  - 上游不吐流(忽略 stream:true)→ `didNotStream` 502 干净失败(:521-531)。
- `internal/gateway/upstream.go` — `upstreamStop`(:72)、`replyEnds`(:123)、
  `carriedError`(:155)/`streamErrorText`(:181,**永不返回空**)。

### 值得借鉴

- **holdWriter 模式**:把"还没决定用哪个上游的回复"作为独立
  `http.ResponseWriter` 包装层,统一解决 failover、心跳、慢启动、排队、安全
  拒绝、循环检测——比在每个转发点散落 if 干净得多。
- 注释行心跳 + "客户端 idle 超时只认真事件"的模型差异(agentQuietMost 只对
  Responses 收紧),是对真实客户端(Codex 300s idle、Alma 240s)的逆向适配。
- 流头先行 + 同响应续写:failover 对客户端完全透明(不重连、不重发头)。
- 断流续传用 prefill 恢复对话,配合 `unecho` 处理复读。

### 取舍

- holdWriter 状态机字段极多(30+),每个都有 issue 号注脚——正确性靠测试与
  issue 追溯。自建 runtime 可从"扣首事件 + 15s 注释心跳 + 4m 上限"最小内核
  起步。
- 事件逐个翻译意味着跨协议时上游原始帧不可复用,passthrough 是性能逃生门。

## 3. 工具调用透传

### 核心数据流

入站协议的 tools/tool_calls → `parse` 译为 IR `Part{ToolCall/ToolResult}` +
`Tool` → (可选:gwmw Request/masker 改写 body 前、gwtool gate 过滤)→ `build`
译为出站协议;回复侧反向:出站 tool_call delta → `decoder` →
`Event{KToolStart/KToolArgs}` → 入站 encoder 写出。同协议 passthrough 不经手。

### 关键文件与机制

- `internal/gateway/ir.go` — `Part` 携带 `ID/Name/Args/CallID/IsError/Images/
  Loads(tool_reference 拉起的 deferred 工具)/Signature/Sealed/SealedBy`;
  `Tool{Name,Description,Schema,Strict,Deferred}`;`joinSplitCalls` 合并被拆散
  的连续 assistant 消息。**Sealed 规则**:`Part.Sealed`(Anthropic
  `redacted_thinking` / Responses `encrypted_content`)只由同协议的
  builder/encoder 原样字节透传,跨协议不伪造——`KSealed` 事件同理。
- reasoning 透传:thinking 文本 + `Signature`(KSig/KTextSig)成对回传,支撑
  interleaved thinking 续接;continuation 的 `emit` 对 resume 状态过滤
  KThink/KSig/KThinkStart/KSealed 不重发(:317-330),thinking 已 journal 化
  用于续传 prefill。
- `internal/gateway/additional_tools.go` — Responses Lite 特有:Codex 把工具
  放在 input 的 `additional_tools` item
  (`codex_protocol::DEFAULT_FUNCTION_NAMESPACE`)。`liftAdditionalTools`(:25)
  入站时拆进顶层 `tools` 并剥 namespace;`addTool`(:111)合并重复 namespace。
  只有 OpenAI 认识这个 item,xAI 直接 422(#350)——provider 侧有
  `AdditionalTools/CodexAsSent/LoadedInPlace` 开关控制何时保持原样发回。
- `internal/gwmw/gwmw.go`(Go 侧插件点,JS 经 `internal/middleware` 同接口
  桥接)— `Agent{Begin(Info) Run}`;
  `Run{Request(body) ([]byte, *Reject); Wrap(w) (http.ResponseWriter,
  func()); End()}`——请求改写、直接拒绝、响应逐事件改写三个钩子;
  `Tried(body, to To) []byte` 在**每个 provider 候选发出前**再给一次改 body
  机会。
  `Masker{JSON,Text,Restore,Writer}` + `Teller/Hit`:敏感信息遮蔽;**agent
  中间件 fail-open(`Safely` 捕 panic),Masker fail-closed(失败即
  `ErrUnmasked` 拒绝)**——遮蔽错=泄密,方向相反,安全分级清晰。
  `internal/middleware/run.go`:`Chain/Begin/Run`(:27-:192)为 JS 实现;
  `Wrap` 返回的 `writer`(:260)逐 SSE 事件切分(`eventEnd/splitEvent`
  :431/:446)喂 JS hook,注释行不计;`middleware.go` 管理 JS realm 实例池、
  单 hook 超时、console 限流(linesAMinute=60)。
  `internal/middleware/points.go`:JS 插件还能注册 `routes.Strategy`
  (`mw.strategy` :215,fail-open 回原序)与 usage observer(`Points()` :359)。
- `internal/gwtool/gwtool.go` — `Gate()/Serve(name)/Served(name)`:网关自答
  工具(`web_search`、`plugin_tools`)的准入闸。
- 文本形式 tool call:continuation.go:535 的 `textCallNames/textCallSee`——
  某些模型把 tool call 写成正文,由 see 层识别并 hold/release。

### 值得借鉴

- "additional_tools 降级/还原"策略:为单个客户端方言做的语义扩展,入口 lift、
  出口按 provider 能力还原,而不是让每个 provider 适配器都懂这个方言。
- Sealed/Signature 这类"不可跨协议翻译的 opaque 块"显式建模,同协议直通、
  跨协议丢弃而非伪造——避免把加密 thinking 假装成普通 thinking。
- 中间件 fail-open / masker fail-closed 的显式分级;`Tried` 钩子允许按候选
  改写请求。

### 取舍

- 工具 schema 只做结构搬运,不做 JSON Schema 深度兼容修补——schema 不兼容
  的锅留给 400 → 自适应重建重试。
- JS 中间件逐事件喂 JS 换来灵活性,代价是每个事件一次跨语言调用 + realm 池。

## 4. 错误与重试语义

### 核心数据流

`failure(status, body)` 分类 → serve 循环分支决定:原地重建重试 / `restAfter`
给该候选设 rest 并换下一个 / 透传给客户端;回复已开始后的失败走 holdWriter
(`failed()`)+ streamTranslated 扣发或续传。budget 限流在**更早**的 HTTP
中间件层(keyLimited),在任何 provider 之前。

### 关键文件与机制

- `internal/gateway/routing.go` —
  - 18 个 `fail*` 常量(:269-326);`failure(status, body)`(:375-414):
    proxyconnect→failProxy;402+usage 词→quota;credit/insufficient_quota→
    credit;429+resetsWhen→quota;429+rateWords→rate;5xx+quotaCodes 或
    <500+usedUpWords→quota;429→rate;else other。`failureOf`(:420)再叠加:
    登录失效/Revoked→failAuth、restrictedRefused→failRestricted。词表多语言
    (中英文时间、Zhipu 1308 的北京时区日期 :684)。
  - `restAfter/restAfterMarked`(:850-:1080)→ `Rest{Why, Status, Until, By,
    Failures, Key, Model, Link}`(:482),写入全局 `restingUntil`
    (fallback.go:1010)。`By` 取值即策略:credit(30m)/quota(15m)/resets
    (vendor 自述时间,`resetsAt` :655 解析 Claude Code/ChatGPT/中文/Zhipu)/
    window(allowance 读数)/retry-after/cooldown(1m)/backoff(指数
    `fallbackCooldown<<n`,封顶 RestCapOr(10m))/restricted(2h)/verify/
    "off"(provider.RestCapOff:不明错误不 rest)。
  - **rest 粒度决策**(:1038-:1066):模型不被该 key 计划服务(modelRefused
    #1235)、pooled quota(#2036)、Cline 免费模型日限(#1398)、"付费模型
    credit 用尽但同账号有免费模型"(PaidBesideFree)→ 只 rest `restID`
    (模型级);OpenRouter 共享池、远程 magpie(#1849/#2077,
    X-Magpie-Limit-Reset 头)同理;其余 rest 整个账号/key。
  - `rateRest`(:1166):优先 Retry-After/reset 头/resets_at;刚放出来又 429 →
    指数翻倍(rateForget 窗口),封顶 longestRateRest(30m);仍有 quota 的
    rate-limited → `sink` 沉底(provider.Sink)。
  - `restSlow`(:1116):慢启动按模型计,连续 slowRests(2) 次起 rest。
- `internal/gateway/fallback.go` —
  - `retryable(status, body)`(:1275):**overflow(上下文超长)→ false**
    (透传给 agent 让它 compact,换谁都一样);401/402/403/404/408/429/5xx →
    true;400/422 仅当 quota/unserved/refused/shape/unsaid/region/
    wrongEndpoint 词;EdgeBlocked → true。
  - `tooLongUnsaid`(:1317):什么都不说的 400/502,若请求 token 估算超窗口
    1.2 倍 → 改写为"prompt too long"让 agent compact。
  - `lateRests`(:1304):回复已开始后断掉的错误是否 rest(超长/拒绝/防护/空
    回复不 rest)。
- `internal/gateway/gateway.go` serve 循环失败分支(:2960-3199):failUpdate
  (重发原样)、failFloor(tokenFloor 抬 max_tokens)、failRoom(按窗口余量改
  max_tokens 重试同账号)、failRefused(安全拒绝:不 rest、`refusalAsksAgain`
  限次换人)、failAuth(登录失效:直接跳过,**不 rest**——会话级问题)、
  failProxy(不 rest 任何人,代理是用户侧问题)、effortRefused(换 matesFirst
  或 400)、413/overflow(`withRoom` 过滤已知太小的成员)。
- **Budget/限流的介入层**:
  - `internal/gateway/key_limit.go` — `keyLimited`(:36)HTTP 中间件:仅 POST、
    仅带 Limits 的 gateway key;拒绝时 429 + Retry-After +
    `X-Magpie-Limit-Reset`(自身限额与 provider 429 区分,#2077)+ **
    `X-Should-Retry: false`**(否则 Anthropic/OpenAI SDK 会自动重试);有
    limit 但 limiter 未注册 → **503 fail-closed**。`reserveFor`(:83) →
    `gwbudget.Limiting`(fail-closed)→ `Limiter.Reserve`。
  - `internal/gwbudget/gwbudget.go` — `Limiter{Reserve(who, body, model, now)
    (release func(), refused Refusal)}`、`Refusal{RetryAfter/ResetAt}`;
    key 有 Limits 而无限额器 → 先触发一次 refresh(≤1s 节流)再取。
  - `internal/budget/budget.go` — `Reserve`(:341):每 key 多 limit(#2227,
    如 5h+week 各自窗口);用量首读自 `usage.jsonl`,之后 `Append`(:155)原子
    地"写文件+入账";**预留 = body字节/4 + 该窗口平均 output**,
    `used + reserved < cap` 才放行(并行请求大约只超一个 call 的量);
    `Binding`(:257)取最紧的 limit。
- `internal/steady/steady.go` — **与请求重试无关**:Windows 文件 rename 竞争
  重试与 `WriteFile`(temp+fsync+rename 防掉电零字节 #1505)。

### 值得借鉴

- **错误分类 → rest 策略 → 候选选择三段解耦**:正则词表分类(可独立测试)、
  `Rest{By}` 记录策略来源、serve 循环只看 `resting()`。给每个 rest 记
  `By` 与 `Failures`,UI 可解释、可手动解除。
- 两个实用判断:overflow 不重试(透传促使 agent compact,`tooLongUnsaid` 用
  token 估算兜底);failAuth 不 rest(重登前 rest 8 天毫无意义)。
- budget 的预留制(平均 output + body/4)比纯事后计数更抗并发超支;
  `X-Should-Retry: false` 防客户端 SDK 二次重试打穿预算。
- rest 粒度可细到"模型级",并允许 rest 后异步收窄(narrowWhenRead):先保守
  rest 整账号,读到 allowance 后缩小到模型——避免一次误判冻结整个账号。

### 取舍

- 分类靠词表正则,需持续维护多语言/多厂商变体(代码里大量 issue 号是证据);
  好处是零成本、离线、可测。
- rest 全内存,多实例不共享(magpie 是单机桌面场景)。

## 5. netproxy 与 netguard(调研第 2 项"代理"的直接参照)

### netproxy = 出站代理决策层(不是代理服务器)

`internal/netproxy/netproxy.go`,包注释开宗明义:决定"magpie 自己发往 vendor
的请求走哪个代理"。GUI(Dock/Start menu 启动)没有 `HTTPS_PROXY` 环境变量,
没有它所有请求直连会挂死。

- `Install()`(:30):把 `http.DefaultTransport.Proxy` 设为 `Func`,
  `http.DefaultClient.Transport` 设为 `Dispatch(t)`。
- 全局代理选择 `For(u)`(:244),优先级:settings 里的 Proxy(`"direct"`=强制
  直连)→ 环境变量(含 Go 原生不读的 `ALL_PROXY`,`NO_PROXY` 按 curl 语义
  匹配 :422)→ 系统代理(macOS scutil / Windows Internet Options,`System()`
  :472 缓存 15s/无代理 2s,#1518)。
- **per-provider 代理(自带到上游的代理层:是,出站方向)**:`With(ctx, choice)`
  (:111)在请求 ctx 上标注该 provider 的选择(`""`全局、`"direct"`直连、
  `http(s)://`、`socks5://`、裸 host:port=HTTP);provider 配置项即
  `provider.Proxy/AccountProxies`。
- `Dispatch`(:158):RoundTripper 按 `route{choice, h1, unchecked}` 克隆 base
  transport(≤32 个,超了全清重建)——**连接池按代理隔离**,防止 HTTP/2 连接
  "从代理 A 拨号却被代理 B 的请求复用"。附加:`HTTP1()`(:146/:224,ChatGPT
  backend 强制 HTTP/1.1 且清 ALPN,仿 Codex)、`uncheckTLS`(per-host 关证书
  校验,配合 provider.InsecureTLS)、`v4Fallback`(IPv6 死路回退 IPv4)、
  `HTTP2Health`(:53,20s 无帧 ping、10s 无 pong 断链,治静默死连接 #2843)。
- `Hold(ctx, err)`(:85):构造"禁止出网"ctx(#1518)。
- `EnvWith(choice, env)`(:274):为 magpie 代启动的 CLI 合成
  `*_PROXY/NO_PROXY`——解决 GUI 父进程无代理环境变量、子进程 CLI 只认环境
  变量的问题。
- `lan.go`:`onLAN` —— 除非该 provider 自带代理,局域网 host 永远直连;
  loopback 永不代理。

### netguard = SSRF 地址判定库(纯函数,无 IO)

`internal/netguard/netguard.go`:头注"只判地址,不拨号"。`Public(a netip.Addr)
bool` 排除 loopback/RFC1918/`fc00::/7`/link-local(含 169.254.169.254 元数据
端点)/CGNAT 100.64/10/6/文档段/fake-ip 198.18.0.0/15/NAT64/6to4;另有
`FakeIP`(Clash/Surge fake-ip 段识别)。用于插件清单、更新源等主动下载校验。

### 分工与借鉴

- 一句话:**netproxy 管出站"走哪条路",netguard 管"哪些目的地不许去"**。
- 借鉴:`Dispatch` 的"按(代理,协议,校验策略)三元组克隆 transport"是多租户
  出站连接隔离的干净做法;`EnvWith` 解决 GUI 父进程 → CLI 子进程的代理传递;
  系统代理短 TTL 缓存(有 15s/无 2s)兼顾启动时序与变更响应。

## 对 Trellis runtime 的意义(2026-10-23 决策后)

**决策:不自研网关,直接采用开源 Magpie**(见 runtime-infra.md)。本调研的
价值是运维与排障能力:

1. **排障地图**:上游失败时的行为可解释——rest 分类(`Rest{Why,By}`)、候选
   顺序(plan/perKeyBarred)、holdWriter 的心跳与持有上限,出问题时能定位到
   具体机制;必要时按行号向上游提 issue 或打补丁。
2. **升级判断**:Air 上 0.1.1332 → 上游 0.1.161 提级时,用本文对照行为变化
   面(错误分类词表、rest 策略、心跳/持有上限都属于易变处)。
3. **代理层的现成参照**(议程第 2 项,已后置):per-provider 出站代理、连接池
   按代理隔离、IPv6 回退、HTTP/2 健康探测、GUI→CLI 代理传递,magpie 都已
   踩过并给出实现;若将来需要独立代理组件,以此为基线。
4. **与 Trellis MCP 网关的镜像关系**:magpie 的 rest/backoff 与我们刚发布的
   session recovery(v0.19.0)是同一族问题(上游失效→隔离→恢复);它的
   `Rest{By}` 可解释 rest 记录值得 MCP 网关后续借鉴。

## 附:引用时的更正(防误读)

- `internal/gateway/draw.go` 是图片生成,非候选挑选(挑选在 fallback.go 的
  plan/perKeyBarred)。
- 不存在 `keepalive.go`;心跳在 `relayEvents`(gateway.go:6239)、
  `sseWriter.comment`(sse.go:109)、`holdWriter.keepAlive/keepQueued`
  (fallback.go:2150/:2427)三处。
- `internal/gateway/classify.go` 是路由意图分类器;错误分类在
  `routing.go failure()`。
- `internal/provider/account_order.go` 是 UI 顺序;`internal/steady` 是
  Windows 文件安全写,均与请求路由/重试无关。
