/**
 * Pulled out of `src/cli.ts`'s `sync` dispatch branch specifically so it's
 * directly unit-testable (test/unit/syncArgs.test.ts) without importing
 * `cli.ts` itself — that file runs `main()` as a top-level side effect
 * when it's the real entrypoint, which a symlink-safe "is this actually
 * the entrypoint" check turned out not to be worth building (it broke the
 * real npm-installed `trellis` bin, whose symlink target's realpath never
 * equals `process.argv[1]`'s). A zero-side-effect module is the simpler
 * fix. This exact class of bug (only `rest[0]` was ever checked, so a
 * flag placed first was mistaken for an unknown target) had no test
 * coverage before it was found by manual review, not a failing test.
 */
export function parseSyncArgs(rest: string[]): { target?: "skills" | "instructions"; unknownArg?: string } {
  const target = rest.find((arg): arg is "skills" | "instructions" => arg === "skills" || arg === "instructions");
  const unknownArg = rest.find((arg) => !arg.startsWith("--") && arg !== "skills" && arg !== "instructions");
  return { target, unknownArg };
}
