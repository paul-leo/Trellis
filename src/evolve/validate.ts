/**
 * 证据要求与机械校验(trellis-evolve 任务 12.2)。
 *
 * editor 输出不可信:机械校验器逐条复核 kind 白名单、target 白名单与
 * 证据要求;校验错误以可执行的说明文字反馈给 editor 并至多重试一次,再
 * 失败则丢弃并入档。分级与目标合法性由代码按 kind 与 target 计算,不
 * 采信 editor 自报的风险等级(12.3 重算)。
 *
 * 检查项(顺序即反馈顺序,全部累积,不短路):
 *
 *   1. 证据要求 —— 无证据 → `no-evidence`,probe 前丢弃;
 *   2. kind 白名单 —— 与 L1 前闸同源(`L1_CONFIG_KINDS`),域外
 *      → `kind-not-allowed`;
 *   3. 受保护目标硬排除 —— secret/凭据材料、MCP auth 配置(含
 *      `mcp/servers.yaml` 整文件与 auth 块形态的 target 描述)、受管
 *      agent 集合、Trellis 自有表面之外的用户手写文件、自我进化自身
 *      配置 → `target-protected` / `target-not-on-surface`;
 *   4. 层检查 —— 目标必须落在提案声明层之内;全局层目标不得指向
 *      workspace 的 `.agents/` 路径 → `layer-mismatch`;
 *   5. workspace 可提交约束 —— workspace 层编辑内容只允许 `${VAR}`
 *      引用,绝不写凭据形态的字面值 → `workspace-commit-violation`;
 *   6. 不自动升格标记 —— 全局层目标 + 仅单 workspace 证据(或证据层
 *      未知)→ `needsExplicitApproval` 标记(不拒绝;12.3 一律 B,
 *      呈现等待显式批准)。
 *
 * 反馈通道接引擎 `validate_tree` 的错误喂回约定(recursion.ts 的
 * `# YOUR PREVIOUS ATTEMPT WAS REJECTED` 形态);`validateProposalWithRetry`
 * 走完整闭环:校验 → 反馈 → editor 至多修订一次 → 再校验 → 仍违规丢弃
 * + 归档(`proposal-reject`)。
 *
 * target 白名单路径表:全局层 = `~/.trellis` 的可编辑面(canonical 五
 * 文件/skills 树)+ `NATIVE_CHECK_SURFACE` 各 agent home 路径;workspace
 * 层 = `<root>/.agents/**` + workspace MCP 配置文件七形态。七形态在此
 * 本地再声明(import 边界 10.3:evolve 不得引 `src/lib/workspaceMcp`)。
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendArchiveRecord } from "./archive.js";
import { containsCredentialLiteral } from "./erase.js";
import { L1_CONFIG_KINDS } from "./gate.js";
import type { EditOp, SurfaceLayer } from "../host/index.js";
import { NATIVE_CHECK_SURFACE } from "../host/index.js";
import type { Proposal } from "./types.js";

/** 档案 kind:机械校验拒绝(含丢弃原因与 issue 列表)。 */
export const PROPOSAL_REJECT_ARCHIVE_KIND = "proposal-reject";

/** 机械校验拒绝码(spec 场景逐条对应)。 */
export type ValidationRejectCode =
  /** 没有任何证据链接(probe 前丢弃,档案以本码记录)。 */
  | "no-evidence"
  /** kind 不在配置类白名单。 */
  | "kind-not-allowed"
  /** 受保护目标(secret/凭据、MCP auth、受管集合、进化自身配置)。 */
  | "target-protected"
  /** Trellis 自有表面之外的用户手写文件。 */
  | "target-not-on-surface"
  /** 目标不属于提案声明层(含全局层指向 workspace `.agents/`)。 */
  | "layer-mismatch"
  /** workspace 层编辑写了凭据形态字面值(违反可提交约束)。 */
  | "workspace-commit-violation";

export interface ValidationIssue {
  readonly code: ValidationRejectCode;
  readonly message: string;
}

/**
 * 升格上下文判定(不自动升格标记的依据):证据层未知不算"另一上下文"。
 */
export type PromotionScope =
  /** 有全局层证据,或 ≥2 个不同 workspace root 的证据。 */
  | "multi-context"
  /** 证据全部来自同一 workspace root。 */
  | "single-workspace"
  /** 证据都在但层归属未知 —— 无法证明另一上下文。 */
  | "unknown"
  /** 目标层是 workspace,不存在升格问题。 */
  | "not-applicable";

export interface ProposalValidation {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  /**
   * 全局层目标的不自动升格标记:仅单 workspace 证据(或证据层未知)时
   * 置 true —— 提案不被拒绝,但其全局版本只被呈现等待显式批准(12.3
   * 的采纳门据此一律按 B 处理)。
   */
  readonly needsExplicitApproval: boolean;
  readonly promotionScope: PromotionScope;
}

