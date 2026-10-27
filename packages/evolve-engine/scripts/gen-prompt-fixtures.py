#!/usr/bin/env python3
"""用 Python 原版 harness2/core/prompts.py 生成 TS 移植的对照 fixture。

每个用例一个 <case>.txt,内容是原版函数的最终返回(含结尾换行)。
TS 测试逐字节比对。开发期工具,不进运行时。
"""
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])  # harness2 仓库根
out_dir = Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)

from harness2.core.prompts import aggregate, compose_round, experience, propose, select
from harness2.core.spec import BenchPrompts

BP_DEMO = BenchPrompts(
    work="Reconcile the ledger workbook and write a closing memo.",
    domain_word="ledger",
    inv_levers="- prefer a script for CSV normalisation",
    dom_levers="- name the source of record",
    deliverable_word="closing memo",
)

BP_FULL = BenchPrompts(
    work="Draft the engagement letter from the intake notes.",
    domain_word="matter",
    inv_levers="- check the file write before finishing",
    dom_levers="- never invent a clause",
    yardstick="A good run re-reads what it wrote.",
    deliverable_word="letter",
    domain_guidance="Engagement letters follow the firm's plain-language rule.",
    selection_checks="Every party name matches the intake sheet.",
    selection_lead="Requested sections all present, in the asked order.",
    selection_conformance="value_only",
)

BP_TTS = BenchPrompts(
    work="Summarise the workshop transcript into action items.",
    domain_word="workshop",
    inv_levers="- keep always-on text tiny",
    dom_levers="- quote the transcript, do not paraphrase commitments",
    deliverable_word="action list",
    prompt_pack="tts",
)

CASES = {
    "propose-adapt-inv-k1": propose(BP_DEMO, "INV", "opencode", k=1),
    "propose-adapt-dom-k2": propose(BP_DEMO, "DOM", "opencode", k=2, index=2),
    "propose-adapt-inv-round2": propose(BP_DEMO, "INV", "opencode", k=2, index=1, round_t=2),
    "propose-codex-dom-k1": propose(BP_DEMO, "DOM", "codex", k=1),
    "propose-full-dom-k1": propose(BP_FULL, "DOM", "opencode", k=1),
    "propose-tts-inv-k2": propose(BP_TTS, "INV", "opencode", k=2, index=1),
    "propose-tts-dom-k1": propose(BP_TTS, "DOM", "codex", k=1),
    "aggregate-adapt-k1": aggregate(BP_DEMO, "opencode", k=1),
    "aggregate-adapt-k2": aggregate(BP_FULL, "opencode", k=2),
    "aggregate-tts-k2": aggregate(BP_TTS, "opencode", k=2, index=2),
    "compose-round-t1-of-3": compose_round(BP_DEMO, "opencode", t=1, k=3),
    "compose-round-t3-of-3": compose_round(BP_DEMO, "opencode", t=3, k=3),
    "select-mixed-full": select(BP_DEMO, 4, "mixed"),
    "select-finals-value-only": select(BP_FULL, 3, "finals", assets_note="\n    context/candidates/<id>.png  rendered preview\n"),
    "select-tts-mixed": select(BP_TTS, 2, "mixed"),
    "experience-demo": experience(BP_DEMO),
}

for name, text in CASES.items():
    (out_dir / f"{name}.txt").write_text(text, encoding="utf-8")
print(f"wrote {len(CASES)} fixtures to {out_dir}")
