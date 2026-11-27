#!/usr/bin/env python3
"""根据布局方案生成"局部修改补丁清单"。只读，不写白板。

输出内容供 Agent 用 edit 工具逐条应用：
- coordinate_patches: 每个节点的 old/new 坐标片段，附唯一性计数
- insert_anchor: 在 nodes 数组末尾插入新节点的锚点
- add_node_lines: 新节点行（已带缩进）

任何一处 count != 1 都会标记为 conflict，Agent 必须停下来询问，不能强行改。
"""

import argparse
import json
import sys
from pathlib import Path


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def as_int(value):
    return int(float(value))


def coord_key(node):
    return f'"x":{as_int(node["x"])},"y":{as_int(node["y"])}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--plan", required=True, help="layout.py 输出的 plan2")
    ap.add_argument("--out", help="输出文件，省略则打印")
    args = ap.parse_args()

    canvas_path = Path(args.canvas)
    if not canvas_path.exists():
        print(json.dumps({"status": "error", "message": "canvas 不存在"}, ensure_ascii=False))
        sys.exit(1)

    raw = canvas_path.read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except Exception as exc:
        print(json.dumps({"status": "error", "message": f"canvas JSON 解析失败: {exc}"}, ensure_ascii=False))
        sys.exit(1)

    node_map = {str(n.get("id")): n for n in (data.get("nodes") or [])}
    plan = load_json(args.plan)

    patches = []
    errors = []

    for mv in plan.get("moves") or []:
        pairs = [
            ("text", mv.get("card_id"), mv.get("text_x"), mv.get("text_y")),
            ("file", mv.get("file_id"), mv.get("file_x"), mv.get("file_y")),
        ]
        for role, node_id, nx, ny in pairs:
            if not node_id or nx is None or ny is None:
                continue
            node = node_map.get(str(node_id))
            if not node:
                errors.append(f"missing {role} node {node_id}")
                continue
            old = coord_key(node)
            new = f'"x":{as_int(nx)},"y":{as_int(ny)}'
            count = raw.count(old)
            patches.append({
                "role": role,
                "node_id": str(node_id),
                "old": old,
                "new": new,
                "count": count,
                "safe": count == 1,
            })
            if count != 1:
                errors.append(f"{role} {node_id} coordinate fragment count={count}")

    add_nodes = plan.get("add_nodes") or []
    add_lines = ["\t\t" + json.dumps(n, ensure_ascii=False, separators=(",", ":")) for n in add_nodes]

    anchor_old = '}\n\t],\n\t"edges":['
    anchor_count = raw.count(anchor_old)
    if add_lines:
        anchor_new = "},\n" + ",\n".join(add_lines) + '\n\t],\n\t"edges":['
    else:
        anchor_new = anchor_old
    if anchor_count != 1:
        errors.append(f"insert anchor count={anchor_count}")

    result = {
        "status": "ok" if not errors else "conflict",
        "canvas": str(canvas_path),
        "coordinate_patches": patches,
        "insert_anchor": {
            "old": anchor_old,
            "new": anchor_new,
            "count": anchor_count,
            "safe": anchor_count == 1,
        },
        "add_node_lines": add_lines,
        "errors": errors,
        "instruction": "Agent 必须用 edit 工具逐条替换 coordinate_patches，再应用 insert_anchor；全部成功后运行 verify.py。",
    }

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(json.dumps({"status": result["status"], "out": args.out, "patches": len(patches), "errors": len(errors)}, ensure_ascii=False))
    else:
        print(text)


if __name__ == "__main__":
    main()