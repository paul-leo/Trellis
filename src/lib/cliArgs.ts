/**
 * Shared CLI flag readers. Every command historically rolled its own
 * `argv.indexOf("--flag")` lookup — which silently ignores the equally
 * common `--flag=value` form (real incident, found by the v0.15.0
 * real-machine smoke test: `mcp add --args=-y,…` exited 0 with the args
 * silently dropped from canonical). These helpers accept both forms, and
 * `unknownFlags` catches typos instead of letting them vanish.
 */

/** Value of `--name <value>` or `--name=<value>`; undefined when absent.
 * The space form returns the next token verbatim (even one starting with
 * `-`), matching the historical `indexOf` behavior. First occurrence wins,
 * same as `indexOf`. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === name) return argv[i + 1];
    if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
  }
  return undefined;
}

/** `--*` tokens none of `known` claims. Non-flag tokens (positionals,
 * values) are never flags; a `--name=value` token is classified by its
 * name part, so a known flag in `=` form is not "unknown". */
export function unknownFlags(argv: readonly string[], known: readonly string[]): string[] {
  const result: string[] = [];
  for (const token of argv) {
    if (!token.startsWith("--")) continue;
    const key = token.split("=", 1)[0]!;
    if (!known.includes(key)) result.push(token);
  }
  return result;
}
