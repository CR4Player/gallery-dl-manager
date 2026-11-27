"""SQLite database initialization and helper queries."""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


def utc_now_iso() -> str:
    """Return current UTC timestamp in ISO-8601 format."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_data_dir() -> Path:
    """Return configured persistent data directory."""
    return Path(os.environ.get("DATA_DIR", "/data"))


def get_db_path() -> Path:
    """Return SQLite database path inside DATA_DIR."""
    return get_data_dir() / "app.db"


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    note TEXT NOT NULL,
    config_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    urls_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    cron_expr TEXT NOT NULL DEFAULT '0 */6 * * *',
    proxy_mode TEXT NOT NULL DEFAULT 'inherit',
    proxy_url TEXT NOT NULL DEFAULT '',
    subdir TEXT NOT NULL DEFAULT '',
    skip_mode TEXT NOT NULL DEFAULT '',
    extra_args TEXT NOT NULL DEFAULT '',
    use_archive INTEGER NOT NULL DEFAULT 0,
    archive_backfill INTEGER NOT NULL DEFAULT 0,
    filename_format TEXT NOT NULL DEFAULT '',
    input_file TEXT NOT NULL DEFAULT '',
    postprocess_mode TEXT NOT NULL DEFAULT 'inherit',
    postprocess_date_field TEXT NOT NULL DEFAULT '',
    postprocess_command TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_run_id INTEGER,
    last_status TEXT,
    last_run_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    task_name TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    urls_json TEXT NOT NULL,
    simulate INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    exit_code INTEGER,
    started_at TEXT,
    finished_at TEXT,
    duration_sec REAL,
    downloaded_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    postprocess_ok INTEGER NOT NULL DEFAULT 0,
    postprocess_warn INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT NOT NULL DEFAULT '',
    error_category TEXT NOT NULL DEFAULT '',
    log_file TEXT NOT NULL DEFAULT '',
    adhoc_opts_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twitter_liked_ids (
    tweet_id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'browser',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_states (
    alert_key TEXT PRIMARY KEY,
    read_at TEXT NOT NULL DEFAULT '',
    dismissed_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_run_files_run_id ON run_files(run_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_created_at ON notification_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twitter_liked_ids_source ON twitter_liked_ids(source);
"""


class Database:
    """Thread-safe SQLite wrapper using per-operation connections in WAL mode."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path) if db_path is not None else get_db_path()

    def connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=10.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    @contextmanager
    def session(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self.session() as conn:
            conn.executescript(SCHEMA_SQL)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
            if "postprocess_date_field" not in cols:
                conn.execute("ALTER TABLE tasks ADD COLUMN postprocess_date_field TEXT NOT NULL DEFAULT ''")
            if "postprocess_command" not in cols:
                conn.execute("ALTER TABLE tasks ADD COLUMN postprocess_command TEXT NOT NULL DEFAULT ''")
            if "filename_format" not in cols:
                conn.execute("ALTER TABLE tasks ADD COLUMN filename_format TEXT NOT NULL DEFAULT ''")
            if "archive_backfill" not in cols:
                conn.execute("ALTER TABLE tasks ADD COLUMN archive_backfill INTEGER NOT NULL DEFAULT 0")
            if "input_file" not in cols:
                conn.execute("ALTER TABLE tasks ADD COLUMN input_file TEXT NOT NULL DEFAULT ''")
            run_cols = {r["name"] for r in conn.execute("PRAGMA table_info(runs)").fetchall()}
            if "adhoc_opts_json" not in run_cols:
                conn.execute("ALTER TABLE runs ADD COLUMN adhoc_opts_json TEXT NOT NULL DEFAULT ''")
            now = utc_now_iso()
            # Mark stale running/queued runs from unexpected container exit as cancelled.
            conn.execute(
                """
                UPDATE runs
                SET status = 'cancelled',
                    finished_at = COALESCE(finished_at, ?),
                    error_category = CASE WHEN error_category = '' THEN 'interrupted' ELSE error_category END,
                    error_summary = CASE WHEN error_summary = '' THEN '容器重启中断' ELSE error_summary END
                WHERE status IN ('running', 'queued')
                """,
                (now,),
            )

    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self.session() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            return row["value"] if row is not None else default

    def set_setting(self, key: str, value: str) -> None:
        now = utc_now_iso()
        with self.session() as conn:
            conn.execute(
                """
                INSERT INTO settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (key, value, now),
            )

    def delete_setting(self, key: str) -> None:
        with self.session() as conn:
            conn.execute("DELETE FROM settings WHERE key = ?", (key,))