/**
 * workspace MCP 配置文件七形态(`src/lib/workspaceMcp.ts`
 * `workspaceMcpConfigPath` 的路径表;import 边界下本地再声明)。
 */
export const WORKSPACE_CONFIG_RELATIVE_PATHS: readonly string[] = [
  join(".mcp.json"),
  join(".codex", "config.toml"),
  join(".kiro", "settings", "mcp.json"),
  join(".pi", "mcp.json"),
  join(".kimi-code", "mcp.json"),
  join("zcode.json"),
  join(".zcode", "config.json"),
];

/** 受保护目标:凭据材料 / MCP auth 配置 / 受管集合 / 进化自身配置。 */
function protectedPathReasonInner(rel: string, base: string): string | null {
  const file = base;
  // 凭据材料:OAuth token 目录、auth.json、.credentials*、.env*、
  // claude 账号缓存(与 staging 的凭据边界同源)。
  if (rel === join(".trellis", "mcp", "oauth") || rel.startsWith(join(".trellis", "mcp", "oauth") + sep)) {
    return "secret/凭据材料(.trellis/mcp/oauth/)受硬排除";
  }
  if (
    file === "auth.json" ||
    file === ".credentials" ||
    file === ".credentials.json" ||
    file.startsWith(".credentials.") ||
    file === ".env" ||
    file.startsWith(".env.")
  ) {
    return `secret/凭据材料(${file})受硬排除`;
  }
  if (rel === join(".claude", "projects") || rel.startsWith(join(".claude", "projects") + sep)) {
    return "secret/凭据材料(.claude/projects 账号缓存)受硬排除";
  }
  // MCP auth 配置:server 定义与 auth 材料整文件受保护(surface.ts
  // Class C 并集从严)——mcp-config-fix 只面向 routes.yaml。
  if (rel === join(".trellis", "mcp", "servers.yaml")) {
    return "MCP auth 配置(mcp/servers.yaml 整文件)受硬排除";
  }
  // 受管 agent 集合。
  if (rel === join(".trellis", "managed.yaml")) {
    return "受管 agent 集合(managed.yaml)受硬排除";
  }
  // 自我进化自身配置。
  if (rel === join(".trellis", "evolve.yaml") || rel.startsWith(join(".trellis", "evolve") + sep)) {
    return "自我进化自身配置(evolve.yaml / evolve/)受硬排除";
  }
  return null;
}

/** `path` 是否为 root 本身或其之下(含根本身;层归属检查用)。
 * 谓词与 gate 的重定位谓词同形,多收根本身一层。 */
