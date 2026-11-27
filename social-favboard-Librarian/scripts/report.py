#!/usr/bin/env python3
"""整理完成后的统计报告。只读，不修改白板。

输出三段式数据：
1. 已归类：每个分组框的卡片数
2. 未归类：散卡数量
3. 未归类聚类：按关键词归成几个候选概念，便于建议新增
"""

import argparse
import json
import re
import sys
from pathlib import Path

CARD_W = 340
TEXT_H = 176
TAG_RE = re.compile(r"#([^\s#，。,.!?！？、；;：:]+)")

CLUSTERS = {
    "AI 产品 / 项目案例": [
        "vibe", "Vibe", "vibecoding", "独立开发", "独立开发者", "上线", "小程序", "App",
        "AI产品", "AI应用", "AI编程", "Claude", "Codex", "codex", "月流水", "月收",
    ],
    "游戏内容 / 评测": [
        "游戏", "steam", "Steam", "评测", "停服", "抄袭", "联机", "手游", "塞尔达", "我的世界",
        "minecraft", "蛋仔", "率土", "ratgame", "恐怖游戏",
    ],
    "视觉审美 / 风格参考": [
        "审美", "美学", "风格", "画风", "视觉", "梦核", "千禧", "y2k", "海报", "设计",
        "复古", "像素风", "排版", "配色",
    ],
    "教程 / 工具": [
        "教程", "教学", "技巧", "方法", "工作流", "工具", "插件", "开源", "skill", "Skill",
        "提示词", "prompt",
    ],
}


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def num(n, k, d=0):
    try:
        return float(n.get(k, d) or 0)
    except Exception:
        return float(d)


def covers(g, n):
    return (
        num(n, "x") >= num(g, "x")
        and num(n, "y") >= num(g, "y")
        and num(n, "x") + num(n, "width", CARD_W) <= num(g, "x") + num(g, "width")
        and num(n, "y") + num(n, "height", TEXT_H) <= num(g, "y") + num(g, "height")
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--out")
    args = ap.parse_args()

    path = Path(args.canvas)
    if not path.exists():
        print(json.dumps({"status": "error", "message": "canvas 不存在"}, ensure_ascii=False))
        sys.exit(1)

    data = load(path)
    nodes = data.get("nodes") or []
    texts = [n for n in nodes if n.get("type") == "text"]
    groups = sorted(
        [n for n in nodes if n.get("type") == "group"],
        key=lambda g: num(g, "width") * num(g, "height"),
    )

    grouped = {}
    loose = []
    for t in texts:
        body = t.get("text", "") or ""
        if body.lstrip().startswith("SF-SHADOW"):
            continue
        raw = body.strip()
        if raw.startswith("**") and raw.endswith("**") and "\n" not in raw:
            continue
        label = None
        for g in groups:
            if covers(g, t):
                label = g.get("label") or "未命名组"
                break
        if label:
            grouped[label] = grouped.get(label, 0) + 1
        else:
            loose.append({
                "title": next((ln.strip().strip("*") for ln in body.splitlines() if ln.strip()), ""),
                "tags": [m.group(1) for m in TAG_RE.finditer(body)],
                "text": body,
            })

    clusters = {}
    for item in loose:
        blob = " ".join([item["title"]] + item["tags"] + [item["text"]])
        best, score = None, 0
        for name, kws in CLUSTERS.items():
            s = sum(1 for kw in kws if kw in blob)
            if s > score:
                best, score = name, s
        clusters.setdefault(best or "其他 / 生活杂项", []).append(item["title"])

    total = sum(grouped.values()) + len(loose)
    result = {
        "status": "ok",
        "canvas": str(path),
        "total_cards": total,
        "grouped": grouped,
        "grouped_total": sum(grouped.values()),
        "loose_total": len(loose),
        "clusters": [
            {
                "name": name,
                "count": len(items),
                "examples": items[:3],
            }
            for name, items in sorted(clusters.items(), key=lambda kv: -len(kv[1]))
        ],
    }

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(json.dumps({"status": "ok", "out": args.out, "total": total, "loose": len(loose)}, ensure_ascii=False))
    else:
        print(text)


if __name__ == "__main__":
    main()