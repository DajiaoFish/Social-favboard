#!/usr/bin/env python3
"""规范化白板：同一视频只保留一套卡，并强制图片对齐到文字上方。只写工作区文件。"""

import argparse
import json
import re
import sys
import uuid
from pathlib import Path

LINK_ID = re.compile(
    r"(?:douyin\.com/video/|bilibili\.com/video/|xiaohongshu\.com/(?:explore|discovery/item)/)([0-9A-Za-z]+)"
)
CARD_MARKS = ["打开原视频", "打开原帖", "在小红书搜索"]


def num(n, k, d=0):
    return float(n.get(k, d) or d)


def covers(g, n):
    return (
        num(n, "x") >= num(g, "x")
        and num(n, "y") >= num(g, "y")
        and num(n, "x") + num(n, "width", 340) <= num(g, "x") + num(g, "width")
        and num(n, "y") + num(n, "height", 176) <= num(g, "y") + num(g, "height")
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--cover-dir", help="vault 下 video-covers 的绝对路径，用于补缺失封面节点")
    args = ap.parse_args()

    path = Path(args.canvas)
    if not path.exists():
        print(json.dumps({"status": "error", "message": "canvas 不存在"}, ensure_ascii=False))
        sys.exit(1)

    data = json.loads(path.read_text(encoding="utf-8"))
    nodes = data["nodes"]
    groups = [n for n in nodes if n.get("type") == "group"]
    texts = [n for n in nodes if n.get("type") == "text"]
    files = [n for n in nodes if n.get("type") == "file"]

    card_texts = {}
    for t in texts:
        body = t.get("text", "") or ""
        if t.get("text", "").lstrip().startswith("SF-SHADOW"):
            continue
        if not any(m in body for m in CARD_MARKS):
            continue
        m = LINK_ID.search(body)
        if m:
            card_texts.setdefault(m.group(1), []).append(t)

    files_by_id = {}
    for f in files:
        stem = str(f.get("file", "")).rsplit("/", 1)[-1]
        m = re.match(r"^(?:douyin|bilibili|xhs)-(.+?)\.[a-zA-Z0-9]+$", stem)
        if m:
            files_by_id.setdefault(m.group(1), []).append(f)

    remove = set()
    aligned = 0
    kept_cards = 0
    pending = []
    added = 0

    for cid, tl in card_texts.items():
        inside = [t for t in tl if any(covers(g, t) for g in groups)]
        keep = inside[0] if inside else tl[0]
        kept_cards += 1
        for t in tl:
            if t is not keep:
                remove.add(str(t.get("id")))
        fl = files_by_id.get(cid) or []
        if fl:
            fl.sort(key=lambda f: abs(num(f, "x") - num(keep, "x")))
            kf = fl[0]
            kf["x"] = num(keep, "x")
            kf["y"] = num(keep, "y") - num(kf, "height", 453) - 10
            aligned += 1
            for f in fl:
                if f is not kf:
                    remove.add(str(f.get("id")))
        else:
            pending.append((cid, keep))

    if args.cover_dir:
        cover_dir = Path(args.cover_dir)
        for cid, keep in pending:
            cands = list(cover_dir.glob(f"*{cid}*"))
            if not cands:
                continue
            nodes.append({
                "id": uuid.uuid4().hex[:16],
                "type": "file",
                "file": "video-covers/" + cands[0].name,
                "x": num(keep, "x"),
                "y": num(keep, "y") - 453 - 10,
                "width": 340,
                "height": 453,
            })
            added += 1

    if remove:
        nodes[:] = [n for n in nodes if str(n.get("id")) not in remove]

    path.write_text(json.dumps(data, ensure_ascii=False, indent="\t"), encoding="utf-8")
    print(json.dumps({
        "status": "ok",
        "kept_cards": kept_cards,
        "aligned": aligned,
        "removed_nodes": len(remove),
        "nodes_after": len(nodes),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()