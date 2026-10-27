// Derived from harness2 `harness2/core/proposer.py` (Apache-2.0, Copyright 2026 Google LLC).
// 任务 5.1:proposer 模块原样翻译——调用指纹缓存、重试退避 10s×(attempt-1)、
// BoundedSemaphore → TS 信号量、失败收口 Reply(ok=false)、审计写盘。
// 函数名与字段名保留 Python snake_case 原样,便于逐行对照。
//
// 显式设计偏差(三处中的两处在本模块落地,docs 见 openspec design D7/D12):
// - D7(凭据 env):不移植任何 Vertex env(CLAUDE_CODE_USE_VERTEX/
//   ANTHROPIC_VERTEX_PROJECT_ID/CLOUD_ML_REGION/GOOGLE_VERTEX_PROJECT/
//   GOOGLE_VERTEX_LOCATION/VERTEXAI_LOCATION);project/region 字段不移植。
//   claude_cli 只保留 ANTHROPIC_MODEL=spec.model ——这是模型选择(claude_cli
//   无 --model 参数),不是凭据形态。spawn 本机 CLI + 现有凭据形态。
// - D12(无绕过):_claude_cli 的 spawn 规格不含 harness2 的
//   --dangerously-skip-permissions 等任何审批/沙盒绕过标志(tasks 7.2 断言)。
//   _opencode 的 OPENCODE_PERMISSION 外目录 deny 是限制性沙盒配置,保留。
//
// 结构性/语言适配(非语义偏差):
// - 沙盒原语(mkdtemp/copytree/harvest/超时杀进程)已抽到 sandbox.ts,call() 组装;
// - Python `_SEM` 为模块级 BoundedSemaphore(config.PROPOSER_CONCURRENCY,默认 2),
//   TS 保留模块级闸门语义;set_proposer_concurrency 是测试接缝(n≤0 不限);
// - 重试退避 `time.sleep(10 * (attempt - 1))` → retry_backoff_s + backoff_ms 测试接缝;
// - shutil.which("claude") or "claude" → 直接 "claude"(Node spawn 自带 PATH 解析);
// - subprocess.TimeoutExpired → sandbox.TimeoutExpiredError;str(exc) → e.message;
// - json.dumps 默认 ensure_ascii/float 形态与 JSON.stringify 有格式差:meta.json、
//   opencode.json 参与审计与运行配置,不参与缓存键与 golden 对照,JSON 语义等价
//   (opencode.json 为定长模板逐字节对齐 Python);
// - Python `timeout or spec.timeout` 的假值语义保留(0 落回默认)。

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const { join } = path;

import { pyRound } from "./pyutil.js";
import {
  auditStem,
  harvestSubpath,
  runWithTimeout,
  TimeoutExpiredError,
  withSessionWorkspace,
} from "./sandbox.js";
import type { ChannelSpec } from "./spec.js";

/** harness2 SYSTEM_ARG_MAX:system 超长时改从 stdin 前置块传入。 */
export const SYSTEM_ARG_MAX = 120_000;

/** Python _DROP_ENV:spawn 子进程前从继承环境里剥掉的凭据形态变量。 */
export const _DROP_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
];

/**
 * D7 判据(任务 7.1):spawn 子进程的环境里不得出现任何 Vertex 形态变量。
 * harness2 会注入 CLAUDE_CODE_USE_VERTEX / ANTHROPIC_VERTEX_* / CLOUD_ML_REGION /
 * GOOGLE_VERTEX_* / VERTEXAI_*;移植版既不注入(不移植),也不放行继承环境里
 * 残留的同类变量(含任意 GOOGLE_* 前缀)。凭据形态只取本机登录态或宿主委派
 * (agent-bridge),spawn env 快照见 test/proposer.test.ts。
 */
export function _is_dropped_env(key: string): boolean {
  if ((_DROP_ENV as readonly string[]).includes(key)) return true;
  if (key === "CLAUDE_CODE_USE_VERTEX" || key === "CLOUD_ML_REGION") return true;
  return (
    key.startsWith("GOOGLE_") ||
    key.startsWith("VERTEX") || // VERTEX_* 与 VERTEXAI_* 一并覆盖
    key.startsWith("ANTHROPIC_VERTEX_")
  );
}

