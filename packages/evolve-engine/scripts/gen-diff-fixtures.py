#!/usr/bin/env python3
"""用 Python 标准库 difflib(harness2 pool harness.diff 的同一实现)生成 TS 移植的对照 fixture。

每个用例一个目录 test/fixtures/diffs/<case>/:
    a.txt          unified_diff 的 from 侧全文
    b.txt          unified_diff 的 to 侧全文
    expected.diff  "".join(unified_diff(...)) 的逐字节期望(可为空文件)
manifest.json 列出用例名与 fromfile/tofile。TS 测试(difflib.test.ts)逐字节比对。
开发期工具,不进运行时。

用法:python3 scripts/gen-diff-fixtures.py [out_dir]
"""
import difflib
import json
import sys
from pathlib import Path


def case_identical() -> tuple[str, str]:
    a = "alpha\nbeta\ngamma\n"
    return a, a


def case_one_line_change() -> tuple[str, str]:
    a = "one\ntwo\nthree\nfour\nfive\nsix\n"
    b = "one\ntwo\nTHREE\nfour\nfive\nsix\n"
    return a, b


def case_middle_hunk() -> tuple[str, str]:
    a = "".join(f"line-{i:02d}\n" for i in range(1, 41))
    b = a.replace("line-20\n", "line-20-CHANGED\n")
    return a, b


def case_multi_hunk() -> tuple[str, str]:
    a = "".join(f"line-{i:02d}\n" for i in range(1, 41))
    b = a.replace("line-05\n", "line-05-CHANGED\n").replace(
        "line-35\n", "line-35-CHANGED\n"
    )
    return a, b


def case_insert_only() -> tuple[str, str]:
    a = "one\ntwo\nthree\nfour\nfive\n"
    b = "one\ntwo\nINSERT-A\nINSERT-B\nINSERT-C\nthree\nfour\nfive\n"
    return a, b


def case_delete_only() -> tuple[str, str]:
    a = "one\ntwo\nGONE-A\nGONE-B\nthree\nfour\nfive\n"
    b = "one\ntwo\nthree\nfour\nfive\n"
    return a, b


def case_empty_to_content() -> tuple[str, str]:
    return "", "born-1\nborn-2\nborn-3\n"


def case_content_to_empty() -> tuple[str, str]:
    return "die-1\ndie-2\ndie-3\n", ""


def case_no_trailing_newline() -> tuple[str, str]:
    a = "one\ntwo\nthree-no-newline"
    b = "one\ntwo\nthree-CHANGED-no-newline"
    return a, b


def case_append_at_end() -> tuple[str, str]:
    a = "".join(f"line-{i:02d}\n" for i in range(1, 11))
    b = a + "appended-1\nappended-2\nappended-3\nappended-4\n"
    return a, b


def case_vtab_split() -> tuple[str, str]:
    # str.splitlines 的边界不止 \n:\x0b 也分行。锚定 TS 端同语义。
    a = "before\nbefore2\x0bafter\nlast\n"
    b = "before\nbefore2\x0bAFTER\nlast\n"
    return a, b


def case_autojunk() -> tuple[str, str]:
    # b 长度 >= 200 时出现次数 > n//100+1 的行判垃圾(SequenceMatcher autojunk)。
    junk = ["JUNK\n"] * 8
    b_lines = junk[:4] + [f"b-{i:03d}\n" for i in range(200)] + junk[4:]
    b = "".join(b_lines) + "b-tail\n"
    a_lines = junk[:4] + [f"b-{i:03d}\n" for i in range(200) if i not in (100, 101)]
    a = "".join(a_lines) + "a-only\nb-tail\n"
    return a, b


CASES = {
    "identical": case_identical,
    "one-line-change": case_one_line_change,
    "middle-hunk": case_middle_hunk,
    "multi-hunk": case_multi_hunk,
    "insert-only": case_insert_only,
    "delete-only": case_delete_only,
    "empty-to-content": case_empty_to_content,
    "content-to-empty": case_content_to_empty,
    "no-trailing-newline": case_no_trailing_newline,
    "append-at-end": case_append_at_end,
    "vtab-split": case_vtab_split,
    "autojunk": case_autojunk,
}


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("test/fixtures/diffs")
    out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, fn in CASES.items():
        a, b = fn()
        fromfile = f"current/{name}.txt"
        tofile = f"pool/{name}.txt"
        expected = "".join(
            difflib.unified_diff(
                a.splitlines(keepends=True),
                b.splitlines(keepends=True),
                fromfile=fromfile,
                tofile=tofile,
            )
        )
        d = out / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "a.txt").write_bytes(a.encode("utf-8"))
        (d / "b.txt").write_bytes(b.encode("utf-8"))
        (d / "expected.diff").write_bytes(expected.encode("utf-8"))
        manifest.append({"case": name, "fromfile": fromfile, "tofile": tofile})
        print(f"{name}: {len(expected)} bytes")
    (out / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
