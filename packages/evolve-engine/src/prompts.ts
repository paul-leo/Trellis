// prompts.ts — harness2/core/prompts.py(1163 行)的逐行移植。
// 方法发送的每一条 prompt。benchmark 文本以值进入,从不以分支进入。
// 大段散文常量在 ./prompt-text.js(生成物,逐字节等于 Python 原版);
// 本文件只有插值与组装逻辑。
//
// 逐条对照:
//   VERSION = "harness2-1"                        原样(在 prompt-text.js)
//   _tidy     → _tidy:\n{3,} → \n\n,strip + 尾部单换行
//   _work/_lens/_checks                           同构
//   _surface_part → _surfacePart:indexOf 缺席即抛(对应 Python str.index 的 ValueError)
//   _build_surface_texts() → 模块加载期构建(对应 Python module-load);
//                   .replace 语义相同(全部替换);替换文本里的 {deliverable} 留给后续 format
//   _st       → _st:未知 surface 抛错,文案含 pyRepr + 排序后名单
//   str.format 命名占位 → _format:支持 {name} 子集;替换后仍残留 {name} 形态即抛
//                   (对应 Python 的 KeyError fail-fast);Python .upper() ≈ toUpperCase()(ASCII)
//   propose / aggregate / compose_round / select / experience / _tts_*  逐行同构
//
// f-string → TS 模板字面量;条件分段保持原顺序;复数 's'/' is'/'s are' 分支同构。

import {
  ANSWER_FREE,
  ANSWER_FREE_SELECT,
  CONFORMANCE_BLOCK,
  EVIDENCE_BOUNDARY,
  EVIDENCE_BOUNDARY_SELECT,
  GENERALIZE,
  POOL_FINALS_SELECT,
  POOL_MIXED_SELECT,
  VALUE_TAIL,
  _DOM_TEMPLATE,
  _INV_TEMPLATE,
  _KEEP_BASE,
  _SURFACE_CODEX,
  _SURFACE_OPENCODE,
  _TTS_DOM,
  _TTS_GENERALIZE,
  _TTS_HOW,
  _TTS_INV,
  _TTS_SURFACE_HEAD_CODEX,
  _TTS_SURFACE_HEAD_OPENCODE,
} from "./prompt-text.js";
import { pyListRepr, pyRepr } from "./pyutil.js";
import type { BenchPrompts } from "./spec.js";
import type { SurfaceSpec } from "./tree.js";

// Python 侧 prompts.VERSION("harness2-1");与 runmark.VERSION 在根入口撞名,导出别名。
export { VERSION as PROMPTS_VERSION } from "./prompt-text.js";

/** 折叠空可选槽留下的连续空行;strip 后补一个换行。 */
export function _tidy(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Python str.format 的命名占位最小子集({name})。残留占位形态即抛(≈KeyError)。 */
function _format(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(value);
  }
  const leftover = out.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
  if (leftover) {
    throw new Error(`KeyError: ${pyRepr(leftover[0].slice(1, -1))}`);
  }
  return out;
}

function _work(bp: BenchPrompts): string {
  return `# THE WORK\n\n${bp.work.trim()}`;
}

function _lens(bp: BenchPrompts): string {
  const body = bp.domain_guidance.trim();
  return body ? `# DOMAIN AND TASK LENS\n\n${body}` : "";
}

function _checks(bp: BenchPrompts): string {
  const body = bp.selection_checks.trim();
  return body ? `# WHAT CORRECTNESS MEANS FOR THIS WORK\n\n${body}` : "";
}

function _surfacePart(surface_md: string, start: string, end?: string): string {
  const i = surface_md.indexOf(start);
  if (i === -1) throw new Error(`ValueError: substring not found: ${pyRepr(start)}`);
  const j = end === undefined ? surface_md.length : surface_md.indexOf(end);
  if (j === -1) throw new Error(`ValueError: substring not found: ${pyRepr(end)}`);
  return surface_md.slice(i, j).trim();
}

