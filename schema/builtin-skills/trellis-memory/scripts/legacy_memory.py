#!/usr/bin/env python3
"""Bounded, read-only legacy migration helper for one explicit workspace."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path.home() / ".claude" / "projects"
MAX_BYTES = 256 * 1024
PRIVATE = re.compile(r"(?:^|[._-])(?:private|credentials?|secrets?|auth)(?:[._-]|$)", re.I)
SECRET = re.compile(r"(?i)(api[_-]?key|access[_-]?token|password|secret|authorization|cookie)\s*[:=]")


def locate(cwd: Path) -> Path:
    key = re.sub(r"[^A-Za-z0-9._-]", "-", str(cwd.resolve()))
    memory = ROOT / key / "memory"
    if not (memory / "MEMORY.md").is_file():
        raise SystemExit("No legacy memory index for this exact workspace; pass the project root as --cwd.")
    return memory.resolve()


def selected_file(memory: Path, name: str) -> Path:
    if Path(name).name != name or PRIVATE.search(name):
        raise SystemExit("Only non-private Markdown files in this workspace may be selected.")
    file = (memory / name).resolve()
    if file.parent != memory or file.suffix != ".md" or not file.is_file():
        raise SystemExit("Selected memory must be a Markdown file inside this workspace.")
    if file.stat().st_size > MAX_BYTES:
        raise SystemExit("Selected memory exceeds the bounded migration limit.")
    return file


def text(memory: Path, name: str) -> str:
    return selected_file(memory, name).read_text(errors="replace")


def safe(line: str) -> str:
    return "[redacted: possible credential]" if SECRET.search(line) else line.rstrip()


def indexed_names(memory: Path) -> list[str]:
    index = text(memory, "MEMORY.md")
    names = re.findall(r"\]\(([^)]+\.md)\)", index)
    found = []
    for name in dict.fromkeys(names):
        try:
            selected_file(memory, name)
        except SystemExit:
            continue
        found.append(name)
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["index", "search", "read"])
    parser.add_argument("value", nargs="?")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()
    memory = locate(Path(args.cwd))
    if args.action == "index":
        print("\n".join(safe(line) for line in text(memory, "MEMORY.md").splitlines()))
        return
    names = indexed_names(memory)
    if args.action == "read":
        if args.value not in names:
            raise SystemExit("Select a non-private file listed in this workspace's index first.")
        print("\n".join(safe(line) for line in text(memory, args.value).splitlines()))
        return
    terms = [term.lower() for term in re.findall(r"[\w.-]+", args.value or "") if len(term) > 1]
    if not terms:
        raise SystemExit("Search requires a non-empty keyword.")
    hits = []
    for name in names:
        body = text(memory, name)
        score = sum((name.lower().count(term) * 4 + body.lower().count(term)) for term in terms)
        if score:
            excerpt = [safe(line)[:500] for line in body.splitlines() if any(term in line.lower() for term in terms)][:3]
            hits.append((score, name, excerpt))
    for score, name, excerpt in sorted(hits, key=lambda hit: (-hit[0], hit[1]))[:max(1, min(args.limit, 10))]:
        print(f"## {name} (score={score})")
        print("\n".join(excerpt))
    if not hits:
        print("No matching indexed legacy memory.")


if __name__ == "__main__":
    main()
