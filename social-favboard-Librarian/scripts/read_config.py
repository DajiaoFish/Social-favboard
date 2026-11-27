#!/usr/bin/env python3
"""定位草稿白板：从 Obsidian vault 列表找到装了 social-favboard 的 vault，
再读插件 data.json 的 targetCanvas。只读，不修改任何文件。"""

import argparse
import json
import os
import sys
from pathlib import Path

PLUGIN_ID = "social-favboard"
PREF_PATH = Path.home() / ".sf-skill" / "config.json"


def load_pref():
    try:
        if PREF_PATH.exists():
            return json.loads(PREF_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def save_pref(vault):
    try:
        PREF_PATH.parent.mkdir(parents=True, exist_ok=True)
        PREF_PATH.write_text(
            json.dumps({"vault": str(vault)}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


def obsidian_vaults():
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return []
    cfg = Path(appdata) / "obsidian" / "obsidian.json"
    if not cfg.exists():
        return []
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return []
    paths = []
    for item in (data.get("vaults") or {}).values():
        p = item.get("path")
        if p:
            paths.append(p)
    return paths


def resolve(vault_path):
    vault = Path(vault_path)
    plugin_dir = vault / ".obsidian" / "plugins" / PLUGIN_ID
    data_file = plugin_dir / "data.json"
    if not data_file.exists():
        return None
    try:
        data = json.loads(data_file.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"error": f"data.json 解析失败: {exc}"}
    target = (data.get("targetCanvas") or "").strip().replace("\\", "/").lstrip("/")
    entry = {
        "vault": str(vault),
        "plugin_dir": str(plugin_dir),
        "data_file": str(data_file),
        "target_canvas_rel": target,
        "target_canvas": str((vault / target).resolve()) if target else "",
        "auto_write": bool(data.get("autoWrite", False)),
        "classify_mode": data.get("classifyMode", "manual"),
        "skill_mode": data.get("skillMode", "import"),
    }
    return entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", help="vault 绝对路径；省略则自动探测")
    ap.add_argument("--remember", action="store_true", help="把解析成功的 vault 写进偏好")
    args = ap.parse_args()

    pref = load_pref()
    candidates = []
    if args.vault:
        candidates = [args.vault]
    elif pref.get("vault"):
        candidates = [pref["vault"]]

    if not candidates:
        candidates = obsidian_vaults()

    if not candidates:
        print(json.dumps({
            "status": "need_vault",
            "message": "没有找到 Obsidian vault，请提供 vault 绝对路径",
        }, ensure_ascii=False))
        return

    usable = []
    for v in candidates:
        entry = resolve(v)
        if entry and "error" not in entry:
            usable.append(entry)

    if not usable and not args.vault:
        # 偏好失效时回退到全量探测
        for v in obsidian_vaults():
            entry = resolve(v)
            if entry and "error" not in entry:
                usable.append(entry)

    if not usable:
        print(json.dumps({
            "status": "plugin_not_found",
            "message": "这些 vault 里没有找到 social-favboard 插件",
            "vaults": candidates,
        }, ensure_ascii=False))
        return

    if len(usable) > 1 and not args.vault:
        print(json.dumps({
            "status": "need_choice",
            "message": "检测到多个装了插件的 vault，请让用户选一个",
            "vaults": [u["vault"] for u in usable],
        }, ensure_ascii=False))
        return

    entry = usable[0]
    if not entry["target_canvas_rel"]:
        print(json.dumps({
            "status": "need_target",
            "message": "插件已找到，但「默认写入白板」是空的，请让用户在插件设置里填写",
            "vault": entry["vault"],
            "data_file": entry["data_file"],
        }, ensure_ascii=False))
        return

    if not Path(entry["target_canvas"]).exists():
        print(json.dumps({
            "status": "target_not_found",
            "message": "插件配置的白板文件不存在",
            "target_canvas": entry["target_canvas"],
            "target_canvas_rel": entry["target_canvas_rel"],
        }, ensure_ascii=False))
        return

    if args.remember:
        save_pref(entry["vault"])

    entry["status"] = "ok"
    print(json.dumps(entry, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()