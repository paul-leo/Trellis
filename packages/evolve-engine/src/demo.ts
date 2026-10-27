// demo.ts — harness2/demo.py(163 行)+ cli/demo.py 驱动的逐行移植。
// A deterministic local adapter for exercising the real adaptation workflow.
//
// 逐条对照:
//   BASE_SCRIPT           → 原样字符串(Python 脚本,由本机 python3 执行 —— 确定性
//                           本地计算,不是 claude/opencode 通道)
//   DemoAdapter           → 类:substrate=OpencodeSubstrate 最小面(name/surface);
//                           ChannelSpec("opencode","local/deterministic");
//                           BenchSpec(name="demo", install_mode="workspace_config",
//                           leak_globs=["reference_answer.txt"], ...)
//   DemoAdapter.execute   → HARNESS2_PYTHON ?? "python3" spawn summarize.py;
//                           execution_count 每次 execute 递增
//   DemoProposer.call     → 全脚本化,不走通道、不走缓存:select.* 按候选文本里的
//                           `Total: <signed>` 精确匹配;experience.* 探测 harness 与
//                           base_harness 的差异;其余标签就地删 " if amount > 0"
//   cli/demo.py main      → runDemo:run_domain("accounting", tasks, k, ...)
//                           + execution_count + editor_calls,写 demo.json
//                           (json.dumps(indent=2) + "\n" 的尾换行保留)
//
// 环境差异(已记录):
// - Python `Decimal` 求和 → TS 用 BigInt 定点十进制(精确,不用 float);
//   `f"{expected:.2f}"` → half-even 2 位格式化。
// - `sys.executable` → `process.env.HARNESS2_PYTHON ?? "python3"`。
// - OpencodeSubstrate 在 TS 只落 demo 需要的 name/surface(materialise/execute 属
//   substrate 执行面,后续任务);surface 常量与 test/fixtures/open-code-surface.ts
//   同源(harness2/substrate/opencode.py:42-86)。
// - Python DemoAdapter 无 score 方法(鸭子类型);TS 接口要求,提供抛错占位,
//   打分管线(阶段二)不在 demo 路径上。

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { Proposer, Reply } from "./proposer.js";
import * as schedule from "./schedule.js";
import {
  makeBenchPrompts,
  makeBenchSpec,
  makeChannelSpec,
  type BenchSpec,
  type ChannelSpec,
  type SubstrateLike,
} from "./spec.js";
import * as harness_tree from "./tree.js";
import { makeSurfaceSpec, type SurfaceSpec, type Tree } from "./tree.js";

export const BASE_SCRIPT = `import csv
import sys
from decimal import Decimal

with open(sys.argv[1]) as source:
    amounts = [Decimal(row['amount']) for row in csv.DictReader(source)]
total = sum((amount for amount in amounts if amount > 0), Decimal(0))
print(f'Total: {total:.2f}')
`;

/** harness2/substrate/opencode.py 的 OPENCODE_SURFACE(demo 只需 name/surface)。 */
export const OPENCODE_SURFACE: SurfaceSpec = makeSurfaceSpec({
  name: "opencode",
  always_on: [
    "systemprompt.md",
    "guardrails.md",
    "LongTermMEMORY.md",
    "tool_descriptions/tool_guidance.md",
  ],
  always_on_max: 24_000,
  always_on_cap_reason: "every token here competes with the agent's own output budget",
  skill_dir: "skills",
  skill_name_rule: "must_match",
  trigger_hint:
    "Fix it by adding a trigger line naming `{name}` to systemprompt.md or " +
    'guardrails.md, e.g. "When <the situation this skill handles>, load the ' +
    "`{name}` skill.\"",
  autotrigger_file: "guardrails.md",
  trigger_line: "- When {desc}, load the `{name}` skill.\n",
  subagent_requires_mode: true,
  plugin_dir: "plugin",
  hooks_file: null,
  stubs: [
    [
      "scripts/README.md",
      "<!-- c7: deterministic helpers, run as `python3 scripts/<name>.py`. " +
        "Add one by emitting scripts/<name>.py. -->\n",
    ],
    [
      "sub_agents/README.md",
      "<!-- c5: delegated subagents, invoked with the `task` tool in their OWN context. " +
        "Add one as sub_agents/<name>/AGENT.md with frontmatter `mode: subagent` and " +
        "`description:`. -->\n",
    ],
    [
      "plugin/README.md",
      "<!-- c8: OpenCode plugins. Acts INSIDE the tool loop -- the only lever that can " +
        "enforce something the model cannot skip. Add one as plugin/<name>.ts. -->\n",
    ],
    [
      "skills/README.md",
      "<!-- c6: reusable workflows loaded on demand via the `skill` tool. Add one as " +
        "skills/<name>/SKILL.md with frontmatter `name:` matching the directory and a " +
        "`description:`. -->\n",
    ],
  ],
});