function isUnderRootInclusive(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** homeDir 相对路径的 `.agents` 段是否为 workspace 形态(parent ≠ home)。 */
function hasWorkspaceAgentsSegment(rel: string): boolean {
  const segments = rel.split(sep);
  const idx = segments.indexOf(".agents");
  return idx > 0;
}

/** 全局层表面白名单:canonical 可编辑面 + NATIVE_CHECK_SURFACE。 */
function onGlobalSurface(rel: string): boolean {
  const canonical = [
    join(".trellis", "agents.md"),
    join(".trellis", "mcp", "routes.yaml"),
    join(".trellis", "memory", "policy.yaml"),
    join(".trellis", "secrets.policy.yaml"),
  ];
  if (canonical.includes(rel)) return true;
  if (rel === join(".trellis", "skills") || rel.startsWith(join(".trellis", "skills") + sep)) return true;
  return NATIVE_CHECK_SURFACE.some((entry) => rel === entry || rel.startsWith(entry + sep));
}

/** workspace 层表面白名单:`.agents/**` + MCP 配置七形态。 */
function onWorkspaceSurface(rel: string): boolean {
  if (rel === ".agents" || rel.startsWith(`.agents${sep}`)) return true;
  return WORKSPACE_CONFIG_RELATIVE_PATHS.includes(rel);
}

/** 绝对路径级的受保护判定(12.3 风险分类器的 C 类规则与 pathIssues 同源)。 */
export function protectedPathReason(path: string, homeDir: string): string | null {
  const resolved = resolve(path);
  const rel = relative(resolve(homeDir), resolved);
  const file = resolved.split(sep).pop() ?? resolved;
  return protectedPathReasonInner(isUnderRootInclusive(path, homeDir) ? rel : "", file);
}

function pathIssues(path: string, layer: SurfaceLayer, homeDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const resolved = resolve(path);
  const rel = relative(resolve(homeDir), resolved);
  const inHome = isUnderRootInclusive(path, homeDir);

  // 受保护目标(与层无关,先拒)。
  const file = resolved.split(sep).pop() ?? resolved;
  const protectedReason = inHome ? protectedPathReasonInner(rel, file) : protectedPathReasonInner("", file);
  if (protectedReason !== null) {
    issues.push({ code: "target-protected", message: `编辑路径 ${path}:${protectedReason}` });
  }

  // 层检查:目标必须在声明层之内;全局层不得指向 workspace `.agents/`。
  if (layer.kind === "workspace") {
    if (!isUnderRootInclusive(path, layer.root)) {
      issues.push({
        code: "layer-mismatch",
        message: `编辑路径 ${path} 不在提案声明的 workspace 层(${layer.root})之内`,
      });
    }
  } else {
    if (!inHome) {
      issues.push({
        code: "layer-mismatch",
        message: `编辑路径 ${path} 不在提案声明的全局层(HOME ${homeDir})之内`,
      });
    } else if (hasWorkspaceAgentsSegment(rel)) {
      issues.push({
        code: "layer-mismatch",
        message: `编辑路径 ${path} 是 workspace 的 .agents/ 路径,不得作全局层目标(声明与目标层不符)`,
      });
    }
  }

  // 表面白名单(按声明层取对应白名单)。
  const onSurface =
    layer.kind === "workspace"
      ? isUnderRootInclusive(path, layer.root) && onWorkspaceSurface(relative(resolve(layer.root), resolved))
      : inHome && onGlobalSurface(rel);
  if (!onSurface) {
    issues.push({
      code: "target-not-on-surface",
      message: `编辑路径 ${path} 不在 Trellis 自有表面之内(用户手写文件受硬排除)`,
    });
  }

  return issues;
}

/** 单个编辑的内容面检查(可提交约束);路径面在 pathIssues。 */
function contentIssues(edit: EditOp, layer: SurfaceLayer): ValidationIssue[] {
  if (layer.kind !== "workspace") return [];
  if (edit.op === "remove-symlink") return [];
  const text = edit.op === "write-file" ? edit.content : edit.target;
  if (containsCredentialLiteral(text)) {
    return [
      {
        code: "workspace-commit-violation",
        message:
          `编辑 ${edit.path} 写入了凭据形态的字面值,违反 workspace 可提交约束` +
          "(只允许 `${VAR}` 引用,绝不写凭据形态的字面值)",
      },
    ];
  }
  return [];
}

/** target 描述符层面的硬排除:MCP auth 块形态的描述。 */
function targetDescriptorIssues(target: string): ValidationIssue[] {
  if (/\bauth\b/i.test(target)) {
    return [
      {
        code: "target-protected",
        message: `提案目标 "${target}" 为 MCP auth 配置(auth 块受硬排除)`,
      },
    ];
  }
  return [];
}

/** 升格上下文判定(12.3 分类器的降级规则与此同源)。 */
export function evaluatePromotion(proposal: Proposal): {
  scope: PromotionScope;
  needsExplicitApproval: boolean;
} {
  if (proposal.layer.kind !== "global") return { scope: "not-applicable", needsExplicitApproval: false };
  const layers = proposal.evidence
    .map((link) => link.layer)
    .filter((layer): layer is SurfaceLayer => layer !== undefined);
  const hasGlobal = layers.some((layer) => layer.kind === "global");
  const workspaceRoots = new Set(
    layers.flatMap((layer) => (layer.kind === "workspace" ? [layer.root] : [])),
  );
  if (hasGlobal || workspaceRoots.size >= 2) return { scope: "multi-context", needsExplicitApproval: false };
  if (workspaceRoots.size === 1) return { scope: "single-workspace", needsExplicitApproval: true };
  // 证据都在但层未知:无法证明另一上下文,升格需显式批准(从严)。
  return { scope: "unknown", needsExplicitApproval: true };
}

/**
 * 机械校验一条提案(不触发任何测量/IO 写入;可提交约束只读内容形态)。
 * 全部 issue 累积返回,顺序即反馈顺序;`needsExplicitApproval` 是标记
 * 不是 issue。
 */
export function validateProposal(proposal: Proposal, options: { readonly homeDir: string }): ProposalValidation {
  const issues: ValidationIssue[] = [];

  // 1. 证据要求。
  if (proposal.evidence.length === 0) {
    issues.push({
      code: "no-evidence",
      message: "提案没有任何证据链接,probe 前丢弃(每条编辑提案必须携带至少一个证据链接)",
    });
  }

  // 2. kind 白名单(与 L1 前闸同源)。
  if (!L1_CONFIG_KINDS.has(proposal.kind)) {
    issues.push({
      code: "kind-not-allowed",
      message: `提案 kind "${proposal.kind}" 不在配置类白名单(域外提案不进提案通道)`,
    });
  }

  // 3. target 描述符硬排除。
  issues.push(...targetDescriptorIssues(proposal.target));

  // 4–5. 逐编辑:受保护目标 / 层检查 / 表面白名单 / 可提交约束。
  for (const edit of proposal.edits) {
    issues.push(...pathIssues(edit.path, proposal.layer, options.homeDir));
    issues.push(...contentIssues(edit, proposal.layer));
  }

  // 6. 不自动升格标记(不是 issue)。
  const { scope, needsExplicitApproval } = evaluatePromotion(proposal);
  return { ok: issues.length === 0, issues, needsExplicitApproval, promotionScope: scope };
}

/**
 * 校验错误 → 可执行反馈文案。通道接引擎 `validate_tree` 的错误喂回约定
 * (recursion.ts `_run_stage`:`# YOUR PREVIOUS ATTEMPT WAS REJECTED` +
 * 错误正文 + 修复指示)。
 */
export function formatValidationFeedback(issues: readonly ValidationIssue[]): string {
  const lines = issues.map((issue) => `- [${issue.code}] ${issue.message}`);
  return [
    "# YOUR PREVIOUS ATTEMPT WAS REJECTED",
    "",
    ...lines,
    "",
    "Fix the listed problems and reply with a revised proposal.",
  ].join("\n");
}

/** 校验闭环的丢弃阶段。 */
export type RejectPhase = "initial" | "retry-declined" | "retry-exhausted";

export interface ValidateProposalWithRetryOptions {
  readonly homeDir: string;
  readonly proposal: Proposal;
  /**
   * editor 重试通道:接收上一轮提案与可执行反馈,返回修订提案;返回
   * null 表示 editor 放弃。缺省 = 无 editor 可用,不重试直接丢弃。
   */
  readonly retryEditor?: (previous: Proposal, feedback: string) => Promise<Proposal | null>;
  /** 时间源(毫秒);缺省 Date.now(档案打戳)。 */
  readonly now?: () => number;
}

export type ValidateProposalWithRetryResult =
  | {
      readonly status: "accepted";
      /** 最终通过的提案(可能是 editor 修订版)。 */
      readonly proposal: Proposal;
      readonly attempts: 1 | 2;
      readonly validation: ProposalValidation;
    }
  | {
      readonly status: "discarded";
      readonly proposalId: string;
      readonly code: ValidationRejectCode;
      readonly reason: string;
      readonly attempts: 1 | 2;
      readonly phase: RejectPhase;
      readonly issues: readonly ValidationIssue[];
    };

function discard(
  options: ValidateProposalWithRetryOptions,
  proposalId: string,
  issues: readonly ValidationIssue[],
  attempts: 1 | 2,
  phase: RejectPhase,
): ValidateProposalWithRetryResult {
  const code = issues[0]?.code ?? "no-evidence";
  const reason = issues[0]?.message ?? "机械校验拒绝";
  const stamp = () => new Date((options.now ?? Date.now)());
  appendArchiveRecord(
    options.homeDir,
    {
      kind: PROPOSAL_REJECT_ARCHIVE_KIND,
      payload: {
        proposalId,
        phase,
        code,
        reason,
        retried: phase !== "initial",
        issues,
      },
    },
    stamp,
  );
  return { status: "discarded", proposalId, code, reason, attempts, phase, issues };
}

/**
 * 机械校验闭环:校验 → 反馈给 editor → 至多修订一次 → 再校验 → 仍违规
 * 丢弃并入档。通过返回最终提案(含升格标记);丢弃时档案以主因码(如
 * `no-evidence`)记录。
 */
export async function validateProposalWithRetry(
  options: ValidateProposalWithRetryOptions,
): Promise<ValidateProposalWithRetryResult> {
  const first = validateProposal(options.proposal, { homeDir: options.homeDir });
  if (first.ok) {
    return { status: "accepted", proposal: options.proposal, attempts: 1, validation: first };
  }

  const feedback = formatValidationFeedback(first.issues);
  const retryEditor = options.retryEditor;
  if (retryEditor === undefined) {
    return discard(options, options.proposal.id, first.issues, 1, "initial");
  }

  let revised: Proposal | null;
  try {
    revised = await retryEditor(options.proposal, feedback);
  } catch {
    return discard(options, options.proposal.id, first.issues, 1, "retry-declined");
  }
  if (revised === null) {
    return discard(options, options.proposal.id, first.issues, 1, "retry-declined");
  }

  const second = validateProposal(revised, { homeDir: options.homeDir });
  if (second.ok) {
    return { status: "accepted", proposal: revised, attempts: 2, validation: second };
  }
  return discard(options, options.proposal.id, second.issues, 2, "retry-exhausted");
}
