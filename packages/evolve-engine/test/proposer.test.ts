// 任务 5.1 验证:proposer 移植——调用指纹缓存、重试退避、并发闸门、失败收口、审计写盘。
// tasks.md 显式验证点:
//   - golden 对照全绿(DemoProposer 覆盖 call(),golden 不锚定真实通道机械;
//     本文件跑完后全量套件须保持全绿);
//   - 缓存命中零子进程(通道执行以桩计数,零子进程 ⇔ _execute 未被调用);
//   - 并发不超闸(全局信号量峰值断言)。
// 通道执行一律用桩,不 spawn 真实 CLI;spawn 规格由 claude_cli_argv 纯函数断言(D7/D12)。
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _call_fingerprint,
  _is_dropped_env,
  _opencode_cost,
  _opencode_stdout,
  _parse_json,
  _strip_oc_banner,
  claude_cli_argv,
  DEFAULT_PROPOSER_CONCURRENCY,
  opencode_argv,
  preflight_credentials,
  Proposer,
  ProposerError,
  Reply,
  retry_backoff_s,
  set_proposer_concurrency,
  SYSTEM_ARG_MAX,
  _DROP_ENV,
} from "../src/proposer.js";
import { auditStem } from "../src/sandbox.js";
import { makeChannelSpec } from "../src/spec.js";

const SPEC = makeChannelSpec({ kind: "claude_cli", model: "claude-x" });

type ExecResult = [string, number, string];

class FakeProposer extends Proposer {
  exec_calls = 0;
  concurrent = 0;
  peak = 0;
  behavior: (tmp: string, mission: string, system: string, wall: number) => Promise<ExecResult>;

  constructor(
    behavior: (tmp: string, mission: string, system: string, wall: number) => Promise<ExecResult>,
    opts: ConstructorParameters<typeof Proposer>[1] = {},
  ) {
    super(SPEC, opts);
    this.behavior = behavior;
  }

  protected async _execute(
    tmp: string,
    mission: string,
    system: string,
    wall: number,
  ): Promise<ExecResult> {
    this.exec_calls += 1;
    this.concurrent += 1;
    this.peak = Math.max(this.peak, this.concurrent);
    try {
      return await this.behavior(tmp, mission, system, wall);
    } finally {
      this.concurrent -= 1;
    }
  }
}

const OK = async (): Promise<ExecResult> => ["answer text", 0.5, ""];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 缓存命中零子进程 ----

test("缓存命中零子进程:同指纹第二次 call 不进通道执行", async () => {
  const audit = await fs.mkdtemp(join(tmpdir(), "prop-audit-"));
  try {
    const p = new FakeProposer(OK, { audit_dir: audit });
    const r1 = await p.call("mission A", null, "lab1");
    assert.equal(p.exec_calls, 1);
    assert.equal(r1.ok, true);
    assert.equal(r1.cached, false);
    assert.equal(r1.text, "answer text");
    assert.equal(r1.cost_usd, 0.5);
    assert.equal(r1.attempts, 1);
    assert.equal(r1.channel, "claude_cli");

    const r2 = await p.call("mission A", null, "lab1");
    assert.equal(p.exec_calls, 1, "缓存命中后通道执行次数不增");
    assert.equal(r2.cached, true);
    assert.equal(r2.ok, true);
    assert.equal(r2.text, "answer text");
    assert.equal(r2.cost_usd, 0, "缓存回复不计费");
    const stem = auditStem("lab1", await _call_fingerprint("lab1", "mission A", "", null));
    assert.equal(r2.audit, join(audit, `${stem}.response.md`));
  } finally {
    await fs.rm(audit, { recursive: true, force: true });
  }
});

