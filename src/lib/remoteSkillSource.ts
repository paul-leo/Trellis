/**
 * Remote Skill source handling.  The public command accepts only GitHub
 * identities, while the lower-level fetch function intentionally accepts a
 * repository URL so unit and sandbox tests can use a local bare Git remote.
 * No command in this module evaluates checked-out content.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { directoryDigest } from "./dirDigest.js";

export interface GitHubRepository {
  source: string;
  url: string;
  owner: string;
  repository: string;
}

export interface RemoteSkillCandidate {
  name: string;
  directory: string;
  subdirectory: string;
}

export interface SelectedRemoteSkill extends RemoteSkillCandidate {
  digest: string;
}

export interface FetchedRemoteRepository {
  repository: { url: string };
  requestedRef: string;
  commit: string;
  root: string;
  candidates: readonly RemoteSkillCandidate[];
  select(name: string): SelectedRemoteSkill;
  dispose(): void;
}

function git(args: readonly string[], cwd?: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git could not read the remote Skill source: ${detail}`);
  }
}

/** Accept the exact two source syntaxes Trellis documents, with no URL state
 * that could put a credential in the provenance lock. */
export function normalizeGitHubRepository(source: string): GitHubRepository {
  const shorthand = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9_.-]+)$/.exec(source);
  if (shorthand) {
    const [, owner, repository] = shorthand;
    return { source, owner: owner!, repository: repository!, url: `https://github.com/${owner}/${repository}.git` };
  }

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error(`Remote Skill source must be GitHub owner/repository or an HTTPS github.com URL: ${source}`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parts.length !== 2
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/.test(parts[0]!)
    || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(parts[1]!)
  ) {
    throw new Error(`Remote Skill source must be a credential-free HTTPS github.com repository URL: ${source}`);
  }
  const owner = parts[0]!;
  const repository = parts[1]!.replace(/\.git$/i, "");
  return { source, owner, repository, url: `https://github.com/${owner}/${repository}.git` };
}

function parseLsRemote(output: string): { hash: string; ref: string }[] {
  return output.split("\n").flatMap((line) => {
    const match = /^([0-9a-f]{40})\t(.+)$/.exec(line.trim());
    return match ? [{ hash: match[1]!, ref: match[2]! }] : [];
  });
}

function resolveDefaultRef(url: string): { requestedRef: string; commit: string } {
  const output = git(["ls-remote", "--symref", url, "HEAD"]);
  const branch = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(output)?.[1];
  const commit = parseLsRemote(output).find((entry) => entry.ref === "HEAD")?.hash;
  if (!branch || !commit) throw new Error(`Could not resolve the default branch for ${url}`);
  return { requestedRef: branch, commit };
}

function resolveRequestedRef(url: string, requestedRef: string): { requestedRef: string; commit: string } {
  if (!requestedRef || /[\0\r\n]/.test(requestedRef)) throw new Error("--branch must be a non-empty Git ref");
  const entries = parseLsRemote(git(["ls-remote", url, requestedRef]));
  const peeled = entries.find((entry) => entry.ref.endsWith("^{}"));
  const direct = entries.find((entry) => !entry.ref.endsWith("^{}"));
  const selected = peeled ?? direct;
  if (!selected) throw new Error(`Remote source has no ref named ${requestedRef}`);
  return { requestedRef, commit: selected.hash };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith("..\/"));
}

function walkDirectories(root: string): string[] {
  const dirs: string[] = [];
  const walk = (current: string): void => {
    dirs.push(current);
    for (const name of readdirSync(current).sort((a, b) => a.localeCompare(b))) {
      // The Git administration directory is implementation state, never
      // source content to inspect for a Skill candidate.
      if (current === root && name === ".git") continue;
      const entry = join(current, name);
      const stat = lstatSync(entry);
      if (stat.isDirectory()) walk(entry);
    }
  };
  walk(root);
  return dirs;
}

