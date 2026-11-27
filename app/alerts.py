"""Persistent notification/alert inbox aggregation, read state, and clear actions."""

from __future__ import annotations

from typing import Any

from app.db import Database, utc_now_iso


def list_alerts(db: Database, limit: int = 50) -> dict[str, Any]:
    """Return active (non-dismissed) run & notification alerts ordered newest-first."""
    fetch_limit = max(1, int(limit))
    items: list[dict[str, Any]] = []

    with db.session() as conn:
        state_rows = conn.execute(
            "SELECT alert_key, read_at, dismissed_at FROM alert_states"
        ).fetchall()
        states = {
            str(r["alert_key"]): {
                "read": bool(r["read_at"]),
                "dismissed": bool(r["dismissed_at"]),
            }
            for r in state_rows
        }

        run_rows = conn.execute(
            """
            SELECT id, task_name, status, error_summary, error_category,
                   COALESCE(finished_at, created_at) AS ts
            FROM runs
            WHERE status IN ('failed', 'auth_error', 'partial')
            ORDER BY id DESC
            LIMIT ?
            """,
            (fetch_limit,),
        ).fetchall()

        notif_rows = conn.execute(
            """
            SELECT id, run_id, channel, status, detail, created_at
            FROM notification_logs
            WHERE status != 'sent'
            ORDER BY id DESC
            LIMIT 20
            """
        ).fetchall()

    for r in run_rows:
        key = f"run:{r['id']}"
        st = states.get(key, {})
        if st.get("dismissed"):
            continue
        items.append(
            {
                "alert_key": key,
                "kind": "run_error",
                "status": str(r["status"]),
                "title": f"#{r['id']} {r['task_name']}",
                "detail": str(r["error_summary"] or r["error_category"] or "任务执行异常"),
                "run_id": int(r["id"]),
                "target_view": "runs",
                "created_at": str(r["ts"] or ""),
                "read": bool(st.get("read", False)),
            }
        )

    for n in notif_rows:
        key = f"notif:{n['id']}"
        st = states.get(key, {})
        if st.get("dismissed"):
            continue
        run_id = int(n["run_id"]) if n["run_id"] is not None else None
        items.append(
            {
                "alert_key": key,
                "kind": "notification_error",
                "status": "failed",
                "title": f"通知发送失败 ({n['channel']})",
                "detail": str(n["detail"] or "推送失败"),
                "run_id": run_id,
                "target_view": "runs" if run_id is not None else "notifications",
                "created_at": str(n["created_at"] or ""),
                "read": bool(st.get("read", False)),
            }
        )

    items.sort(key=lambda x: x["created_at"], reverse=True)
    items = items[:fetch_limit]
    unread_count = sum(1 for item in items if not item["read"])
    return {"unread_count": unread_count, "total": len(items), "items": items}


def mark_alerts_read(
    db: Database,
    alert_key: str | None = None,
    mark_all: bool = False,
) -> int:
    """Mark one alert or all currently active alerts as read."""
    now = utc_now_iso()
    keys: list[str]
    if mark_all:
        keys = [item["alert_key"] for item in list_alerts(db, limit=200)["items"] if not item["read"]]
    elif alert_key and str(alert_key).strip():
        keys = [str(alert_key).strip()]
    else:
        return 0

    if not keys:
        return 0

    with db.session() as conn:
        conn.executemany(
            """
            INSERT INTO alert_states (alert_key, read_at, dismissed_at)
            VALUES (?, ?, '')
            ON CONFLICT(alert_key) DO UPDATE SET
                read_at = CASE WHEN alert_states.read_at = '' THEN excluded.read_at ELSE alert_states.read_at END
            """,
            [(k, now) for k in keys],
        )
    return len(keys)


def clear_alerts(
    db: Database,
    alert_key: str | None = None,
    clear_all: bool = False,
) -> int:
    """Dismiss one alert or all active alerts from the alert center (keeps underlying run logs)."""
    now = utc_now_iso()
    keys: list[str]
    if clear_all:
        keys = [item["alert_key"] for item in list_alerts(db, limit=200)["items"]]
    elif alert_key and str(alert_key).strip():
        keys = [str(alert_key).strip()]
    else:
        return 0

    if not keys:
        return 0

    with db.session() as conn:
        conn.executemany(
            """
            INSERT INTO alert_states (alert_key, read_at, dismissed_at)
            VALUES (?, ?, ?)
            ON CONFLICT(alert_key) DO UPDATE SET
                dismissed_at = excluded.dismissed_at,
                read_at = CASE WHEN alert_states.read_at = '' THEN excluded.read_at ELSE alert_states.read_at END
            """,
            [(k, now, now) for k in keys],
        )
    return len(keys)