/** OpencodeSubstrate 的 demo 最小面:demo 只读 name 与 surface()。 */
export class OpencodeSubstrate implements SubstrateLike {
  readonly name = "oc";
  surface(): SurfaceSpec {
    return OPENCODE_SURFACE;
  }
}

/** BigInt 定点十进制:精确求和 demo 的 signed amounts(替代 Python Decimal)。 */
function parseDecimalCents(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`DemoProposer: unparseable amount ${JSON.stringify(s)}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = m[2] as string;
  const frac = (m[3] ?? "").replace(/(\d\d).*/, "$1").padEnd(2, "0").slice(0, 2);
  return sign * (BigInt(whole) * 100n + BigInt(frac));
}

/** `f"{cents/100:.2f}"` 的 half-even 2 位格式化(cents 已是整数,直接拼)。 */
function centsToString(cents: bigint): string {
  const neg = cents < 0n;
  const a = neg ? -cents : cents;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}

async function sumSignedAmounts(csvText: string): Promise<bigint> {
  // csv.DictReader 的最小对应:首行 header,后续行取 amount 列。
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  let total = 0n;
  for (let i = 1; i < lines.length; i++) {
    const cols = (lines[i] as string).split(",");
    total += parseDecimalCents(cols[cols.length - 1] as string);
  }
  return total;
}

function runPython(script: string, arg: string, timeout: number): Promise<string> {
  const python = process.env.HARNESS2_PYTHON ?? "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, arg], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`DemoAdapter.execute timed out after ${timeout}s`));
    }, timeout * 1000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`summarize.py exited ${code}: ${err}`));
    });
  });
}

const AMOUNTS: readonly (readonly [string, string])[] = [
  ["ledger-1", "100.25\n-20.10\n5.00\n"],
  ["ledger-2", "35.50\n-10.25\n-5.00\n"],
];

export class DemoAdapter {
  readonly root: string;
  readonly substrate: SubstrateLike;
  readonly spec: BenchSpec;
  execution_count = 0;

  constructor(root: string) {
    this.root = root;
    this.substrate = new OpencodeSubstrate();
    const channel: ChannelSpec = makeChannelSpec({ kind: "opencode", model: "local/deterministic" });
    this.spec = makeBenchSpec({
      name: "demo",
      runs_root: join(root, "runs"),
      install_mode: "workspace_config",
      prompts: makeBenchPrompts({ work: "reconcile signed amounts in a transaction ledger" }),
      channels: { proposer: channel, selector: channel },
      leak_globs: ["reference_answer.txt"],
    });
    this.execution_count = 0;
  }

  /** 同步构造期写树:TS 无同步 I/O,拆为 async 工厂(Python __init__ 的写盘部分)。 */
  async setup(): Promise<void> {
    const base: Tree = {};
    for (const name of OPENCODE_SURFACE.always_on) base[name] = "";
    base["systemprompt.md"] = "Reconcile the ledger using python scripts/summarize.py.\n";
    base["scripts/summarize.py"] = BASE_SCRIPT;
    await harness_tree.write_tree(OPENCODE_SURFACE, base, await this.base_harness(), {
      stubs: false,
    });
    for (const [task_id, amounts] of AMOUNTS) {
      const source = await this.task_files(task_id);
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(join(source, "ledger.csv"), "amount\n" + amounts, "utf8");
    }
  }

  async tasks(_split = "all"): Promise<string[]> {
    return ["ledger-1", "ledger-2"];
  }

  domain_of(_task_id: string): string {
    return "accounting";
  }

  task_prompt(_task_id: string): string {
    return "Sum every signed amount in ledger.csv. Return Total: with two decimal places.";
  }

  async task_files(task_id: string): Promise<string> {
    return join(this.root, "sources", task_id);
  }

  async base_harness(): Promise<string> {
    return join(this.root, "base");
  }

  async validate_tree(harness: Record<string, string>): Promise<void> {
    if (!("scripts/summarize.py" in harness)) {
      // Python raise ValueError(...) —— TS Error;recursion 按 e.message 反馈。
      throw new Error("The local executor requires scripts/summarize.py");
    }
  }

  async execute(
    task_id: string,
    harness_dir: string | null,
    run_id: string,
    opts: { timeout?: number | null } = {},
  ): Promise<string> {
    this.execution_count += 1;
    const run_dir = join(this.root, "executions", run_id);
    await fs.mkdir(run_dir, { recursive: true });
    const script = join(harness_dir ?? (await this.base_harness()), "scripts", "summarize.py");
    const csv = join(await this.task_files(task_id), "ledger.csv");
    const stdout = await runPython(script, csv, opts.timeout || 10);
    await fs.writeFile(join(run_dir, "answer.txt"), stdout, "utf8");
    await fs.writeFile(
      join(run_dir, "trajectory.md"),
      "[ACTION] Run scripts/summarize.py on ledger.csv\n[OBSERVATION]\n" + stdout,
      "utf8",
    );
    return run_dir;
  }

  async delivered(run_dir: string): Promise<boolean> {
    try {
      return (await fs.stat(join(run_dir, "answer.txt"))).isFile();
    } catch {
      return false;
    }
  }

  async trajectory(run_dir: string, _opts: { obs_trunc: number }): Promise<string> {
    return fs.readFile(join(run_dir, "trajectory.md"), "utf8");
  }

  async deliverable_text(run_dir: string): Promise<string> {
    return fs.readFile(join(run_dir, "answer.txt"), "utf8");
  }

  async deliverable_files(run_dir: string): Promise<Record<string, string>> {
    return { "answer.txt": await this.deliverable_text(run_dir) };
  }

  /** demo 不进打分管线;Python 侧无此方法(鸭子类型),TS 接口要求提供占位。 */
  async score(_run_dir: string, _task_id: string): Promise<Record<string, unknown> | null> {
    throw new Error("DemoAdapter is never scored; core.judge is out of the demo path");
  }
}

export class DemoProposer extends Proposer {
  /** Scripted edits and selection; no model service or benchmark judge is used. */
  override async call(
    _mission: string,
    context_dir: string | null,
    label: string,
    _opts: {
      system?: string;
      timeout?: number;
      max_attempts?: number;
      harvest?: string | null;
    } = {},
  ): Promise<Reply> {
    const context = context_dir as string;
    let workspace: string | null = null;
    let text: string;
    if (label.startsWith("select.")) {
      const csvText = await fs.readFile(join(context, "source", "ledger.csv"), "utf8");
      const expected = await sumSignedAmounts(csvText);
      const dir = join(context, "candidates");
      const candidates = (await fs.readdir(dir))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => join(dir, f));
      let chosen = "";
      for (const path of candidates) {
        const body = await fs.readFile(path, "utf8");
        if (body.includes(`Total: ${centsToString(expected)}`)) {
          chosen = path.slice(path.lastIndexOf("/") + 1, path.length - 3); // path.stem
          break;
        }
      }
      text =
        `<why>The signed total matches the source ledger.</why>\n` +
        "```choice\n" +
        chosen +
        "\n```";
    } else if (label.startsWith("experience.")) {
      const changed =
        (await fs.readFile(join(context, "harness", "scripts", "summarize.py"), "utf8")) !==
        (await fs.readFile(join(context, "base_harness", "scripts", "summarize.py"), "utf8"));
      text =
        "<edits>\ncomponent: scripts/summarize.py\ncandidates: inv1\n" +
        "change: dropped the positive-only filter from the amount sum\n" +
        "observed: the probe total included the credits the base run omitted\n" +
        `verdict: ${changed ? "helped" : "no observed effect"}\n</edits>\n\n` +
        (changed
          ? "<experience>\ncue: When a ledger includes credits and debits\n" +
            "lesson: Include both signs when summing in scripts/summarize.py.\n" +
            "evidence: The scripts/summarize.py row -- removing the positive-only filter " +
            "changed the probe total to include the credits omitted by the base trajectory.\n" +
            "confidence: high for this observed arithmetic contrast\n</experience>"
          : "NO_ENTRY");
    } else {
      workspace = join(context, "harness");
      const script = join(workspace, "scripts", "summarize.py");
      const body = await fs.readFile(script, "utf8");
      await fs.writeFile(script, body.replaceAll(" if amount > 0", ""), "utf8");
      text =
        "<notes>Keep signed amounts: the base total omitted credits in the source ledger.</notes>";
    }
    const reply = new Reply(label, text, true, 0, 0, 1, false, "", "", null, workspace);
    this._calls.push(reply);
    return reply;
  }
}

export interface DemoRunResult extends schedule.DomainResult {
  execution_count: number;
  editor_calls: number;
}

/**
 * cli/demo.py main 的库形态:root 下跑 accounting 域 k 双模式,写 demo.json
 * (json.dumps(indent=2) + "\n")。返回 result 供测试断言。
 */
export async function runDemo(
  root: string,
  opts: { k?: number; modes?: readonly string[] } = {},
): Promise<DemoRunResult> {
  const k = opts.k ?? 2;
  const modes = opts.modes ?? schedule.MODES;
  const adapter = new DemoAdapter(root);
  await adapter.setup();
  const proposer = new DemoProposer(adapter.spec.channels["proposer"] as ChannelSpec);
  const result = await schedule.run_domain("accounting", await adapter.tasks(), k, {
    adapter: adapter as unknown as Parameters<typeof schedule.run_domain>[3]["adapter"],
    prop: proposer,
    runs_root: adapter.spec.runs_root,
    library_root: join(root, "library", `k${k}`),
    modes,
  });
  const report: DemoRunResult = {
    ...result,
    execution_count: adapter.execution_count,
    editor_calls: proposer._calls.length,
  };
  await fs.writeFile(
    join(root, "demo.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
  return report;
}