interface _SurfaceText {
  readonly surface_md: string;
  readonly inv: string;
  readonly dom: string;
  readonly tts_surface: string;
}

function _buildSurfaceTexts(): Record<string, _SurfaceText> {
  const oc_tts = [
    _TTS_SURFACE_HEAD_OPENCODE,
    _surfacePart(_SURFACE_OPENCODE, "THREE RULES THAT DISCARD", "THE DELIVERABLE'S SHAPE"),
    _surfacePart(_SURFACE_OPENCODE, "# HOW TO MAKE A CHANGE"),
  ].join("\n\n");
  const cx_tts = [
    _TTS_SURFACE_HEAD_CODEX,
    _surfacePart(_SURFACE_CODEX, "A skill only exists", "THE DELIVERABLE'S SHAPE"),
    _surfacePart(_SURFACE_CODEX, "# HOW TO MAKE A CHANGE"),
  ].join("\n\n");
  return {
    opencode: {
      surface_md: _SURFACE_OPENCODE,
      inv: _INV_TEMPLATE.split("__LOOP_LEVER__").join(
        "`plugin/<name>.ts` hook -- for example, preventing exit before a " +
          "{deliverable} exists",
      ),
      dom: _DOM_TEMPLATE.split("__TRIGGER_SENTENCE__").join(
        "A skill exists only once its name appears in the always-on text: write that " +
          "trigger line in the same edit.",
      ),
      tts_surface: oc_tts,
    },
    codex: {
      surface_md: _SURFACE_CODEX,
      inv: _INV_TEMPLATE.split("__LOOP_LEVER__").join(
        "hook in `.codex/hooks.json` -- for example, blocking a finish before a " +
          "{deliverable} exists, with a corrective reason",
      ),
      dom: _DOM_TEMPLATE.split("__TRIGGER_SENTENCE__").join(
        "A skill exists only once its name appears in `AGENTS.md` as a trigger: write " +
          "that trigger line in the same edit.",
      ),
      tts_surface: cx_tts,
    },
  };
}

const _SURFACE_TEXTS = _buildSurfaceTexts();

function _st(surface: SurfaceSpec | string): _SurfaceText {
  const name = typeof surface === "string" ? surface : surface.name;
  const got = _SURFACE_TEXTS[name];
  if (!got) {
    throw new Error(
      `no prompt surface for ${pyRepr(name)}; known: ${pyListRepr(Object.keys(_SURFACE_TEXTS).sort())}`,
    );
  }
  return got;
}

function _tts_propose(
  bp: BenchPrompts,
  dim: string,
  st: _SurfaceText,
  opts: { k: number; index: number },
): string {
  const block = _format(dim === "INV" ? _TTS_INV : _TTS_DOM, {
    deliverable: bp.deliverable_word,
    domain: bp.domain_word,
    levers: (dim === "INV" ? bp.inv_levers : bp.dom_levers).trim(),
  });
  let where =
    "Do not hedge toward an average or try to cover every base -- commit to the single " +
    "most defensible version of your dimension. A later stage compares and merges.";
  if (opts.k > 1) {
    where =
      `You are candidate ${opts.index} of ${opts.k} on this dimension, drawn independently from ` +
      `the same evidence and never shown the others. ` + where;
  }
  const parts = [
    `You are the ${dim === "INV" ? "INVARIANT" : "DOMAIN"} harness editor for one ` +
      `task in this ${bp.domain_word}. You have the CURRENT real task, FULL rollouts of ` +
      `it under the current (base) harness, the current harness files, and this area's ` +
      `library of what was adopted for earlier tasks.`,
    _work(bp),
    _lens(bp),
    block,
    _format(_TTS_GENERALIZE, {
      domain_word: bp.domain_word,
      DOMAIN_WORD_UPPER: bp.domain_word.toUpperCase(),
    }),
    _TTS_HOW,
    where,
  ];
  if (bp.yardstick.trim()) {
    parts.push(`# WHAT GOOD PROCESS LOOKS LIKE HERE\n\n${bp.yardstick.trim()}`);
  }
  parts.push(ANSWER_FREE, EVIDENCE_BOUNDARY, st.tts_surface);
  return _tidy(parts.join("\n\n"));
}

