#!/usr/bin/env python3
"""根据归属方案计算横向网格布局。只计算，不写文件。

面框内按每行 3 套排列；行高取该行最高的一套。
输入 plan 与旧版一致；输出 plan2（add_nodes / moves / update_texts / summary）。
"""

import argparse
import json
import uuid
from pathlib import Path

CARD_W = 340
TEXT_H = 176
ENTITY_W = 260
ENTITY_H = 90
PAD = 60
COL_GAP = 80
CARD_GAP_X = 60
CARD_GAP_Y = 90
IMG_TEXT_GAP = 10
COLS = 3
LINE_H = 60
LINE_GAP = 20


def new_id():
    return uuid.uuid4().hex[:16]


def load_canvas(path):
    raw = Path(path).read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    raise SystemExit("canvas 不是整体 JSON，无法布局")


def card_size(node_map, card_id, file_id):
    fh = 453.0
    th = float(TEXT_H)
    fn = node_map.get(str(file_id)) if file_id else None
    if fn:
        fh = float(fn.get("height", 453))
    tn = node_map.get(str(card_id)) if card_id else None
    if tn:
        th = float(tn.get("height", TEXT_H))
    return fh, th


def build_tree(assignments):
    tree = {}
    for a in assignments:
        items = []
        if a.get("main"):
            items.append((a["main"], "main"))
        for p in a.get("copies") or []:
            items.append((p, "copy"))
        for path, role in items:
            if not path:
                continue
            entity = path[0]
            facet = path[1] if len(path) > 1 else "未命名面"
            line = path[2] if len(path) > 2 else None
            e = tree.setdefault(entity, {"facets": {}})
            f = e["facets"].setdefault(facet, {"lines": {}, "cards": []})
            entry = {
                "role": role,
                "path": path,
                "card_id": a.get("card_id"),
                "file_id": a.get("file_id"),
            }
            if line:
                f["lines"].setdefault(line, {"cards": []})["cards"].append(entry)
            else:
                f["cards"].append(entry)
    return tree


def shadow_nodes(node_map, entry, x, top_y, fh, th):
    card_id = str(entry.get("card_id"))
    file_id = str(entry.get("file_id") or "")
    src_text = node_map.get(card_id, {}).get("text", "") or ""
    src_file = node_map.get(file_id, {})
    label = " / ".join(entry["path"])
    return [
        {
            "id": new_id(), "type": "file",
            "file": src_file.get("file", ""),
            "x": x, "y": top_y,
            "width": float(src_file.get("width", CARD_W)),
            "height": fh,
        },
        {
            "id": new_id(), "type": "text",
            "text": f"SF-SHADOW:{card_id}|{label}\n{src_text}",
            "x": x, "y": top_y + fh + IMG_TEXT_GAP,
            "width": CARD_W, "height": th,
            "color": "5",
        },
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out")
    ap.add_argument("--base-x", type=float, default=None)
    ap.add_argument("--base-y", type=float, default=200)
    ap.add_argument("--cols", type=int, default=COLS)
    args = ap.parse_args()

    canvas = load_canvas(args.canvas)
    nodes = canvas.get("nodes") or []
    node_map = {str(n.get("id")): n for n in nodes}
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    assignments = plan.get("assignments") or []

    base_x = args.base_x
    if base_x is None:
        base_x = max([float(n.get("x", 0)) + float(n.get("width", 0)) for n in nodes], default=0) + 160

    cols = max(1, args.cols)
    grid_w = cols * CARD_W + (cols - 1) * CARD_GAP_X
    facet_w = grid_w + PAD * 2

    tree = build_tree(assignments)
    add_nodes, moves, update_texts = [], [], []
    cur_y = args.base_y

    for entity_name, e in tree.items():
        entity_y = cur_y
        facet_x = base_x + ENTITY_W + COL_GAP
        local_y = cur_y
        for facet_name, f in e["facets"].items():
            y = local_y + PAD
            for line_name, l in f["lines"].items():
                add_nodes.append({
                    "id": new_id(), "type": "text",
                    "text": f"**{line_name}**",
                    "x": facet_x + PAD, "y": y,
                    "width": grid_w, "height": LINE_H, "color": "5",
                })
                y += LINE_H + LINE_GAP
                cards = l["cards"]
                for start in range(0, len(cards), cols):
                    row = cards[start:start + cols]
                    sizes = [card_size(node_map, c["card_id"], c["file_id"]) for c in row]
                    row_h = max([fh + IMG_TEXT_GAP + th for fh, th in sizes])
                    for idx, item in enumerate(row):
                        fh, th = sizes[idx]
                        x = facet_x + PAD + idx * (CARD_W + CARD_GAP_X)
                        if item["role"] == "main":
                            moves.append({
                                "card_id": item["card_id"],
                                "file_id": item["file_id"],
                                "file_x": x, "file_y": y,
                                "text_x": x, "text_y": y + fh + IMG_TEXT_GAP,
                            })
                        else:
                            add_nodes.extend(shadow_nodes(node_map, item, x, y, fh, th))
                    y += row_h + CARD_GAP_Y
            cards = f["cards"]
            for start in range(0, len(cards), cols):
                row = cards[start:start + cols]
                sizes = [card_size(node_map, c["card_id"], c["file_id"]) for c in row]
                row_h = max([fh + IMG_TEXT_GAP + th for fh, th in sizes])
                for idx, item in enumerate(row):
                    fh, th = sizes[idx]
                    x = facet_x + PAD + idx * (CARD_W + CARD_GAP_X)
                    if item["role"] == "main":
                        moves.append({
                            "card_id": item["card_id"],
                            "file_id": item["file_id"],
                            "file_x": x, "file_y": y,
                            "text_x": x, "text_y": y + fh + IMG_TEXT_GAP,
                        })
                    else:
                        add_nodes.extend(shadow_nodes(node_map, item, x, y, fh, th))
                y += row_h + CARD_GAP_Y
            height = max(y - local_y - CARD_GAP_Y + PAD, 300)
            add_nodes.append({
                "id": new_id(), "type": "group",
                "label": facet_name,
                "x": facet_x, "y": local_y,
                "width": facet_w, "height": height,
                "color": "3",
            })
            local_y += height + COL_GAP
        add_nodes.append({
            "id": new_id(), "type": "text",
            "text": f"**{entity_name}**",
            "x": base_x, "y": entity_y,
            "width": ENTITY_W, "height": ENTITY_H, "color": "1",
        })
        cur_y = local_y

    for a in assignments:
        for target in a.get("medium") or []:
            update_texts.append({
                "card_id": a.get("card_id"),
                "insert_first_line": "也可归入：" + " / ".join(target),
            })

    result = {
        "status": "ok",
        "base_x": base_x,
        "cols": cols,
        "add_nodes": add_nodes,
        "moves": moves,
        "update_texts": update_texts,
        "summary": {
            "entities": len(tree),
            "facets": sum(len(e["facets"]) for e in tree.values()),
            "cards_moved": len(moves),
            "shadow_cards": sum(1 for n in add_nodes if n["type"] == "text" and str(n.get("text", "")).startswith("SF-SHADOW")),
            "groups_created": sum(1 for n in add_nodes if n["type"] == "group"),
            "labels_created": sum(1 for n in add_nodes if n["type"] == "text" and not str(n.get("text", "")).startswith("SF-SHADOW")),
        },
    }

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(json.dumps({"status": "ok", "out": args.out, "summary": result["summary"]}, ensure_ascii=False))
    else:
        print(text)


if __name__ == "__main__":
    main()