function candidatesIn(root: string): RemoteSkillCandidate[] {
  return walkDirectories(root).flatMap((directory) => {
    const names = readdirSync(directory);
    const exact = names.find((name) => name === "SKILL.md");
    if (!exact) return [];
    const entry = join(directory, exact);
    // A non-file `SKILL.md` is deliberately not advertised as a valid
    // candidate; selecting this directory produces a precise error below.
    if (!lstatSync(entry).isFile()) return [];
    return [{ name: basename(directory), directory, subdirectory: relative(root, directory).split(sep).join("/") }];
  });
}

function validateSelectedDirectory(root: string, directory: string, expectedName: string): SelectedRemoteSkill {
  if (basename(directory) !== expectedName) throw new Error(`Selected remote Skill directory is not named ${expectedName}`);
  const rootReal = realpathSync(root);
  const walk = (current: string): void => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Remote Skill ${expectedName} contains a symbolic link: ${current}`);
    const resolved = realpathSync(current);
    if (!isInside(rootReal, resolved)) throw new Error(`Remote Skill ${expectedName} resolves outside the fetched repository`);
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(current)) walk(join(current, name));
  };

  const entry = join(directory, "SKILL.md");
  const entryStat = lstatSync(entry);
  if (entryStat.isSymbolicLink()) {
    const resolvedEntry = realpathSync(entry);
    if (!isInside(rootReal, resolvedEntry)) throw new Error(`Remote Skill ${expectedName} entry file resolves outside the fetched repository`);
    throw new Error(`Remote Skill ${expectedName} entry file must not be a symbolic link`);
  }
  if (!entryStat.isFile()) throw new Error(`Remote Skill ${expectedName} has no regular, exact-case SKILL.md`);
  walk(directory);
  return {
    name: expectedName,
    directory,
    subdirectory: relative(root, directory).split(sep).join("/"),
    digest: directoryDigest(directory),
  };
}

/**
 * Fetches a single immutable commit into a system temporary directory.  It is
 * exported with a URL-shaped repository argument to let tests exercise the
 * real Git protocol against a local bare repo; CLI callers first use
 * normalizeGitHubRepository and therefore cannot pass arbitrary hosts.
 */
export function fetchRemoteRepository(repository: { url: string }, opts: { branch?: string } = {}): FetchedRemoteRepository {
  const resolvedRef = opts.branch === undefined ? resolveDefaultRef(repository.url) : resolveRequestedRef(repository.url, opts.branch);
  const temp = mkdtempSync(join(tmpdir(), "trellis-remote-skill-"));
  let disposed = false;
  try {
    git(["init", "--quiet"], temp);
    git(["remote", "add", "origin", repository.url], temp);
    git(["fetch", "--quiet", "--depth=1", "origin", resolvedRef.commit], temp);
    git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], temp);
    const actualCommit = git(["rev-parse", "HEAD"], temp).trim();
    if (!/^[0-9a-f]{40}$/.test(actualCommit)) throw new Error("Git did not produce an immutable commit identifier");
    const root = resolve(temp);
    const candidates = candidatesIn(root);
    return {
      repository: { url: repository.url },
      requestedRef: resolvedRef.requestedRef,
      commit: actualCommit,
      root,
      candidates,
      select(name: string): SelectedRemoteSkill {
        const matchingDirectories = walkDirectories(root).filter((directory) => basename(directory) === name);
        if (matchingDirectories.length === 0) {
          const available = candidates.map((candidate) => candidate.name).sort().join(", ") || "none";
          throw new Error(`Remote source has no Skill named ${name}. Available Skills: ${available}`);
        }
        const withEntry = matchingDirectories.filter((directory) => {
          try {
            return readdirSync(directory).includes("SKILL.md");
          } catch {
            return false;
          }
        });
        if (withEntry.length !== 1) {
          if (withEntry.length === 0) throw new Error(`Remote Skill ${name} has no regular, exact-case SKILL.md`);
          throw new Error(`Remote source contains multiple Skills named ${name}; select a repository with one matching Skill`);
        }
        return validateSelectedDirectory(root, withEntry[0]!, name);
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        rmSync(temp, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}
