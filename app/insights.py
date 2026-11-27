"""Insights, inheritance resolution, site health aggregation, and metadata probe parsing."""

from __future__ import annotations

import copy
import json
import re
import shlex
import urllib.parse
from typing import Any

from app.config_manager import (
    DEFAULT_DATE_TEMPLATE,
    _normalize_site_pp_cfg,
    count_valid_urls,
    describe_postprocess_preview,
    extract_secret_values,
    get_app_settings,
    get_download_dir,
    get_inputs_dir,
    load_global_config,
    redact_text,
    summarize_sites,
    synthesize_runtime_config,
    validate_input_filename,
)
from app.db import Database, get_data_dir

SITE_DOMAINS: dict[str, list[str]] = {
    "twitter": ["twitter.com", "x.com"],
    "bluesky": ["bsky.app"],
    "pixiv": ["pixiv.net"],
    "fanbox": ["fanbox.cc"],
    "patreon": ["patreon.com"],
    "rule34": ["rule34.xxx"],
    "instagram": ["instagram.com"],
    "deviantart": ["deviantart.com"],
    "danbooru": ["danbooru.donmai.us"],
    "kemonoparty": ["kemono.su", "kemono.party"],
    "reddit": ["reddit.com"],
    "tumblr": ["tumblr.com"],
    "weibo": ["weibo.com", "weibo.cn"],
    "gelbooru": ["gelbooru.com"],
    "e621": ["e621.net"],
    "misskey": ["misskey.io"],
    "bilibili": ["bilibili.com"],
}

_DATE_KEY_RE = re.compile(r"(date|time|created|posted|published|updated)", re.IGNORECASE)
_ISO_SAMPLE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?")
_SECRET_KEY_NAMES = {
    "password",
    "api-key",
    "api_key",
    "token",
    "secret",
    "authorization",
    "access-token",
    "refresh-token",
    "client-secret",
}


def get_site_domains(site: str) -> list[str]:
    """Return known domains for a gallery-dl extractor key."""
    key = site.strip().lower()
    if key in SITE_DOMAINS:
        return list(SITE_DOMAINS[key])
    return [f"{key}.com", key] if key else []


def expand_source_urls(
    urls: list[str],
    input_file: str = "",
    max_file_urls: int = 200,
) -> list[str]:
    """Expand URLs plus any `file:<name>` entries or `input_file` contents up to `max_file_urls`."""
    expanded: list[str] = []
    file_names: list[str] = []

    if input_file and input_file.strip():
        file_names.append(input_file.strip())

    for item in urls:
        u = str(item).strip()
        if not u or u.startswith("#"):
            continue
        if u.startswith("file:"):
            fname = u[5:].strip()
            if fname:
                file_names.append(fname)
        else:
            expanded.append(u)

    if file_names:
        inputs_dir = get_inputs_dir()
        remaining = max(0, max_file_urls)
        for fname in file_names:
            if remaining <= 0:
                break
            try:
                safe_name = validate_input_filename(fname)
            except ValueError:
                continue
            fpath = inputs_dir / safe_name
            if not fpath.is_file():
                continue
            try:
                lines = fpath.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for ln in lines:
                s = ln.strip()
                if not s or s.startswith("#"):
                    continue
                expanded.append(s)
                remaining -= 1
                if remaining <= 0:
                    break

    return expanded


def _extract_hostname(raw_url: str) -> str:
    s = raw_url.strip()
    if not s or s.startswith("#") or s.startswith("file:"):
        return ""
    if "://" not in s:
        if "." not in s or " " in s:
            return ""
        s = "https://" + s
    try:
        host = urllib.parse.urlparse(s).hostname or ""
    except ValueError:
        return ""
    host = host.lower().strip(".")
    if host.startswith("www."):
        host = host[4:]
    return host


def _host_matches_site(host: str, site: str) -> bool:
    if not host or not site:
        return False
    s = site.lower()
    if s in SITE_DOMAINS:
        for dom in SITE_DOMAINS[s]:
            if host == dom or host.endswith("." + dom):
                return True
        return False
    labels = [p for p in host.split(".") if p]
    if s in labels:
        return True
    dom = f"{s}.com"
    return host == dom or host.endswith("." + dom)


