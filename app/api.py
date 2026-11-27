"""Starlette ASGI application and REST/SSE API for gallery-dl-manager."""

from __future__ import annotations

import asyncio
import copy
import json
import sqlite3
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from app import alerts
from app import cron as cron_mod
from app import notifier
from app import twitter_likes
from app.auth import SESSION_COOKIE_NAME, AuthManager, cookie_secure_flag, is_auth_disabled
from app.config_manager import (
    DEFAULT_DATE_TEMPLATE,
    build_postprocessor_spec,
    delete_input_file,
    describe_postprocess_preview,
    extract_secret_values,
    get_app_settings,
    get_inputs_dir,
    get_postprocess_site_configs,
    import_legacy_if_needed,
    list_input_files,
    load_global_config,
    parse_cookies_input,
    redact_text,
    save_global_config,
    save_input_file,
    save_postprocess_site_configs,
    summarize_sites,
    validate_input_filename,
    validate_safe_subdir,
)
from app.db import Database, utc_now_iso
from app.runner import DEFAULT_LOG_TAIL_LINES, MAX_LOG_TAIL_LINES, TaskManager, tail_log_lines
from app.version import get_versions

STATIC_DIR = Path(__file__).parent / "static"


def _count_archive_entries() -> int:
    arch_path = twitter_likes.get_archive_sqlite_path()
    if not arch_path.is_file():
        return 0
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(f"file:{arch_path}?mode=ro", uri=True, timeout=3.0)
        row = conn.execute("SELECT COUNT(*) FROM archive").fetchone()
        return int(row[0]) if row else 0
    except sqlite3.Error:
        return 0
    finally:
        if conn is not None:
            conn.close()


def _client_ip(request: Request) -> str:
    xff = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if xff:
        return xff
    return request.client.host if request.client else "unknown"


def _require_csrf(request: Request) -> Response | None:
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        if request.headers.get("X-Requested-With") != "fetch":
            return JSONResponse({"error": "Missing X-Requested-With header"}, status_code=403)
    return None