function _tts_aggregate(
  bp: BenchPrompts,
  st: _SurfaceText,
  opts: { k: number; index: number },
): string {
  const { k } = opts;
  const n = 2 * k;
  const parts = [
    "You are the integration judge and synthesizer. What you emit is what gets ADOPTED: it " +
      "runs on this task, and if selected it enters this area's library where later tasks read " +
      "it. Every rule that bound the candidate proposers binds you -- merging an edit does not " +
      "launder it.",
    _work(bp),
    _lens(bp),
    `# WHAT YOU HAVE\n\n` +
      `${k} rollout${k > 1 ? "s" : ""} of this task under the unmodified (base) harness, ` +
      `and ${n} dimension-scoped candidate harnesses built on that same base -- ${k} on the ` +
      `INVARIANT dimension (tool and procedure machinery) and ${k} on the DOMAIN dimension ` +
      `(what a professional in this field knows). Each candidate was rolled out ONCE and you ` +
      `have that rollout. All of it is in your workspace:\n\n` +
      `    context/task.md               the real task\n` +
      `    context/harness/              the base harness files, and the tree you edit\n` +
      `    context/rollouts/<label>.md   FULL trajectories, untruncated\n` +
      `    context/deliverables/         what each base rollout actually PRODUCED, one ` +
      `entry per rollout\n` +
      `    context/pool/<label>/         one per candidate: \`harness/\` (its files), ` +
      `\`rollout.md\`\n` +
      `                                  and \`produced.md\` (what its rollout delivered)\n` +
      `    context/library/              earlier tasks' adopted harnesses (browse INDEX.md)\n\n` +
      `Open what each side PRODUCED, not only its trajectory: judging an edit without reading ` +
      `its product is guessing.`,
    "# YOUR JOB\n\n" +
      "1. Judge each candidate edit from the evidence: did its rollout show it helped, hurt, " +
      "or did nothing versus the base rollouts? The task's user request is the yardstick -- " +
      "completeness against what was asked counts as much as correctness of what was " +
      "produced. An edit whose skill was never loaded or whose rule was ignored changed " +
      "nothing, whatever it says on paper.\n" +
      "2. Synthesize ONE final harness containing only what the evidence supports: merge the " +
      "good parts of both dimensions, resolve overlaps rather than concatenating, keep " +
      "always-on text tiny, and keep every retained skill's trigger line narrow. Adopting a " +
      "single candidate wholesale is valid when it is simply the best state.\n\n" +
      "KEEPING THE BASE UNCHANGED IS A VALID OUTCOME -- if no candidate demonstrably improved " +
      "on base, leave the tree as it is and say KEEP_BASE in your notes. " + _KEEP_BASE,
    k > 1
      ? `You are one of ${k} synthesizers composing a final from this same evidence in ` +
        `parallel, and you will not see the others. Do not aim for the consensus answer -- ` +
        `commit to the harness you can defend.`
      : "",
    ...(bp.yardstick.trim()
      ? [`# WHAT GOOD PROCESS LOOKS LIKE HERE\n\n${bp.yardstick.trim()}`]
      : []),
    ANSWER_FREE,
    EVIDENCE_BOUNDARY,
    st.tts_surface,
    "# NOTES FORMAT\n\n" +
      "In your single `<notes>` block, one line per decision:\n\n" +
      "    kept|revised|dropped -> <which edit> -> <the evidence: what the trajectories " +
      "showed, with counts where sets are involved>\n\n" +
      "A decision without evidence attached is a decision the next reader cannot audit.",
  ];
  return _tidy(parts.join("\n\n"));
}

