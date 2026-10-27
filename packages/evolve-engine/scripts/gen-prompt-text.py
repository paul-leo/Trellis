#!/usr/bin/env python3
"""从 harness2/core/prompts.py 提取字符串常量,生成 prompt-text.ts。

用 ast.literal_eval 求值(仅限字面量与字面量拼接),以 JSON 字符串字面量形式落盘,
保证与 Python 原版逐字节一致。开发期工具,不进运行时。
"""
import ast
import json
import sys

NAMES = [
    "VERSION",  # 单独处理:不是字符串拼接之外的常量,但保持一致
    "ANSWER_FREE",
    "ANSWER_FREE_SELECT",
    "EVIDENCE_BOUNDARY",
    "POOL_MIXED_SELECT",
    "POOL_FINALS_SELECT",
    "EVIDENCE_BOUNDARY_SELECT",
    "_SURFACE_OPENCODE",
    "_SURFACE_CODEX",
    "GENERALIZE",
    "_KEEP_BASE",
    "_INV_TEMPLATE",
    "_DOM_TEMPLATE",
    "_TTS_SURFACE_HEAD_OPENCODE",
    "_TTS_SURFACE_HEAD_CODEX",
    "_TTS_INV",
    "_TTS_DOM",
    "_TTS_GENERALIZE",
    "_TTS_HOW",
    "CONFORMANCE_BLOCK",
    "VALUE_TAIL",
]

src_path, out_path = sys.argv[1], sys.argv[2]
module = ast.parse(open(src_path, encoding="utf-8").read())
values = {}
for node in module.body:
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        name = node.targets[0].id
        if name in NAMES:
            values[name] = ast.literal_eval(node.value)

missing = [n for n in NAMES if n not in values]
if missing:
    sys.exit(f"missing constants: {missing}")

lines = [
    "// prompt-text.ts — 由 scripts/gen-prompt-text.py 从 harness2/core/prompts.py 生成,",
    "// 字符串与 Python 原版逐字节一致(ast.literal_eval + JSON 转义)。",
    "// 本文件是生成物:改 prompt 请改上游并重新生成,不要手改。",
    "",
]
for name in NAMES:
    lines.append(f"export const {name} = {json.dumps(values[name], ensure_ascii=False)};")
    lines.append("")

with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print(f"wrote {out_path}: {len(NAMES)} constants")
