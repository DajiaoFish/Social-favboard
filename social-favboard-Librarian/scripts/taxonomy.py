#!/usr/bin/env python3
"""概念库（分类类型-灵感体系.md）读写。默认只读；创建或追加需要显式确认参数。"""

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_NAME = "分类类型-灵感体系.md"


def parse_md(text):
    entities = []
    current_entity = None
    current_facet = None
    current_line = None
    for raw in text.splitlines():
        line = raw.rstrip()
        m = re.match(r"^##\s*体[:：]\s*(.+)$", line)
        if m:
            current_entity = {"name": m.group(1).strip(), "description": "", "facets": []}
            entities.append(current_entity)
            current_facet = None
            current_line = None
            continue
        if current_entity is None:
            continue
        m = re.match(r"^描述[:：]\s*(.+)$", line)
        if m:
            current_entity["description"] = m.group(1).strip()
            continue
        m = re.match(r"^-\s*面[:：]\s*(.+)$", line)
        if m:
            current_facet = {"name": m.group(1).strip(), "keywords": [], "lines": [], "samples": []}
            current_entity["facets"].append(current_facet)
            current_line = None
            continue
        if current_facet is None:
            continue
        m = re.match(r"^\s+-\s*线[:：]\s*(.+)$", line)
        if m:
            current_line = {"name": m.group(1).strip(), "samples": []}
            current_facet["lines"].append(current_line)
            continue
        m = re.match(r"^\s+关键词[:：]\s*(.+)$", line)
        if m:
            current_facet["keywords"] = [k.strip() for k in re.split(r"[,，、]", m.group(1)) if k.strip()]
            continue
        m = re.match(r"^\s+样例[:：]\s*(.+)$", line)
        if m:
            if current_line is not None:
                current_line["samples"].append(m.group(1).strip())
            else:
                current_facet["samples"].append(m.group(1).strip())
            continue
    return entities


def render_md(entities):
    out = ["# 分类类型-灵感体系", ""]
    for e in entities:
        out.append(f"## 体：{e['name']}")
        if e.get("description"):
            out.append(f"描述：{e['description']}")
        out.append("")
        for f in e["facets"]:
            out.append(f"- 面：{f['name']}")
            if f.get("keywords"):
                out.append(f"  关键词：{'、'.join(f['keywords'])}")
            for s in f.get("samples", []):
                out.append(f"  样例：{s}")
            for l in f.get("lines", []):
                out.append(f"  - 线：{l['name']}")
                for s in l.get("samples", []):
                    out.append(f"    样例：{s}")
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def load(path):
    if not path.exists():
        return None
    return parse_md(path.read_text(encoding="utf-8"))


def find_entity(entities, name):
    for e in entities:
        if e["name"] == name:
            return e
    return None


def find_facet(entity, name):
    for f in entity.get("facets", []):
        if f["name"] == name:
            return f
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", required=True)
    ap.add_argument("--file", default=DEFAULT_NAME)
    ap.add_argument("--action", default="list",
                    choices=["list", "create", "add-entity", "add-facet", "add-line", "add-sample", "add-keywords"])
    ap.add_argument("--entity")
    ap.add_argument("--facet")
    ap.add_argument("--line")
    ap.add_argument("--value")
    ap.add_argument("--description", default="")
    ap.add_argument("--confirm", action="store_true", help="确认创建或修改")
    args = ap.parse_args()

    path = Path(args.vault) / args.file
    entities = load(path)

    if args.action == "list":
        print(json.dumps({
            "status": "ok",
            "exists": entities is not None,
            "path": str(path),
            "entities": entities or [],
        }, ensure_ascii=False, indent=2))
        return

    if not args.confirm:
        print(json.dumps({
            "status": "need_confirm",
            "message": "该操作会修改概念库，需要用户明确同意后加 --confirm 再执行",
            "path": str(path),
        }, ensure_ascii=False))
        return

    if entities is None:
        if args.action != "create":
            print(json.dumps({
                "status": "not_found",
                "message": "概念库不存在，请先用 create 创建",
                "path": str(path),
            }, ensure_ascii=False))
            return
        entities = []

    if args.action == "create":
        if path.exists():
            print(json.dumps({"status": "exists", "path": str(path)}, ensure_ascii=False))
            return
        path.write_text(render_md(entities), encoding="utf-8")
        print(json.dumps({"status": "created", "path": str(path)}, ensure_ascii=False))
        return

    if not args.entity:
        print(json.dumps({"status": "error", "message": "缺少 --entity"}, ensure_ascii=False))
        return

    entity = find_entity(entities, args.entity)

    if args.action == "add-entity":
        if entity:
            print(json.dumps({"status": "exists", "message": "体已存在"}, ensure_ascii=False))
            return
        entities.append({"name": args.entity, "description": args.description, "facets": []})
        path.write_text(render_md(entities), encoding="utf-8")
        print(json.dumps({"status": "added", "path": str(path)}, ensure_ascii=False))
        return

    if not entity:
        print(json.dumps({"status": "not_found", "message": "体不存在"}, ensure_ascii=False))
        return

    if args.action in ("add-facet", "add-line", "add-keywords", "add-sample") and not args.facet:
        print(json.dumps({"status": "error", "message": "缺少 --facet"}, ensure_ascii=False))
        return

    facet = find_facet(entity, args.facet) if args.facet else None

    if args.action == "add-facet":
        if facet:
            print(json.dumps({"status": "exists", "message": "面已存在"}, ensure_ascii=False))
            return
        entity["facets"].append({"name": args.facet, "keywords": [], "lines": [], "samples": []})
    elif args.action == "add-line":
        if not facet:
            print(json.dumps({"status": "not_found", "message": "面不存在"}, ensure_ascii=False))
            return
        if not args.line:
            print(json.dumps({"status": "error", "message": "缺少 --line"}, ensure_ascii=False))
            return
        if any(l["name"] == args.line for l in facet["lines"]):
            print(json.dumps({"status": "exists", "message": "线已存在"}, ensure_ascii=False))
            return
        facet["lines"].append({"name": args.line, "samples": []})
    elif args.action == "add-keywords":
        if not facet:
            print(json.dumps({"status": "not_found", "message": "面不存在"}, ensure_ascii=False))
            return
        words = [w.strip() for w in re.split(r"[,，、]", args.value or "") if w.strip()]
        for w in words:
            if w not in facet["keywords"]:
                facet["keywords"].append(w)
    elif args.action == "add-sample":
        if not facet:
            print(json.dumps({"status": "not_found", "message": "面不存在"}, ensure_ascii=False))
            return
        target = None
        if args.line:
            target = next((l for l in facet["lines"] if l["name"] == args.line), None)
            if target is None:
                print(json.dumps({"status": "not_found", "message": "线不存在"}, ensure_ascii=False))
                return
        sample = (args.value or "").strip()
        if not sample:
            print(json.dumps({"status": "error", "message": "缺少 --value"}, ensure_ascii=False))
            return
        bucket = target["samples"] if target else facet["samples"]
        if sample in bucket:
            print(json.dumps({"status": "exists"}, ensure_ascii=False))
            return
        bucket.append(sample)

    path.write_text(render_md(entities), encoding="utf-8")
    print(json.dumps({"status": "updated", "path": str(path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()