test("缓存键随 harvest 的 workspace 存在性收敛;stale 状态不被复用", async () => {
  const audit = await fs.mkdtemp(join(tmpdir(), "prop-audit-"));
  try {
    // 通道执行不产 harvest 子路径 → workspace 收割失败,缓存写入但后续 harvest 读取失效。
    const p = new FakeProposer(OK, { audit_dir: audit });
    const r1 = await p.call("m", null, "lab2", { harvest: "context/harness" });
    assert.equal(p.exec_calls, 1);
    assert.equal(r1.workspace, null, "无子路径可收割");

    const r2 = await p.call("m", null, "lab2", { harvest: "context/harness" });
    assert.equal(p.exec_calls, 2, "workspace 缺失时缓存不服务");
    assert.equal(r2.workspace, null);

    // 通道执行真的收割到 workspace 后,缓存可带 workspace 复用。
    const p2 = new FakeProposer(
      async (tmp) => {
        await fs.mkdir(join(tmp, "context", "harness"), { recursive: true });
        await fs.writeFile(join(tmp, "context", "harness", "guardrails.md"), "G", "utf8");
        return ["tree edit", 1, ""];
      },
      { audit_dir: audit },
    );
    const r3 = await p2.call("m2", null, "lab3", { harvest: "context/harness" });
    assert.equal(p2.exec_calls, 1);
    const stem3 = auditStem("lab3", await _call_fingerprint("lab3", "m2", "", null));
    assert.equal(r3.workspace, join(audit, `${stem3}.workspace`));
    assert.equal(await fs.readFile(join(r3.workspace!, "guardrails.md"), "utf8"), "G");

    const r4 = await p2.call("m2", null, "lab3", { harvest: "context/harness" });
    assert.equal(p2.exec_calls, 1, "workspace 在,缓存命中零子进程");
    assert.equal(r4.cached, true);
    assert.equal(r4.workspace, r3.workspace);
  } finally {
    await fs.rm(audit, { recursive: true, force: true });
  }
});

// ---- 并发不超闸 ----

test("并发不超闸:默认闸门 2,六路并发峰值 ≤ 2;不限闸时六路齐发", async () => {
  const audit = await fs.mkdtemp(join(tmpdir(), "prop-audit-"));
  set_proposer_concurrency(DEFAULT_PROPOSER_CONCURRENCY);
  try {
    const slow = async (): Promise<ExecResult> => {
      await sleep(60);
      return ["x", 0, ""];
    };
    const p = new FakeProposer(slow, { audit_dir: audit });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => p.call(`m${i}`, null, `conc-${i}`)),
    );
    assert.equal(p.exec_calls, 6);
    assert.ok(p.peak <= 2, `峰值 ${p.peak} 超过闸门 2`);
    assert.ok(p.peak >= 1);

    set_proposer_concurrency(0);
    const p2 = new FakeProposer(slow, { audit_dir: audit });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => p2.call(`m${i}`, null, `free-${i}`)),
    );
    assert.equal(p2.peak, 6, "不限闸时六路齐发");
  } finally {
    set_proposer_concurrency(DEFAULT_PROPOSER_CONCURRENCY);
    await fs.rm(audit, { recursive: true, force: true });
  }
});

// ---- 调用指纹 ----

test("call_fingerprint: 稳定且对 label/mission/system/路径/内容敏感,__pycache__ 不参与", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "fp-ctx-"));
  const other = await fs.mkdtemp(join(tmpdir(), "fp-ctx2-"));
  try {
    await fs.writeFile(join(base, "a.md"), "A", "utf8");
    await fs.writeFile(join(other, "a.md"), "A", "utf8");

    const k0 = await _call_fingerprint("l", "m", "s", base);
    assert.equal(k0.length, 16);
    assert.equal(await _call_fingerprint("l", "m", "s", base), k0, "同输入稳定");
    assert.notEqual(await _call_fingerprint("l2", "m", "s", base), k0, "label 参与");
    assert.notEqual(await _call_fingerprint("l", "m2", "s", base), k0, "mission 参与");
    assert.notEqual(await _call_fingerprint("l", "m", "s2", base), k0, "system 参与");
    assert.notEqual(await _call_fingerprint("l", "m", "s", other), k0, "路径参与(内容相同也独立)");
    assert.notEqual(await _call_fingerprint("l", "m", "s", null), k0, "无 context 也不同");

    await fs.writeFile(join(base, "a.md"), "B", "utf8");
    const k1 = await _call_fingerprint("l", "m", "s", base);
    assert.notEqual(k1, k0, "内容参与");

    await fs.mkdir(join(base, "__pycache__"), { recursive: true });
    await fs.writeFile(join(base, "__pycache__", "a.pyc"), "JUNK", "utf8");
    assert.equal(await _call_fingerprint("l", "m", "s", base), k1, "__pycache__ 不参与指纹");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});

