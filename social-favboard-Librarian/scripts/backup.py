#!/usr/bin/env python3
"""把草稿白板备份到工作区，并只保留最近 N 份。

只清理本 skill 为同一个白板生成的旧备份，不碰 vault 里的任何文件。
"""

import argparse
import json
import shutil
import time
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--canvas", required=True)
    ap.add_argument("--out-dir", default=".sf-out")
    ap.add_argument("--keep", type=int, default=10, help="保留最近 N 份备份")
    args = ap.parse_args()

    src = Path(args.canvas)
    if not src.exists():
        print(json.dumps({"status": "error", "message": "canvas 不存在"}, ensure_ascii=False))
        return

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = out_dir / f"{src.stem}.{stamp}{src.suffix}"
    index = 1
    while dst.exists():
        dst = out_dir / f"{src.stem}.{stamp}-{index}{src.suffix}"
        index += 1

    shutil.copy2(src, dst)

    prefix = src.stem + "."
    mine = [p for p in out_dir.glob("*" + src.suffix) if p.name.startswith(prefix)]
    mine.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    removed = []
    for old in mine[args.keep:]:
        try:
            old.unlink()
            removed.append(old.name)
        except Exception:
            pass

    print(json.dumps({
        "status": "ok",
        "source": str(src),
        "backup": str(dst),
        "bytes": dst.stat().st_size,
        "kept": min(len(mine), args.keep),
        "removed_old": removed,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()