def match_sites(
    urls: list[str],
    known_sites: list[str] | None = None,
    input_file: str = "",
) -> list[str]:
    """Identify matching gallery-dl extractor site keys from URLs and optional input file."""
    expanded = expand_source_urls(urls, input_file=input_file)
    candidates: list[str] = list(SITE_DOMAINS.keys())
    if known_sites:
        seen_cand = set(candidates)
        for ks in known_sites:
            k = str(ks).strip().lower()
            if k and k not in seen_cand:
                seen_cand.add(k)
                candidates.append(k)

    matched: list[str] = []
    seen: set[str] = set()
    for u in expanded:
        host = _extract_hostname(u)
        if not host:
            continue
        for site in candidates:
            if site not in seen and _host_matches_site(host, site):
                seen.add(site)
                matched.append(site)
    return matched


def fetch_tasks_recent_statuses(db: Database, limit_per_task: int = 10) -> dict[int, list[dict[str, Any]]]:
    """Return up to `limit_per_task` recent runs per task in chronological order (oldest -> newest)."""
    lim = max(1, int(limit_per_task))
    with db.session() as conn:
        rows = conn.execute(
            """
            SELECT id, task_id, status, created_at, downloaded_count
            FROM (
                SELECT id, task_id, status, created_at, downloaded_count,
                       ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id DESC) AS rn
                FROM runs
                WHERE task_id IS NOT NULL
            )
            WHERE rn <= ?
            ORDER BY task_id ASC, id ASC
            """,
            (lim,),
        ).fetchall()
    out: dict[int, list[dict[str, Any]]] = {}
    for r in rows:
        tid = int(r["task_id"])
        out.setdefault(tid, []).append(
            {
                "id": int(r["id"]),
                "status": str(r["status"]),
                "created_at": str(r["created_at"]),
                "downloaded_count": int(r["downloaded_count"]),
            }
        )
    return out


def compute_task_detail(
    db: Database,
    task_row: Any,
    known_sites: list[str] | None = None,
) -> dict[str, Any]:
    """Compute recent runs, aggregate health metrics, and matched sites for one task."""
    task_id = int(task_row["id"])
    with db.session() as conn:
        recent_rows = conn.execute(
            "SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 30",
            (task_id,),
        ).fetchall()

    total = len(recent_rows)
    success = sum(1 for r in recent_rows if r["status"] == "success")
    partial = sum(1 for r in recent_rows if r["status"] == "partial")
    failed = sum(1 for r in recent_rows if r["status"] == "failed")
    auth_error = sum(1 for r in recent_rows if r["status"] == "auth_error")
    cancelled = sum(1 for r in recent_rows if r["status"] == "cancelled")
    finished_cnt = sum(1 for r in recent_rows if r["status"] not in ("queued", "running"))
    durations = [float(r["duration_sec"]) for r in recent_rows if r["duration_sec"] is not None]
    total_downloaded = sum(int(r["downloaded_count"] or 0) for r in recent_rows)

    urls = json.loads(task_row["urls_json"]) if task_row["urls_json"] else []
    input_file = task_row["input_file"] if "input_file" in task_row.keys() else ""
    sites = match_sites(urls, known_sites=known_sites, input_file=input_file or "")

    return {
        "recent_rows": recent_rows,
        "health": {
            "total": total,
            "success": success,
            "partial": partial,
            "failed": failed,
            "auth_error": auth_error,
            "cancelled": cancelled,
            "success_rate": round(success / finished_cnt, 4) if finished_cnt > 0 else None,
            "avg_duration_sec": round(sum(durations) / len(durations), 2) if durations else None,
            "total_downloaded": total_downloaded,
        },
        "sites": sites,
    }


