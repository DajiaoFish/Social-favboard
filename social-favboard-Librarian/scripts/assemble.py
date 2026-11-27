#!/usr/bin/env python3
"""生成完整新白板（横向网格，每行 3 套）。只写工作区，不写 vault。

流程：读现有白板 → 合并已分组卡片和新归属 → 重排 → 输出到工作区文件，
由插件「Skill 排版结果自动写入白板」负责落盘。
"""

import argparse
import json
import re
from pathlib import Path

CARD_W = 340
PAD = 60
GAPX = 60
GAPY = 90
ENTITY_W = 260
COL_GAP = 80


def parse_concepts(md_path):
    concepts = {}
    if not md_path:
        return concepts
    path = Path(md_path)
    if not path.exists():
        return concepts
    current = None
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^##\s*体[:：]\s*(.+)$", line)
        if m:
            current = m.group(1).strip()
            concepts.setdefault(current, [])
            continue
        m = re.match(r"^-\s*面[:：]\s*(.+)$", line)
        if m and current:
            concepts[current].append(m.group(1).strip())
    return concepts


def num(n, k, d=0):
    return float(n.get(k, d) or 0)


def covers(g, n):
    return (
        num(n, "x") >= num(g, "x")
        and num(n, "y") >= num(g, "y")
        and num(n, "x") + num(n, "width", CARD_W) <= num(g, "x") + num(g, "width")
        and num(n, "y") + num(n, "height", 176) <= num(g, "y") + num(g, "height")
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--vault")
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-x", type=float, default=0)
    ap.add_argument("--base-y", type=float, default=19316)
    ap.add_argument("--cols", type=int, default=3)
    ap.add_argument("--group-gap", type=float, default=100)
    args = ap.parse_args()

    canvas = Path(args.canvas)
    if not canvas.exists():
        raise SystemExit("canvas 不存在")
    data = json.loads(canvas.read_text(encoding="utf-8"))
    nodes = data["nodes"]
    by_id = {str(n["id"]): n for n in nodes}
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))

    md = Path(args.vault) / "分类类型-灵感体系.md" if args.vault else None
    concepts = parse_concepts(md)

    files = {k: n for k, n in by_id.items() if n.get("type") == "file"}
    texts = [n for n in nodes if n.get("type") == "text"]
    groups = [n for n in nodes if n.get("type") == "group"]

    LINK_ID = re.compile(r"(?:douyin\.com/video/|bilibili\.com/video/|xiaohongshu\.com/(?:explore|discovery/item)/)([0-9A-Za-z]+)")
    used_files = set()

    def pair_of(t):
        body = t.get("text", "") or ""
        m = LINK_ID.search(body)
        if m:
            nid = m.group(1)
            cands = [
                f for f in files.values()
                if nid in str(f.get("file", "")) and str(f.get("id")) not in used_files
            ]
            if cands:
                cands.sort(key=lambda f: abs(num(f, "x") - num(t, "x")))
                used_files.add(str(cands[0].get("id")))
                return cands[0]
        best = None
        for f in files.values():
            if str(f.get("id")) in used_files:
                continue
            if abs(num(f, "x") - num(t, "x")) <= 2:
                gap = num(t, "y") - (num(f, "y") + num(f, "height", 453))
                if 0 <= gap <= 60 and (best is None or gap < best[0]):
                    best = (gap, f)
        if best:
            used_files.add(str(best[1].get("id")))
        return best[1] if best else None

    # 概念兜底：plan 里出现但分类类型-灵感体系里没有的，补进去
    for a in plan.get("assignments") or []:
        main = a.get("main") or []
        if len(main) >= 2:
            concepts.setdefault(main[0], [])
            if main[1] not in concepts[main[0]]:
                concepts[main[0]].append(main[1])
        for p in a.get("copies") or []:
            if len(p) >= 2:
                concepts.setdefault(p[0], [])
                if p[1] not in concepts[p[0]]:
                    concepts[p[0]].append(p[1])

    group_map = {}
    for g in groups:
        label = g.get("label")
        for entity, facets in concepts.items():
            if label in facets:
                group_map[label] = (entity, label)

    buckets = {(e, f): [] for e in concepts for f in concepts[e]}
    seen = set()
    seen_card_ids = set()
    for g in groups:
        label = g.get("label")
        key = group_map.get(label)
        if not key:
            continue
        for t in texts:
            if covers(g, t):
                m = LINK_ID.search(t.get("text", "") or "")
                cid = m.group(1) if m else str(t.get("id"))
                if cid in seen_card_ids:
                    continue
                seen_card_ids.add(cid)
                buckets.setdefault(key, []).append({"text": t, "file": pair_of(t), "medium": []})
                seen.add(str(t.get("id")))

    for a in plan.get("assignments") or []:
        main = a.get("main") or []
        if len(main) < 2:
            continue
        key = (main[0], main[1])
        t0 = by_id.get(str(a.get("card_id")))
        if t0 is None:
            continue
        m0 = LINK_ID.search(t0.get("text", "") or "")
        cid0 = m0.group(1) if m0 else str(a.get("card_id"))
        if cid0 in seen_card_ids or str(a.get("card_id")) in seen:
            continue
        seen_card_ids.add(cid0)
        t = t0
        f = by_id.get(str(a.get("file_id"))) if a.get("file_id") else None
        buckets.setdefault(key, []).append({
            "text": t, "file": f, "medium": a.get("medium") or [],
        })

    entity_label = {}
    for n in texts:
        raw = (n.get("text") or "").strip()
        if raw.startswith("**") and raw.endswith("**") and "\n" not in raw:
            name = raw.strip("*")
            if name in concepts:
                entity_label[name] = n

    cols = max(1, args.cols)
    ENTITY_COLS = 5
    ENTITY_GAP = 200
    entity_width = ENTITY_W + COL_GAP + 1260

    cur_row_y = args.base_y
    row_height = 0
    entity_col = 0

    for entity, facets in concepts.items():
        body_x = args.base_x + entity_col * (entity_width + ENTITY_GAP)
        facet_x = body_x + ENTITY_W + COL_GAP
        entity_y = cur_row_y
        cur_y = entity_y
        for facet in facets:
            cards = buckets.get((entity, facet), [])
            if not cards:
                continue
            g = None
            for existing in groups:
                if existing.get("label") == facet:
                    g = existing
                    break
            if g is None:
                g = {"id": f"g{abs(hash(entity + facet)) % 100000}", "type": "group",
                     "label": facet, "color": "3", "x": facet_x, "y": cur_y,
                     "width": 0, "height": 0}
                nodes.append(g)
                groups.append(g)
            gx, gy = facet_x, cur_y
            y = gy + PAD
            max_right = gx
            for start in range(0, len(cards), cols):
                row = cards[start:start + cols]
                row_h = 0
                for i, item in enumerate(row):
                    t, f = item["text"], item["file"]
                    fh = num(f, "height", 453) if f else 453
                    th = num(t, "height", 176)
                    x = gx + PAD + i * (CARD_W + GAPX)
                    if f:
                        f["x"], f["y"] = x, y
                    t["x"], t["y"] = x, y + fh + 10
                    if item["medium"]:
                        line = "也可归入：" + " / ".join(item["medium"][0])
                        if line not in (t.get("text") or ""):
                            t["text"] = line + "\n" + (t.get("text") or "")
                    row_h = max(row_h, fh + 10 + th)
                    max_right = max(max_right, x + CARD_W)
                y += row_h + GAPY
            g["x"], g["y"] = gx, gy
            g["width"] = max_right - gx + PAD
            g["height"] = max(y - GAPY + PAD - gy, 300)
            cur_y = gy + g["height"] + args.group_gap
        label = entity_label.get(entity)
        if label is None:
            label = {"id": f"e{abs(hash(entity)) % 100000}", "type": "text",
                     "text": f"**{entity}**", "width": ENTITY_W, "height": 90,
                     "color": "1", "x": body_x, "y": entity_y}
            nodes.append(label)
            entity_label[entity] = label
        label["x"], label["y"] = body_x, entity_y

        row_height = max(row_height, cur_y - entity_y)
        entity_col += 1
        if entity_col >= ENTITY_COLS:
            cur_row_y += row_height + ENTITY_GAP
            row_height = 0
            entity_col = 0

    # 清理重复节点：同一视频只保留布局用到的那一套，删除历史重复副本
    used_text = set()
    used_file = set()
    for _, items in buckets.items():
        for it in items:
            used_text.add(str(it["text"].get("id")))
            if it["file"]:
                used_file.add(str(it["file"].get("id")))

    card_texts = {}
    for t in texts:
        m = LINK_ID.search(t.get("text", "") or "")
        if m:
            card_texts.setdefault(m.group(1), []).append(t)

    remove_ids = set()
    for _, lst in card_texts.items():
        if any(str(t.get("id")) in used_text for t in lst):
            for t in lst:
                if str(t.get("id")) not in used_text:
                    remove_ids.add(str(t.get("id")))

    files_by_link = {}
    for f in files.values():
        stem = str(f.get("file", "")).rsplit("/", 1)[-1]
        m = re.match(r"^(?:douyin|bilibili|xhs)-(.+?)\.[a-zA-Z0-9]+$", stem)
        if m:
            files_by_link.setdefault(m.group(1), []).append(f)
    for _, lst in files_by_link.items():
        if any(str(f.get("id")) in used_file for f in lst):
            for f in lst:
                if str(f.get("id")) not in used_file:
                    remove_ids.add(str(f.get("id")))

    if remove_ids:
        nodes[:] = [n for n in nodes if str(n.get("id")) not in remove_ids]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent="\t"), encoding="utf-8")

    print(json.dumps({
        "status": "ok",
        "out": str(out),
        "nodes": len(nodes),
        "buckets": {f"{k[0]} / {k[1]}": len(v) for k, v in buckets.items() if v},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()