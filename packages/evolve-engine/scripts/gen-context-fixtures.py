#!/usr/bin/env python3
"""用 Python 原版 harness2/core/context.py 生成 layout / mission 的对照 fixture。

每个用例一个 test/fixtures/context/<case>.txt,内容是原版函数最终返回(含结尾换行)。
TS 测试(context.test.ts)逐字节比对。开发期工具,不进运行时。

用法:python3 scripts/gen-context-fixtures.py <harness2-root> <out_dir>
"""
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])  # harness2 仓库根
out_dir = Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)

from harness2.core.context import ContextTree, mission


def tree(**kw) -> ContextTree:
    base = dict(
        root="context",
        task_id="ledger-1",
        rollouts=[],
        deliverables=[],
        harness_files=0,
        library=False,
        pool=[],
        failed=[],
        deliverables_mode="contents",
        source_files=0,
        decisions=0,
    )
    base.update(kw)
    return ContextTree(**base)


CASES_LAYOUT = {
    "layout-minimal": tree(),
    "layout-source-decisions": tree(source_files=3, decisions=2),
    "layout-contents-full": tree(
        rollouts=["agg1", "agg2", "b1", "b2"],
        deliverables=["agg1", "agg2", "b1", "b2"],
        harness_files=5,
        library=True,
        pool=["agg1", "agg2"],
        source_files=2,
        decisions=1,
        deliverables_mode="contents",
    ),
    "layout-names-mode": tree(
        rollouts=["c1", "c2"],
        deliverables=["c1", "c2"],
        harness_files=3,
        deliverables_mode="names",
    ),
    "layout-many-rollouts": tree(
        rollouts=[f"r{i}" for i in range(1, 9)],
        deliverables=[f"r{i}" for i in range(1, 9)],
    ),
    "layout-failed-extra": tree(
        rollouts=["ok1"],
        deliverables=["ok1", "bad1"],
        failed=["bad1: ValueError: x"],
        harness_files=1,
    ),
}


def main() -> None:
    for name, t in CASES_LAYOUT.items():
        (out_dir / f"{name}.txt").write_text(t.layout, encoding="utf-8")
        print(f"{name}: {len(t.layout)} chars")
    t = CASES_LAYOUT["layout-contents-full"]
    m = mission(t, job="   Find what regressed in agg2 and say which trajectory moment shows it.   ")
    (out_dir / "mission-contents-full.txt").write_text(m, encoding="utf-8")
    print(f"mission-contents-full: {len(m)} chars")


if __name__ == "__main__":
    main()
