"""Runtime binary version inspection helpers."""

from __future__ import annotations

import platform
import subprocess
from functools import lru_cache


def _run_version(cmd: list[str]) -> str:
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        out = (res.stdout or res.stderr or "").strip().splitlines()
        return out[0].strip() if out else "unknown"
    except Exception:
        return "unavailable"


@lru_cache(maxsize=1)
def get_versions() -> dict[str, str]:
    """Return versions of gallery-dl, exiftool, ffmpeg, and Python."""
    return {
        "gallery_dl": _run_version(["gallery-dl", "--version"]),
        "exiftool": _run_version(["exiftool", "-ver"]),
        "ffmpeg": _run_version(["ffmpeg", "-version"]),
        "python": platform.python_version(),
    }