def compute_sites_health(
    db: Database,
    conf: dict[str, Any],
    settings: dict[str, Any],
) -> list[dict[str, Any]]:
    """Aggregate site credential configuration, task usage, and run health across recent history."""
    summaries = summarize_sites(
        conf,
        settings["postprocess_default_sites"],
        settings.get("postprocess_site_configs"),
    )
    by_site: dict[str, dict[str, Any]] = {}
    for s in summaries:
        site_key = str(s["site"])
        auth_keys = {a["key"] for a in s.get("auth_fields", [])}
        has_creds = s.get("cookie_count", 0) > 0 or bool(
            auth_keys & {"password", "api-key", "username"}
        )
        by_site[site_key] = {
            **s,
            "configured": True,
            "domains": get_site_domains(site_key),
            "has_credentials": has_creds,
            "task_ids": [],
            "task_names": [],
            "last_run_at": None,
            "last_run_id": None,
            "last_status": None,
            "last_success_at": None,
            "last_auth_error_at": None,
            "last_auth_error_run_id": None,
            "last_auth_error_summary": "",
            "recent_runs_count": 0,
            "health": "unknown",
        }

    known_sites = list(by_site.keys())
    with db.session() as conn:
        task_rows = conn.execute(
            "SELECT id, name, urls_json, input_file FROM tasks ORDER BY id ASC"
        ).fetchall()
        run_rows = conn.execute(
            """
            SELECT id, urls_json, status, error_summary, started_at, finished_at, created_at
            FROM runs
            ORDER BY id DESC
            LIMIT 300
            """
        ).fetchall()

    def _ensure_discovered_site(site_key: str) -> dict[str, Any]:
        if site_key not in by_site:
            by_site[site_key] = {
                "site": site_key,
                "configured": False,
                "domains": get_site_domains(site_key),
                "cookie_count": 0,
                "cookie_keys": [],
                "auth_fields": [],
                "has_credentials": False,
                "skip": "",
                "filename": "",
                "postprocess_enabled": False,
                "postprocess_config": _normalize_site_pp_cfg({}, enabled_default=False),
                "postprocess_preview": describe_postprocess_preview(mode="disabled"),
                "task_ids": [],
                "task_names": [],
                "last_run_at": None,
                "last_run_id": None,
                "last_status": None,
                "last_success_at": None,
                "last_auth_error_at": None,
                "last_auth_error_run_id": None,
                "last_auth_error_summary": "",
                "recent_runs_count": 0,
                "health": "unknown",
            }
        return by_site[site_key]

    for tr in task_rows:
        urls = json.loads(tr["urls_json"]) if tr["urls_json"] else []
        inp = tr["input_file"] if "input_file" in tr.keys() else ""
        matched = match_sites(urls, known_sites=known_sites, input_file=inp or "")
        for s_key in matched:
            entry = _ensure_discovered_site(s_key)
            tid = int(tr["id"])
            if tid not in entry["task_ids"]:
                entry["task_ids"].append(tid)
                entry["task_names"].append(str(tr["name"]))

    latest_finished_status: dict[str, str] = {}
    for rr in run_rows:
        urls = json.loads(rr["urls_json"]) if rr["urls_json"] else []
        matched = match_sites(urls, known_sites=known_sites)
        ts = str(rr["finished_at"] or rr["started_at"] or rr["created_at"] or "")
        status = str(rr["status"])
        for s_key in matched:
            if s_key not in by_site and status != "auth_error":
                continue
            entry = _ensure_discovered_site(s_key)
            entry["recent_runs_count"] += 1
            if entry["last_run_id"] is None:
                entry["last_run_id"] = int(rr["id"])
                entry["last_run_at"] = ts
                entry["last_status"] = status
            if s_key not in latest_finished_status and status not in ("queued", "running"):
                latest_finished_status[s_key] = status
            if status == "success" and entry["last_success_at"] is None:
                entry["last_success_at"] = ts
            if status == "auth_error" and entry["last_auth_error_at"] is None:
                entry["last_auth_error_at"] = ts
                entry["last_auth_error_run_id"] = int(rr["id"])
                entry["last_auth_error_summary"] = str(rr["error_summary"] or "认证失效")

    for s_key, entry in by_site.items():
        fin = latest_finished_status.get(s_key)
        if fin == "auth_error":
            entry["health"] = "error"
        elif fin in ("failed", "partial"):
            entry["health"] = "warn"
        elif fin == "success":
            entry["health"] = "ok"
        else:
            entry["health"] = "unknown"

    order_rank = {"error": 0, "warn": 1, "ok": 2, "unknown": 3}
    items = list(by_site.values())
    items.sort(key=lambda x: (order_rank.get(x["health"], 9), not x["configured"], x["site"]))
    return items


