import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLoginShellPath, resolveLoginShellPath } from "./shellPath.js";

/** A fake "shell" that ignores its real args and just prints a known PATH,
 * so the test never depends on this machine's real rc files. */
function makeFakeShell(dir: string, path: string): string {
  const script = join(dir, "fake-shell.sh");
  writeFileSync(script, `#!/bin/sh\necho -n "__TRELLIS_PATH__${path}__TRELLIS_PATH__"\n`);
  chmodSync(script, 0o755);
  return script;
}

test("resolveLoginShellPath: returns the shell's PATH when the shell succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-shellpath-"));
  const shell = makeFakeShell(dir, "/fake/bin:/fake/usr/bin");
  const path = resolveLoginShellPath({ shell });
  assert.equal(path, "/fake/bin:/fake/usr/bin");
});

test("resolveLoginShellPath: a nonexistent shell binary returns undefined, not a throw", () => {
  const path = resolveLoginShellPath({ shell: "/definitely/not/a/real/shell/binary" });
  assert.equal(path, undefined);
});

test("resolveLoginShellPath: a shell that hangs past the timeout returns undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-shellpath-"));
  const script = join(dir, "hang.sh");
  writeFileSync(script, `#!/bin/sh\nsleep 5\n`);
  chmodSync(script, 0o755);
  const path = resolveLoginShellPath({ shell: script, timeoutMs: 200 });
  assert.equal(path, undefined);
});

test("applyLoginShellPath: merges the shell PATH ahead of the existing PATH, deduping overlap", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-shellpath-"));
  const shell = makeFakeShell(dir, "/fake/volta/bin:/usr/bin");
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  const changed = applyLoginShellPath({ shell }, env);
  assert.equal(changed, true);
  assert.equal(env.PATH, "/fake/volta/bin:/usr/bin:/bin");
});

test("resolveLoginShellPath: against a REAL shell (not the fake stand-in above), an env PATH entry survives — regression for `$PATH` mis-parsing as `$PATH__TRELLIS_PATH__`", () => {
  // The fake shell in the tests above hardcodes its own output and never
  // actually interprets the constructed command string, so it can't catch
  // a bug in that string itself. `/bin/sh -c` does real shell parsing:
  // a bare `$PATH` immediately followed by the marker text would parse as
  // one nonexistent variable name and silently expand to "" — this test
  // fails loudly if that regression reappears.
  // Not a strict-equal round-trip: a real interactive shell may legitimately
  // re-derive PATH from its own rc/profile scripts rather than preserve the
  // inherited value verbatim (that's the point of `-i` — it's exactly how
  // Volta/nvm's real PATH edits get picked up). What the old, broken
  // `$PATH__TRELLIS_PATH__` parse could never do is echo the canary value
  // back at all — it always came back empty.
  const path = resolveLoginShellPath({ shell: "/bin/sh", env: { PATH: "/regression/canary/bin" } });
  assert.ok(path?.split(":").includes("/regression/canary/bin"), `expected the canary entry to survive in: ${path}`);
});

test("applyLoginShellPath: a failed resolution leaves the existing PATH untouched and returns false", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  const changed = applyLoginShellPath({ shell: "/definitely/not/a/real/shell/binary" }, env);
  assert.equal(changed, false);
  assert.equal(env.PATH, "/usr/bin:/bin");
});