// ---- 重试退避与失败收口 ----

test("retry_backoff_s: 10s×(attempt-1)", () => {
  assert.equal(retry_backoff_s(1), 0);
  assert.equal(retry_backoff_s(2), 10);
  assert.equal(retry_backoff_s(3), 20);
});

test("失败收口:Reply(ok=false) 进 _calls 与审计,ProposerError 文案逐字", async () => {
  const audit = await fs.mkdtemp(join(tmpdir(), "prop-audit-"));
  try {
    const p = new FakeProposer(
      async () => {
        throw new Error("boom");
      },
      { audit_dir: audit, attempts: 1 },
    );
    await assert.rejects(p.call("M", null, "fail lab"), (e: unknown) => {
      assert.ok(e instanceof ProposerError);
      assert.equal(e.message, "[fail lab] claude_cli/claude-x: Error: boom");
      assert.equal(e.attempts, 1);
      assert.equal(e.cost_usd, 0);
      return true;
    });
    assert.equal(p._calls.length, 1);
    const r = p._calls[0];
    assert.equal(r.ok, false);
    assert.equal(r.text, "");
    assert.equal(r.error, "Error: boom");
    assert.equal(r.attempts, 1);
    assert.equal(r.channel, "claude_cli");

    // safeLabel:空格 → 下划线;文件名带 cacheKey 段。
    const stemF = auditStem("fail lab", await _call_fingerprint("fail lab", "M", "", null));
    const meta2 = JSON.parse(await fs.readFile(join(audit, `${stemF}.meta.json`), "utf8"));
    assert.equal(meta2.ok, false);
    assert.equal(meta2.error, "Error: boom");
    assert.equal(meta2.model, "claude-x");
    assert.equal(meta2.channel, "claude_cli");
    assert.equal(meta2.attempts, 1);
  } finally {
    await fs.rm(audit, { recursive: true, force: true });
  }
});

test("失败收口:空回复 last=err 或 'empty reply';重试退避后成功 attempts 计数", async () => {
  const audit = await fs.mkdtemp(join(tmpdir(), "prop-audit-"));
  try {
    const p = new FakeProposer(async () => ["", 0, ""], {
      audit_dir: audit,
      attempts: 1,
    });
    await assert.rejects(p.call("m", null, "empty1"), /empty reply/);
    assert.equal(p._calls[0].error, "empty reply");

    // 通道自带 err 文本时优先于 'empty reply'。
    const p2 = new FakeProposer(async () => ["", 0, "CLI error: x"], {
      audit_dir: audit,
      attempts: 1,
    });
    await assert.rejects(p2.call("m", null, "empty2"), /CLI error: x/);

    // 重试退避接缝置 0:第一次炸、第二次成功 → attempts=2,spent 累计。
    let n = 0;
    const p3 = new FakeProposer(
      async () => {
        n += 1;
        if (n === 1) throw new Error("flaky");
        return ["recovered", 1.5, ""];
      },
      { audit_dir: audit, attempts: 3, backoff_ms: () => 0 },
    );
    const r = await p3.call("m", null, "retry1");
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 2);
    assert.equal(r.text, "recovered");
    assert.equal(r.cost_usd, 1.5, "失败尝试的 cost 也累计(Python spent_usd)");
    assert.equal(p3._calls.length, 1);
  } finally {
    await fs.rm(audit, { recursive: true, force: true });
  }
});