def _mask_proxy_credentials(proxy_url: str) -> str:
    if "://" not in proxy_url or "@" not in proxy_url:
        return proxy_url
    try:
        parts = urllib.parse.urlsplit(proxy_url)
        if parts.username or parts.password:
            host = parts.hostname or ""
            port = f":{parts.port}" if parts.port else ""
            return f"{parts.scheme}://[REDACTED]@{host}{port}"
    except ValueError:
        pass
    return proxy_url


def redact_config_for_preview(conf: dict[str, Any], extra_secrets: list[str] | None = None) -> dict[str, Any]:
    """Deep-copy and redact all cookie values, credentials, and proxy passwords for safe UI preview."""
    cloned = copy.deepcopy(conf)

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            for k, v in list(node.items()):
                lk = str(k).lower()
                if lk == "cookies" and isinstance(v, dict):
                    node[k] = {ck: "[REDACTED]" for ck in v.keys()}
                elif lk in _SECRET_KEY_NAMES and isinstance(v, str) and v:
                    node[k] = "[REDACTED]"
                elif lk == "proxy" and isinstance(v, str) and v:
                    node[k] = _mask_proxy_credentials(v)
                else:
                    _walk(v)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(cloned)
    return cloned


def _parse_urls_input(body: dict[str, Any]) -> list[str]:
    raw = body.get("file_content") if body.get("file_content") else body.get("urls", [])
    if isinstance(raw, str):
        return [u.strip() for u in raw.replace(",", "\n").splitlines() if u.strip() and not u.strip().startswith("#")]
    if isinstance(raw, list):
        return [str(u).strip() for u in raw if str(u).strip() and not str(u).strip().startswith("#")]
    return []


