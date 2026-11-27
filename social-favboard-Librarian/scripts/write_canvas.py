#!/usr/bin/env python3
"""把布局结果写回草稿白板。默认 dry-run；--apply 才写入，写入前自动备份。"""

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

PLUGIN_ID = "social-favboard"


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def find_target_canvas(canvas_path):
    p = Path(canvas_path).resolve()
    for parent in [p.parent, *p.parents]:
        data_file = parent / ".obsidian" / "plugins" / PLUGIN_ID / "data.json"
        if data_file.exists():
            data = load_json(data_file)
            target = (data.get("targetCanvas") or "").strip().replace("\\", "/").lstrip("/")
            if not target:
                return None
            expected = (parent / target).resolve()
            return {"expected": str(expected), "match": expected == p}
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--allow-delete-shadow", action="store_true")
    args = ap.parse_args()

    canvas_path = Path(args.canvas)
    if not canvas_path.exists():
        print(json.dumps({"status": "error", "message": "canvas 不存在"}, ensure_ascii=False))
        sys.exit(1)

    check = find_target_canvas(canvas_path)
    if check is None:
        print(json.dumps({"status": "refused", "message": "找不到插件配置，拒绝写入"}, ensure_ascii=False))
        sys.exit(2)
    if not check["match"]:
        print(json.dumps({
            "status": "refused",
            "message": "目标不是插件配置的草稿白板，拒绝写入",
            "expected": check["expected"],
            "given": str(canvas_path.resolve()),
        }, ensure_ascii=False))
        sys.exit(2)

    canvas = load_json(canvas_path)
    nodes = canvas.get("nodes") or []
    edges = canvas.get("edges") or []
    plan = load_json(args.plan)
    node_map = {str(n.get("id")): n for n in nodes}

    added = moved = annotated = shadow_removed = 0
    missing = []

    for n in plan.get("add_nodes") or []:
        if str(n.get("id")) not in node_map:
            nodes.append(n)
            node_map[str(n.get("id"))] = n
            added += 1

    for mv in plan.get("moves") or []:
        card_id = str(mv.get("card_id") or "")
        file_id = str(mv.get("file_id") or "")
        tnode = node_map.get(card_id)
        fnode = node_map.get(file_id) if file_id else None
        if not tnode:
            missing.append(card_id)
            continue
        tnode["x"] = float(mv["text_x"])
        tnode["y"] = float(mv["text_y"])
        if fnode:
            fnode["x"] = float(mv["file_x"])
            fnode["y"] = float(mv["file_y"])
        moved += 1

    for up in plan.get("update_texts") or []:
        node = node_map.get(str(up.get("card_id") or ""))
        if not node:
            continue
        line = up.get("insert_first_line") or ""
        body = node.get("text", "") or ""
        if not line or line in body:
            continue
        node["text"] = line + "\n" + body
        annotated += 1

    if args.allow_delete_shadow:
        keep = []
        for n in nodes:
            body = n.get("text", "") or ""
            if n.get("type") == "text" and body.lstrip().startswith("SF-SHADOW"):
                shadow_removed += 1
                continue
            keep.append(n)
        nodes = keep

    result = {
        "status": "applied" if args.apply else "dry_run",
        "canvas": str(canvas_path),
        "added_nodes": added,
        "moved_cards": moved,
        "annotated": annotated,
        "shadow_removed": shadow_removed,
        "missing_cards": missing,
    }

    if not args.apply:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = canvas_path.with_name(canvas_path.name + ".sfbak-" + stamp)
    index = 1
    while backup.exists():
        backup = canvas_path.with_name(canvas_path.name + ".sfbak-" + stamp + "-" + str(index))
        index += 1
    shutil.copy2(canvas_path, backup)

    canvas["nodes"] = nodes
    canvas["edges"] = edges
    canvas_path.write_text(json.dumps(canvas, ensure_ascii=False, indent="\t"), encoding="utf-8")

    result["backup"] = str(backup)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()