function _tts_select(bp: BenchPrompts, n: number, pool_kind: string, assets_note: string): string {
  return _tidy(
    [
      `You are choosing which of ${n} candidate ANSWERS to a workplace task should be ` +
        `delivered to the person who asked for this work.`,
      _work(bp),
      pool_kind === "mixed" ? POOL_MIXED_SELECT : POOL_FINALS_SELECT,
      "# WHAT YOU ARE LOOKING AT\n\n" +
        "Each candidate is what one agent run produced for the SAME task, in full.\n\n" +
        "    context/task.md              the request, verbatim\n" +
        "    context/source/             the material the work was done from\n" +
        `    context/candidates/<id>.md  what that run PRODUCED -- the ` +
        `${bp.deliverable_word}, rendered\n` + (assets_note || "") + "\n" +
        "You are choosing between ARTIFACTS. You are not told how any of them was produced and " +
        "you cannot see the runs that made them, so judge each one on what it is, against the " +
        "request and the source -- never on how impressive or thorough it sounds.",
      "# HOW TO DECIDE, IN THIS ORDER\n\n" +
        `1. COVERAGE. Is every ${bp.deliverable_word} the instructions name present, and does ` +
        `each contain every section, field, value or analysis they ask for? Count what the ` +
        `request explicitly asks to be produced, computed, stated or explained, and prefer the ` +
        `candidate that answers the most of those points.\n\n` +
        "2. CORRECTNESS. Are the values internally consistent -- totals matching their " +
        "components, figures agreeing between files, counts matching what the source actually " +
        "contains? Where candidates disagree on a number, check `context/source/` and prefer " +
        "the one whose derivation the material supports. Reject invented specifics; where the " +
        "source is silent, a candidate that says so is safer than one that fills the gap " +
        "confidently.\n\n" +
        "3. FIDELITY. Required formats, file names and structure, and no placeholder, TODO, " +
        "unresolved note, broken reference or empty required field. A renderer-truncation " +
        "marker inserted for this comparison is not a defect in the original artifact; judge " +
        "only what is actually visible.\n\n" +
        "Length and polish are not merits in themselves. The candidates are independent " +
        "attempts of differing quality, better than each other in different respects, and it is " +
        "entirely possible that the plainest one is the best answer. Pick the best available " +
        "answer, not the most elaborate one.",
      ANSWER_FREE_SELECT,
      EVIDENCE_BOUNDARY_SELECT,
      "# OUTPUT FORMAT\n\nFirst the reasoning, then the choice as the very last thing:\n\n" +
        "<why>\nAt most 5 lines. Name the criterion that decided it, and the closest runner-up " +
        "with the specific thing that cost it the pick.\n</why>\n\n" +
        "```choice\n<the id of the single candidate to submit>\n```",
    ].join("\n\n"),
  );
}