// ---- 并发闸门:Python threading.BoundedSemaphore 的 async 等价 ----

class _Semaphore {
  private readonly _bound: number;
  private _avail: number;
  private _waiters: Array<() => void> = [];

  constructor(n: number) {
    this._bound = n;
    this._avail = n;
  }

  private acquire(): Promise<void> {
    if (this._avail > 0) {
      this._avail -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  private release(): void {
    if (this._avail >= this._bound) {
      throw new Error("Semaphore released too many times");
    }
    const next = this._waiters.shift();
    if (next) next();
    else this._avail += 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Python config.PROPOSER_CONCURRENCY。 */
export const DEFAULT_PROPOSER_CONCURRENCY = 2;

// Python:_SEM = BoundedSemaphore(MAX_CONCURRENCY) if MAX_CONCURRENCY > 0 else None。
// 模块级、全实例共享的闸门;测试经 set_proposer_concurrency 调整/恢复。
let _SEM: _Semaphore | null = new _Semaphore(DEFAULT_PROPOSER_CONCURRENCY);

/** 测试接缝:重设全局闸门(n≤0 不限;回到默认传 DEFAULT_PROPOSER_CONCURRENCY)。 */
export function set_proposer_concurrency(n: number): void {
  _SEM = n > 0 ? new _Semaphore(n) : null;
}

/** Python 重试退避:`time.sleep(10 * (attempt - 1))` 的秒数。 */
export function retry_backoff_s(attempt: number): number {
  return 10 * (attempt - 1);
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Python: `d[key]` when it is a dict, else {}. */
function _obj(d: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = d[key];
  return _isObj(v) ? v : {};
}

function _isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function _err_str(exc: unknown): string {
  // Python f"{type(exc).__name__}: {exc}" —— str(exc) 只有 message。
  if (exc instanceof Error) return `${exc.constructor.name}: ${exc.message}`;
  return `Error: ${String(exc)}`;
}

/** Python f"<unreadable:{type(exc).__name__}:{exc}>"(name 与 message 间无空格)。 */
function _unreadable(exc: unknown): string {
  const name = exc instanceof Error ? exc.constructor.name : "Error";
  const msg = exc instanceof Error ? exc.message : String(exc);
  return `<unreadable:${name}:${msg}>`;
}

async function _is_file(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function _is_dir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Python FileNotFoundError —— 具名子类,使 _err_str 的 constructor.name 对齐 type(exc).__name__。 */
export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

/** Python: A call did not produce a usable reply. Never swallowed into an empty string. */
export class ProposerError extends Error {
  readonly attempts: number;
  readonly cost_usd: number;

  constructor(message: string, attempts = 0, cost_usd = 0) {
    super(message);
    this.name = "ProposerError";
    this.attempts = attempts;
    this.cost_usd = cost_usd;
  }
}

/** Python: One session: what came back, what it cost, and where the audit trail is. */
export class Reply {
  label: string;
  text: string;
  ok: boolean;
  cost_usd: number;
  wall_s: number;
  attempts: number;
  cached: boolean;
  channel: string;
  error: string;
  audit: string | null;
  workspace: string | null;

  // Python dataclass 字段序;__bool__ = ok 在 JS 无对应(对象恒真),调用方读 reply.ok。
  constructor(
    label: string,
    text: string,
    ok: boolean,
    cost_usd = 0,
    wall_s = 0,
    attempts = 0,
    cached = false,
    channel = "",
    error = "",
    audit: string | null = null,
    workspace: string | null = null,
  ) {
    this.label = label;
    this.text = text;
    this.ok = ok;
    this.cost_usd = cost_usd;
    this.wall_s = wall_s;
    this.attempts = attempts;
    this.cached = cached;
    this.channel = channel;
    this.error = error;
    this.audit = audit;
    this.workspace = workspace;
  }
}

interface ProposerPaths {
  mission: string;
  system: string;
  response: string;
  meta: string;
  workspace: string;
}

export interface ProposerOpts {
  audit_dir?: string | null;
  attempts?: number;
  /** 测试接缝:attempt≥2 时的等待毫秒;默认 retry_backoff_s(attempt)*1000(与 Python 一致)。 */
  backoff_ms?: (attempt: number) => number;
  /** config.BUN 等价(opencode 通道);默认环境变量 HARNESS2_BUN,否则 "bun"。 */
  bun?: string;
  /** config.OPENCODE_DIR 等价(opencode 通道);默认环境变量 HARNESS2_OPENCODE_DIR。 */
  opencode_dir?: string;
}

/** Python: Runs agentic sessions on one channel, with an audit trail and a cache. */
export class Proposer {
  readonly spec: ChannelSpec;
  readonly audit_dir: string | null;
  readonly attempts: number;
  readonly backoff_ms: (attempt: number) => number;
  readonly bun: string;
  readonly opencode_dir: string;
  readonly _calls: Reply[] = [];

  constructor(spec: ChannelSpec, opts: ProposerOpts = {}) {
    // Python __post_init__。
    if (!spec.model.trim()) {
      throw new Error("Set HARNESS2_IMPROVER_MODEL before starting model sessions");
    }
    this.spec = spec;
    this.audit_dir = opts.audit_dir ?? null;
    this.attempts = opts.attempts ?? 2;
    this.backoff_ms = opts.backoff_ms ?? ((attempt) => retry_backoff_s(attempt) * 1000);
    this.bun = opts.bun ?? process.env.HARNESS2_BUN ?? "bun";
    this.opencode_dir = opts.opencode_dir ?? process.env.HARNESS2_OPENCODE_DIR ?? "";
  }

  /** D7:继承环境剥掉 _DROP_ENV 与一切 Vertex 形态(_is_dropped_env);
   * claude_cli 只注入 ANTHROPIC_MODEL(模型选择非凭据)。 */
  env(): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = {};
    for (const k of Object.keys(process.env)) {
      if (!_is_dropped_env(k)) e[k] = process.env[k];
    }
    if (this.spec.kind === "claude_cli") {
      e.ANTHROPIC_MODEL = this.spec.model;
    }
    return e;
  }

  /**
   * Run one session. Raises ProposerError if no usable reply after `attempts`.
   * `harvest` names a subpath of the session's working directory to copy out before that
   * directory is destroyed -- e.g. "context/harness", which is how an edited tree comes back.
   */
  async call(
    mission: string,
    context_dir: string | null,
    label: string,
    opts: {
      system?: string;
      timeout?: number;
      max_attempts?: number;
      harvest?: string | null;
    } = {},
  ): Promise<Reply> {
    const system = opts.system ?? "";
    const cache_key = await _call_fingerprint(label, mission, system, context_dir);
    const cached = await this._cached(label, cache_key, Boolean(opts.harvest));
    if (cached !== null) {
      this._calls.push(cached);
      return cached;
    }

    // Python: int(timeout or self.spec.timeout) —— 0 也落回默认。
    const wall = opts.timeout || this.spec.timeout;
    const tries = Math.max(1, Math.trunc(opts.max_attempts ?? this.attempts));
    let last = "";
    let spent_usd = 0;
    const t0 = Date.now() / 1000;

    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1) await _sleep(this.backoff_ms(attempt));
      try {
        const outcome = await withSessionWorkspace(
          async (tmp) => {
            // Python: with _SEM if _SEM is not None else nullcontext() 只包住通道执行。
            const run = (): Promise<[string, number, string]> =>
              this._execute(tmp, mission, system, wall);
            const [text, cost, err] = _SEM ? await _SEM.run(run) : await run();
            spent_usd += cost;
            if (!text.trim()) return { kind: "empty" as const, err: err || "empty reply" };
            const r = new Reply(
              label,
              text,
              true,
              spent_usd,
              pyRound(Date.now() / 1000 - t0, 1),
              attempt,
              false,
              this.spec.kind,
            );
            if (opts.harvest) {
              r.workspace = await harvestSubpath(tmp, opts.harvest, label, {
                auditDir: this.audit_dir,
                cacheKey: cache_key,
              });
              if (r.workspace === null) await _drop_workspace(await this._paths(label, cache_key));
            }
            await this._write_audit(r, mission, system, cache_key);
            this._calls.push(r);
            return { kind: "ok" as const, reply: r };
          },
          { prefix: "harness2-prop-", contextDir: context_dir },
        );
        if (outcome.kind === "ok") return outcome.reply;
        last = outcome.err;
      } catch (exc) {
        last =
          exc instanceof TimeoutExpiredError
            ? `timeout after ${wall}s`
            : _err_str(exc);
      }
    }

    // 失败收口:Reply(ok=false) 留进 _calls 与审计,再抛 ProposerError。
    const r = new Reply(
      label,
      "",
      false,
      spent_usd,
      pyRound(Date.now() / 1000 - t0, 1),
      tries,
      false,
      this.spec.kind,
      last,
    );
    this._calls.push(r);
    await this._write_audit(r, mission, system, cache_key);
    throw new ProposerError(`[${label}] ${this.spec.kind}/${this.spec.model}: ${last}`, tries, spent_usd);
  }

  /** 通道执行的唯一咽喉(测试桩覆写点);Python 内联于 call() 的三元分派。 */
  protected async _execute(
    tmp: string,
    mission: string,
    system: string,
    wall: number,
  ): Promise<[string, number, string]> {
    return this.spec.kind === "claude_cli"
      ? this._claude_cli(tmp, mission, system, wall)
      : this._opencode(tmp, mission, system, wall);
  }

  protected async _claude_cli(
    cwd: string,
    mission: string,
    system: string,
    wall: number,
  ): Promise<[string, number, string]> {
    const { argv, stdin } = claude_cli_argv(this.spec, mission, system);
    const res = await runWithTimeout(argv[0], argv.slice(1), {
      cwd,
      wall,
      env: this.env(),
      input: stdin,
    });
    const payload = _parse_json(res.stdout);
    // Python: str(payload.get("result") or payload.get("text") or "") —— 假值穿透。
    const raw = payload.result || payload.text || "";
    let text = typeof raw === "string" ? raw : String(raw);
    let err = "";
    const subtype = payload.subtype ?? null;
    if (payload.is_error || (subtype !== null && subtype !== "success")) {
      err = `CLI error: ${payload.subtype} ${text.slice(0, 200)}`;
      text = "";
    } else if (res.code !== 0 && !text.trim()) {
      const rc = res.code ?? -1; // 信号致死近似 -1(Python 为 -N)。
      err = `rc=${rc}: ${(res.stderr || "").slice(-300)}`;
    }
    const cost = Number(payload.total_cost_usd ?? 0) || 0;
    return [text, cost, err];
  }

  protected async _opencode(
    cwd: string,
    mission: string,
    system: string,
    wall: number,
  ): Promise<[string, number, string]> {
    await fs.writeFile(join(cwd, "MISSION.md"), (system ? `${system}\n\n---\n\n` : "") + mission, "utf8");
    const out = join(cwd, "output");
    await fs.mkdir(out, { recursive: true });
    // Python json.dumps 默认分隔符形态:{"agent": {"build": {"steps": N}}} —— 定长模板逐字节对齐。
    await fs.writeFile(
      join(cwd, "opencode.json"),
      `{"agent": {"build": {"steps": ${this.spec.steps}}}}`,
      "utf8",
    );
    const prompt =
      "Read MISSION.md first. Do what it asks. Reply with the requested output as " +
      "your final message AND save it verbatim to output/answer.md.";
    const oc = this._opencode_dir();

    const env = this.env();
    // 限制性沙盒配置(外部目录 deny),不是绕过标志(D12)。
    env.OPENCODE_PERMISSION = JSON.stringify({
      external_directory: { "*": "deny", [cwd]: "allow", [`${cwd}/**`]: "allow" },
    });
    env.XDG_DATA_HOME = join(cwd, ".ocdata");
    env.XDG_STATE_HOME = join(cwd, ".ocstate");

    const argv = opencode_argv({
      bun: this.bun,
      oc,
      model: this.spec.model,
      effort: this.spec.effort,
      cwd,
      prompt,
    });
    const res = await runWithTimeout(argv[0], argv.slice(1), { cwd, wall, env });
    const cost = _opencode_cost(res.stdout);
    const ansText = await fs.readFile(join(out, "answer.md"), "utf8").catch(() => null);
    if (ansText !== null && ansText.trim()) return [ansText, cost, ""];
    const [text, err] = _opencode_stdout(res.stdout);
    if (text.trim()) return [text, cost, ""];
    const rc = res.code ?? -1;
    const tail = _strip_oc_banner(res.stderr || "").trim().slice(-300);
    return ["", cost, `rc=${rc}: ${err || tail || "empty reply"}`];
  }

  protected _opencode_dir(): string {
    const oc = this.opencode_dir;
    if (!oc || !_exists_sync(join(oc, "packages", "opencode", "src", "index.ts"))) {
      // Python raise FileNotFoundError(...) —— 具名子类使 _err_str 的
      // constructor.name 对齐 type(exc).__name__("FileNotFoundError")。
      throw new FileNotFoundError(
        `no OpenCode checkout at ${oc || "<unset>"} (opencode_dir); run ` +
          `scripts/setup_benchmark.py <benchmark> to clone the pinned commit there`,
      );
    }
    return oc;
  }

  protected async _paths(label: string, cache_key = ""): Promise<ProposerPaths | null> {
    if (!this.audit_dir) return null;
    const d = this.audit_dir;
    await fs.mkdir(d, { recursive: true });
    const stem = auditStem(label, cache_key);
    return {
      mission: path.join(d, `${stem}.mission.md`),
      system: path.join(d, `${stem}.system.md`),
      response: path.join(d, `${stem}.response.md`),
      meta: path.join(d, `${stem}.meta.json`),
      workspace: path.join(d, `${stem}.workspace`),
    };
  }

  protected async _cached(
    label: string,
    cache_key = "",
    require_workspace = false,
  ): Promise<Reply | null> {
    const p = await this._paths(label, cache_key);
    if (!p || !(await _is_file(p.response))) return null;
    if (require_workspace && !(await _is_dir(p.workspace))) return null;
    const txt = await fs.readFile(p.response, "utf8");
    if (!txt.trim()) return null;
    return new Reply(
      label,
      txt,
      true,
      0,
      0,
      0,
      true,
      this.spec.kind,
      "",
      p.response,
      (await _is_dir(p.workspace)) ? p.workspace : null,
    );
  }

  protected async _write_audit(
    r: Reply,
    mission: string,
    system: string,
    cache_key = "",
  ): Promise<void> {
    const p = await this._paths(r.label, cache_key);
    if (!p) return;
    await fs.writeFile(p.mission, mission, "utf8");
    if (system) await fs.writeFile(p.system, system, "utf8");
    await fs.writeFile(p.response, r.text, "utf8");
    // Python json.dumps(indent=2) 的键序:label, ok, channel, model, effort,
    // attempts, wall_s, cost_usd, error。
    await fs.writeFile(
      p.meta,
      JSON.stringify(
        {
          label: r.label,
          ok: r.ok,
          channel: r.channel,
          model: this.spec.model,
          effort: this.spec.effort,
          attempts: r.attempts,
          wall_s: r.wall_s,
          cost_usd: r.cost_usd,
          error: r.error,
        },
        null,
        2,
      ),
      "utf8",
    );
    r.audit = p.response;
  }
}

/** Python: Remove a stale harvested workspace so a later cache read cannot serve it. */
async function _drop_workspace(paths: ProposerPaths | null): Promise<void> {
  if (paths) await fs.rm(paths.workspace, { recursive: true, force: true });
}

function _exists_sync(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * claude_cli 的 spawn 规格(argv + stdin)。**D12 显式偏差**:harness2 在此带
 * --dangerously-skip-permissions;移植版不采纳任何审批/沙盒绕过标志。
 * cli 名 "claude" 由 Node spawn 做 PATH 解析(shutil.which 等价)。
 */
export function claude_cli_argv(
  spec: ChannelSpec,
  mission: string,
  system: string,
): { argv: string[]; stdin: string } {
  const argv = ["claude", "-p", "--output-format", "json", "--effort", spec.effort];
  let stdin = mission;
  if (system) {
    if (system.length > SYSTEM_ARG_MAX) {
      stdin = `# SYSTEM INSTRUCTIONS\n\n${system}\n\n# END\n\n${mission}`;
      argv.push(
        "--append-system-prompt",
        "Follow the SYSTEM INSTRUCTIONS block at the top of the message.",
      );
    } else {
      argv.push("--append-system-prompt", system);
    }
  }
  return { argv, stdin };
}

/**
 * opencode 的 spawn 规格(argv)。**D12 显式偏差**:不含任何审批/沙盒绕过标志;
 * _opencode 注入的 OPENCODE_PERMISSION 外目录 deny 是限制性沙盒配置(env),不是绕过。
 */
export function opencode_argv(input: {
  bun: string;
  oc: string;
  model: string;
  effort: string;
  cwd: string;
  prompt: string;
}): string[] {
  const argv = [
    input.bun,
    "run",
    "--cwd",
    join(input.oc, "packages", "opencode"),
    "--conditions=browser",
    "src/index.ts",
    "run",
    input.prompt,
    "--dir",
    input.cwd,
    "--model",
    input.model,
    "--format",
    "json",
  ];
  if (input.effort) argv.push("--variant", input.effort);
  return argv;
}

/** 凭据缺席 preflight 的可注入检测点(宿主可挂 agent-bridge 委派;测试不碰真实 CLI)。 */
export interface CredentialProbes {
  /** CLI 是否可被 spawn(shutil.which 等价);默认 PATH 扫描。 */
  cli_on_path?: (cli: string) => boolean;
  /** 本机登录态是否存在;默认探测 claude 配置目录。 */
  has_local_login?: () => boolean;
  /** 宿主委派通道(agent-bridge 等)是否可用;默认 false。 */
  has_delegation?: () => boolean;
}

function _cli_on_path(cli: string): boolean {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const st = statSync(join(dir, cli));
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch {
      // keep scanning PATH
    }
  }
  return false;
}

function _has_claude_login_state(): boolean {
  // 启发式默认:本机登录态落在 claude 配置目录(CLAUDE_CONFIG_DIR 或 ~/.claude)
  // 或 ~/.claude.json;宿主可注入更精确的探针(如 agent-bridge 可用性)。
  const home = process.env.HOME ?? homedir();
  const cfg = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  try {
    if (statSync(cfg).isDirectory()) return true;
  } catch {
    // fall through
  }
  try {
    return statSync(join(home, ".claude.json")).isFile();
  } catch {
    return false;
  }
}

/**
 * 凭据缺席 preflight(任务 7.1):spawn 本机 CLI 前检查"现有凭据形态"
 * (本机登录态或宿主委派)是否就绪;失败抛错并给出修复指引。不 spawn 任何进程、
 * 不启动模型链。opencode 通道的凭据在检出自身配置中,不由引擎注入(D7),此处不检。
 */
export function preflight_credentials(spec: ChannelSpec, probes: CredentialProbes = {}): void {
  if (spec.kind !== "claude_cli") return;
  const onPath = probes.cli_on_path ?? _cli_on_path;
  const hasLogin = probes.has_local_login ?? _has_claude_login_state;
  const hasDelegation = probes.has_delegation ?? (() => false);
  if (!onPath("claude")) {
    throw new Error(
      "claude CLI not found on PATH: install Claude Code " +
        "(npm install -g @anthropic-ai/claude-code) and re-run preflight. " +
        "The engine spawns the local CLI with the machine's existing credential " +
        "form; it injects no API keys and no Vertex environment (D7).",
    );
  }
  if (!hasDelegation() && !hasLogin()) {
    throw new Error(
      "no usable credential form for claude_cli (no agent-bridge delegation and " +
        "no local login state): run `claude` once and complete login (`claude /login`), " +
        "or wire agent-bridge delegation in the host. The engine injects no API " +
        "keys and no Vertex environment (D7).",
    );
  }
}

/** Python: `d[key]` when it is a dict, else {} 的模块级导出形态(与原版同名)。 */
export { _obj };

/**
 * The claude CLI's one JSON object, tolerating banners and trailing noise around it.
 * Not for opencode stdout, which is a JSONL event stream: use `_opencode_stdout`.
 */
export function _parse_json(stdout: string): Record<string, unknown> {
  const s = (stdout ?? "").trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    // Python 直接 return json.loads(s);非对象顶层走 .get 会 AttributeError,
    // 这里收敛为 {}(同路径继续走 result/text 容错),边缘偏差已记录于头注释。
    return _isObj(v) ? v : {};
  } catch {
    for (const line0 of s.split(/\r?\n/).reverse()) {
      const line = line0.trim();
      if (line.startsWith("{") && line.endsWith("}")) {
        try {
          const v = JSON.parse(line);
          if (_isObj(v)) return v;
        } catch {
          continue;
        }
      }
    }
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (0 <= i && i < j) {
      try {
        const v = JSON.parse(s.slice(i, j + 1));
        if (_isObj(v)) return v;
      } catch {
        // fall through
      }
    }
  }
  return { result: s };
}

const _OC_BANNER =
  /^(?:Performing one time database migration[^\n]*|sqlite-migration:[^\n]*|Database migration complete\.)[ \t]*$/gm;

/** Drop the migration banner lines from OpenCode output. No-op when they are absent. */
export function _strip_oc_banner(s: string): string {
  return (s ?? "").replace(_OC_BANNER, "");
}

/**
 * Fold `opencode run --format json` into (final assistant text, error text).
 * The stream is one raw event per line and assistant prose lives at part.text of a
 * `text` event. All text events are joined, so a trailing terminator event cannot
 * swallow the answer; `error` events become the error string. Plain-text stdout is
 * returned as-is.
 */
export function _opencode_stdout(stdout: string): [string, string] {
  const texts: string[] = [];
  const errors: string[] = [];
  let saw_json = false;
  for (const raw of (stdout ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!_isObj(ev)) continue;
    saw_json = true;
    const part = _obj(ev, "part");
    const ptype = part.type ?? ev.type;
    if (ptype === "text") {
      const t = part.text;
      if (typeof t === "string" && t.trim()) texts.push(t);
    } else if (ptype === "error") {
      const e = ev.error;
      let msg: string;
      if (_isObj(e)) {
        msg = String(_obj(e, "data").message ?? e.name ?? "").trim();
      } else {
        msg = String(e ?? "").trim();
      }
      if (msg) errors.push(msg);
    }
  }
  if (!saw_json) return [_strip_oc_banner(stdout).trim(), ""];
  return [texts.join("\n\n"), errors.join("; ").slice(-300)];
}

/** Sum `part.cost` over the step_finish events of an `opencode run --format json` stream. */
export function _opencode_cost(stdout: string): number {
  let total = 0;
  for (const raw of (stdout ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!_isObj(ev)) continue;
    const part = _obj(ev, "part");
    const ptype = part.type ?? ev.type;
    if (ptype === "step-finish" || ptype === "step_finish") {
      const c = part.cost;
      if (typeof c === "number") total += c;
    }
  }
  return pyRound(total, 6);
}

/**
 * Content-address one call, including its evidence and its mode/task workspace path.
 * The resolved path is part of the key: the two modes can have byte-identical k=1
 * evidence and must still be independent draws.
 */
export async function _call_fingerprint(
  label: string,
  mission: string,
  system: string,
  context_dir: string | null,
): Promise<string> {
  const h = createHash("sha256");
  for (const value of [label, mission, system]) {
    h.update(value, "utf8");
    h.update("\0");
  }
  if (context_dir) {
    // Python Path.resolve() 解析符号链接;Node 只有 realpath 做得到。
    const resolved = await fs.realpath(context_dir).catch(() => path.resolve(context_dir));
    h.update(resolved, "utf8");
    h.update("\0");
    if (await _is_dir(context_dir)) {
      const files = await _rglob_files(context_dir);
      files.sort(_parts_cmp);
      for (const full of files) {
        const rel = path.relative(context_dir, full);
        h.update(rel, "utf8");
        h.update("\0");
        try {
          h.update(await fs.readFile(full));
        } catch (exc) {
          h.update(_unreadable(exc));
        }
        h.update("\0");
      }
    }
  }
  return h.digest("hex").slice(0, 16);
}

/** Python sorted(root.rglob("*")) 的 Path 部件序(非字符串序)。 */
function _parts_cmp(a: string, b: string): number {
  const pa = a.split(path.sep);
  const pb = b.split(path.sep);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

/** rglob("*") 的文件集:不递归符号链接目录(glob ** 语义),跳过 __pycache__ 部件。 */
async function _rglob_files(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        const st = await fs.stat(full).catch(() => null);
        if (st?.isFile()) out.push(full);
        continue;
      }
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) out.push(full);
    }
  };
  await walk(root);
  // Python: if not p.is_file() or "__pycache__" in p.parts: continue
  return out.filter((full) => !full.split(path.sep).includes("__pycache__"));
}
