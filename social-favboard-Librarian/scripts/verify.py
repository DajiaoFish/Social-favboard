#!/usr/bin/env python3
"""白板写入后的校验。只读，不修改文件。

除了 JSON/节点/坐标，还检查「套卡完整性」：每张卡片文本是否都能找到配对的封面图。
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


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def num(n, k, d=0):
    return float(n.get(k, d) or 0)


def extract_id(text):
    for pat in LINK_ID_PATTERNS:
        m = pat.search(text or "")
        if m:
            return m.group(1)
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--backup")
    ap.add_argument("--plan")
    args = ap.parse_args()

    canvas_path = Path(args.canvas)
    if not canvas_path.exists():
        print(json.dumps({"status": "error", "message": "canvas 不存在"}, ensure_ascii=False))
        sys.exit(1)

    try:
        data = load_json(canvas_path)
    except Exception as exc:
        print(json.dumps({"status": "invalid_json", "message": str(exc)}, ensure_ascii=False))
        sys.exit(2)

    nodes = data.get("nodes") or []
    edges = data.get("edges") or []
    by_id = {str(n.get("id")): n for n in nodes}
    texts = [n for n in nodes if n.get("type") == "text"]
    files = [n for n in nodes if n.get("type") == "file"]
    file_by_stem = {}
    for f in files:
        stem = str(f.get("file", "")).rsplit("/", 1)[-1]
        m = re.match(r"^(?:douyin|bilibili|xhs)-(.+?)\.[a-zA-Z0-9]+$", stem)
        if m:
            file_by_stem.setdefault(m.group(1), []).append(f)

    types = {}
    for n in nodes:
        t = n.get("type")
        types[t] = types.get(t, 0) + 1

    missing_pairs = []
    checked_cards = 0
    for t in texts:
        body = t.get("text", "") or ""
        if body.lstrip().startswith("SF-SHADOW"):
            continue
        if body.strip().startswith("**") and body.strip().endswith("**") and "\n" not in body.strip():
            continue
        if not any(m in body for m in CARD_MARKS):
            continue
        checked_cards += 1
        nid = extract_id(body)
        cands = file_by_stem.get(nid) or []
        if not cands:
            missing_pairs.append({"card_id": str(t.get("id")), "reason": "no_cover_node"})
            continue
        best = None
        best_score = 1e9
        for f in cands:
            if abs(num(f, "x") - num(t, "x")) > 2:
                continue
            gap = num(t, "y") - (num(f, "y") + num(f, "height", 453))
            score = abs(gap - 10)
            if score < best_score:
                best = f
                best_score = score
        if not best or best_score > 60:
            missing_pairs.append({"card_id": str(t.get("id")), "reason": "x_mismatch_or_gap"})

    result = {
        "status": "ok",
        "canvas": str(canvas_path),
        "nodes": len(nodes),
        "edges": len(edges),
        "types": types,
        "cards_checked": checked_cards,
        "shadow_cards": sum(
            1 for n in nodes
            if n.get("type") == "text" and str(n.get("text", "")).startswith("SF-SHADOW")
        ),
        "groups": [n.get("label") for n in nodes if n.get("type") == "group"],
        "missing_pairs": missing_pairs,
        "coordinate_checks": [],
    }

    if args.backup:
        try:
            old = load_json(args.backup)
            result["before"] = {"nodes": len(old.get("nodes") or []), "edges": len(old.get("edges") or [])}
            result["node_delta"] = len(nodes) - len(old.get("nodes") or [])
            result["edge_delta"] = len(edges) - len(old.get("edges") or [])
        except Exception as exc:
            result["backup_error"] = str(exc)

    if args.plan:
        plan = load_json(args.plan)
        for mv in plan.get("moves") or []:
            for role, node_id, x, y in (
                ("text", mv.get("card_id"), mv.get("text_x"), mv.get("text_y")),
                ("file", mv.get("file_id"), mv.get("file_x"), mv.get("file_y")),
            ):
                if not node_id or x is None or y is None:
                    continue
                node = by_id.get(str(node_id))
                if not node:
                    result["coordinate_checks"].append({"node_id": node_id, "ok": False, "reason": "missing"})
                    continue
                ok = int(num(node, "x")) == int(float(x)) and int(num(node, "y")) == int(float(y))
                result["coordinate_checks"].append({"node_id": str(node_id), "role": role, "ok": ok})

    bad = [c for c in result["coordinate_checks"] if not c["ok"]]
    if bad:
        result["status"] = "coordinate_mismatch"
    if missing_pairs:
        result["status"] = "pair_mismatch"

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()