/** 单个 INV 或 DOM 候选的任务书。round_t 非空 ⟹ 顺序模式第 t 轮。 */
export function propose(
  bp: BenchPrompts,
  dim: string,
  surface: SurfaceSpec | string,
  opts: { k?: number; index?: number; round_t?: number | null } = {},
): string {
  const k = opts.k ?? 1;
  const index = opts.index ?? 1;
  const round_t = opts.round_t ?? null;
  if (dim !== "INV" && dim !== "DOM") {
    throw new Error(`unknown proposal dimension ${pyRepr(dim)}; expected 'INV' or 'DOM'`);
  }
  const st = _st(surface);

  if (bp.prompt_pack === "tts" && round_t === null) {
    return _tts_propose(bp, dim, st, { k, index });
  }
  const block = _format(dim === "INV" ? st.inv : st.dom, {
    deliverable: bp.deliverable_word,
    domain: bp.domain_word,
    levers: (dim === "INV" ? bp.inv_levers : bp.dom_levers).trim(),
  });
  let where =
    k > 1
      ? `You are candidate ${index} of ${k} on this dimension, drawn independently from the ` +
        `same evidence.`
      : "";
  if (round_t) {
    where +=
      `\n\nThis is round ${round_t}. You are editing the checkpoint the previous ` +
      `round produced, not the original harness, and the evidence includes every ` +
      `earlier round. In this stage \`KEEP_BASE\` means leave that CURRENT checkpoint ` +
      `unchanged; it never resets to the original harness.`;
  }
  const how = [
    "# HOW TO DECIDE WHAT TO CHANGE\n",
    "Every edit must trace to a moment in a trajectory. For each one ask: which run did " +
      "what, and would this text have changed it? If you cannot name the moment, the edit " +
      "is speculation and costs context for nothing. Prefer, in order:",
    "  1. a DIVERGENCE -- the runs disagreed, so the agent can already do it and just " +
      "needs telling. This is the cheapest win.",
    "  2. a repeated concrete failure -- the same error or omission in every run.",
    "  3. a risk visible in a trajectory but not yet realised.",
    "Do not fix what the runs already got right, and do not restate what the harness " +
      "already says clearly; duplicated instruction dilutes the rest.",
  ];
  if (where.trim()) {
    how.push("", where.trim());
  }
  how.push(
    "",
    "Do not hedge toward an average or try to cover every base -- commit to the " +
      "single most defensible version of your dimension. A later stage compares and " +
      "merges.",
  );

  const parts = [
    "You are adapting an autonomous agent's harness.",
    _work(bp),
    _lens(bp),
    block,
    _format(GENERALIZE, {
      domain_word: bp.domain_word,
      DOMAIN_WORD_UPPER: bp.domain_word.toUpperCase(),
    }),
    how.join("\n"),
  ];
  if (bp.yardstick.trim()) {
    parts.push(`# WHAT GOOD PROCESS LOOKS LIKE HERE\n\n${bp.yardstick.trim()}`);
  }
  parts.push(ANSWER_FREE, EVIDENCE_BOUNDARY, st.surface_md);
  return _tidy(parts.join("\n\n"));
}

/** agg-k:从全部 base 证据与全部 2k 候选合成唯一 final。 */
export function aggregate(
  bp: BenchPrompts,
  surface: SurfaceSpec | string,
  opts: { k?: number; index?: number } = {},
): string {
  const k = opts.k ?? 1;
  const index = opts.index ?? 1;
  const st = _st(surface);
  if (bp.prompt_pack === "tts") {
    return _tts_aggregate(bp, st, { k, index });
  }
  const n = 2 * k;
  return _tidy(
    [
      "You are composing THE final harness for one piece of work. What you emit is what gets " +
        "ADOPTED: it runs on this task, and if selected it enters this area's library where " +
        "later tasks read it. Every rule that bound the candidate proposers binds you -- you " +
        "are the last gate, and merging an edit launders it.",
      _work(bp),
      _lens(bp),
      `# WHAT YOU HAVE\n\n` +
        `${k} rollout${k > 1 ? "s" : ""} under the unmodified harness, and ${n} candidate ` +
        `harnesses -- ${k} on the INV dimension (how the agent works) and ${k} on the DOM ` +
        `dimension (what a practitioner knows). Each candidate was rolled out ONCE and you ` +
        `have that rollout.\n\n` +
        `The candidates were sampled separately but share the same task, evidence and likely ` +
        `model biases. Agreement is support, not independent proof; contradiction is a reason ` +
        `to inspect the trajectories, not to vote.`,
      `# HOW TO WEIGH THE EVIDENCE\n\n` +
        `The ${k} base rollout${k > 1 ? "s are" : " is"} draws from ONE distribution -- ` +
        `read them as a set, not as ${k} separate stories.\n\n` +
        `- A failure that repeats across the base set is a real property of the base harness ` +
        `and the strongest thing you can act on. A defect in 1/${k} is noise, and an edit ` +
        `aimed at it is overfitting to one sample.\n` +
        `- Each candidate has ONE rollout, so a single good or bad outcome is weak evidence ` +
        `either way. An edit earns its place when a SPECIFIC MOMENT in a trajectory shows ` +
        `the mechanism -- 'this looks like good practice' is not evidence; name the moment.\n` +
        `- Judge the downside as heavily as the upside. The costliest failure on this work ` +
        `is a run that produces nothing; an edit that helps one rollout and risks emptiness ` +
        `elsewhere is a bad edit.\n` +
        `- IF ANY ROLLOUT ASSOCIATED WITH AN EDIT PRODUCED NOTHING, say so explicitly in ` +
        `your notes and treat that edit as UNSAFE unless the rest of the evidence is ` +
        `overwhelming. Never merge an edit from a non-delivering rollout without stating ` +
        `why.`,
      "# YOUR JOB\n\nCompose ONE harness. All of these are valid, judged only on what the " +
        "rollouts support:\n" +
        "- MERGE across candidates -- the expected outcome when an INV edit and a DOM edit each " +
        "earn their place. Resolve the overlaps rather than concatenating.\n" +
        "- ADOPT ONE WHOLESALE if a single candidate is simply the best state.\n" +
        "- KEEP_BASE.\n\n" + _KEEP_BASE,
      k > 1
        ? `You are one of ${k} aggregators composing a final from this same evidence in ` +
          `parallel, and you will not see the others. Do not aim for the consensus answer -- ` +
          `commit to the harness you can defend.`
        : "",
      ...(bp.yardstick.trim()
        ? [`# WHAT GOOD PROCESS LOOKS LIKE HERE\n\n${bp.yardstick.trim()}`]
        : []),
      ANSWER_FREE,
      EVIDENCE_BOUNDARY,
      st.surface_md,
      "# NOTES FORMAT\n\n" +
        "In your single `<notes>` block, one line per decision, in this exact shape:\n\n" +
        "    kept|revised|dropped -> <which edit> -> <the trajectory moment or base-set " +
        "pattern that decided it, with counts where sets are involved, e.g. 'failed in " +
        `${Math.max(k - 1, 2)}/${k} base rollouts'>\n\n` +
        "A decision without evidence attached is a decision the next reader cannot audit.",
    ].join("\n\n"),
  );
}

