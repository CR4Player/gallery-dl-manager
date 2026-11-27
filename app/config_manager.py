"""Configuration management, legacy import, cookie parsing, redaction, and runtime config synthesis."""

from __future__ import annotations

import copy
import json
import os
import re
import shlex
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from app.db import Database, get_data_dir, utc_now_iso

POSTPROCESS_MARKER = "/app/app/postprocess.py"
DEFAULT_DATE_TEMPLATE = "{date:%Y-%m-%dT%H:%M:%S}"

LEGACY_SEED_TASKS = [
    {
        "name": "Bluesky 点赞",
        "urls": ["https://bsky.app/profile/example.bsky.social"],
        "cron_expr": "0 */6 * * *",
    },
    {
        "name": "Rule34 收藏",
        "urls": ["https://rule34.xxx/index.php?page=favorites&s=view&id=123456"],
        "cron_expr": "0 */6 * * *",
    },
    {
        "name": "Twitter 点赞",
        "urls": ["https://x.com/example/likes"],
        "cron_expr": "0 */6 * * *",
    },
]

DEFAULT_GLOBAL_SETTINGS = {
    "global_proxy": "",
    "max_concurrency": 1,
    "log_retention_days": 30,
    "postprocess_default_sites": ["twitter"],
    "scheduler_paused": False,
}

SENSITIVE_KEYS = {
    "password",
    "api-key",
    "api_key",
    "token",
    "access-token",
    "refresh-token",
    "client-secret",
    "secret",
    "auth_token",
    "ct0",
    "session_id",
    "kdt",
    "fanboxsessid",
}


def get_download_dir() -> Path:
    return Path(os.environ.get("DOWNLOAD_DIR", "/gallery-dl"))


def get_legacy_conf_path() -> Path:
    return Path(os.environ.get("LEGACY_CONF_PATH", "/config/legacy-gallery-dl.conf"))


def get_inputs_dir() -> Path:
    p = get_data_dir() / "inputs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def validate_input_filename(name: str) -> str:
    """Validate single-segment .txt filename inside /data/inputs."""
    cleaned = name.strip()
    if not cleaned:
        raise ValueError("输入文件名不能为空")
    if "/" in cleaned or "\\" in cleaned or ".." in cleaned:
        raise ValueError("输入文件名不能包含路径分隔符或 '..'")
    if not cleaned.lower().endswith(".txt"):
        cleaned += ".txt"
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.txt", cleaned):
        raise ValueError("输入文件名仅允许字母、数字、点、下划线和连字符")
    return cleaned


