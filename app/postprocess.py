#!/usr/bin/env python3
"""Smart ExifTool + mtime postprocessor for gallery-dl downloaded media."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".avif"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".3gp"}


def parse_utc_date(raw: str | None) -> datetime | None:
    """Parse gallery-dl `{date:%Y-%m-%dT%H:%M:%S}` (UTC) into aware UTC datetime."""
    if not raw:
        return None
    val = raw.strip()
    if not val or val.lower() in ("none", "null", "unknown"):
        return None
    for candidate in (val, val.replace("Z", "+00:00")):
        try:
            dt = datetime.fromisoformat(candidate)
            if dt.tzinfo is None:
                return dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError:
            continue
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(val, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def classify_media(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    return "skip"


def _format_local_offset(dt_local: datetime) -> str:
    offset = dt_local.utcoffset()
    if offset is None:
        return "+00:00"
    total_minutes = int(offset.total_seconds() // 60)
    sign = "+" if total_minutes >= 0 else "-"
    total_minutes = abs(total_minutes)
    hh, mm = divmod(total_minutes, 60)
    return f"{sign}{hh:02d}:{mm:02d}"


def build_exiftool_command(
    path: Path,
    dt_utc: datetime,
    kind: str,
    extra_args: list[str] | None = None,
) -> list[str]:
    extras = [a for a in (extra_args or []) if a]
    if kind == "video":
        utc_str = dt_utc.strftime("%Y:%m:%d %H:%M:%S")
        return [
            "exiftool",
            "-overwrite_original",
            "-q",
            "-api",
            "QuickTimeUTC=1",
            f"-MediaCreateDate={utc_str}",
            f"-MediaModifyDate={utc_str}",
            f"-CreateDate={utc_str}",
            f"-ModifyDate={utc_str}",
            f"-TrackCreateDate={utc_str}",
            f"-TrackModifyDate={utc_str}",
            f"-DateTimeOriginal={utc_str}",
            *extras,
            str(path),
        ]

    dt_local = dt_utc.astimezone()
    local_str = dt_local.strftime("%Y:%m:%d %H:%M:%S")
    offset_str = _format_local_offset(dt_local)
    return [
        "exiftool",
        "-overwrite_original",
        "-q",
        f"-DateTimeOriginal={local_str}",
        f"-CreateDate={local_str}",
        f"-ModifyDate={local_str}",
        f"-OffsetTimeOriginal={offset_str}",
        f"-OffsetTimeDigitized={offset_str}",
        f"-OffsetTime={offset_str}",
        *extras,
        str(path),
    ]


def process_file(path: Path, raw_date: str | None, extra_args: list[str] | None = None) -> str:
    """Run exiftool (when applicable) and synchronize file mtime to UTC post date."""
    if not path.is_file():
        print(f"[postprocess][warn] 文件不存在: {path}", flush=True)
        return "warn"

    dt_utc = parse_utc_date(raw_date)
    if dt_utc is None:
        print(
            f"[postprocess][skip] 缺少有效日期 (收到 {raw_date!r}，请检查该站点的日期字段模板，可用 -K 查看站点可用字段): {path}",
            flush=True,
        )
        return "skip"

    kind = classify_media(path)
    status = "skip"
    if kind in ("image", "video"):
        cmd = build_exiftool_command(path, dt_utc, kind, extra_args=extra_args)
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
            if res.returncode == 0:
                status = "ok"
                print(f"[postprocess][ok] exiftool ({kind}) {path}", flush=True)
            else:
                status = "warn"
                msg = (res.stderr or res.stdout or f"exit={res.returncode}").strip().splitlines()[0]
                print(f"[postprocess][warn] exiftool 写入失败 ({msg}): {path}", flush=True)
        except Exception as exc:
            status = "warn"
            print(f"[postprocess][warn] exiftool 执行异常 ({exc}): {path}", flush=True)
    else:
        print(f"[postprocess][skip] 跳过非 EXIF 格式，仅同步 mtime: {path}", flush=True)

    try:
        ts = dt_utc.timestamp()
        os.utime(path, (ts, ts))
    except Exception as exc:
        print(f"[postprocess][warn] 同步 mtime 失败 ({exc}): {path}", flush=True)
        return "warn"

    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="gallery-dl-manager postprocessor")
    parser.add_argument("--date", default="", help="Post timestamp in UTC ISO format")
    parser.add_argument("--extra-arg", action="append", default=[], help="Extra exiftool CLI argument")
    parser.add_argument("--path", required=True, help="Target downloaded file path")
    args = parser.parse_args(argv)
    process_file(Path(args.path), args.date, extra_args=args.extra_arg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