/** seq-k:从本轮候选与全部更早轮合成检查点 C_t。 */
export function compose_round(
  bp: BenchPrompts,
  surface: SurfaceSpec | string,
  opts: { t: number; k: number },
): string {
  const { t, k } = opts;
  const st = _st(surface);
  const final = t >= k;
  return _tidy(
    [
      `You are composing checkpoint ${t} of ${k} in a sequential adaptation loop.`,
      _work(bp),
      _lens(bp),
      "# WHAT YOU HAVE\n\n" +
        "The rollouts under the unmodified harness (the shared evidence, which does not change " +
        "between rounds), this round's INV and DOM candidates with their rollouts, and every " +
        "earlier round's candidates, checkpoints and trajectories. The previous checkpoint's " +
        "own rollout is this round's on-policy evidence: it shows what the harness you are " +
        "editing actually does." +
        (t === 1
          ? "\n\nThis is the FIRST round, so the only evidence is the base rollouts and this " +
            "round's two candidates."
          : ""),
      "# YOUR JOB\n\n" +
        (final
          ? "Compose THE FINAL harness, from the WHOLE history rather than just this round.\n"
          : `Compose checkpoint ${t}, which the next round will build on.\n`) +
        "All of these are valid:\n" +
        "- MERGE across rounds -- including a candidate REJECTED earlier, if a later rollout " +
        "now argues for it.\n" +
        "- REPRODUCE an earlier checkpoint verbatim, if that state was simply the best one " +
        "and later rounds drifted away from it.\n" +
        "- ADOPT this round's best candidate.\n" +
        "- KEEP_BASE.\n\n" +
        _KEEP_BASE +
        "\n\nHere `KEEP_BASE` means keep the CURRENT checkpoint in `context/harness/` " +
        "unchanged; it does not restore the original harness. In `<notes>`, identify which " +
        "rounds' edits survive and which were dropped or restored.",
      ANSWER_FREE,
      EVIDENCE_BOUNDARY,
      st.surface_md,
    ].join("\n\n"),
  );
}