test("构造:空 model 抛错文案逐字", () => {
  assert.throws(
    () => new Proposer(makeChannelSpec({ kind: "claude_cli", model: "" })),
    /Set HARNESS2_IMPROVER_MODEL before starting model sessions/,
  );
});

// ---- 审计写盘 ----

test("审计写盘:mission/system/response/meta 内容与字段;空 system 不写 system.md", async () => {
  const audit = await fs.mkdtemp(join(tmpdir(), "prop-audit-"));
  try {
    const p = new FakeProposer(OK, { audit_dir: audit });
    await p.call("the mission", null, "aud1");
    const stem1 = auditStem("aud1", await _call_fingerprint("aud1", "the mission", "", null));
    assert.equal(await fs.readFile(join(audit, `${stem1}.mission.md`), "utf8"), "the mission");
    assert.equal(await fs.readFile(join(audit, `${stem1}.response.md`), "utf8"), "answer text");
    await assert.rejects(fs.stat(join(audit, `${stem1}.system.md`)));
    const meta = JSON.parse(await fs.readFile(join(audit, `${stem1}.meta.json`), "utf8"));
    assert.deepEqual(meta, {
      label: "aud1",
      ok: true,
      channel: "claude_cli",
      model: "claude-x",
      effort: "high",
      attempts: 1,
      wall_s: meta.wall_s,
      cost_usd: 0.5,
      error: "",
    });
    assert.equal(typeof meta.wall_s, "number");

    await p.call("the mission", null, "aud2", { system: "SYS TEXT" });
    const stem2 = auditStem("aud2", await _call_fingerprint("aud2", "the mission", "SYS TEXT", null));
    assert.equal(await fs.readFile(join(audit, `${stem2}.system.md`), "utf8"), "SYS TEXT");
  } finally {
    await fs.rm(audit, { recursive: true, force: true });
  }
});

// ---- D7 / D12:env 与 spawn 规格 ----