def _task_row_to_dict(row: Any) -> dict[str, Any]:
    urls = json.loads(row["urls_json"])
    next_times: list[str] = []
    cron_desc = ""
    try:
        cron_desc = cron_mod.describe_cron_zh(row["cron_expr"])
        if row["enabled"]:
            next_times = [dt.isoformat(timespec="seconds") for dt in cron_mod.next_runs(row["cron_expr"], count=3)]
    except Exception:
        cron_desc = f"Cron 无效: {row['cron_expr']}"
    pp_mode = row["postprocess_mode"]
    pp_date = row["postprocess_date_field"] if "postprocess_date_field" in row.keys() else ""
    pp_cmd = row["postprocess_command"] if "postprocess_command" in row.keys() else ""
    preview = (
        describe_postprocess_preview(mode="custom", custom_command=pp_cmd)
        if pp_mode == "custom"
        else describe_postprocess_preview(mode="builtin", date_template=pp_date)
        if pp_mode == "enabled"
        else describe_postprocess_preview(mode="disabled")
        if pp_mode == "disabled"
        else {"mode": "inherit", "exec_command": "按站点配置分别执行", "exiftool_image_cmd": "", "exiftool_video_cmd": ""}
    )
    return {
        "id": row["id"],
        "name": row["name"],
        "urls": urls,
        "enabled": bool(row["enabled"]),
        "cron_expr": row["cron_expr"],
        "cron_desc": cron_desc,
        "next_runs": next_times,
        "proxy_mode": row["proxy_mode"],
        "proxy_url": row["proxy_url"],
        "subdir": row["subdir"],
        "skip_mode": row["skip_mode"],
        "extra_args": row["extra_args"],
        "filename_format": row["filename_format"] if "filename_format" in row.keys() else "",
        "input_file": row["input_file"] if "input_file" in row.keys() else "",
        "use_archive": bool(row["use_archive"]),
        "archive_backfill": bool(row["archive_backfill"]) if "archive_backfill" in row.keys() else False,
        "postprocess_mode": pp_mode,
        "postprocess_date_field": pp_date,
        "postprocess_command": pp_cmd,
        "postprocess_preview": preview,
        "notes": row["notes"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_run_id": row["last_run_id"],
        "last_status": row["last_status"],
        "last_run_at": row["last_run_at"],
        "consecutive_failures": row["consecutive_failures"],
    }


def _run_row_to_dict(row: Any) -> dict[str, Any]:
    raw_urls = json.loads(row["urls_json"])
    display_urls = raw_urls if len(raw_urls) <= 5 else raw_urls[:3] + [f"... (共 {len(raw_urls)} 条)"]
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "task_name": row["task_name"],
        "trigger_type": row["trigger_type"],
        "urls": display_urls,
        "url_count": len(raw_urls),
        "simulate": bool(row["simulate"]),
        "status": row["status"],
        "exit_code": row["exit_code"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "duration_sec": row["duration_sec"],
        "downloaded_count": row["downloaded_count"],
        "skipped_count": row["skipped_count"],
        "postprocess_ok": row["postprocess_ok"],
        "postprocess_warn": row["postprocess_warn"],
        "error_summary": row["error_summary"],
        "error_category": row["error_category"],
        "created_at": row["created_at"],
    }


def create_app(db: Database | None = None) -> Starlette:
    database = db if db is not None else Database()
    auth = AuthManager(database)
    manager = TaskManager(database)

    @asynccontextmanager
    async def lifespan(_app: Starlette):
        database.init_schema()
        get_inputs_dir()
        import_legacy_if_needed(database)
        setup_token = auth.ensure_initialized()
        if setup_token:
            auth.print_setup_banner(setup_token)
        await manager.start()
        try:
            yield
        finally:
            await manager.stop()

    def _run_with_live(row: Any) -> dict[str, Any]:
        d = _run_row_to_dict(row)
        if d["status"] == "running":
            if snap := manager.get_live_snapshot(int(d["id"])):
                d.update(
                    {
                        "downloaded_count": snap["downloaded_count"],
                        "skipped_count": snap["skipped_count"],
                        "postprocess_ok": snap["postprocess_ok"],
                        "postprocess_warn": snap["postprocess_warn"],
                        "duration_sec": snap["duration_sec"],
                    }
                )
        return d

    def _is_authenticated(request: Request) -> bool:
        if is_auth_disabled():
            return True
        return auth.verify_session_cookie(request.cookies.get(SESSION_COOKIE_NAME))

    def _guard_api(request: Request) -> Response | None:
        if not _is_authenticated(request):
            return JSONResponse({"error": "未登录或会话已过期"}, status_code=401)
        return _require_csrf(request)

    def _has_valid_sync_token(request: Request) -> bool:
        auth_header = request.headers.get("Authorization", "")
        token = ""
        if auth_header.lower().startswith("bearer "):
            token = auth_header[7:].strip()
        elif request.query_params.get("token"):
            token = request.query_params.get("token", "").strip()
        return twitter_likes.verify_sync_token(database, token)

    def _guard_sync_or_admin(request: Request) -> Response | None:
        if _has_valid_sync_token(request):
            return None
        return _guard_api(request)

    async def health(_request: Request) -> Response:
        settings = get_app_settings(database)
        with database.session() as conn:
            running = conn.execute("SELECT COUNT(*) FROM runs WHERE status = 'running'").fetchone()[0]
            queued = conn.execute("SELECT COUNT(*) FROM runs WHERE status = 'queued'").fetchone()[0]
        return JSONResponse(
            {
                "status": "ok",
                "scheduler_paused": settings["scheduler_paused"],
                "running_count": running,
                "queued_count": queued,
                "versions": get_versions(),
            }
        )

    async def page_index(request: Request) -> Response:
        if not is_auth_disabled():
            if not auth.is_configured():
                return RedirectResponse("/setup", status_code=302)
            if not _is_authenticated(request):
                return RedirectResponse("/login", status_code=302)
        return FileResponse(STATIC_DIR / "index.html")

    async def page_login(request: Request) -> Response:
        if is_auth_disabled():
            return RedirectResponse("/", status_code=302)
        if not auth.is_configured():
            return RedirectResponse("/setup", status_code=302)
        if _is_authenticated(request):
            return RedirectResponse("/", status_code=302)
        return FileResponse(STATIC_DIR / "login.html")

    async def page_setup(request: Request) -> Response:
        if is_auth_disabled():
            return RedirectResponse("/", status_code=302)
        if auth.is_configured():
            return RedirectResponse("/login" if not _is_authenticated(request) else "/", status_code=302)
        return FileResponse(STATIC_DIR / "login.html")

    async def api_auth_status(request: Request) -> Response:
        return JSONResponse(
            {
                "auth_disabled": is_auth_disabled(),
                "configured": auth.is_configured(),
                "authenticated": _is_authenticated(request),
            }
        )

    async def api_auth_setup(request: Request) -> Response:
        if csrf := _require_csrf(request):
            return csrf
        ip = _client_ip(request)
        if wait := auth.limiter.check_blocked(ip):
            return JSONResponse({"error": f"尝试次数过多，请在 {wait} 秒后重试"}, status_code=429)
        body = await request.json()
        token = str(body.get("token", ""))
        password = str(body.get("password", ""))
        try:
            ok = auth.complete_setup(token, password)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        if not ok:
            auth.limiter.record_failure(ip)
            return JSONResponse({"error": "初始化口令不正确"}, status_code=403)
        auth.limiter.reset(ip)
        resp = JSONResponse({"ok": True})
        resp.set_cookie(
            SESSION_COOKIE_NAME,
            auth.create_session_cookie(),
            httponly=True,
            samesite="lax",
            secure=cookie_secure_flag(),
            max_age=30 * 24 * 3600,
        )
        return resp

    async def api_auth_login(request: Request) -> Response:
        if csrf := _require_csrf(request):
            return csrf
        if not auth.is_configured():
            return JSONResponse({"error": "站点尚未初始化"}, status_code=400)
        ip = _client_ip(request)
        if wait := auth.limiter.check_blocked(ip):
            return JSONResponse({"error": f"登录失败次数过多，请在 {wait} 秒后重试"}, status_code=429)
        body = await request.json()
        password = str(body.get("password", ""))
        if not auth.verify_login(password):
            auth.limiter.record_failure(ip)
            return JSONResponse({"error": "密码错误"}, status_code=401)
        auth.limiter.reset(ip)
        resp = JSONResponse({"ok": True})
        resp.set_cookie(
            SESSION_COOKIE_NAME,
            auth.create_session_cookie(),
            httponly=True,
            samesite="lax",
            secure=cookie_secure_flag(),
            max_age=30 * 24 * 3600,
        )
        return resp

    async def api_auth_logout(request: Request) -> Response:
        if csrf := _require_csrf(request):
            return csrf
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(SESSION_COOKIE_NAME)
        return resp

    async def api_auth_password(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        cur_pw = str(body.get("current_password", ""))
        new_pw = str(body.get("new_password", ""))
        try:
            ok = auth.change_password(cur_pw, new_pw)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        if not ok:
            return JSONResponse({"error": "当前密码错误"}, status_code=400)
        resp = JSONResponse({"ok": True})
        resp.set_cookie(
            SESSION_COOKIE_NAME,
            auth.create_session_cookie(),
            httponly=True,
            samesite="lax",
            secure=cookie_secure_flag(),
            max_age=30 * 24 * 3600,
        )
        return resp

    async def api_dashboard(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        settings = get_app_settings(database)
        today_start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc).isoformat(timespec="seconds")
        week_start = (datetime.now().astimezone() - timedelta(days=7)).astimezone(timezone.utc).isoformat(timespec="seconds")
        with database.session() as conn:
            active_rows = conn.execute(
                "SELECT * FROM runs WHERE status IN ('running', 'queued') ORDER BY id ASC"
            ).fetchall()
            recent_rows = conn.execute(
                "SELECT * FROM runs ORDER BY id DESC LIMIT 15"
            ).fetchall()
            alert_rows = conn.execute(
                "SELECT * FROM runs WHERE status IN ('failed', 'auth_error', 'partial') ORDER BY id DESC LIMIT 5"
            ).fetchall()
            today_dl = conn.execute(
                "SELECT COALESCE(SUM(downloaded_count), 0) FROM runs WHERE created_at >= ? AND simulate = 0",
                (today_start,),
            ).fetchone()[0]
            week_dl = conn.execute(
                "SELECT COALESCE(SUM(downloaded_count), 0) FROM runs WHERE created_at >= ? AND simulate = 0",
                (week_start,),
            ).fetchone()[0]
            task_total = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
            task_enabled = conn.execute("SELECT COUNT(*) FROM tasks WHERE enabled = 1").fetchone()[0]
            task_failing = conn.execute("SELECT COUNT(*) FROM tasks WHERE consecutive_failures > 0").fetchone()[0]
            enabled_rows = conn.execute(
                "SELECT id, name, cron_expr, last_status FROM tasks WHERE enabled = 1 ORDER BY id ASC"
            ).fetchall()
            tw_sync_ids = conn.execute("SELECT COUNT(*) FROM twitter_liked_ids").fetchone()[0]

        upcoming_tasks: list[dict[str, Any]] = []
        for tr in enabled_rows:
            try:
                nxt_list = cron_mod.next_runs(tr["cron_expr"], count=1)
                if not nxt_list:
                    continue
                nxt_dt = nxt_list[0]
                upcoming_tasks.append(
                    {
                        "id": int(tr["id"]),
                        "name": str(tr["name"]),
                        "cron_expr": str(tr["cron_expr"]),
                        "cron_desc": cron_mod.describe_cron_zh(tr["cron_expr"]),
                        "next_run_at": nxt_dt.isoformat(timespec="seconds"),
                        "last_status": tr["last_status"],
                    }
                )
            except Exception:
                continue
        upcoming_tasks.sort(key=lambda x: x["next_run_at"])
        upcoming_tasks = upcoming_tasks[:5]

        archive_entries = await asyncio.to_thread(_count_archive_entries)
        input_files_count = len(list_input_files())
        alert_summary = alerts.list_alerts(database, limit=50)

        return JSONResponse(
            {
                "scheduler_paused": settings["scheduler_paused"],
                "legacy_import_notice": database.get_setting("legacy_import_notice") == "1",
                "unread_alerts_count": alert_summary["unread_count"],
                "stats": {
                    "today_downloaded": int(today_dl),
                    "week_downloaded": int(week_dl),
                    "task_total": int(task_total),
                    "task_enabled": int(task_enabled),
                    "task_failing": int(task_failing),
                    "running_count": sum(1 for r in active_rows if r["status"] == "running"),
                    "queued_count": sum(1 for r in active_rows if r["status"] == "queued"),
                },
                "active_runs": [_run_with_live(r) for r in active_rows],
                "upcoming_tasks": upcoming_tasks,
                "storage_summary": {
                    "archive_entries": archive_entries,
                    "twitter_sync_ids": int(tw_sync_ids),
                    "input_files_count": input_files_count,
                },
                "recent_runs": [_run_with_live(r) for r in recent_rows],
                "recent_alerts": [_run_with_live(r) for r in alert_rows],
                "versions": get_versions(),
            }
        )

    async def api_alerts_list(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        return JSONResponse(alerts.list_alerts(database, limit=50))

    async def api_alerts_read(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        alerts.mark_alerts_read(
            database,
            alert_key=body.get("alert_key"),
            mark_all=bool(body.get("all")),
        )
        return JSONResponse(alerts.list_alerts(database, limit=50))

    async def api_alerts_clear(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        alerts.clear_alerts(
            database,
            alert_key=body.get("alert_key"),
            clear_all=bool(body.get("all")),
        )
        return JSONResponse(alerts.list_alerts(database, limit=50))

    async def api_scheduler_pause(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        database.set_setting("scheduler_paused", "1")
        return JSONResponse({"scheduler_paused": True})

    async def api_scheduler_resume(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        database.set_setting("scheduler_paused", "0")
        return JSONResponse({"scheduler_paused": False})

    async def api_download(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        raw_urls = body.get("file_content") or body.get("urls", "")
        if isinstance(raw_urls, str):
            urls = [u.strip() for u in raw_urls.replace(",", "\n").splitlines() if u.strip() and not u.strip().startswith("#")]
        elif isinstance(raw_urls, list):
            urls = [str(u).strip() for u in raw_urls if str(u).strip() and not str(u).strip().startswith("#")]
        else:
            urls = []
        input_file = str(body.get("input_file", "")).strip()
        try:
            validate_safe_subdir(str(body.get("subdir", "")))
            pp_mode = str(body.get("postprocess_mode", "inherit"))
            pp_date = str(body.get("postprocess_date_field", "")).strip()
            pp_cmd = str(body.get("postprocess_command", "")).strip()
            if pp_mode == "custom":
                build_postprocessor_spec(mode="custom", custom_command=pp_cmd)
            run_id = manager.enqueue_adhoc(
                urls=urls,
                input_file=input_file,
                proxy_mode=str(body.get("proxy_mode", "inherit")),
                proxy_url=str(body.get("proxy_url", "")),
                subdir=str(body.get("subdir", "")),
                skip_mode=str(body.get("skip_mode", "")),
                filename_format=str(body.get("filename_format", "")),
                extra_args=str(body.get("extra_args", "")),
                use_archive=bool(body.get("use_archive", False)),
                archive_backfill=bool(body.get("archive_backfill", False)),
                postprocess_mode=pp_mode,
                postprocess_date_field=pp_date,
                postprocess_command=pp_cmd,
                simulate=bool(body.get("simulate", False)),
                name=str(body.get("name", "临时下载")).strip() or "临时下载",
            )
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"run_id": run_id}, status_code=201)

    async def api_tasks_list(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        with database.session() as conn:
            rows = conn.execute("SELECT * FROM tasks ORDER BY id ASC").fetchall()
        return JSONResponse({"tasks": [_task_row_to_dict(r) for r in rows]})

    async def api_tasks_create(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        try:
            name = str(body.get("name", "")).strip()
            if not name:
                raise ValueError("任务名称不能为空")
            raw_urls = body.get("urls", [])
            if isinstance(raw_urls, str):
                urls = [u.strip() for u in raw_urls.splitlines() if u.strip()]
            else:
                urls = [str(u).strip() for u in raw_urls if str(u).strip()]
            raw_input_file = str(body.get("input_file", "")).strip()
            input_file = validate_input_filename(raw_input_file) if raw_input_file else ""
            if not urls and not input_file:
                raise ValueError("请填写至少一个 URL 或选择一个输入文件")
            cron_expr = cron_mod.validate_cron(str(body.get("cron_expr", "0 */6 * * *")))
            subdir = validate_safe_subdir(str(body.get("subdir", "")))
            pp_mode = str(body.get("postprocess_mode", "inherit"))
            pp_date = str(body.get("postprocess_date_field", "")).strip()
            pp_cmd = str(body.get("postprocess_command", "")).strip()
            if pp_mode == "custom":
                build_postprocessor_spec(mode="custom", custom_command=pp_cmd)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        now = utc_now_iso()
        with database.session() as conn:
            cur = conn.execute(
                """
                INSERT INTO tasks (
                    name, urls_json, enabled, cron_expr, proxy_mode, proxy_url,
                    subdir, skip_mode, extra_args, filename_format, input_file, use_archive, archive_backfill,
                    postprocess_mode, postprocess_date_field, postprocess_command,
                    notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    json.dumps(urls, ensure_ascii=False),
                    1 if body.get("enabled", True) else 0,
                    cron_expr,
                    str(body.get("proxy_mode", "inherit")),
                    str(body.get("proxy_url", "")).strip(),
                    subdir,
                    str(body.get("skip_mode", "")).strip(),
                    str(body.get("extra_args", "")).strip(),
                    str(body.get("filename_format", "")).strip(),
                    input_file,
                    1 if body.get("use_archive", False) else 0,
                    1 if (body.get("use_archive", False) and body.get("archive_backfill", False)) else 0,
                    pp_mode,
                    pp_date,
                    pp_cmd,
                    str(body.get("notes", "")).strip(),
                    now,
                    now,
                ),
            )
            task_id = int(cur.lastrowid)
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return JSONResponse({"task": _task_row_to_dict(row)}, status_code=201)

    async def api_tasks_update(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        task_id = int(request.path_params["task_id"])
        body = await request.json()
        try:
            name = str(body.get("name", "")).strip()
            if not name:
                raise ValueError("任务名称不能为空")
            raw_urls = body.get("urls", [])
            if isinstance(raw_urls, str):
                urls = [u.strip() for u in raw_urls.splitlines() if u.strip()]
            else:
                urls = [str(u).strip() for u in raw_urls if str(u).strip()]
            raw_input_file = str(body.get("input_file", "")).strip()
            input_file = validate_input_filename(raw_input_file) if raw_input_file else ""
            if not urls and not input_file:
                raise ValueError("请填写至少一个 URL 或选择一个输入文件")
            cron_expr = cron_mod.validate_cron(str(body.get("cron_expr", "0 */6 * * *")))
            subdir = validate_safe_subdir(str(body.get("subdir", "")))
            pp_mode = str(body.get("postprocess_mode", "inherit"))
            pp_date = str(body.get("postprocess_date_field", "")).strip()
            pp_cmd = str(body.get("postprocess_command", "")).strip()
            if pp_mode == "custom":
                build_postprocessor_spec(mode="custom", custom_command=pp_cmd)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        with database.session() as conn:
            cur = conn.execute(
                """
                UPDATE tasks
                SET name = ?, urls_json = ?, enabled = ?, cron_expr = ?, proxy_mode = ?, proxy_url = ?,
                    subdir = ?, skip_mode = ?, extra_args = ?, filename_format = ?, input_file = ?, use_archive = ?, archive_backfill = ?,
                    postprocess_mode = ?, postprocess_date_field = ?, postprocess_command = ?,
                    notes = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    name,
                    json.dumps(urls, ensure_ascii=False),
                    1 if body.get("enabled", True) else 0,
                    cron_expr,
                    str(body.get("proxy_mode", "inherit")),
                    str(body.get("proxy_url", "")).strip(),
                    subdir,
                    str(body.get("skip_mode", "")).strip(),
                    str(body.get("extra_args", "")).strip(),
                    str(body.get("filename_format", "")).strip(),
                    input_file,
                    1 if body.get("use_archive", False) else 0,
                    1 if (body.get("use_archive", False) and body.get("archive_backfill", False)) else 0,
                    pp_mode,
                    pp_date,
                    pp_cmd,
                    str(body.get("notes", "")).strip(),
                    utc_now_iso(),
                    task_id,
                ),
            )
            if cur.rowcount == 0:
                return JSONResponse({"error": "任务不存在"}, status_code=404)
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return JSONResponse({"task": _task_row_to_dict(row)})

    async def api_tasks_delete(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        task_id = int(request.path_params["task_id"])
        with database.session() as conn:
            cur = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
            if cur.rowcount == 0:
                return JSONResponse({"error": "任务不存在"}, status_code=404)
        return JSONResponse({"ok": True})

    async def api_tasks_run(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        task_id = int(request.path_params["task_id"])
        simulate = False
        try:
            body = await request.json()
            simulate = bool(body.get("simulate", False))
        except Exception:
            pass
        try:
            run_id, already_active = manager.enqueue_task(task_id, trigger_type="manual", simulate=simulate)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)
        return JSONResponse({"run_id": run_id, "already_active": already_active})

    async def api_tasks_toggle(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        task_id = int(request.path_params["task_id"])
        with database.session() as conn:
            row = conn.execute("SELECT enabled FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "任务不存在"}, status_code=404)
            new_val = 0 if row["enabled"] else 1
            conn.execute("UPDATE tasks SET enabled = ?, updated_at = ? WHERE id = ?", (new_val, utc_now_iso(), task_id))
            updated = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if new_val == 1:
            database.delete_setting("legacy_import_notice")
        return JSONResponse({"task": _task_row_to_dict(updated)})

    async def api_tasks_enable_all(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        with database.session() as conn:
            conn.execute("UPDATE tasks SET enabled = 1, updated_at = ?", (utc_now_iso(),))
        database.delete_setting("legacy_import_notice")
        return JSONResponse({"ok": True})

    async def api_tasks_batch(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        action = str(body.get("action", "")).strip()
        raw_ids = body.get("task_ids", [])
        if action not in ("enable", "disable", "delete"):
            return JSONResponse({"error": "不支持的批量操作"}, status_code=400)
        if not isinstance(raw_ids, list):
            return JSONResponse({"error": "task_ids 格式无效"}, status_code=400)
        task_ids = sorted({int(x) for x in raw_ids if str(x).isdigit()})
        if not task_ids:
            return JSONResponse({"error": "请至少选择一个任务"}, status_code=400)

        placeholders = ",".join("?" for _ in task_ids)
        now = utc_now_iso()
        with database.session() as conn:
            if action == "enable":
                cur = conn.execute(
                    f"UPDATE tasks SET enabled = 1, updated_at = ? WHERE id IN ({placeholders})",
                    [now, *task_ids],
                )
            elif action == "disable":
                cur = conn.execute(
                    f"UPDATE tasks SET enabled = 0, updated_at = ? WHERE id IN ({placeholders})",
                    [now, *task_ids],
                )
            else:
                cur = conn.execute(
                    f"DELETE FROM tasks WHERE id IN ({placeholders})",
                    task_ids,
                )
        if action == "enable":
            database.delete_setting("legacy_import_notice")
        return JSONResponse({"ok": True, "affected": cur.rowcount})

    async def api_tasks_dismiss_notice(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        database.delete_setting("legacy_import_notice")
        return JSONResponse({"ok": True})

    async def api_cron_preview(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        expr = str(body.get("cron_expr", ""))
        try:
            norm = cron_mod.validate_cron(expr)
            desc = cron_mod.describe_cron_zh(norm)
            nxt = [dt.strftime("%Y-%m-%d %H:%M:%S %Z") for dt in cron_mod.next_runs(norm, count=3)]
            return JSONResponse({"valid": True, "normalized": norm, "description": desc, "next_runs": nxt})
        except ValueError as exc:
            return JSONResponse({"valid": False, "error": str(exc)}, status_code=400)

    async def api_runs_list(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        status_filter = request.query_params.get("status", "").strip()
        task_id_raw = request.query_params.get("task_id", "").strip()
        limit = max(1, min(200, int(request.query_params.get("limit", "50"))))
        offset = max(0, int(request.query_params.get("offset", "0")))

        clauses = []
        params: list[Any] = []
        if status_filter:
            clauses.append("status = ?")
            params.append(status_filter)
        if task_id_raw.isdigit():
            clauses.append("task_id = ?")
            params.append(int(task_id_raw))
        where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""

        with database.session() as conn:
            total = conn.execute(f"SELECT COUNT(*) FROM runs {where_sql}", params).fetchone()[0]
            rows = conn.execute(
                f"SELECT * FROM runs {where_sql} ORDER BY id DESC LIMIT ? OFFSET ?",
                params + [limit, offset],
            ).fetchall()
        return JSONResponse({"total": int(total), "runs": [_run_with_live(r) for r in rows]})

    async def api_runs_detail(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        run_id = int(request.path_params["run_id"])
        with database.session() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                return JSONResponse({"error": "运行记录不存在"}, status_code=404)
            file_rows = conn.execute(
                "SELECT file_path, status, created_at FROM run_files WHERE run_id = ? ORDER BY id ASC",
                (run_id,),
            ).fetchall()
        log_lines: list[str] = []
        log_truncated = False
        lp = Path(row["log_file"]) if row["log_file"] else None
        if row["status"] not in ("queued", "running"):
            log_lines, log_truncated = tail_log_lines(lp, max_lines=500)
        run_dict = _run_with_live(row)
        files_out = [dict(f) for f in file_rows]
        if row["status"] == "running":
            if snap := manager.get_live_snapshot(run_id):
                files_out = [{"file_path": p, "status": "downloaded", "created_at": ""} for p in snap["files"]]
        return JSONResponse(
            {
                "run": run_dict,
                "files": files_out,
                "log_lines": log_lines,
                "log_truncated": log_truncated,
            }
        )

    async def api_runs_log(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        run_id = int(request.path_params["run_id"])
        download = request.query_params.get("download") == "1"
        with database.session() as conn:
            row = conn.execute("SELECT log_file FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "运行记录不存在"}, status_code=404)
        lp = Path(row["log_file"]) if row["log_file"] else None
        text = lp.read_text(encoding="utf-8", errors="replace") if (lp and lp.is_file()) else ""
        headers = {}
        if download:
            headers["Content-Disposition"] = f'attachment; filename="gallery-dl-run-{run_id}.log"'
        return PlainTextResponse(text, headers=headers)

    async def api_runs_stream(request: Request) -> Response:
        if not _is_authenticated(request):
            return JSONResponse({"error": "未登录或会话已过期"}, status_code=401)
        run_id = int(request.path_params["run_id"])
        raw_tail = request.query_params.get("tail", str(DEFAULT_LOG_TAIL_LINES)).strip()
        try:
            tail_limit = max(50, min(MAX_LOG_TAIL_LINES, int(raw_tail)))
        except ValueError:
            tail_limit = DEFAULT_LOG_TAIL_LINES

        with database.session() as conn:
            row = conn.execute("SELECT status, log_file FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "运行记录不存在"}, status_code=404)

        q = manager.subscribe_run(run_id)

        async def event_gen():
            try:
                lp = Path(row["log_file"]) if row["log_file"] else None
                tail_lines, truncated = tail_log_lines(lp, max_lines=tail_limit)
                yield f"data: {json.dumps({'type': 'log_snapshot', 'lines': tail_lines, 'truncated': truncated, 'tail_limit': tail_limit}, ensure_ascii=False)}\n\n"

                if row["status"] not in ("queued", "running"):
                    yield f"data: {json.dumps({'type': 'done', 'status': row['status']}, ensure_ascii=False)}\n\n"
                    return

                if snap := manager.get_live_snapshot(run_id):
                    yield f"data: {json.dumps({'type': 'stats', 'downloaded_count': snap['downloaded_count'], 'skipped_count': snap['skipped_count'], 'postprocess_ok': snap['postprocess_ok'], 'postprocess_warn': snap['postprocess_warn'], 'duration_sec': snap['duration_sec']}, ensure_ascii=False)}\n\n"

                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15.0)
                        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                        if ev.get("type") == "done":
                            break
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        with database.session() as c2:
                            cur = c2.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
                            if cur and cur["status"] not in ("queued", "running"):
                                yield f"data: {json.dumps({'type': 'done', 'status': cur['status']}, ensure_ascii=False)}\n\n"
                                break
            finally:
                manager.unsubscribe_run(run_id, q)

        return StreamingResponse(
            event_gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def api_runs_cancel(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        run_id = int(request.path_params["run_id"])
        ok = await manager.cancel_run(run_id)
        return JSONResponse({"ok": ok})

    async def api_runs_retry(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        run_id = int(request.path_params["run_id"])
        with database.session() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "运行记录不存在"}, status_code=404)
        if row["task_id"] is not None:
            new_run_id, already = manager.enqueue_task(int(row["task_id"]), trigger_type="retry", simulate=bool(row["simulate"]))
            return JSONResponse({"run_id": new_run_id, "already_active": already})
        urls = json.loads(row["urls_json"])
        new_run_id = manager.enqueue_adhoc(urls=urls, simulate=bool(row["simulate"]), name=f"重试 #{run_id}")
        return JSONResponse({"run_id": new_run_id, "already_active": False})

    async def api_config_overview(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        settings = get_app_settings(database)
        conf = load_global_config(database)
        sites = summarize_sites(
            conf,
            settings["postprocess_default_sites"],
            settings.get("postprocess_site_configs"),
        )
        with database.session() as conn:
            snaps = conn.execute(
                "SELECT id, created_at, note FROM config_snapshots ORDER BY id DESC LIMIT 15"
            ).fetchall()
        downloader = conf.get("downloader", {}) if isinstance(conf.get("downloader"), dict) else {}
        extractor = conf.get("extractor", {}) if isinstance(conf.get("extractor"), dict) else {}
        return JSONResponse(
            {
                "settings": settings,
                "downloader": {
                    "retries": downloader.get("retries", 4),
                    "timeout": downloader.get("timeout", 30.0),
                    "mtime": downloader.get("mtime", False),
                },
                "default_skip": extractor.get("skip", "abort:7"),
                "sites": sites,
                "snapshots": [dict(s) for s in snaps],
            }
        )

    async def api_config_settings(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        global_proxy = str(body.get("global_proxy", "")).strip()
        max_concurrency = max(1, min(3, int(body.get("max_concurrency", 1))))
        log_retention_days = max(1, min(365, int(body.get("log_retention_days", 30))))
        pp_sites = body.get("postprocess_default_sites", ["twitter"])
        if not isinstance(pp_sites, list):
            pp_sites = ["twitter"]
        pp_sites = [str(s).strip() for s in pp_sites if str(s).strip()]

        database.set_setting("global_proxy", global_proxy)
        database.set_setting("max_concurrency", str(max_concurrency))
        database.set_setting("log_retention_days", str(log_retention_days))

        site_cfgs = get_postprocess_site_configs(database, pp_sites)
        pp_set = set(pp_sites)
        for s_key in list(site_cfgs.keys()):
            site_cfgs[s_key]["enabled"] = s_key in pp_set
        for s_key in pp_sites:
            if s_key not in site_cfgs:
                site_cfgs[s_key] = {
                    "enabled": True,
                    "mode": "builtin",
                    "date_template": DEFAULT_DATE_TEMPLATE,
                    "extra_args": "",
                    "custom_command": "",
                }
        save_postprocess_site_configs(database, site_cfgs)

        conf = load_global_config(database)
        extractor = conf.setdefault("extractor", {})
        if "default_skip" in body:
            raw_skip = str(body.get("default_skip", "")).strip()
            if raw_skip:
                extractor["skip"] = raw_skip
            else:
                extractor.pop("skip", None)
        downloader = conf.setdefault("downloader", {})
        if "retries" in body:
            downloader["retries"] = max(0, min(20, int(body["retries"])))
        if "timeout" in body:
            downloader["timeout"] = max(5.0, min(300.0, float(body["timeout"])))
        save_global_config(database, conf, note="更新全局下载与后处理设置")
        return JSONResponse({"ok": True})

    async def api_config_proxy_test(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        proxy_url = str(body.get("proxy_url", "")).strip()
        test_url = str(body.get("test_url", "https://api.github.com/zen")).strip() or "https://api.github.com/zen"
        handlers = []
        if proxy_url:
            handlers.append(urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}))
        opener = urllib.request.build_opener(*handlers)
        try:
            def _do():
                req = urllib.request.Request(test_url, headers={"User-Agent": "gallery-dl-manager/1.0"})
                with opener.open(req, timeout=10) as resp:
                    return resp.status, resp.read(120).decode("utf-8", errors="replace")

            status_code, preview = await asyncio.to_thread(_do)
            return JSONResponse({"ok": 200 <= status_code < 400, "status": status_code, "detail": preview})
        except Exception as exc:
            return JSONResponse({"ok": False, "detail": redact_text(str(exc), [proxy_url])})

    async def api_config_site_get(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        site = request.path_params["site"].strip()
        conf = load_global_config(database)
        settings = get_app_settings(database)
        site_cfg = conf.get("extractor", {}).get(site, {})
        if not isinstance(site_cfg, dict):
            site_cfg = {}
        pp_map = settings.get("postprocess_site_configs", {})
        pp_cfg = pp_map.get(
            site,
            {
                "enabled": site in settings["postprocess_default_sites"],
                "mode": "builtin",
                "date_template": DEFAULT_DATE_TEMPLATE,
                "extra_args": "",
                "custom_command": "",
            },
        )
        pp_preview = (
            describe_postprocess_preview(
                mode=pp_cfg["mode"],
                date_template=pp_cfg["date_template"],
                extra_args=pp_cfg["extra_args"],
                custom_command=pp_cfg["custom_command"],
            )
            if pp_cfg.get("enabled")
            else describe_postprocess_preview(mode="disabled")
        )
        return JSONResponse(
            {
                "site": site,
                "username": site_cfg.get("username", ""),
                "has_password": bool(site_cfg.get("password")),
                "has_api_key": bool(site_cfg.get("api-key")),
                "user_id": site_cfg.get("user-id", ""),
                "browser": site_cfg.get("browser", ""),
                "user_agent": site_cfg.get("user-agent", ""),
                "filename": site_cfg.get("filename", ""),
                "skip": site_cfg.get("skip", ""),
                "cookie_keys": list((site_cfg.get("cookies") or {}).keys()) if isinstance(site_cfg.get("cookies"), dict) else [],
                "postprocess_enabled": bool(pp_cfg.get("enabled")),
                "postprocess_config": pp_cfg,
                "postprocess_preview": pp_preview,
            }
        )

    async def api_config_site_put(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        site = request.path_params["site"].strip()
        if not site:
            return JSONResponse({"error": "站点名不能为空"}, status_code=400)
        body = await request.json()

        pp_enabled = bool(body.get("postprocess_enabled", False))
        pp_type = str(body.get("postprocess_type", "builtin"))
        if pp_type not in ("builtin", "custom"):
            pp_type = "builtin"
        pp_date = str(body.get("postprocess_date_field", DEFAULT_DATE_TEMPLATE)).strip() or DEFAULT_DATE_TEMPLATE
        pp_extra = str(body.get("postprocess_extra_args", "")).strip()
        pp_cmd = str(body.get("postprocess_command", "")).strip()
        if pp_enabled:
            try:
                build_postprocessor_spec(mode=pp_type, date_template=pp_date, extra_args=pp_extra, custom_command=pp_cmd)
            except ValueError as exc:
                return JSONResponse({"error": str(exc)}, status_code=400)

        conf = load_global_config(database)
        extractor = conf.setdefault("extractor", {})
        site_cfg = copy.deepcopy(extractor.get(site) if isinstance(extractor.get(site), dict) else {})

        for body_key, conf_key in (
            ("username", "username"),
            ("user_id", "user-id"),
            ("browser", "browser"),
            ("user_agent", "user-agent"),
            ("filename", "filename"),
            ("skip", "skip"),
        ):
            if body_key in body:
                val = str(body[body_key]).strip()
                if val:
                    site_cfg[conf_key] = val
                else:
                    site_cfg.pop(conf_key, None)

        if str(body.get("password", "")).strip():
            site_cfg["password"] = str(body["password"]).strip()
        elif body.get("clear_password"):
            site_cfg.pop("password", None)

        if str(body.get("api_key", "")).strip():
            site_cfg["api-key"] = str(body["api_key"]).strip()
        elif body.get("clear_api_key"):
            site_cfg.pop("api-key", None)

        cookies_raw = str(body.get("cookies_input", "")).strip()
        if body.get("clear_cookies"):
            site_cfg.pop("cookies", None)
        elif cookies_raw:
            try:
                parsed_cookies = parse_cookies_input(cookies_raw)
            except ValueError as exc:
                return JSONResponse({"error": str(exc)}, status_code=400)
            site_cfg["cookies"] = parsed_cookies

        extractor[site] = site_cfg
        save_global_config(database, conf, note=f"更新站点 {site} 配置")

        if "postprocess_enabled" in body or "postprocess_type" in body:
            settings = get_app_settings(database)
            site_cfgs = get_postprocess_site_configs(database, settings["postprocess_default_sites"])
            site_cfgs[site] = {
                "enabled": pp_enabled,
                "mode": pp_type,
                "date_template": pp_date,
                "extra_args": pp_extra,
                "custom_command": pp_cmd,
            }
            save_postprocess_site_configs(database, site_cfgs)

        return JSONResponse({"ok": True, "cookie_count": len(site_cfg.get("cookies", {}))})

    async def api_config_postprocess_preview(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        mode = str(body.get("mode", "builtin"))
        return JSONResponse(
            describe_postprocess_preview(
                mode=mode,
                date_template=str(body.get("date_template", "")),
                extra_args=str(body.get("extra_args", "")),
                custom_command=str(body.get("custom_command", "")),
            )
        )

    async def api_config_site_delete(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        site = request.path_params["site"].strip()
        conf = load_global_config(database)
        extractor = conf.get("extractor", {})
        if isinstance(extractor, dict) and site in extractor:
            extractor.pop(site)
            save_global_config(database, conf, note=f"删除站点 {site} 配置")
        return JSONResponse({"ok": True})

    async def api_config_raw_get(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        conf = load_global_config(database)
        return JSONResponse({"config_json": json.dumps(conf, ensure_ascii=False, indent=2)})

    async def api_config_raw_put(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        raw_text = str(body.get("config_json", ""))
        note = str(body.get("note", "手动编辑 JSON 配置")).strip() or "手动编辑 JSON 配置"
        try:
            parsed = json.loads(raw_text)
            if not isinstance(parsed, dict):
                raise ValueError("根配置必须是 JSON 对象")
        except Exception as exc:
            return JSONResponse({"error": f"JSON 格式错误: {exc}"}, status_code=400)
        snap_id = save_global_config(database, parsed, note=note)
        return JSONResponse({"ok": True, "snapshot_id": snap_id})

    async def api_config_snapshot_restore(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        snap_id = int(request.path_params["snap_id"])
        with database.session() as conn:
            row = conn.execute("SELECT config_json, note FROM config_snapshots WHERE id = ?", (snap_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "配置快照不存在"}, status_code=404)
        parsed = json.loads(row["config_json"])
        new_id = save_global_config(database, parsed, note=f"回滚至快照 #{snap_id}")
        return JSONResponse({"ok": True, "snapshot_id": new_id})

    async def api_inputs_list(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        return JSONResponse({"files": list_input_files(), "inputs_dir": "/data/inputs"})

    async def api_inputs_upload(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        ct = request.headers.get("content-type", "")
        try:
            if "multipart/form-data" in ct:
                form = await request.form()
                upload = form.get("file")
                if upload is None:
                    raise ValueError("缺少上传文件")
                filename = str(form.get("filename") or getattr(upload, "filename", "list.txt"))
                raw_bytes = await upload.read()
                content = raw_bytes.decode("utf-8", errors="replace")
            else:
                body = await request.json()
                filename = str(body.get("filename", ""))
                content = str(body.get("content", ""))
            meta = save_input_file(filename, content)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"file": meta}, status_code=201)

    async def api_inputs_delete(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        try:
            ok = delete_input_file(request.path_params["filename"])
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        if not ok:
            return JSONResponse({"error": "文件不存在"}, status_code=404)
        return JSONResponse({"ok": True})

    async def api_notifications_get(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        cfg = notifier.load_notification_config(database)
        with database.session() as conn:
            logs = conn.execute(
                "SELECT * FROM notification_logs ORDER BY id DESC LIMIT 30"
            ).fetchall()
        return JSONResponse({"config": cfg, "logs": [dict(r) for r in logs]})

    async def api_notifications_put(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        try:
            saved = notifier.save_notification_config(database, body)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"config": saved})

    async def api_notifications_test(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        body = await request.json()
        channel = body.get("channel")
        cfg = body.get("config") or notifier.load_notification_config(database)
        settings = get_app_settings(database)
        res = await asyncio.to_thread(
            notifier.send_test_notification,
            database,
            cfg,
            channel,
            settings["global_proxy"],
        )
        return JSONResponse(res)

    async def api_archive_twitter_ids_get(request: Request) -> Response:
        if err := _guard_sync_or_admin(request):
            return err
        payload = await asyncio.to_thread(twitter_likes.get_twitter_ids_payload, database, None, True)
        if_none_match = request.headers.get("If-None-Match", "").strip('"')
        if if_none_match and if_none_match == payload["etag"]:
            return Response(status_code=304, headers={"ETag": f'"{payload["etag"]}"', "Cache-Control": "no-cache"})
        return JSONResponse(payload, headers={"ETag": f'"{payload["etag"]}"', "Cache-Control": "no-cache"})

    async def api_archive_twitter_ids_post(request: Request) -> Response:
        if err := _guard_sync_or_admin(request):
            return err
        body = await request.json()
        add_ids = body.get("add") if isinstance(body.get("add"), list) else []
        remove_ids = body.get("remove") if isinstance(body.get("remove"), list) else []
        source = str(body.get("source", "browser")).strip() or "browser"
        res = await asyncio.to_thread(twitter_likes.update_browser_ids, database, add_ids, remove_ids, source)
        return JSONResponse({"ok": True, **res})

    async def api_twitter_sync_status(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        token = twitter_likes.get_or_create_sync_token(database)
        summary = await asyncio.to_thread(twitter_likes.get_twitter_ids_payload, database, None, False)
        return JSONResponse({"token": token, **summary})

    async def api_twitter_sync_rotate_token(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        token = twitter_likes.rotate_sync_token(database)
        return JSONResponse({"ok": True, "token": token})

    async def api_twitter_sync_scan_disk(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        scan_res = await asyncio.to_thread(twitter_likes.scan_twitter_disk_dir, database)
        summary = await asyncio.to_thread(twitter_likes.get_twitter_ids_payload, database, None, False)
        return JSONResponse({"ok": True, **scan_res, **summary})

    async def api_twitter_sync_import_like_js(request: Request) -> Response:
        if err := _guard_api(request):
            return err
        ct = request.headers.get("content-type", "")
        try:
            if "multipart/form-data" in ct:
                form = await request.form()
                upload = form.get("file")
                if upload is None:
                    raise ValueError("缺少上传文件")
                raw_bytes = await upload.read()
                content = raw_bytes.decode("utf-8", errors="replace")
            else:
                body = await request.json()
                content = str(body.get("content", ""))
            imp_res = await asyncio.to_thread(twitter_likes.import_like_js, database, content)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        summary = await asyncio.to_thread(twitter_likes.get_twitter_ids_payload, database, None, False)
        return JSONResponse({"ok": True, **imp_res, **summary})

    async def api_twitter_sync_userscript(request: Request) -> Response:
        if not _is_authenticated(request):
            return JSONResponse({"error": "未登录或会话已过期"}, status_code=401)
        token = twitter_likes.get_or_create_sync_token(database)
        server_url = str(request.base_url).rstrip("/")
        connect_host = request.url.hostname or ""
        script = twitter_likes.render_userscript(server_url=server_url, token=token, connect_host=connect_host)
        return Response(
            script,
            media_type="application/javascript; charset=utf-8",
            headers={
                "Content-Disposition": 'attachment; filename="gallery-dl-x-permanent-likes.user.js"',
                "Cache-Control": "no-store",
            },
        )

    routes = [
        Route("/health", health, methods=["GET"]),
        Route("/", page_index, methods=["GET"]),
        Route("/login", page_login, methods=["GET"]),
        Route("/setup", page_setup, methods=["GET"]),
        Route("/api/auth/status", api_auth_status, methods=["GET"]),
        Route("/api/auth/setup", api_auth_setup, methods=["POST"]),
        Route("/api/auth/login", api_auth_login, methods=["POST"]),
        Route("/api/auth/logout", api_auth_logout, methods=["POST"]),
        Route("/api/auth/password", api_auth_password, methods=["POST"]),
        Route("/api/dashboard", api_dashboard, methods=["GET"]),
        Route("/api/alerts", api_alerts_list, methods=["GET"]),
        Route("/api/alerts/read", api_alerts_read, methods=["POST"]),
        Route("/api/alerts/clear", api_alerts_clear, methods=["POST"]),
        Route("/api/scheduler/pause", api_scheduler_pause, methods=["POST"]),
        Route("/api/scheduler/resume", api_scheduler_resume, methods=["POST"]),
        Route("/api/download", api_download, methods=["POST"]),
        Route("/api/tasks", api_tasks_list, methods=["GET"]),
        Route("/api/tasks", api_tasks_create, methods=["POST"]),
        Route("/api/tasks/enable-all", api_tasks_enable_all, methods=["POST"]),
        Route("/api/tasks/batch", api_tasks_batch, methods=["POST"]),
        Route("/api/tasks/dismiss-import-notice", api_tasks_dismiss_notice, methods=["POST"]),
        Route("/api/tasks/{task_id:int}", api_tasks_update, methods=["PUT"]),
        Route("/api/tasks/{task_id:int}", api_tasks_delete, methods=["DELETE"]),
        Route("/api/tasks/{task_id:int}/run", api_tasks_run, methods=["POST"]),
        Route("/api/tasks/{task_id:int}/toggle", api_tasks_toggle, methods=["POST"]),
        Route("/api/cron/preview", api_cron_preview, methods=["POST"]),
        Route("/api/runs", api_runs_list, methods=["GET"]),
        Route("/api/runs/{run_id:int}", api_runs_detail, methods=["GET"]),
        Route("/api/runs/{run_id:int}/log", api_runs_log, methods=["GET"]),
        Route("/api/runs/{run_id:int}/stream", api_runs_stream, methods=["GET"]),
        Route("/api/runs/{run_id:int}/cancel", api_runs_cancel, methods=["POST"]),
        Route("/api/runs/{run_id:int}/retry", api_runs_retry, methods=["POST"]),
        Route("/api/config/overview", api_config_overview, methods=["GET"]),
        Route("/api/config/settings", api_config_settings, methods=["PUT"]),
        Route("/api/config/proxy-test", api_config_proxy_test, methods=["POST"]),
        Route("/api/config/postprocess-preview", api_config_postprocess_preview, methods=["POST"]),
        Route("/api/config/site/{site:str}", api_config_site_get, methods=["GET"]),
        Route("/api/config/site/{site:str}", api_config_site_put, methods=["PUT"]),
        Route("/api/config/site/{site:str}", api_config_site_delete, methods=["DELETE"]),
        Route("/api/config/raw", api_config_raw_get, methods=["GET"]),
        Route("/api/config/raw", api_config_raw_put, methods=["PUT"]),
        Route("/api/config/snapshots/{snap_id:int}/restore", api_config_snapshot_restore, methods=["POST"]),
        Route("/api/inputs", api_inputs_list, methods=["GET"]),
        Route("/api/inputs/upload", api_inputs_upload, methods=["POST"]),
        Route("/api/inputs/{filename:str}", api_inputs_delete, methods=["DELETE"]),
        Route("/api/archive/twitter-ids", api_archive_twitter_ids_get, methods=["GET"]),
        Route("/api/archive/twitter-ids", api_archive_twitter_ids_post, methods=["POST"]),
        Route("/api/twitter-sync/status", api_twitter_sync_status, methods=["GET"]),
        Route("/api/twitter-sync/token/rotate", api_twitter_sync_rotate_token, methods=["POST"]),
        Route("/api/twitter-sync/scan-disk", api_twitter_sync_scan_disk, methods=["POST"]),
        Route("/api/twitter-sync/import-like-js", api_twitter_sync_import_like_js, methods=["POST"]),
        Route("/api/twitter-sync/userscript.user.js", api_twitter_sync_userscript, methods=["GET"]),
        Route("/api/notifications", api_notifications_get, methods=["GET"]),
        Route("/api/notifications", api_notifications_put, methods=["PUT"]),
        Route("/api/notifications/test", api_notifications_test, methods=["POST"]),
        Mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static"),
    ]

    return Starlette(routes=routes, lifespan=lifespan)