def count_valid_urls(text: str) -> int:
    return sum(1 for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#"))


def list_input_files() -> list[dict[str, Any]]:
    inputs_dir = get_inputs_dir()
    items: list[dict[str, Any]] = []
    for p in sorted(inputs_dir.glob("*.txt"), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_file():
            continue
        st = p.stat()
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
            url_count = count_valid_urls(text)
        except Exception:
            url_count = 0
        items.append(
            {
                "name": p.name,
                "size": st.st_size,
                "url_count": url_count,
                "updated_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
            }
        )
    return items


def save_input_file(filename: str, content: str) -> dict[str, Any]:
    safe_name = validate_input_filename(filename)
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if normalized and not normalized.endswith("\n"):
        normalized += "\n"
    if count_valid_urls(normalized) == 0:
        raise ValueError("输入文件内容中没有有效 URL")
    target = get_inputs_dir() / safe_name
    target.write_text(normalized, encoding="utf-8")
    st = target.stat()
    return {
        "name": safe_name,
        "size": st.st_size,
        "url_count": count_valid_urls(normalized),
        "updated_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
    }


def delete_input_file(filename: str) -> bool:
    safe_name = validate_input_filename(filename)
    target = get_inputs_dir() / safe_name
    if not target.is_file():
        return False
    target.unlink()
    return True


def _is_windows_legacy_postprocessor(pp: Any) -> bool:
    if not isinstance(pp, dict):
        return False
    cmd = pp.get("command")
    if isinstance(cmd, list) and cmd:
        first = str(cmd[0]).lower()
        return first.endswith(".exe") or "powershell" in first or "pwsh" in first or first == "cmd"
    if isinstance(cmd, str):
        low = cmd.lower()
        return ".exe" in low or "powershell" in low
    return False


def _is_managed_postprocessor(pp: Any) -> bool:
    if not isinstance(pp, dict):
        return False
    cmd = pp.get("command")
    if isinstance(cmd, list):
        return any(POSTPROCESS_MARKER in str(part) for part in cmd)
    if isinstance(cmd, str):
        return POSTPROCESS_MARKER in cmd
    return False


def build_postprocessor_spec(
    mode: str = "builtin",
    date_template: str = "",
    extra_args: str = "",
    custom_command: str = "",
) -> dict[str, Any]:
    """Build a gallery-dl exec postprocessor dict for builtin or custom mode."""
    if mode == "custom":
        raw = custom_command.strip()
        if not raw:
            raise ValueError("自定义后处理指令不能为空")
        if raw.startswith("["):
            try:
                parsed = json.loads(raw)
                if not isinstance(parsed, list) or not parsed:
                    raise ValueError("JSON 指令必须是非空字符串数组")
                cmd = [str(x) for x in parsed]
            except json.JSONDecodeError as exc:
                raise ValueError(f"JSON 指令解析失败: {exc}") from exc
        else:
            try:
                cmd = shlex.split(raw)
            except ValueError as exc:
                raise ValueError(f"指令引号格式有误: {exc}") from exc
        if not cmd:
            raise ValueError("自定义后处理指令不能为空")
        return {"name": "exec", "on": "file", "command": cmd}

    tpl = date_template.strip() or DEFAULT_DATE_TEMPLATE
    cmd = ["python3", POSTPROCESS_MARKER, "--date", tpl]
    if extra_args.strip():
        try:
            tokens = shlex.split(extra_args.strip())
        except ValueError as exc:
            raise ValueError(f"额外 ExifTool 参数引号格式有误: {exc}") from exc
        for tok in tokens:
            cmd.extend(["--extra-arg", tok])
    cmd.extend(["--path", "{_path}"])
    return {"name": "exec", "on": "file", "command": cmd}


def make_postprocessor_entry(date_template: str = "", extra_args: str = "") -> dict[str, Any]:
    return build_postprocessor_spec(mode="builtin", date_template=date_template, extra_args=extra_args)


def describe_postprocess_preview(
    mode: str = "builtin",
    date_template: str = "",
    extra_args: str = "",
    custom_command: str = "",
) -> dict[str, str]:
    """Return human-readable preview of the exact exec and exiftool commands."""
    if mode == "disabled":
        return {"mode": "disabled", "exec_command": "(已禁用)", "exiftool_image_cmd": "", "exiftool_video_cmd": ""}
    try:
        spec = build_postprocessor_spec(mode=mode, date_template=date_template, extra_args=extra_args, custom_command=custom_command)
        exec_cmd = " ".join(shlex.quote(str(x)) for x in spec["command"])
    except ValueError as exc:
        return {"mode": mode, "exec_command": f"(配置无效: {exc})", "exiftool_image_cmd": "", "exiftool_video_cmd": ""}

    if mode == "custom":
        return {"mode": "custom", "exec_command": exec_cmd, "exiftool_image_cmd": "", "exiftool_video_cmd": ""}

    extra_part = f"{extra_args.strip()} " if extra_args.strip() else ""
    img_cmd = (
        "exiftool -overwrite_original -q "
        "-DateTimeOriginal=<本地时间> -CreateDate=<本地时间> -ModifyDate=<本地时间> "
        "-OffsetTimeOriginal=<±HH:MM> -OffsetTimeDigitized=<±HH:MM> -OffsetTime=<±HH:MM> "
        f"{extra_part}{{_path}}"
    )
    vid_cmd = (
        "exiftool -overwrite_original -q -api QuickTimeUTC=1 "
        "-MediaCreateDate=<UTC时间> -MediaModifyDate=<UTC时间> "
        "-CreateDate=<UTC时间> -ModifyDate=<UTC时间> "
        "-TrackCreateDate=<UTC时间> -TrackModifyDate=<UTC时间> "
        "-DateTimeOriginal=<UTC时间> "
        f"{extra_part}{{_path}}"
    )
    return {
        "mode": "builtin",
        "exec_command": exec_cmd,
        "exiftool_image_cmd": img_cmd,
        "exiftool_video_cmd": vid_cmd,
    }


def normalize_base_config(conf: dict[str, Any]) -> dict[str, Any]:
    """Normalize a gallery-dl config dict for containerized Linux execution."""
    cleaned = copy.deepcopy(conf if isinstance(conf, dict) else {})
    extractor = cleaned.setdefault("extractor", {})
    if not isinstance(extractor, dict):
        extractor = {}
        cleaned["extractor"] = extractor

    extractor["base-directory"] = str(get_download_dir())

    for key, val in list(extractor.items()):
        if isinstance(val, dict) and isinstance(val.get("postprocessors"), list):
            kept = [
                pp for pp in val["postprocessors"]
                if not _is_windows_legacy_postprocessor(pp) and not _is_managed_postprocessor(pp)
            ]
            if kept:
                val["postprocessors"] = kept
            else:
                val.pop("postprocessors", None)

    output = cleaned.setdefault("output", {})
    if isinstance(output, dict):
        output["mode"] = "pipe"
        output["shorten"] = False
        output["progress"] = False

    return cleaned


def load_global_config(db: Database) -> dict[str, Any]:
    raw = db.get_setting("global_config_json")
    if not raw:
        return {"extractor": {"base-directory": str(get_download_dir())}, "output": {"mode": "pipe", "shorten": False}}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def save_global_config(db: Database, conf: dict[str, Any], note: str = "更新配置") -> int:
    normalized = normalize_base_config(conf)
    text = json.dumps(normalized, ensure_ascii=False, indent=2)
    db.set_setting("global_config_json", text)
    now = utc_now_iso()
    with db.session() as conn:
        cur = conn.execute(
            "INSERT INTO config_snapshots (created_at, note, config_json) VALUES (?, ?, ?)",
            (now, note, text),
        )
        snap_id = int(cur.lastrowid)
        # Keep latest 30 snapshots
        conn.execute(
            """
            DELETE FROM config_snapshots
            WHERE id NOT IN (SELECT id FROM config_snapshots ORDER BY id DESC LIMIT 30)
            """
        )
    return snap_id


def _normalize_site_pp_cfg(raw: Any, enabled_default: bool = False) -> dict[str, Any]:
    d = raw if isinstance(raw, dict) else {}
    mode = str(d.get("mode", "builtin"))
    if mode not in ("builtin", "custom"):
        mode = "builtin"
    return {
        "enabled": bool(d.get("enabled", enabled_default)),
        "mode": mode,
        "date_template": str(d.get("date_template", DEFAULT_DATE_TEMPLATE) or DEFAULT_DATE_TEMPLATE).strip(),
        "extra_args": str(d.get("extra_args", "") or "").strip(),
        "custom_command": str(d.get("custom_command", "") or "").strip(),
    }


def get_postprocess_site_configs(db: Database, default_sites: list[str] | None = None) -> dict[str, dict[str, Any]]:
    raw = db.get_setting("postprocess_site_configs")
    parsed: dict[str, Any] = {}
    if raw:
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                parsed = obj
        except json.JSONDecodeError:
            parsed = {}
    sites_list = default_sites if default_sites is not None else ["twitter"]
    out: dict[str, dict[str, Any]] = {}
    for k, v in parsed.items():
        key = str(k).strip()
        if key:
            out[key] = _normalize_site_pp_cfg(v)
    if not out:
        for s in sites_list:
            out[s] = _normalize_site_pp_cfg({}, enabled_default=True)
    return out


def save_postprocess_site_configs(db: Database, configs: dict[str, dict[str, Any]]) -> None:
    cleaned = {str(k).strip(): _normalize_site_pp_cfg(v) for k, v in configs.items() if str(k).strip()}
    db.set_setting("postprocess_site_configs", json.dumps(cleaned, ensure_ascii=False))
    enabled_sites = sorted([k for k, v in cleaned.items() if v.get("enabled")])
    db.set_setting("postprocess_default_sites", json.dumps(enabled_sites))


def get_app_settings(db: Database) -> dict[str, Any]:
    result = dict(DEFAULT_GLOBAL_SETTINGS)
    proxy = db.get_setting("global_proxy")
    if proxy is not None:
        result["global_proxy"] = proxy
    conc = db.get_setting("max_concurrency")
    if conc is not None:
        try:
            result["max_concurrency"] = max(1, min(3, int(conc)))
        except ValueError:
            pass
    ret = db.get_setting("log_retention_days")
    if ret is not None:
        try:
            result["log_retention_days"] = max(1, min(365, int(ret)))
        except ValueError:
            pass
    sites_raw = db.get_setting("postprocess_default_sites")
    if sites_raw is not None:
        try:
            parsed = json.loads(sites_raw)
            if isinstance(parsed, list):
                result["postprocess_default_sites"] = [str(x).strip() for x in parsed if str(x).strip()]
        except json.JSONDecodeError:
            pass
    site_cfgs = get_postprocess_site_configs(db, result["postprocess_default_sites"])
    result["postprocess_site_configs"] = site_cfgs
    result["postprocess_default_sites"] = sorted([k for k, v in site_cfgs.items() if v.get("enabled")])
    paused = db.get_setting("scheduler_paused")
    if paused is not None:
        result["scheduler_paused"] = paused == "1"
    return result


def import_legacy_if_needed(
    db: Database,
    legacy_path: Path | None = None,
    import_tasks_enabled: bool | None = None,
) -> bool:
    """Import legacy gallery-dl.conf and seed the 3 existing scheduled tasks once."""
    if db.get_setting("legacy_imported") == "1":
        return False

    if import_tasks_enabled is None:
        import_tasks_enabled = os.environ.get("IMPORT_TASKS_ENABLED", "false").strip().lower() == "true"

    path = legacy_path if legacy_path is not None else get_legacy_conf_path()
    imported_any = False

    if path.is_file():
        with path.open("r", encoding="utf-8") as f:
            raw_conf = json.load(f)
        proxy = ""
        if isinstance(raw_conf, dict) and isinstance(raw_conf.get("extractor"), dict):
            proxy = str(raw_conf["extractor"].get("proxy") or "").strip()
            raw_conf["extractor"].pop("proxy", None)
        if proxy:
            db.set_setting("global_proxy", proxy)
        save_global_config(db, raw_conf, note="首次启动从 legacy gallery-dl.conf 导入")
        imported_any = True
    elif not db.get_setting("global_config_json"):
        save_global_config(db, {}, note="初始化默认配置")

    if not db.get_setting("postprocess_default_sites"):
        db.set_setting("postprocess_default_sites", json.dumps(["twitter"]))
    if not db.get_setting("max_concurrency"):
        db.set_setting("max_concurrency", "1")
    if not db.get_setting("log_retention_days"):
        db.set_setting("log_retention_days", "30")

    with db.session() as conn:
        existing_count = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        if existing_count == 0:
            now = utc_now_iso()
            enabled_val = 1 if import_tasks_enabled else 0
            for item in LEGACY_SEED_TASKS:
                conn.execute(
                    """
                    INSERT INTO tasks (
                        name, urls_json, enabled, cron_expr, proxy_mode, proxy_url,
                        subdir, skip_mode, extra_args, use_archive, postprocess_mode,
                        notes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'inherit', '', '', '', '', 0, 'inherit', ?, ?, ?)
                    """,
                    (
                        item["name"],
                        json.dumps(item["urls"], ensure_ascii=False),
                        enabled_val,
                        item["cron_expr"],
                        "从原 gallery-dl 容器自动导入",
                        now,
                        now,
                    ),
                )

    db.set_setting("legacy_imported", "1")
    if not import_tasks_enabled:
        db.set_setting("legacy_import_notice", "1")
    return imported_any


def parse_cookies_input(text: str) -> dict[str, str]:
    """Parse JSON dict, EditThisCookie JSON array, Netscape cookies.txt, or Cookie header string."""
    stripped = text.strip()
    if not stripped:
        return {}

    # 1. JSON dict or array of {name, value}
    if stripped[0] in "{[":
        try:
            data = json.loads(stripped)
            if isinstance(data, dict):
                return {str(k): str(v) for k, v in data.items() if str(k).strip()}
            if isinstance(data, list):
                out: dict[str, str] = {}
                for item in data:
                    if isinstance(item, dict) and "name" in item and "value" in item:
                        name = str(item["name"]).strip()
                        if name:
                            out[name] = str(item["value"])
                if out:
                    return out
        except json.JSONDecodeError:
            pass

    # 2. Netscape cookies.txt lines (7 tab-separated columns)
    netscape_out: dict[str, str] = {}
    lines = stripped.splitlines()
    found_tab = False
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 7:
            found_tab = True
            name = parts[5].strip()
            value = parts[6]
            if name:
                netscape_out[name] = value
    if found_tab and netscape_out:
        return netscape_out

    # 3. Raw Cookie header string: k1=v1; k2=v2
    if "=" in stripped:
        header_out: dict[str, str] = {}
        # Split on semicolon or newline
        for chunk in re.split(r"[;\r\n]+", stripped):
            part = chunk.strip()
            if not part or "=" not in part:
                continue
            k, v = part.split("=", 1)
            k = k.strip()
            if k:
                header_out[k] = v.strip()
        if header_out:
            return header_out

    raise ValueError("无法识别 Cookie 格式：请粘贴 JSON 对象、浏览器导出的 JSON 数组、Netscape cookies.txt 或 key=value 字符串")


def _mask_value(val: str) -> str:
    s = str(val)
    if len(s) <= 6:
        return "*" * len(s)
    return f"{s[:3]}...{s[-3:]}"


def extract_secret_values(conf: dict[str, Any], extra_secrets: list[str] | None = None) -> list[str]:
    """Collect sensitive secret strings (len >= 8) from config for log redaction."""
    secrets_found: set[str] = set()

    def walk(node: Any, parent_key: str = "") -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                lk = str(k).lower()
                if lk == "cookies" and isinstance(v, dict):
                    for ck, cv in v.items():
                        sv = str(cv)
                        if len(sv) >= 8:
                            secrets_found.add(sv)
                elif lk in SENSITIVE_KEYS or parent_key == "cookies":
                    if isinstance(v, (str, int)) and len(str(v)) >= 6:
                        secrets_found.add(str(v))
                else:
                    walk(v, lk)
        elif isinstance(node, list):
            for item in node:
                walk(item, parent_key)

    walk(conf)
    if extra_secrets:
        for s in extra_secrets:
            if s and len(s) >= 6:
                secrets_found.add(s)
    return sorted(secrets_found, key=len, reverse=True)


def redact_text(text: str, secret_values: list[str]) -> str:
    out = text
    for s in secret_values:
        if s and s in out:
            out = out.replace(s, "[REDACTED]")
    return out


def summarize_sites(
    conf: dict[str, Any],
    postprocess_default_sites: list[str],
    postprocess_site_configs: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build masked site configuration summary for UI."""
    extractor = conf.get("extractor", {})
    if not isinstance(extractor, dict):
        return []
    site_cfgs = postprocess_site_configs or {}
    summaries = []
    for key, val in extractor.items():
        if not isinstance(val, dict):
            continue
        cookies = val.get("cookies") if isinstance(val.get("cookies"), dict) else {}
        auth_fields = []
        for field in ("username", "password", "api-key", "user-id", "browser", "user-agent"):
            if field in val and val[field] not in (None, ""):
                if field in ("password", "api-key"):
                    auth_fields.append({"key": field, "masked": _mask_value(str(val[field]))})
                else:
                    auth_fields.append({"key": field, "masked": str(val[field])})
        pp_cfg = _normalize_site_pp_cfg(site_cfgs.get(key), enabled_default=(key in postprocess_default_sites))
        if key in postprocess_default_sites:
            pp_cfg["enabled"] = True
        pp_preview = (
            describe_postprocess_preview(
                mode=pp_cfg["mode"],
                date_template=pp_cfg["date_template"],
                extra_args=pp_cfg["extra_args"],
                custom_command=pp_cfg["custom_command"],
            )
            if pp_cfg["enabled"]
            else describe_postprocess_preview(mode="disabled")
        )
        summaries.append(
            {
                "site": key,
                "cookie_count": len(cookies),
                "cookie_keys": list(cookies.keys()),
                "auth_fields": auth_fields,
                "skip": val.get("skip", ""),
                "filename": val.get("filename", ""),
                "postprocess_enabled": pp_cfg["enabled"],
                "postprocess_config": pp_cfg,
                "postprocess_preview": pp_preview,
            }
        )
    return summaries


def validate_safe_subdir(subdir: str) -> str:
    """Validate optional relative subdirectory under /gallery-dl, preventing traversal."""
    cleaned = subdir.strip().replace("\\", "/").strip("/")
    if not cleaned:
        return ""
    if cleaned.startswith("/") or ":" in cleaned:
        raise ValueError("子目录必须是相对路径")
    parts = PurePosixPath(cleaned).parts
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError("子目录不能包含 '..' 或非法路径段")
    return "/".join(parts)


def synthesize_runtime_config(
    base_config: dict[str, Any],
    *,
    global_proxy: str = "",
    proxy_mode: str = "inherit",
    proxy_url: str = "",
    subdir: str = "",
    skip_mode: str = "",
    filename_format: str = "",
    use_archive: bool = False,
    archive_backfill: bool = False,
    archive_path: str = "",
    postprocess_mode: str = "inherit",
    postprocess_date_field: str = "",
    postprocess_command: str = "",
    postprocess_default_sites: list[str] | None = None,
    postprocess_site_configs: dict[str, dict[str, Any]] | None = None,
    download_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Build per-run gallery-dl JSON config without mutating the stored base config."""
    conf = normalize_base_config(base_config)
    extractor = conf.setdefault("extractor", {})

    base_dir = Path(download_dir) if download_dir is not None else get_download_dir()
    safe_sub = validate_safe_subdir(subdir)
    target_dir = base_dir / safe_sub if safe_sub else base_dir
    extractor["base-directory"] = str(target_dir)

    # Proxy resolution
    effective_proxy = ""
    if proxy_mode == "direct":
        effective_proxy = ""
    elif proxy_mode == "custom":
        effective_proxy = proxy_url.strip()
    else:  # inherit
        effective_proxy = global_proxy.strip()

    if effective_proxy:
        extractor["proxy"] = effective_proxy
    else:
        extractor.pop("proxy", None)

    if skip_mode.strip():
        raw_skip = skip_mode.strip().lower()
        if raw_skip == "true":
            extractor["skip"] = True
        elif raw_skip == "false":
            extractor["skip"] = False
        else:
            extractor["skip"] = skip_mode.strip()
        # Task-level skip override must not be shadowed by site-level skip
        for k, v in extractor.items():
            if isinstance(v, dict):
                v.pop("skip", None)

    if filename_format.strip():
        extractor["filename"] = filename_format.strip()
        # Task-level filename override must not be shadowed by site-level filename
        for k, v in extractor.items():
            if isinstance(v, dict):
                v.pop("filename", None)

    if use_archive and archive_path:
        extractor["archive"] = archive_path
        if archive_backfill:
            extractor["archive-event"] = ["file", "skip"]
        else:
            extractor.pop("archive-event", None)
    else:
        extractor.pop("archive", None)
        extractor.pop("archive-event", None)

    # Remove any pre-existing managed postprocessor before applying mode
    if isinstance(extractor.get("postprocessors"), list):
        extractor["postprocessors"] = [
            pp for pp in extractor["postprocessors"] if not _is_managed_postprocessor(pp)
        ]
        if not extractor["postprocessors"]:
            extractor.pop("postprocessors", None)

    for k, v in list(extractor.items()):
        if isinstance(v, dict) and isinstance(v.get("postprocessors"), list):
            v["postprocessors"] = [
                pp for pp in v["postprocessors"] if not _is_managed_postprocessor(pp)
            ]
            if not v["postprocessors"]:
                v.pop("postprocessors", None)

    if postprocess_mode == "enabled":
        pp_entry = build_postprocessor_spec(mode="builtin", date_template=postprocess_date_field)
        pps = extractor.setdefault("postprocessors", [])
        if isinstance(pps, list):
            pps.append(pp_entry)
    elif postprocess_mode == "custom":
        pp_entry = build_postprocessor_spec(mode="custom", custom_command=postprocess_command)
        pps = extractor.setdefault("postprocessors", [])
        if isinstance(pps, list):
            pps.append(pp_entry)
    elif postprocess_mode == "inherit":
        site_map: dict[str, dict[str, Any]] = {}
        if postprocess_site_configs:
            for site, cfg in postprocess_site_configs.items():
                ncfg = _normalize_site_pp_cfg(cfg)
                if ncfg["enabled"]:
                    site_map[site] = ncfg
        else:
            for site in postprocess_default_sites or []:
                site_map[site] = _normalize_site_pp_cfg({}, enabled_default=True)

        for site, ncfg in site_map.items():
            site_cfg = extractor.setdefault(site, {})
            if isinstance(site_cfg, dict):
                pp_entry = build_postprocessor_spec(
                    mode=ncfg["mode"],
                    date_template=ncfg["date_template"],
                    extra_args=ncfg["extra_args"],
                    custom_command=ncfg["custom_command"],
                )
                pps = site_cfg.setdefault("postprocessors", [])
                if isinstance(pps, list):
                    pps.append(pp_entry)

    return conf