/** 盲选候选产出,与 substrate 无关;pool_kind 选匿名块,assets_note 说明随附的渲染证据。 */
export function select(
  bp: BenchPrompts,
  n: number,
  pool_kind = "mixed",
  assets_note = "",
): string {
  if (pool_kind !== "mixed" && pool_kind !== "finals") {
    throw new Error(`unknown pool_kind ${pyRepr(pool_kind)}; expected 'mixed' or 'finals'`);
  }
  if (bp.prompt_pack === "tts") {
    return _tts_select(bp, n, pool_kind, assets_note);
  }
  return _tidy(
    [
      `You are choosing which of ${n} candidate answers should be delivered to the person ` +
        `who asked for this work.`,
      _work(bp),
      _lens(bp),
      pool_kind === "mixed" ? POOL_MIXED_SELECT : POOL_FINALS_SELECT,
      "# WHAT YOU ARE LOOKING AT\n\n" +
        "    context/task.md              the request, verbatim\n" +
        "    context/source/             the material the work was done from\n" +
        `    context/candidates/<id>.md  what that run PRODUCED -- the ` +
        `${bp.deliverable_word}, rendered\n` + (assets_note || "") + "\n" +
        "You are choosing between ARTIFACTS. You are not told how any of them was produced and " +
        "you cannot see the runs that made them, so judge each one on what it is, against the " +
        "request and the source -- never on how impressive or thorough it sounds.",
      "# HOW TO DECIDE, IN THIS ORDER\n\n" +
        (bp.selection_lead.trim() ? `0. ${bp.selection_lead.trim()}\n\n` : "") +
        `1. DELIVERY. Is every ${bp.deliverable_word} named by the instructions present, at the ` +
        `requested path, in the requested form, with every named part?\n\n` +
        (bp.selection_conformance === "value_only" ? "" : CONFORMANCE_BLOCK) +
        "3. FIDELITY. CHECK THE CLAIMS AGAINST `context/source/`, which holds the material the " +
        "work was done from. Open it and verify the facts, data, names, figures and constraints " +
        "a candidate asserts -- do not take its word for them, and do not settle for whether it " +
        "sounds authoritative. Reject invented specifics. Where candidates disagree, the source " +
        "decides it; where the source is silent, prefer the candidate that says so over the one " +
        "that fills the gap confidently.\n\n" +
        "4. INTERNAL CONSISTENCY. Does the artifact agree with itself? Totals that match their " +
        "rows, figures that agree between a summary and the table it summarises, " +
        "cross-references that resolve, counts that match the number of items actually present. " +
        "A number that contradicts another number in the same artifact is a defect even when you " +
        "cannot tell which one is wrong.\n\n" +
        "5. OPERATIONAL FITNESS. Is this the right kind of artifact, and can the intended person " +
        "or system actually use, run, open, import or act on it without reconstructing missing " +
        "work? Judge this as the requester's downstream consumer, not as a reviewer wanting to " +
        "be convinced -- an addition that helps a human read the file but breaks an importer is " +
        "a cost, not a benefit.\n\n" +
        "6. FINISH. No placeholders, TODOs, unresolved notes, broken references, empty required " +
        "fields, visibly incomplete sections, or content that does not match its declared format. " +
        "A renderer-truncation marker inserted for this comparison is not a defect in the original " +
        "artifact; judge only what is actually visible.\n\n" +
        (bp.selection_conformance === "full" ? "" : VALUE_TAIL) +
        "Length and polish are not merits in themselves. A shorter, correct, complete, " +
        "exactly-shaped answer beats a longer one with a gap or an embellishment.",
      _checks(bp),
      ANSWER_FREE_SELECT,
      EVIDENCE_BOUNDARY_SELECT,
      "# OUTPUT FORMAT\n\nFirst the reasoning, then the choice as the very last thing:\n\n" +
        "<why>\nAt most 6 lines. Name the criterion that decided it, and the closest runner-up " +
        "with the specific thing that cost it the pick. If you rejected a candidate on " +
        "CONFORMANCE, say which field, column or section.\n</why>\n\n" +
        "```choice\n<the id of the single candidate to submit>\n```",
    ].join("\n\n"),
  );
}

