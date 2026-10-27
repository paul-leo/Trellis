// Derived from harness2 `harness2/substrate/base.py` (Apache-2.0, Copyright 2026 Google LLC).
// 任务 2.2:Substrate 协议的原样翻译。逐字段对照清单(右为 Python 源):
//
//   Install(staging_dir, fingerprint, extras=Mapping 默认 {})  → Install 同名 readonly 字段
//   RunRequest(task_ref, run_ids: tuple[str,...], timeout)     → RunRequest 同名 readonly 字段
//   Launcher = Callable[[RunRequest, Install], list[Path]]     → (req, install) => Promise<Path[]>
//   Substrate(Protocol, runtime_checkable)                     → interface(TS 结构化类型)
//     surface() -> SurfaceSpec                                 → 同名同步方法
//     materialise(tree_dir, spec, ctx) -> Install              → 同名异步方法;Python 未标注 spec
//                                                                类型(实为 core.spec.BenchSpec,
//                                                                任务 4.1 落地),此处记为 unknown
//     execute(task_ref, install, run_ids, timeout) -> list     → 同名异步方法
//     read_trajectory(stream_path, *, obs_trunc, max_chars,
//                     args_trunc=400) -> str                   → 同名异步方法,默认值保留
//     preflight() -> None                                      → 同名异步方法,失败 throw
//
// 语言适配(非语义偏差):Python 同步 I/O 在 TS 中一律 Promise;Path 以 string(绝对路径)
// 表示;frozen dataclass 以 readonly 字段 + 工厂内 Object.freeze 表达。

import type { SurfaceSpec } from "./tree.js";

/** 绝对文件系统路径(Python pathlib.Path 的 TS 表达)。 */
export type Path = string;

/** A materialised harness ready for a launcher; `fingerprint` digests the SOURCE tree. */
export interface Install {
  readonly staging_dir: Path;
  readonly fingerprint: string;
  readonly extras: Readonly<Record<string, string>>;
}

export function makeInstall(input: {
  staging_dir: Path;
  fingerprint: string;
  extras?: Readonly<Record<string, string>>;
}): Install {
  return Object.freeze({ extras: {}, ...input });
}

/** One execution request handed to a benchmark-supplied launcher body. */
export interface RunRequest {
  readonly task_ref: string;
  readonly run_ids: readonly string[];
  readonly timeout: number;
}

export function makeRunRequest(input: RunRequest): RunRequest {
  return Object.freeze(input);
}

export type Launcher = (request: RunRequest, install: Install) => Promise<Path[]>;

/**
 * The full substrate interface: what an agent framework owns, benchmark-free.
 * (core.spec 的 SubstrateLike 子集在任务 4.1 随 spec 模块落地。)
 */
export interface Substrate {
  readonly name: string;

  /** The editable c1..c8 tree schema + validators for this substrate. */
  surface(): SurfaceSpec;

  /**
   * Stage the editable tree as substrate-native files, per `spec.install_mode`.
   * `ctx` carries benchmark-owned values: {{token}} interpolation slots and `file:<rel>`
   * entries for integration files that ride along with the staged tree.
   */
  materialise(
    tree_dir: Path,
    spec: unknown,
    ctx: Readonly<Record<string, string>>,
  ): Promise<Install>;

  /** Run rollouts via the benchmark-supplied launcher; one run_dir per run_id. */
  execute(
    task_ref: string,
    install: Install,
    run_ids: readonly string[],
    timeout: number,
  ): Promise<Path[]>;

  /**
   * Render this substrate's capture format into the shared grammar.
   * `obs_trunc` and `max_chars` are carried on the cell's BenchSpec, never module-global
   * state. `args_trunc` is a per-substrate default (400 for opencode, 2000 for codex) that
   * BenchSpec does not carry and no caller overrides.
   */
  read_trajectory(
    stream_path: Path,
    opts: { obs_trunc: number; max_chars: number; args_trunc?: number },
  ): Promise<string>;

  /**
   * Health checks before money is spent; throws with the remediation command and never
   * starts any part of the model chain.
   */
  preflight(): Promise<void>;
}
