#!/usr/bin/env python3
"""只读解析草稿白板：套卡配对、分组归属、散卡识别。不修改文件。"""

import argparse
import json
import re
import sys
from pathlib import Path

CARD_W = 340
TEXT_H = 176
TAG_RE = re.compile(r"#([^\s#，。,.!?！？、；;：:]+)")


def load_canvas(path):
    raw = Path(path).read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
        if isinstance(data, dict) and "nodes" in data:
            return data
    except Exception:
        pass
    nodes, edges = [], []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        nodes.extend(obj.get("nodes") or [])
        edges.extend(obj.get("edges") or [])
    return {"nodes": nodes, "edges": edges}


def num(node, key, default=0):
    try:
        return float(node.get(key, default) or 0)
    except Exception:
        return float(default)


def covers(group, node, margin=0):
    return (
        num(node, "x") >= num(group, "x") - margin
        and num(node, "y") >= num(group, "y") - margin
        and num(node, "x") + num(node, "width", CARD_W) <= num(group, "x") + num(group, "width") + margin
        and num(node, "y") + num(node, "height", TEXT_H) <= num(group, "y") + num(group, "height") + margin
    )


def clean_title(text):
    for line in (text or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("SF-SHADOW"):
            continue
        if s.startswith("也可归入"):
            continue
        s = s.strip("*").strip()
        if s:
            return s
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--text-chars", type=int, default=200, help="每张卡正文输出前 N 字")
    args = ap.parse_args()

    path = Path(args.canvas)
    if not path.exists():
        print(json.dumps({"status": "error", "message": "canvas 不存在"}, ensure_ascii=False))
        sys.exit(1)

    data = load_canvas(path)
    nodes = data.get("nodes") or []
    edges = data.get("edges") or []

    files, texts, groups = {}, [], []
    other = 0
    for n in nodes:
        t = n.get("type")
        if t == "file":
            files[str(n.get("id"))] = n
        elif t == "text":
            texts.append(n)
        elif t == "group":
            groups.append(n)
        else:
            other += 1

    groups_sorted = sorted(groups, key=lambda g: num(g, "width") * num(g, "height"))
    paired = set()
    cards = []

    for t in texts:
        tx, ty = num(t, "x"), num(t, "y")
        best = None
        for fid, f in files.items():
            if abs(num(f, "x") - tx) > 2:
                continue
            gap = ty - (num(f, "y") + num(f, "height", 453))
            if 0 <= gap <= 60 and (best is None or gap < best[0]):
                best = (gap, fid)
        fid = best[1] if best else None
        if fid:
            paired.add(fid)

        label, group_id = None, None
        for g in groups_sorted:
            if covers(g, t):
                label = g.get("label")
                group_id = g.get("id")
                break

        body = t.get("text", "") or ""
        cards.append({
            "card_id": str(t.get("id")),
            "file_id": fid,
            "paired": bool(fid),
            "title": clean_title(body),
            "tags": [m.group(1) for m in TAG_RE.finditer(body)][:20],
            "text": body[: args.text_chars],
            "platform": next((ln.split("·")[-1].strip() for ln in body.splitlines() if " · " in ln), ""),
            "group": label,
            "group_id": group_id,
            "is_shadow": body.lstrip().startswith("SF-SHADOW"),
            "x": tx,
            "y": ty,
            "width": num(t, "width", CARD_W),
            "height": num(t, "height", TEXT_H),
        })

    unpaired_files = [fid for fid in files if fid not in paired]
    loose = [c for c in cards if not c["group"] and not c["is_shadow"]]
    shadows = [c for c in cards if c["is_shadow"]]

    result = {
        "status": "ok",
        "canvas": str(path),
        "counts": {
            "nodes": len(nodes),
            "edges": len(edges),
            "file": len(files),
            "text": len(texts),
            "group": len(groups),
            "other": other,
            "cards": len(cards),
            "loose": len(loose),
            "shadow": len(shadows),
            "unpaired_files": len(unpaired_files),
        },
        "groups": [
            {"id": g.get("id"), "label": g.get("label"), "x": num(g, "x"), "y": num(g, "y"),
             "width": num(g, "width"), "height": num(g, "height"), "color": g.get("color")}
            for g in groups
        ],
        "loose_cards": loose,
        "shadow_cards": shadows,
        "unpaired_file_ids": unpaired_files,
        "max_x": max([num(n, "x") + num(n, "width") for n in nodes], default=0),
        "max_y": max([num(n, "y") + num(n, "height") for n in nodes], default=0),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()