def compute_effective_config(db: Database, body: dict[str, Any]) -> dict[str, Any]:
    """Resolve effective config, CLI command preview, and inheritance sources for a task or adhoc run."""
    settings = get_app_settings(db)
    base_conf = load_global_config(db)

    opts: dict[str, Any] = {
        "urls": [],
        "input_file": "",
        "proxy_mode": "inherit",
        "proxy_url": "",
        "subdir": "",
        "skip_mode": "",
        "filename_format": "",
        "extra_args": "",
        "use_archive": False,
        "archive_backfill": False,
        "postprocess_mode": "inherit",
        "postprocess_date_field": "",
        "postprocess_command": "",
        "simulate": False,
    }

    task_id_raw = body.get("task_id")
    if task_id_raw is not None and str(task_id_raw).strip().isdigit():
        with db.session() as conn:
            trow = conn.execute("SELECT * FROM tasks WHERE id = ?", (int(str(task_id_raw).strip()),)).fetchone()
        if trow is not None:
            tkeys = trow.keys()
            opts.update(
                {
                    "urls": json.loads(trow["urls_json"]) if trow["urls_json"] else [],
                    "input_file": trow["input_file"] if "input_file" in tkeys else "",
                    "proxy_mode": trow["proxy_mode"],
                    "proxy_url": trow["proxy_url"],
                    "subdir": trow["subdir"],
                    "skip_mode": trow["skip_mode"],
                    "filename_format": trow["filename_format"] if "filename_format" in tkeys else "",
                    "extra_args": trow["extra_args"],
                    "use_archive": bool(trow["use_archive"]),
                    "archive_backfill": bool(trow["archive_backfill"]) if "archive_backfill" in tkeys else False,
                    "postprocess_mode": trow["postprocess_mode"],
                    "postprocess_date_field": trow["postprocess_date_field"] if "postprocess_date_field" in tkeys else "",
                    "postprocess_command": trow["postprocess_command"] if "postprocess_command" in tkeys else "",
                }
            )

    if "urls" in body or "file_content" in body:
        opts["urls"] = _parse_urls_input(body)
    for key in (
        "input_file",
        "proxy_mode",
        "proxy_url",
        "subdir",
        "skip_mode",
        "filename_format",
        "extra_args",
        "postprocess_mode",
        "postprocess_date_field",
        "postprocess_command",
    ):
        if key in body and body[key] is not None:
            opts[key] = str(body[key]).strip()
    for bkey in ("use_archive", "archive_backfill", "simulate"):
        if bkey in body:
            opts[bkey] = bool(body[bkey])

    input_file = validate_input_filename(opts["input_file"]) if opts["input_file"] else ""
    archive_path = str(get_data_dir() / "archive.sqlite3")

    runtime_conf = synthesize_runtime_config(
        base_conf,
        global_proxy=settings["global_proxy"],
        proxy_mode=opts["proxy_mode"] or "inherit",
        proxy_url=opts["proxy_url"],
        subdir=opts["subdir"],
        skip_mode=opts["skip_mode"],
        filename_format=opts["filename_format"],
        use_archive=bool(opts["use_archive"]),
        archive_backfill=bool(opts["archive_backfill"]),
        archive_path=archive_path,
        postprocess_mode=opts["postprocess_mode"] or "inherit",
        postprocess_date_field=opts["postprocess_date_field"],
        postprocess_command=opts["postprocess_command"],
        postprocess_default_sites=settings["postprocess_default_sites"],
        postprocess_site_configs=settings.get("postprocess_site_configs"),
        download_dir=get_download_dir(),
    )

    extractor_base = base_conf.get("extractor") if isinstance(base_conf.get("extractor"), dict) else {}
    matched_sites = match_sites(
        opts["urls"],
        known_sites=[k for k, v in extractor_base.items() if isinstance(v, dict)],
        input_file=input_file,
    )

    # Resolve inheritance metadata for each option
    proxy_mode = opts["proxy_mode"] or "inherit"
    if proxy_mode == "direct":
        proxy_field = {"value": "", "source": "direct"}
    elif proxy_mode == "custom":
        proxy_field = {"value": _mask_proxy_credentials(opts["proxy_url"]), "source": "task"}
    else:
        g_proxy = settings["global_proxy"].strip()
        proxy_field = {"value": _mask_proxy_credentials(g_proxy), "source": "global" if g_proxy else "direct"}

    if opts["skip_mode"]:
        skip_field = {"value": runtime_conf["extractor"].get("skip", opts["skip_mode"]), "source": "task"}
    else:
        skip_val: Any = None
        skip_src = "default"
        for s in matched_sites:
            sc = extractor_base.get(s)
            if isinstance(sc, dict) and "skip" in sc and sc["skip"] not in ("", None):
                skip_val = sc["skip"]
                skip_src = f"site:{s}"
                break
        if skip_src == "default" and "skip" in extractor_base and extractor_base["skip"] not in ("", None):
            skip_val = extractor_base["skip"]
            skip_src = "global"
        skip_field = {"value": skip_val if skip_val is not None else "true (gallery-dl 默认)", "source": skip_src}

    if opts["filename_format"]:
        filename_field = {"value": opts["filename_format"], "source": "task"}
    else:
        fn_val: Any = ""
        fn_src = "default"
        for s in matched_sites:
            sc = extractor_base.get(s)
            if isinstance(sc, dict) and sc.get("filename"):
                fn_val = sc["filename"]
                fn_src = f"site:{s}"
                break
        if fn_src == "default" and extractor_base.get("filename"):
            fn_val = extractor_base["filename"]
            fn_src = "global"
        filename_field = {"value": fn_val or "站点默认模板", "source": fn_src}

    pp_mode = opts["postprocess_mode"] or "inherit"
    postprocess_items: list[dict[str, str]] = []
    if pp_mode == "enabled":
        prev = describe_postprocess_preview(mode="builtin", date_template=opts["postprocess_date_field"])
        postprocess_items.append({"site": "*", "mode": "builtin", "exec_command": prev["exec_command"], "source": "task"})
    elif pp_mode == "custom":
        prev = describe_postprocess_preview(mode="custom", custom_command=opts["postprocess_command"])
        postprocess_items.append({"site": "*", "mode": "custom", "exec_command": prev["exec_command"], "source": "task"})
    elif pp_mode == "inherit":
        site_cfgs = settings.get("postprocess_site_configs") or {}
        target_sites = matched_sites if matched_sites else list(site_cfgs.keys())
        for s in target_sites:
            ncfg = _normalize_site_pp_cfg(site_cfgs.get(s), enabled_default=(s in settings["postprocess_default_sites"]))
            if not ncfg["enabled"]:
                continue
            prev = describe_postprocess_preview(
                mode=ncfg["mode"],
                date_template=ncfg["date_template"],
                extra_args=ncfg["extra_args"],
                custom_command=ncfg["custom_command"],
            )
            postprocess_items.append({"site": s, "mode": ncfg["mode"], "exec_command": prev["exec_command"], "source": "site"})

    cmd_parts = ["gallery-dl", "-c", "/data/.runtime-conf.json"]
    if opts["simulate"]:
        cmd_parts.append("--simulate")
    if opts["extra_args"]:
        try:
            cmd_parts.extend(shlex.split(opts["extra_args"]))
        except ValueError:
            cmd_parts.append(opts["extra_args"])
    if input_file:
        cnt = 0
        inp_path = get_inputs_dir() / input_file
        if inp_path.is_file():
            cnt = count_valid_urls(inp_path.read_text(encoding="utf-8", errors="replace"))
        cmd_parts.extend(["-i", f"/data/inputs/{input_file}"])
        cmd_str = " ".join(shlex.quote(p) for p in cmd_parts) + (f"  # {cnt} 条 URL" if cnt else "")
    elif len(opts["urls"]) > 5:
        cmd_parts.extend(["-i", f"<临时列表 ({len(opts['urls'])} 条 URL)>"])
        cmd_str = " ".join(shlex.quote(p) for p in cmd_parts)
    elif opts["urls"]:
        cmd_parts.extend(opts["urls"])
        cmd_str = " ".join(shlex.quote(p) for p in cmd_parts)
    else:
        cmd_str = " ".join(shlex.quote(p) for p in cmd_parts) + " <URL>"

    secrets = extract_secret_values(runtime_conf, extra_secrets=[opts["proxy_url"], settings["global_proxy"]])
    redacted_conf = redact_config_for_preview(runtime_conf, extra_secrets=secrets)
    conf_json = redact_text(json.dumps(redacted_conf, ensure_ascii=False, indent=2), secrets)
    cmd_str = redact_text(cmd_str, secrets)

    return {
        "command": cmd_str,
        "base_directory": str(runtime_conf["extractor"].get("base-directory", "")),
        "fields": {
            "proxy": proxy_field,
            "skip": skip_field,
            "filename": filename_field,
            "subdir": {"value": opts["subdir"] or "默认根目录", "source": "task" if opts["subdir"] else "default"},
            "extra_args": {"value": opts["extra_args"] or "", "source": "task" if opts["extra_args"] else "default"},
            "archive": {
                "value": bool(opts["use_archive"]),
                "backfill": bool(opts["use_archive"] and opts["archive_backfill"]),
                "path": archive_path if opts["use_archive"] else "",
            },
            "postprocess": postprocess_items,
        },
        "sites": matched_sites,
        "config_json": conf_json,
    }


def parse_gallery_dl_k_output(text: str) -> list[dict[str, Any]]:
    """Parse `gallery-dl -K` keyword listing into sorted metadata field descriptors."""
    fields: dict[str, str] = {}
    current_key: str | None = None
    for raw_line in text.splitlines():
        if not raw_line.strip():
            continue
        if not raw_line[0].isspace():
            # Top-level key (e.g. `date` or `author[name]`)
            key = raw_line.strip().rstrip(":")
            if re.fullmatch(r"[A-Za-z0-9_.\[\]-]+", key):
                current_key = key
                fields.setdefault(key, "")
            else:
                current_key = None
        elif current_key is not None and not fields[current_key]:
            fields[current_key] = raw_line.strip()[:120]

    items: list[dict[str, Any]] = []
    for k, sample in fields.items():
        is_date = bool(_DATE_KEY_RE.search(k) or _ISO_SAMPLE_RE.match(sample))
        items.append({"key": k, "sample": sample, "is_date": is_date})
    items.sort(key=lambda x: (not x["is_date"], x["key"]))
    return items
