#!/usr/bin/env python3
"""检查并生成「套卡对齐」补丁：把错位的封面图重新对到文本卡上方。

只读，输出补丁清单，由 Agent 用 edit 应用。
"""

import argparse
import json
import re
import sys
from pathlib import Path

LINK_ID_PATTERNS = [
    re.compile(r"douyin\.com/video/(\d{6,})"),
    re.compile(r"bilibili\.com/video/((?:BV|av)[0-9A-Za-z]+)"),
    re.compile(r"xiaohongshu\.com/(?:explore|discovery/item)/([0-9a-zA-Z]+)"),
]
CARD_MARKS = ["打开原视频", "打开原帖", "在小红书搜索"]


def num(n, k, d=0):
    return float(n.get(k, d) or 0)


def extract_id(text):
    for pat in LINK_ID_PATTERNS:
        m = pat.search(text or "")
        if m:
            return m.group(1)
    return ""


def find_file_for(node_id, files):
    for f in files:
        path = str(f.get("file", ""))
        stem = path.rsplit("/", 1)[-1]
        if node_id and node_id in stem:
            return f
    return None


def is_pair_ok(text, file_node):
    if not file_node:
        return False
    if abs(num(file_node, "x") - num(text, "x")) > 2:
        return False
    gap = num(text, "y") - (num(file_node, "y") + num(file_node, "height", 453))
    return 0 <= gap <= 60


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--out")
    args = ap.parse_args()

    path = Path(args.canvas)
    if not path.exists():
        print(json.dumps({"status": "error", "message": "canvas 不存在"}, ensure_ascii=False))
        sys.exit(1)

    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    nodes = data.get("nodes") or []
    texts = [n for n in nodes if n.get("type") == "text"]
    files = [n for n in nodes if n.get("type") == "file"]

    patches = []
    missing = []
    checked = 0

    for t in texts:
        body = t.get("text", "") or ""
        if body.lstrip().startswith("SF-SHADOW"):
            continue
        if body.strip().startswith("**") and body.strip().endswith("**") and "\n" not in body.strip():
            continue
        if not any(m in body for m in CARD_MARKS):
            continue
        checked += 1
        node_id = extract_id(body)
        f = find_file_for(node_id, files) if node_id else None
        if not f:
            title = next((ln.strip().strip("*") for ln in body.splitlines() if ln.strip()), "")
            missing.append({"card_id": str(t.get("id")), "title": title[:60], "reason": "封面节点缺失"})
            continue
        if is_pair_ok(t, f):
            continue
        old = f'"x":{int(num(f, "x"))},"y":{int(num(f, "y"))}'
        new_x = int(num(t, "x"))
        new_y = int(num(t, "y") - num(f, "height", 453) - 10)
        new = f'"x":{new_x},"y":{new_y}'
        patches.append({
            "card_id": str(t.get("id")),
            "file_id": str(f.get("id")),
            "title": next((ln.strip().strip("*") for ln in body.splitlines() if ln.strip()), "")[:60],
            "old": old,
            "new": new,
            "count": raw.count(old),
        })

    result = {
        "status": "ok" if not missing else "has_missing_cover",
        "checked": checked,
        "patches": patches,
        "missing": missing,
        "instruction": "按 patches 用 edit 逐条替换即可对齐；missing 表示封面节点真的缺失，需要重新采集。",
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(json.dumps({
            "status": result["status"],
            "out": args.out,
            "checked": checked,
            "patches": len(patches),
            "missing": len(missing),
        }, ensure_ascii=False))
    else:
        print(text)


if __name__ == "__main__":
    main()