test("D7 env:剥掉 _DROP_ENV;claude_cli 只注入 ANTHROPIC_MODEL,无任何 Vertex 形态", () => {
  const saved: Record<string, string | undefined> = {};
  const poke = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
  ];
  for (const k of poke) {
    saved[k] = process.env[k];
    process.env[k] = "SECRET-SENTINEL";
  }
  // ANTHROPIC_MODEL 不在剥除清单(claude_cli 通道要注入它)。运行测试的
  // 机器/会话可能自带一份,而 env() 按设计继承非凭据变量 —— opencode 通道
  // 的"不注入 ANTHROPIC_MODEL"断言只在没有环境副本时成立,先清掉并还原。
  saved.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  try {
    const p = new Proposer(SPEC);
    const e = p.env();
    for (const k of poke) assert.equal(e[k], undefined, `${k} 应被剥掉`);
    assert.equal(_DROP_ENV.length, 5);
    assert.equal(e.ANTHROPIC_MODEL, "claude-x");
    for (const k of Object.keys(e)) {
      assert.ok(
        !/^(GOOGLE_|VERTEX|CLAUDE_CODE_USE_)/.test(k),
        `env 不得注入 Vertex 形态变量: ${k}`,
      );
    }
    // opencode 通道同样零注入。
    const oc = new Proposer(makeChannelSpec({ kind: "opencode", model: "p/m" })).env();
    assert.equal(oc.ANTHROPIC_MODEL, undefined);
    for (const k of Object.keys(oc)) {
      assert.ok(!/^(GOOGLE_|VERTEX|CLAUDE_CODE_USE_)/.test(k), k);
    }
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("D12/7.2 spawn 规格:claude_cli_argv 与 opencode_argv 均不含任何审批/沙盒绕过标志", () => {
  const { argv, stdin } = claude_cli_argv(SPEC, "MISSION", "");
  assert.deepEqual(argv, ["claude", "-p", "--output-format", "json", "--effort", "high"]);
  assert.equal(stdin, "MISSION");
  for (const a of argv) {
    assert.ok(!/dangerous|bypass|skip-permissions/i.test(a), `绕过标志: ${a}`);
  }

  const small = claude_cli_argv(SPEC, "M", "system text");
  assert.deepEqual(small.argv.slice(-2), ["--append-system-prompt", "system text"]);
  assert.equal(small.stdin, "M");

  const huge = "S".repeat(SYSTEM_ARG_MAX + 1);
  const big = claude_cli_argv(SPEC, "M", huge);
  assert.equal(
    big.stdin,
    `# SYSTEM INSTRUCTIONS\n\n${huge}\n\n# END\n\nM`,
  );
  assert.deepEqual(big.argv.slice(-2), [
    "--append-system-prompt",
    "Follow the SYSTEM INSTRUCTIONS block at the top of the message.",
  ]);

  // opencode 通道同样无绕过标志(harness2 的 --dangerously-bypass-approvals-and-sandbox
  // 不采纳;OPENCODE_PERMISSION 外目录 deny 是限制性沙盒配置,在 env 而非 argv)。
  const oc = opencode_argv({
    bun: "bun",
    oc: "/oc",
    model: "p/m",
    effort: "high",
    cwd: "/w",
    prompt: "P",
  });
  for (const a of oc) {
    assert.ok(!/dangerous|bypass|skip-permissions|yolo/i.test(a), `绕过标志: ${a}`);
  }
  assert.ok(oc.includes("--format") && oc.includes("json"));
});

// ---- 任务 7.1:凭据 env 快照与凭据缺席 preflight ----

test("7.1 spawn env 快照:GOOGLE_*/VERTEX_*/Vertex 形态既不注入也不继承", () => {
  const vertexShaped = [
    "GOOGLE_VERTEX_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "VERTEXAI_LOCATION",
    "VERTEX_FOO",
    "CLAUDE_CODE_USE_VERTEX",
    "CLOUD_ML_REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of [...vertexShaped, "ENV_KEEPER"]) {
    saved[k] = process.env[k];
    process.env[k] = "SECRET-SENTINEL";
  }
  // 同 D7:环境自带的 ANTHROPIC_MODEL 会经 env() 继承进 opencode 通道,
  // "不注入"断言须在没有环境副本时才成立。
  saved.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  try {
    for (const kind of ["claude_cli", "opencode"] as const) {
      const p = new Proposer(
        makeChannelSpec({ kind, model: kind === "claude_cli" ? "claude-x" : "p/m" }),
      );
      const e = p.env();
      for (const k of vertexShaped) {
        assert.equal(e[k], undefined, `${kind}: ${k} 不得出现在 spawn env`);
      }
      assert.equal(e.ENV_KEEPER, "SECRET-SENTINEL", `${kind}: 非凭据变量应放行`);
      // 快照断言:输出 key 集合里没有任何 Vertex/GOOGLE 形态(与判据一致)
      for (const k of Object.keys(e)) {
        assert.ok(!_is_dropped_env(k), `env() 输出里出现应剥变量: ${k}`);
        assert.ok(!/^(GOOGLE_|VERTEX|CLAUDE_CODE_USE_)/.test(k), `Vertex 形态泄漏: ${k}`);
      }
    }
    assert.equal(new Proposer(SPEC).env().ANTHROPIC_MODEL, "claude-x");
    assert.equal(
      new Proposer(makeChannelSpec({ kind: "opencode", model: "p/m" })).env().ANTHROPIC_MODEL,
      undefined,
    );
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("7.1 preflight:凭据缺席抛错带修复指引;登录态或委派任一存在即通过", () => {
  // CLI 缺席:修复指引给安装命令
  assert.throws(
    () => preflight_credentials(SPEC, { cli_on_path: () => false }),
    (exc: unknown) => {
      const m = (exc as Error).message;
      assert.ok(m.includes("claude CLI not found on PATH"), m);
      assert.ok(m.includes("npm install -g @anthropic-ai/claude-code"), m);
      return true;
    },
  );
  // CLI 在,但既无本机登录态也无宿主委派:修复指引给登录/委派两条路
  // (探针全部钉死,不依赖本机 ~/.claude 真实状态)
  assert.throws(
    () =>
      preflight_credentials(SPEC, {
        cli_on_path: () => true,
        has_local_login: () => false,
        has_delegation: () => false,
      }),
    (exc: unknown) => {
      const m = (exc as Error).message;
      assert.ok(m.includes("no usable credential form"), m);
      assert.ok(m.includes("claude /login"), m);
      assert.ok(m.includes("agent-bridge"), m);
      return true;
    },
  );
  // 本机登录态单独存在 → 通过(委派缺席)
  preflight_credentials(SPEC, {
    cli_on_path: () => true,
    has_local_login: () => true,
    has_delegation: () => false,
  });
  // 宿主委派(agent-bridge)单独存在 → 免本机登录态
  preflight_credentials(SPEC, {
    cli_on_path: () => true,
    has_local_login: () => false,
    has_delegation: () => true,
  });
  // opencode 通道:凭据在检出自身配置,引擎不注入也不检(D7)
  preflight_credentials(makeChannelSpec({ kind: "opencode", model: "p/m" }), {
    cli_on_path: () => false,
  });
});

test("opencode 通道:缺检出抛 FileNotFoundError 文案,不 spawn", async () => {
  const audit = await fs.mkdtemp(join(tmpdir(), "prop-audit-"));
  try {
    const p = new Proposer(makeChannelSpec({ kind: "opencode", model: "p/m" }), {
      audit_dir: audit,
      attempts: 1,
      opencode_dir: "",
    });
    await assert.rejects(
      p.call("m", null, "oc1"),
      /FileNotFoundError: no OpenCode checkout at <unset> \(opencode_dir\)/,
    );
  } finally {
    await fs.rm(audit, { recursive: true, force: true });
  }
});

// ---- 解析机械(纯函数,与 Python 同名同义) ----

test("_parse_json: 整包/噪声行/括号切片/兜底 result", () => {
  assert.deepEqual(_parse_json('{"result": "ok"}'), { result: "ok" });
  assert.deepEqual(_parse_json(""), {});
  assert.deepEqual(
    _parse_json('banner noise\n{"result": "line"}\ntrailing'),
    { result: "line" },
  );
  assert.deepEqual(_parse_json("noise\n{not json}\nstill"), {
    result: "noise\n{not json}\nstill",
  });
  assert.deepEqual(_parse_json("pre {\"text\": \"mid\"} post"), { text: "mid" });
});

test("_opencode_stdout / _opencode_cost / _strip_oc_banner", () => {
  const stream = [
    '{"type":"text","part":{"type":"text","text":"hello"}}',
    '{"type":"step-finish","part":{"type":"step-finish","cost":0.25}}',
    '{"type":"text","part":{"type":"text","text":"world"}}',
    '{"type":"step_finish","part":{"type":"step_finish","cost":0.05}}',
    '{"type":"error","error":{"data":{"message":"bad"}}}',
  ].join("\n");
  assert.deepEqual(_opencode_stdout(stream), ["hello\n\nworld", "bad"]);
  assert.equal(_opencode_cost(stream), 0.3);

  assert.deepEqual(_opencode_stdout("plain output"), ["plain output", ""]);
  assert.deepEqual(
    _opencode_stdout("Performing one time database migration x\nsqlite-migration: y\nDatabase migration complete.\nresult text"),
    ["result text", ""],
  );
  // Python re.sub 多行 $ 不吃换行:banner 行被换成空串,行尾 \n 留下(与原版一致)。
  assert.equal(
    _strip_oc_banner("Performing one time database migration now  \nkeep\n"),
    "\nkeep\n",
  );
});

test("Reply: ok 形态(JS 无 __bool__,读 reply.ok)", () => {
  const r = new Reply("l", "t", true);
  assert.equal(r.ok, true);
  assert.equal(r.cost_usd, 0);
  assert.equal(r.audit, null);
  const f = new Reply("l", "", false, 1, 2, 3, false, "claude_cli", "err");
  assert.equal(f.ok, false);
  assert.equal(f.error, "err");
  assert.equal(f.attempts, 3);
});
