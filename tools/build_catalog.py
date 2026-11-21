#!/usr/bin/env python3
"""从 sources/ 里的脚本生成 LumeBox 官方订阅清单。

产出（全部落在 subscriptions/ 下，路径与 App 的 SubscriptionCatalog 约定一致）：
  comics.txt              漫画板块
  videos.txt              视频板块（含 movie/ 的电影源）
  mixed.txt               综合源（视频板块里 contentCategory 标记为综合的）
  audiobook.txt           听书板块
  all.json                总订阅（comic + video 两板块）
  cdn/*.txt + cdn/all.json  jsDelivr 线路的同内容副本

清单里每一行是一个脚本的 raw 地址；`//` 开头为注释。
"""
from __future__ import annotations

import json
import os
import re
import sys

BASE = "https://raw.githubusercontent.com/kiseding/LumeBox-Sources/main/"
SECTION_ORDER = ["comic", "video"]


def read_header(path: str) -> dict | None:
    """取出脚本首行 `// LumeSource: {...}` 里的元数据。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("//"):
                    m = re.match(r"^//\s*LumeSource:\s*(\{.*\})\s*$", line)
                    if m:
                        try:
                            return json.loads(m.group(1))
                        except json.JSONDecodeError:
                            return None
                    continue
                break
    except OSError:
        return None
    return None


def scan(root: str) -> dict[str, list[tuple[str, dict]]]:
    """按目录收集脚本：{目录名: [(相对路径, 元数据)]}。"""
    buckets: dict[str, list[tuple[str, dict]]] = {}
    skip = {"subscriptions", "archive", "tools"}
    for entry in sorted(os.listdir(root)):
        folder = os.path.join(root, entry)
        if not os.path.isdir(folder) or entry in skip:
            continue
        items: list[tuple[str, dict]] = []
        for name in sorted(os.listdir(folder)):
            full = os.path.join(folder, name)
            if not os.path.isfile(full):
                continue
            if not name.endswith((".js", ".py", ".mjs")):
                continue
            meta = read_header(full) or {}
            items.append((f"{entry}/{name}", meta))
        if items:
            buckets[entry] = items
    return buckets


def url_of(rel: str) -> str:
    return f"{BASE}{rel}"


def write_lines(path: str, header: list[str], urls: list[str]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for line in header:
            fh.write(f"// {line}\n")
        fh.write("\n")
        for url in urls:
            fh.write(url + "\n")


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    subs = os.path.join(root, "subscriptions")
    os.makedirs(subs, exist_ok=True)

    buckets = scan(root)
    counts = {k: len(v) for k, v in buckets.items()}

    comic = [url_of(r) for r, _ in buckets.get("comic", [])]
    # 视频板块：video/ 与 movie/ 同属 App 的 video section
    video = [url_of(r) for r, _ in buckets.get("video", [])]
    movie = [url_of(r) for r, _ in buckets.get("movie", [])]
    audiobook = [url_of(r) for r, _ in buckets.get("audiobook", [])]

    # 综合源：身份头里 contentTypes 声明了两种及以上内容类型的源。
    # 这类源同时保留在所属板块清单里，避免影响旧订阅。
    def is_mixed(meta: dict) -> bool:
        types = meta.get("contentTypes")
        return isinstance(types, list) and len(set(types)) >= 2

    mixed_pairs = [
        (rel, meta)
        for bucket in ("video", "movie", "comic", "photo")
        for rel, meta in buckets.get(bucket, [])
        if is_mixed(meta)
    ]
    mixed = [url_of(rel) for rel, _ in mixed_pairs]

    video_all = video + movie

    write_lines(
        os.path.join(subs, "comics.txt"),
        [f"LumeBox 漫画 源订阅清单（{len(comic)} 个源）",
         "本文件是地址清单，一行一个脚本地址；直接粘本文件的 raw 地址即可一次拉全。"],
        comic,
    )
    write_lines(
        os.path.join(subs, "videos.txt"),
        [f"LumeBox 视频 源订阅清单（{len(video_all)} 个源：video/ {len(video)} + movie/ {len(movie)}）",
         "本文件是地址清单，一行一个脚本地址；直接粘本文件的 raw 地址即可一次拉全。"],
        video_all,
    )
    write_lines(
        os.path.join(subs, "mixed.txt"),
        [f"LumeBox 综合源 订阅清单（{len(mixed)} 个源）",
         "综合源包含多种内容；成人内容仍受 App 隐私设置控制。"],
        mixed,
    )
    write_lines(
        os.path.join(subs, "audiobook.txt"),
        [f"LumeBox 听书 源订阅清单（{len(audiobook)} 个源）",
         "本文件是地址清单，一行一个脚本地址。"],
        audiobook,
    )

    total = {
        "format": "lume.total-subscription",
        "version": 1,
        "sections": {
            "comic": [{"url": f"{BASE}subscriptions/comics.txt", "enabled": True}],
            "video": [{"url": f"{BASE}subscriptions/videos.txt", "enabled": True}],
        },
    }
    with open(os.path.join(subs, "all.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(total, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    # legacy/ 是历史分类清单，App 的 legacyPaths 仍会映射到这些路径。
    # 按 contentCategory 把视频源再分一份，保证旧链接不会 404。
    video_meta = buckets.get("video", []) + buckets.get("movie", [])
    adult = [
        url_of(rel)
        for rel, meta in video_meta
        if str(meta.get("contentCategory", "")).lower() == "adult"
    ]
    hd = [
        url_of(rel)
        for rel, meta in video_meta
        if str(meta.get("contentCategory", "")).lower() in {"movie", "hd"}
    ]
    write_lines(
        os.path.join(subs, "legacy", "videos-hd.txt"),
        [f"LumeBox 高清影视 订阅清单（{len(hd)} 个源，历史分类）"],
        hd,
    )
    write_lines(
        os.path.join(subs, "legacy", "videos-18plus.txt"),
        [f"LumeBox 成人影视 订阅清单（{len(adult)} 个源，历史分类）",
         "18+ 内容；受 App 隐私设置控制。"],
        adult,
    )
    write_lines(
        os.path.join(subs, "legacy", "videos-hd-cdn.txt"),
        [f"LumeBox 高清影视 订阅清单（CDN 线路，{len(hd)} 个源）"],
        hd,
    )
    write_lines(
        os.path.join(subs, "legacy", "videos-18plus-cdn.txt"),
        [f"LumeBox 成人影视 订阅清单（CDN 线路，{len(adult)} 个源）"],
        adult,
    )

    # jsDelivr 线路副本
    write_lines(
        os.path.join(subs, "cdn", "comics.txt"),
        [f"LumeBox 漫画 源订阅清单（CDN 线路，{len(comic)} 个源）",
         "内容与 subscriptions/comics.txt 相同。"],
        comic,
    )
    write_lines(
        os.path.join(subs, "cdn", "videos.txt"),
        [f"LumeBox 视频 源订阅清单（CDN 线路，{len(video_all)} 个源）",
         "内容与 subscriptions/videos.txt 相同。"],
        video_all,
    )
    write_lines(
        os.path.join(subs, "cdn", "mixed.txt"),
        [f"LumeBox 综合源 订阅清单（CDN 线路，{len(mixed)} 个源）"],
        mixed,
    )
    write_lines(
        os.path.join(subs, "cdn", "audiobook.txt"),
        [f"LumeBox 听书 源订阅清单（CDN 线路，{len(audiobook)} 个源）"],
        audiobook,
    )
    with open(os.path.join(subs, "cdn", "all.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(total, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(json.dumps({
        "目录统计": counts,
        "清单": {
            "comics.txt": len(comic),
            "videos.txt": len(video_all),
            "mixed.txt": len(mixed),
            "audiobook.txt": len(audiobook),
            "all.json": 2,
        },
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
