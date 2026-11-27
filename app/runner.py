"""Async task scheduler, subprocess runner, output parser, and SSE log broadcaster."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import signal
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app import cron as cron_mod
from app import notifier
from app.config_manager import (
    count_valid_urls,
    extract_secret_values,
    get_app_settings,
    get_download_dir,
    get_inputs_dir,
    load_global_config,
    redact_text,
    synthesize_runtime_config,
    validate_input_filename,
)
from app.db import Database, get_data_dir, utc_now_iso

DEFAULT_LOG_TAIL_LINES = 300
MAX_LOG_TAIL_LINES = 2000


def tail_log_lines(path: Path | None, max_lines: int = DEFAULT_LOG_TAIL_LINES) -> tuple[list[str], bool]:
    """Read the last `max_lines` lines from a UTF-8 log file in bounded O(tail) chunks."""
    if path is None or not path.is_file():
        return [], False
    limit = max(1, int(max_lines))
    chunk_size = 65536
    chunks: list[bytes] = []
    newline_count = 0
    truncated = False
    with path.open("rb") as f:
        f.seek(0, 2)
        pos = f.tell()
        if pos == 0:
            return [], False
        while pos > 0 and newline_count <= limit:
            step = min(chunk_size, pos)
            pos -= step
            f.seek(pos)
            chunk = f.read(step)
            chunks.append(chunk)
            newline_count += chunk.count(b"\n")
    raw = b"".join(reversed(chunks))
    if pos > 0:
        truncated = True
        idx = raw.find(b"\n")
        if idx != -1:
            raw = raw[idx + 1 :]
    lines = raw.decode("utf-8", errors="replace").splitlines()
    if len(lines) > limit:
        lines = lines[-limit:]
        truncated = True
    return lines, truncated

_ERROR_LINE_RE = re.compile(r"\[[^\]]+\]\[error\]\s*(.+)", re.IGNORECASE)
_AUTH_HINT_RE = re.compile(
    r"(401\s*unauthorized|authorizationerror|authenticationerror|login\s*required|invalid\s*cookie|expired\s*cookie|not\s*logged\s*in)",
    re.IGNORECASE,
)
_CHALLENGE_HINT_RE = re.compile(
    r"(challengeerror|cloudflare|403\s*forbidden|http\s*error\s*403)",
    re.IGNORECASE,
)


def parse_gallery_dl_line(line: str, download_dir: str | Path = "/gallery-dl") -> dict[str, Any]:
    """Classify a single output line from gallery-dl / postprocess.py."""
    text = line.rstrip("\r\n")
    stripped = text.strip()
    dl_prefix = str(download_dir).rstrip("/") + "/"

    if stripped.startswith("[postprocess][ok]"):
        return {"kind": "postprocess_ok", "text": text}
    if stripped.startswith("[postprocess][warn]"):
        return {"kind": "postprocess_warn", "text": text}
    if stripped.startswith("[postprocess][skip]"):
        return {"kind": "postprocess_skip", "text": text}

    if stripped.startswith("# "):
        candidate = stripped[2:].strip()
        if candidate.startswith(dl_prefix) or candidate.startswith("/"):
            return {"kind": "skipped_file", "path": candidate, "text": text}

    if stripped.startswith(dl_prefix):
        return {"kind": "downloaded_file", "path": stripped, "text": text}

    m = _ERROR_LINE_RE.search(stripped)
    if m:
        return {"kind": "error", "message": m.group(1).strip(), "text": text}

    if "[warning]" in stripped.lower():
        return {"kind": "warning", "message": stripped, "text": text}

    return {"kind": "info", "text": text}


def classify_run_result(
    exit_code: int | None,
    errors: list[str],
    downloaded_count: int,
    cancelled: bool,
) -> tuple[str, str, str]:
    """Map exit code + parsed error lines into (status, error_category, error_summary)."""
    if cancelled:
        return "cancelled", "cancelled", "任务已被手动中止"

    joined = "\n".join(errors)
    last_err = errors[-1] if errors else ""

    if (exit_code is not None and (exit_code & 16)) or _AUTH_HINT_RE.search(joined):
        return "auth_error", "auth_error", last_err or "认证或 Cookie 可能已失效"

    if _CHALLENGE_HINT_RE.search(joined):
        return "partial" if downloaded_count > 0 else "failed", "cloudflare_403", last_err or "触发 Cloudflare / 403 访问拦截"

    if exit_code == 0 and not errors:
        return "success", "", ""

    if exit_code in (4, 8, 12) and downloaded_count > 0:
        return "partial", "partial_error", last_err or f"部分链接执行异常 (exit={exit_code})"

    if exit_code == 0 and errors:
        return "partial", "warning_error", last_err

    return "failed", "runtime_error", last_err or f"gallery-dl 异常退出 (exit={exit_code})"


class TaskManager:
    """Coordinates cron scheduling, run queueing, subprocess execution, and SSE streaming."""

    def __init__(self, db: Database) -> None:
        self.db = db
        self.queue: asyncio.Queue[int] = asyncio.Queue()
        self.active_procs: dict[int, asyncio.subprocess.Process] = {}
        self.live_runs: dict[int, dict[str, Any]] = {}
        self.cancelled_runs: set[int] = set()
        self.subscribers: dict[int, set[asyncio.Queue[dict[str, Any]]]] = {}
        self.global_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._workers: list[asyncio.Task[Any]] = []
        self._scheduler_task: asyncio.Task[Any] | None = None
        self._stop_event = asyncio.Event()
        self._last_cleanup_day: str = ""

    @property
    def logs_dir(self) -> Path:
        p = get_data_dir() / "logs"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def get_live_snapshot(self, run_id: int) -> dict[str, Any] | None:
        """Return live counters and downloaded files for an active run."""
        live = self.live_runs.get(run_id)
        if live is None:
            return None
        return {
            "downloaded_count": live["downloaded_count"],
            "skipped_count": live["skipped_count"],
            "postprocess_ok": live["postprocess_ok"],
            "postprocess_warn": live["postprocess_warn"],
            "duration_sec": round(time.monotonic() - live["started_mono"], 1),
            "files": list(live["files"]),
        }

    def subscribe_run(self, run_id: int) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
        self.subscribers.setdefault(run_id, set()).add(q)
        return q

    def unsubscribe_run(self, run_id: int, q: asyncio.Queue[dict[str, Any]]) -> None:
        subs = self.subscribers.get(run_id)
        if subs:
            subs.discard(q)
            if not subs:
                self.subscribers.pop(run_id, None)

    def _emit_run_event(self, run_id: int, event: dict[str, Any]) -> None:
        for q in list(self.subscribers.get(run_id, ())):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def subscribe_global(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
        self.global_subscribers.add(q)
        return q

    def unsubscribe_global(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self.global_subscribers.discard(q)

    def emit_global(self, event: dict[str, Any]) -> None:
        self._emit_global_event(event)

    def _emit_global_event(self, event: dict[str, Any]) -> None:
        for q in list(self.global_subscribers):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    async def start(self) -> None:
        self._stop_event.clear()
        settings = get_app_settings(self.db)
        worker_count = max(1, min(3, int(settings.get("max_concurrency", 1))))
        for i in range(worker_count):
            self._workers.append(asyncio.create_task(self._worker_loop(i)))
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        for run_id in list(self.active_procs):
            await self.cancel_run(run_id)
        if self._scheduler_task:
            self._scheduler_task.cancel()
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*(self._workers + ([self._scheduler_task] if self._scheduler_task else [])), return_exceptions=True)
        self._workers.clear()
        self._scheduler_task = None

    def enqueue_task(self, task_id: int, *, trigger_type: str = "manual", simulate: bool = False) -> tuple[int, bool]:
        """Enqueue a saved task if not already queued/running. Returns (run_id, already_active)."""
        with self.db.session() as conn:
            active = conn.execute(
                "SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1",
                (task_id,),
            ).fetchone()
            if active is not None:
                return int(active["id"]), True

            task = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if task is None:
                raise ValueError(f"任务不存在: {task_id}")

            urls_val = json.loads(task["urls_json"])
            if not urls_val and "input_file" in task.keys() and task["input_file"]:
                urls_val = [f"file:{task['input_file']}"]
            now = utc_now_iso()
            cur = conn.execute(
                """
                INSERT INTO runs (task_id, task_name, trigger_type, urls_json, simulate, status, log_file, created_at)
                VALUES (?, ?, ?, ?, ?, 'queued', '', ?)
                """,
                (task_id, task["name"], trigger_type, json.dumps(urls_val, ensure_ascii=False), 1 if simulate else 0, now),
            )
            run_id = int(cur.lastrowid)
            log_file = str(self.logs_dir / f"run-{run_id}.log")
            conn.execute("UPDATE runs SET log_file = ? WHERE id = ?", (log_file, run_id))

        self.queue.put_nowait(run_id)
        self._emit_global_event({"type": "run_queued", "run_id": run_id, "task_id": task_id})
        return run_id, False

    def enqueue_adhoc(
        self,
        *,
        urls: list[str],
        input_file: str = "",
        proxy_mode: str = "inherit",
        proxy_url: str = "",
        subdir: str = "",
        skip_mode: str = "",
        filename_format: str = "",
        extra_args: str = "",
        use_archive: bool = False,
        archive_backfill: bool = False,
        postprocess_mode: str = "inherit",
        postprocess_date_field: str = "",
        postprocess_command: str = "",
        simulate: bool = False,
        name: str = "临时下载",
    ) -> int:
        clean_urls = [u.strip() for u in urls if u.strip() and not u.strip().startswith("#")]
        safe_input_file = validate_input_filename(input_file) if input_file.strip() else ""
        if not clean_urls and not safe_input_file:
            raise ValueError("请至少提供一个有效的 URL 或选择输入文件")

        now = utc_now_iso()
        adhoc_opts = {
            "input_file": safe_input_file,
            "proxy_mode": proxy_mode,
            "proxy_url": proxy_url,
            "subdir": subdir,
            "skip_mode": skip_mode,
            "filename_format": filename_format,
            "extra_args": extra_args,
            "use_archive": use_archive,
            "archive_backfill": archive_backfill,
            "postprocess_mode": postprocess_mode,
            "postprocess_date_field": postprocess_date_field,
            "postprocess_command": postprocess_command,
        }
        stored_urls = clean_urls if clean_urls else [f"file:{safe_input_file}"]
        with self.db.session() as conn:
            cur = conn.execute(
                """
                INSERT INTO runs (task_id, task_name, trigger_type, urls_json, simulate, status, error_summary, log_file, created_at)
                VALUES (NULL, ?, 'adhoc', ?, ?, 'queued', ?, '', ?)
                """,
                (name, json.dumps(stored_urls, ensure_ascii=False), 1 if simulate else 0, json.dumps(adhoc_opts, ensure_ascii=False), now),
            )
            run_id = int(cur.lastrowid)
            log_file = str(self.logs_dir / f"run-{run_id}.log")
            conn.execute("UPDATE runs SET log_file = ?, error_summary = '' WHERE id = ?", (log_file, run_id))

        self.db.set_setting(f"adhoc_opts:{run_id}", json.dumps(adhoc_opts, ensure_ascii=False))
        self.queue.put_nowait(run_id)
        self._emit_global_event({"type": "run_queued", "run_id": run_id, "task_id": None})
        return run_id

    async def cancel_run(self, run_id: int) -> bool:
        self.cancelled_runs.add(run_id)
        proc = self.active_procs.get(run_id)
        if proc is not None and proc.returncode is None:
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, signal.SIGTERM)
            except Exception:
                try:
                    proc.terminate()
                except Exception:
                    pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception:
                    proc.kill()
            return True

        # If queued (not started yet), mark cancelled immediately in DB
        with self.db.session() as conn:
            row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
            if row and row["status"] == "queued":
                conn.execute(
                    "UPDATE runs SET status = 'cancelled', finished_at = ?, error_category = 'cancelled', error_summary = '队列中被取消' WHERE id = ?",
                    (utc_now_iso(), run_id),
                )
                self._emit_run_event(run_id, {"type": "done", "status": "cancelled"})
                self._emit_global_event({"type": "run_finished", "run_id": run_id, "status": "cancelled"})
                return True
        return False

    async def _worker_loop(self, _worker_idx: int) -> None:
        while not self._stop_event.is_set():
            try:
                run_id = await asyncio.wait_for(self.queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            try:
                await self._execute_run(run_id)
            except Exception as exc:
                print(f"[runner] unexpected error for run #{run_id}: {exc}", flush=True)
            finally:
                self.queue.task_done()

    async def _execute_run(self, run_id: int) -> None:
        with self.db.session() as conn:
            run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not run or run["status"] != "queued":
                return
            task = (
                conn.execute("SELECT * FROM tasks WHERE id = ?", (run["task_id"],)).fetchone()
                if run["task_id"] is not None
                else None
            )

        if run_id in self.cancelled_runs:
            self.cancelled_runs.discard(run_id)
            return

        urls: list[str] = json.loads(run["urls_json"])
        simulate = bool(run["simulate"])
        log_path = Path(run["log_file"] or (self.logs_dir / f"run-{run_id}.log"))
        log_path.parent.mkdir(parents=True, exist_ok=True)

        settings = get_app_settings(self.db)
        base_conf = load_global_config(self.db)
        archive_path = str(get_data_dir() / "archive.sqlite3")

        if task is not None:
            tkeys = task.keys()
            opts = {
                "proxy_mode": task["proxy_mode"],
                "proxy_url": task["proxy_url"],
                "subdir": task["subdir"],
                "skip_mode": task["skip_mode"],
                "filename_format": task["filename_format"] if "filename_format" in tkeys else "",
                "input_file": task["input_file"] if "input_file" in tkeys else "",
                "extra_args": task["extra_args"],
                "use_archive": bool(task["use_archive"]),
                "archive_backfill": bool(task["archive_backfill"]) if "archive_backfill" in tkeys else False,
                "postprocess_mode": task["postprocess_mode"],
                "postprocess_date_field": task["postprocess_date_field"] if "postprocess_date_field" in tkeys else "",
                "postprocess_command": task["postprocess_command"] if "postprocess_command" in tkeys else "",
            }
            previous_status = task["last_status"]
        else:
            raw_opts = self.db.get_setting(f"adhoc_opts:{run_id}")
            opts = json.loads(raw_opts) if raw_opts else {}
            self.db.delete_setting(f"adhoc_opts:{run_id}")
            previous_status = None

        runtime_conf = synthesize_runtime_config(
            base_conf,
            global_proxy=settings["global_proxy"],
            proxy_mode=opts.get("proxy_mode", "inherit"),
            proxy_url=opts.get("proxy_url", ""),
            subdir=opts.get("subdir", ""),
            skip_mode=opts.get("skip_mode", ""),
            filename_format=opts.get("filename_format", ""),
            use_archive=bool(opts.get("use_archive", False)),
            archive_backfill=bool(opts.get("archive_backfill", False)),
            archive_path=archive_path,
            postprocess_mode=opts.get("postprocess_mode", "inherit"),
            postprocess_date_field=opts.get("postprocess_date_field", ""),
            postprocess_command=opts.get("postprocess_command", ""),
            postprocess_default_sites=settings["postprocess_default_sites"],
            postprocess_site_configs=settings.get("postprocess_site_configs"),
            download_dir=get_download_dir(),
        )
        secret_values = extract_secret_values(
            runtime_conf,
            extra_secrets=[opts.get("proxy_url", ""), settings["global_proxy"]],
        )

        tmp_conf_path = get_data_dir() / f".runtime-conf-{run_id}.json"
        tmp_conf_path.write_text(json.dumps(runtime_conf, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_input_path: Path | None = None

        cmd = ["gallery-dl", "-c", str(tmp_conf_path)]
        if simulate:
            cmd.append("--simulate")
        extra_raw = str(opts.get("extra_args", "") or "").strip()
        if extra_raw:
            try:
                cmd.extend(shlex.split(extra_raw))
            except ValueError:
                pass

        input_file_name = str(opts.get("input_file", "") or "").strip()
        cmd_desc = ""
        input_error = ""
        if input_file_name:
            try:
                safe_name = validate_input_filename(input_file_name)
                inp_path = get_inputs_dir() / safe_name
                if not inp_path.is_file():
                    input_error = f"输入文件不存在: {inp_path}"
                else:
                    url_cnt = count_valid_urls(inp_path.read_text(encoding="utf-8", errors="replace"))
                    if url_cnt == 0:
                        input_error = f"输入文件中没有有效 URL: {inp_path}"
                    else:
                        cmd.extend(["-i", str(inp_path)])
                        cmd_desc = f"gallery-dl {' '.join(shlex.quote(x) for x in cmd[3:])} (共 {url_cnt} 条 URL)"
            except ValueError as exc:
                input_error = str(exc)
        elif len(urls) > 5:
            tmp_input_path = get_data_dir() / f".runtime-input-{run_id}.txt"
            tmp_input_path.write_text("\n".join(urls) + "\n", encoding="utf-8")
            cmd.extend(["-i", str(tmp_input_path)])
            cmd_desc = f"gallery-dl {' '.join(shlex.quote(x) for x in cmd[3:-2])} -i <临时列表> (共 {len(urls)} 条 URL)"
        else:
            cmd.extend(urls)
            cmd_desc = f"gallery-dl {' '.join(shlex.quote(x) for x in cmd[3:])}"

        started_at = utc_now_iso()
        t0 = time.monotonic()
        with self.db.session() as conn:
            conn.execute("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?", (started_at, run_id))
        self._emit_global_event({"type": "run_started", "run_id": run_id})

        downloaded_files: list[str] = []
        skipped_count = 0
        postprocess_ok = 0
        postprocess_warn = 0
        errors: list[str] = []
        dl_dir = get_download_dir()

        self.live_runs[run_id] = {
            "started_mono": t0,
            "downloaded_count": 0,
            "skipped_count": 0,
            "postprocess_ok": 0,
            "postprocess_warn": 0,
            "files": downloaded_files,
        }
        last_sse_stats_ts = 0.0
        last_db_flush_ts = 0.0

        def flush_progress(force_sse: bool = False, force_db: bool = False) -> None:
            nonlocal last_sse_stats_ts, last_db_flush_ts
            now_m = time.monotonic()
            dur = round(now_m - t0, 1)
            live = self.live_runs.get(run_id)
            if live is not None:
                live["downloaded_count"] = len(downloaded_files)
                live["skipped_count"] = skipped_count
                live["postprocess_ok"] = postprocess_ok
                live["postprocess_warn"] = postprocess_warn

            if force_sse or (now_m - last_sse_stats_ts >= 0.4):
                last_sse_stats_ts = now_m
                self._emit_run_event(
                    run_id,
                    {
                        "type": "stats",
                        "downloaded_count": len(downloaded_files),
                        "skipped_count": skipped_count,
                        "postprocess_ok": postprocess_ok,
                        "postprocess_warn": postprocess_warn,
                        "duration_sec": dur,
                    },
                )

            if force_db or (now_m - last_db_flush_ts >= 2.0):
                last_db_flush_ts = now_m
                with self.db.session() as c_prog:
                    c_prog.execute(
                        """
                        UPDATE runs
                        SET downloaded_count = ?, skipped_count = ?, postprocess_ok = ?, postprocess_warn = ?, duration_sec = ?
                        WHERE id = ?
                        """,
                        (len(downloaded_files), skipped_count, postprocess_ok, postprocess_warn, dur, run_id),
                    )

        def write_and_emit(line_text: str) -> None:
            safe_line = redact_text(line_text, secret_values)
            with log_path.open("a", encoding="utf-8") as lf:
                lf.write(safe_line + "\n")
            self._emit_run_event(run_id, {"type": "log", "line": safe_line})

        write_and_emit(f"[{datetime.now().astimezone():%F %T %Z}] ===== 开始执行 Run #{run_id}: {run['task_name']} =====")
        if input_error:
            errors.append(input_error)
            write_and_emit(f"[manager][error] {input_error}")
            exit_code: int | None = 1
        else:
            write_and_emit(f"[cmd] {cmd_desc}")
            exit_code = None
        proc: asyncio.subprocess.Process | None = None
        try:
            if not input_error:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    start_new_session=True,
                )
                self.active_procs[run_id] = proc
                assert proc.stdout is not None
                while True:
                    raw_bytes = await proc.stdout.readline()
                    if not raw_bytes:
                        break
                    raw_line = raw_bytes.decode("utf-8", errors="replace").rstrip("\r\n")
                    parsed = parse_gallery_dl_line(raw_line, dl_dir)
                    kind = parsed["kind"]
                    if kind == "downloaded_file":
                        downloaded_files.append(parsed["path"])
                        self._emit_run_event(run_id, {"type": "file", "file_path": parsed["path"]})
                        flush_progress(force_sse=True, force_db=True)
                    elif kind == "skipped_file":
                        skipped_count += 1
                        flush_progress()
                    elif kind == "postprocess_ok":
                        postprocess_ok += 1
                        flush_progress()
                    elif kind == "postprocess_warn":
                        postprocess_warn += 1
                        flush_progress()
                    elif kind == "error":
                        errors.append(parsed["message"])
                    write_and_emit(raw_line)
                exit_code = await proc.wait()
        except Exception as exc:
            errors.append(str(exc))
            write_and_emit(f"[manager][error] 进程执行异常: {exc}")
        finally:
            self.active_procs.pop(run_id, None)
            for tmp_p in (tmp_conf_path, tmp_input_path):
                if tmp_p is not None:
                    try:
                        tmp_p.unlink(missing_ok=True)
                    except Exception:
                        pass

        cancelled = run_id in self.cancelled_runs
        self.cancelled_runs.discard(run_id)
        duration_sec = round(time.monotonic() - t0, 2)
        finished_at = utc_now_iso()

        status, error_category, error_summary = classify_run_result(
            exit_code, errors, len(downloaded_files), cancelled
        )
        write_and_emit(
            f"[{datetime.now().astimezone():%F %T %Z}] ===== 执行结束: status={status}, exit={exit_code}, 新增={len(downloaded_files)}, 跳过={skipped_count}, 耗时={duration_sec:.1f}s ====="
        )

        with self.db.session() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = ?, exit_code = ?, finished_at = ?, duration_sec = ?,
                    downloaded_count = ?, skipped_count = ?, postprocess_ok = ?, postprocess_warn = ?,
                    error_summary = ?, error_category = ?
                WHERE id = ?
                """,
                (
                    status,
                    exit_code,
                    finished_at,
                    duration_sec,
                    len(downloaded_files),
                    skipped_count,
                    postprocess_ok,
                    postprocess_warn,
                    error_summary,
                    error_category,
                    run_id,
                ),
            )
            for fpath in downloaded_files:
                conn.execute(
                    "INSERT INTO run_files (run_id, file_path, status, created_at) VALUES (?, ?, 'downloaded', ?)",
                    (run_id, fpath, finished_at),
                )
            if run["task_id"] is not None:
                if status == "success":
                    conn.execute(
                        "UPDATE tasks SET last_run_id = ?, last_status = ?, last_run_at = ?, consecutive_failures = 0 WHERE id = ?",
                        (run_id, status, finished_at, run["task_id"]),
                    )
                elif status != "cancelled":
                    conn.execute(
                        "UPDATE tasks SET last_run_id = ?, last_status = ?, last_run_at = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?",
                        (run_id, status, finished_at, run["task_id"]),
                    )

        self.live_runs.pop(run_id, None)
        self._emit_run_event(
            run_id,
            {
                "type": "stats",
                "downloaded_count": len(downloaded_files),
                "skipped_count": skipped_count,
                "postprocess_ok": postprocess_ok,
                "postprocess_warn": postprocess_warn,
                "duration_sec": duration_sec,
            },
        )
        self._emit_run_event(run_id, {"type": "done", "status": status, "exit_code": exit_code})
        self._emit_global_event({"type": "run_finished", "run_id": run_id, "status": status})

        try:
            notifier.notify_run_finished(
                self.db,
                run_id=run_id,
                task_id=run["task_id"],
                task_name=run["task_name"],
                status=status,
                previous_status=previous_status,
                error_category=error_category,
                error_summary=error_summary,
                downloaded_count=len(downloaded_files),
                duration_sec=duration_sec,
                global_proxy=settings["global_proxy"],
            )
        except Exception as exc:
            print(f"[notifier] failed to dispatch notification for run #{run_id}: {exc}", flush=True)

    def _cleanup_old_logs(self, retention_days: int) -> None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
        for path in self.logs_dir.glob("run-*.log"):
            try:
                mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
                if mtime < cutoff:
                    path.unlink(missing_ok=True)
            except Exception:
                pass

    async def _scheduler_loop(self) -> None:
        last_minute: datetime | None = None
        while not self._stop_event.is_set():
            now_local = datetime.now().astimezone()
            cur_minute = now_local.replace(second=0, microsecond=0)
            if cur_minute != last_minute:
                last_minute = cur_minute
                settings = get_app_settings(self.db)
                if not settings["scheduler_paused"]:
                    with self.db.session() as conn:
                        rows = conn.execute("SELECT id, cron_expr FROM tasks WHERE enabled = 1").fetchall()
                    for row in rows:
                        try:
                            spec = cron_mod.parse_cron(row["cron_expr"])
                            if cron_mod.matches(cur_minute, spec):
                                self.enqueue_task(int(row["id"]), trigger_type="cron")
                        except Exception as exc:
                            print(f"[scheduler] invalid cron for task #{row['id']}: {exc}", flush=True)

                day_str = cur_minute.strftime("%Y-%m-%d")
                if day_str != self._last_cleanup_day:
                    self._last_cleanup_day = day_str
                    self._cleanup_old_logs(int(settings["log_retention_days"]))

            next_min = (datetime.now().astimezone().replace(second=0, microsecond=0) + timedelta(minutes=1))
            sleep_sec = max(0.5, min(5.0, (next_min - datetime.now().astimezone()).total_seconds()))
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_sec)
            except asyncio.TimeoutError:
                pass