/** 两份记录:每条 harness 编辑的作为,然后是那一条可迁移的教训。 */
export function experience(bp: BenchPrompts): string {
  return _tidy(
    [
      "You are reading the complete record of one improvement round: a base harness, the " +
        "edits proposed against it, the executions those edited harnesses produced, and which " +
        "output was finally submitted. Write two things for a library that future work in this " +
        "area reads before it makes its own edits.",
      _work(bp),
      _lens(bp),
      "# THE ADOPTED CANDIDATE IS NOT THE ONLY EVIDENCE\n\n" +
        "Selection compared DELIVERABLES with the harnesses hidden, so the choice says which " +
        "output read best -- not which edit worked. Treat every candidate as evidence. An edit " +
        "that appeared only in a rejected candidate may still be the one that changed behavior " +
        "for the better, and an edit inside the adopted candidate may have contributed nothing " +
        "to why it was adopted. Read the trajectories, not the verdict.",
      "# WHAT EACH EDIT DID\n\n" +
        "Diff every candidate harness against `context/base_harness/`. For each component any " +
        "candidate changed, write one row: the component, what the edit actually changed, the " +
        "observed difference in execution it produced, and a verdict.\n\n" +
        "Verdicts are `helped`, `hurt`, `no observed effect` and `confounded`. Use " +
        "`confounded` -- and prefer it -- whenever a candidate changed several components at " +
        "once and no execution isolates one of them, or when a single rollout is all that " +
        "stands behind the difference. A confounded row is a useful record; an invented " +
        "attribution poisons the library for every later task. Cite the run and the point in " +
        "the trajectory where behavior diverges. If two candidates changed the same component " +
        "in different ways, say which forms were tried and what each produced.",
      "# THE ONE LESSON THAT TRANSFERS\n\n" +
        "Now write at most one durable entry, and only if the edit rows support it.\n\n" +
        "The `cue` describes the SHAPE OF SITUATION the lesson applies to, so it can fire on a " +
        "different matter. Not this task's facts -- the pattern. The `lesson` is the operation " +
        "to perform on a harness, stated so it can be applied and checked, and it must name " +
        "the component it concerns.\n\n" +
        "Too generic is useless ('be thorough'); too specific never fires again ('the fee rose " +
        "to 250 on Jan 1'). Aim between: 'when an instrument performs several sequential acts " +
        "and one of them terminates the actor's own authority, order them so the terminating " +
        "act comes last'.\n\n" +
        "The `evidence` field cites the edit rows the lesson rests on. A lesson resting only " +
        "on `confounded` rows is a guess: narrow it to what the record does show, or decline. " +
        "Adoption alone never establishes that an edit helped or will transfer. If the record " +
        "shows no concrete, reusable execution contrast, write the single line NO_ENTRY in " +
        "place of the <experience> block -- the edit rows are still worth writing.",
      ANSWER_FREE,
      EVIDENCE_BOUNDARY,
      "# OUTPUT FORMAT\n\n" +
        "<edits>\ncomponent: <name as it appears in the harness tree>\n" +
        "candidates: <the labels that carried this edit>\n" +
        "change: <what the edit did>\n" +
        "observed: <the execution difference, and where you saw it>\n" +
        "verdict: <helped|hurt|no observed effect|confounded>\n" +
        "(repeat these five lines for each changed component)\n</edits>\n\n" +
        "<experience>\ncue: <the shape of situation this applies to>\n" +
        "lesson: <the transferable operation, naming the component>\n" +
        "evidence: <the edit rows this rests on, and the execution contrast>\n" +
        "confidence: <high|medium|low, and why>\n</experience>",
    ].join("\n\n"),
  );
}
