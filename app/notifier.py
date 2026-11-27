"""Failure and recovery notification dispatcher (Telegram, Feishu, Bark, Generic Webhook)."""

from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from app.db import Database, utc_now_iso

DEFAULT_NOTIFICATION_CONFIG: dict[str, Any] = {
    "enabled": False,
    "notify_on": ["failed", "auth_error", "partial"],
    "notify_on_recovery": True,
    "cooldown_minutes": 60,
    "use_proxy": False,
    "telegram": {
        "enabled": False,
        "bot_token": "",
        "chat_id": "",
        "api_base": "https://api.telegram.org",
    },
    "feishu": {
        "enabled": False,
        "webhook_url": "",
        "secret": "",
    },
    "bark": {
        "enabled": False,
        "server_url": "https://api.day.app",
        "device_key": "",
        "group": "gallery-dl",
    },
    "webhook": {
        "enabled": False,
        "url": "",
        "headers_json": "{}",
    },
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_notification_config(db: Database) -> dict[str, Any]:
    raw = db.get_setting("notification_config_json")
    if not raw:
        return copy.deepcopy(DEFAULT_NOTIFICATION_CONFIG)
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return _deep_merge(DEFAULT_NOTIFICATION_CONFIG, parsed)
    except json.JSONDecodeError:
        pass
    return copy.deepcopy(DEFAULT_NOTIFICATION_CONFIG)


def save_notification_config(db: Database, cfg: dict[str, Any]) -> dict[str, Any]:
    merged = _deep_merge(DEFAULT_NOTIFICATION_CONFIG, cfg)
    merged["cooldown_minutes"] = max(0, min(10080, int(merged.get("cooldown_minutes", 60))))
    db.set_setting("notification_config_json", json.dumps(merged, ensure_ascii=False))
    return merged


def compute_feishu_sign(secret: str, timestamp: int) -> str:
    """Compute Feishu custom bot HMAC-SHA256 signature."""
    string_to_sign = f"{timestamp}\n{secret}"
    hmac_code = hmac.new(string_to_sign.encode("utf-8"), digestmod=hashlib.sha256).digest()
    return base64.b64encode(hmac_code).decode("utf-8")


def _http_post_json(
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
    proxy_url: str = "",
    timeout: int = 12,
) -> tuple[bool, str]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req_headers = {"Content-Type": "application/json; charset=utf-8"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")

    handlers = []
    if proxy_url:
        handlers.append(urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read(512).decode("utf-8", errors="replace")
            return 200 <= resp.status < 300, f"HTTP {resp.status}: {body[:160]}"
    except urllib.error.HTTPError as exc:
        body = exc.read(256).decode("utf-8", errors="replace")
        return False, f"HTTP {exc.code}: {body[:160]}"
    except Exception as exc:
        return False, str(exc)


def dispatch_channel(
    channel: str,
    cfg: dict[str, Any],
    *,
    title: str,
    message: str,
    event_meta: dict[str, Any],
    proxy_url: str = "",
) -> tuple[bool, str]:
    if channel == "telegram":
        tg = cfg.get("telegram", {})
        token = str(tg.get("bot_token", "")).strip()
        chat_id = str(tg.get("chat_id", "")).strip()
        api_base = str(tg.get("api_base", "https://api.telegram.org")).strip().rstrip("/")
        if not token or not chat_id:
            return False, "Telegram bot_token 或 chat_id 为空"
        url = f"{api_base}/bot{token}/sendMessage"
        return _http_post_json(
            url,
            {"chat_id": chat_id, "text": f"{title}\n\n{message}", "disable_web_page_preview": True},
            proxy_url=proxy_url,
        )

    if channel == "feishu":
        fs = cfg.get("feishu", {})
        webhook_url = str(fs.get("webhook_url", "")).strip()
        secret = str(fs.get("secret", "")).strip()
        if not webhook_url:
            return False, "飞书 Webhook URL 为空"
        payload: dict[str, Any] = {
            "msg_type": "text",
            "content": {"text": f"{title}\n{message}"},
        }
        if secret:
            ts = int(time.time())
            payload["timestamp"] = str(ts)
            payload["sign"] = compute_feishu_sign(secret, ts)
        return _http_post_json(webhook_url, payload, proxy_url=proxy_url)

    if channel == "bark":
        bk = cfg.get("bark", {})
        server = str(bk.get("server_url", "https://api.day.app")).strip().rstrip("/")
        key = str(bk.get("device_key", "")).strip()
        group = str(bk.get("group", "gallery-dl")).strip()
        if not key:
            return False, "Bark device_key 为空"
        url = f"{server}/push"
        return _http_post_json(
            url,
            {"device_key": key, "title": title, "body": message, "group": group or "gallery-dl"},
            proxy_url=proxy_url,
        )

    if channel == "webhook":
        wh = cfg.get("webhook", {})
        url = str(wh.get("url", "")).strip()
        if not url:
            return False, "Webhook URL 为空"
        custom_headers: dict[str, str] = {}
        raw_h = str(wh.get("headers_json", "{}") or "{}").strip()
        try:
            parsed_h = json.loads(raw_h)
            if isinstance(parsed_h, dict):
                custom_headers = {str(k): str(v) for k, v in parsed_h.items()}
        except json.JSONDecodeError:
            return False, "Webhook 自定义 Headers JSON 格式错误"
        payload = {"title": title, "message": message, **event_meta}
        return _http_post_json(url, payload, headers=custom_headers, proxy_url=proxy_url)

    return False, f"未知通道: {channel}"


def _cooldown_active(db: Database, dedup_key: str, cooldown_minutes: int) -> bool:
    if cooldown_minutes <= 0:
        return False
    raw = db.get_setting(f"notify_cooldown:{dedup_key}")
    if not raw:
        return False
    try:
        last_dt = datetime.fromisoformat(raw)
        return datetime.now(timezone.utc) - last_dt < timedelta(minutes=cooldown_minutes)
    except ValueError:
        return False


def _record_cooldown(db: Database, dedup_key: str) -> None:
    db.set_setting(f"notify_cooldown:{dedup_key}", utc_now_iso())


def send_test_notification(
    db: Database,
    cfg: dict[str, Any],
    channel: str | None = None,
    global_proxy: str = "",
) -> dict[str, Any]:
    proxy = global_proxy if cfg.get("use_proxy") else ""
    targets = [channel] if channel else [
        c for c in ("telegram", "feishu", "bark", "webhook") if cfg.get(c, {}).get("enabled")
    ]
    if not targets:
        return {"ok": False, "results": [{"channel": "none", "ok": False, "detail": "未启用任何通知通道"}]}

    results = []
    now = utc_now_iso()
    for ch in targets:
        ok, detail = dispatch_channel(
            ch,
            cfg,
            title="[gallery-dl-manager] 测试通知",
            message=f"这是一条测试推送，说明 {ch} 通道配置正常。\n时间：{datetime.now().astimezone():%Y-%m-%d %H:%M:%S %Z}",
            event_meta={"event": "test", "timestamp": now},
            proxy_url=proxy,
        )
        results.append({"channel": ch, "ok": ok, "detail": detail})
        with db.session() as conn:
            conn.execute(
                "INSERT INTO notification_logs (run_id, channel, status, detail, created_at) VALUES (NULL, ?, ?, ?, ?)",
                (ch, "sent" if ok else "failed", detail, now),
            )
    return {"ok": all(r["ok"] for r in results), "results": results}


def notify_run_finished(
    db: Database,
    *,
    run_id: int,
    task_id: int | None,
    task_name: str,
    status: str,
    previous_status: str | None,
    error_category: str,
    error_summary: str,
    downloaded_count: int,
    duration_sec: float,
    global_proxy: str = "",
) -> list[dict[str, Any]]:
    """Evaluate notification rules (failure / auth_error / partial / recovery) and send."""
    cfg = load_notification_config(db)
    if not cfg.get("enabled"):
        return []

    notify_on = set(cfg.get("notify_on") or [])
    is_recovery = (
        status == "success"
        and bool(cfg.get("notify_on_recovery"))
        and previous_status in ("failed", "auth_error", "partial")
    )

    if not is_recovery and status not in notify_on:
        return []

    dedup_scope = f"task:{task_id}" if task_id is not None else "adhoc"
    if not is_recovery:
        dedup_key = f"{dedup_scope}:{error_category or status}"
        if _cooldown_active(db, dedup_key, int(cfg.get("cooldown_minutes", 60))):
            return []
    else:
        dedup_key = f"{dedup_scope}:recovery"

    enabled_channels = [
        ch for ch in ("telegram", "feishu", "bark", "webhook") if cfg.get(ch, {}).get("enabled")
    ]
    if not enabled_channels:
        return []

    if is_recovery:
        title = f"[gallery-dl] 任务恢复正常：{task_name}"
        body = (
            f"Run #{run_id} 已恢复成功\n"
            f"新增文件：{downloaded_count} | 耗时：{duration_sec:.1f}s"
        )
    else:
        status_label = {
            "auth_error": "认证 / Cookie 失效",
            "failed": "执行失败",
            "partial": "部分失败 / 被拦截",
        }.get(status, status)
        title = f"[gallery-dl] {status_label}：{task_name}"
        body = (
            f"Run #{run_id} | 状态：{status}\n"
            f"新增：{downloaded_count} | 耗时：{duration_sec:.1f}s\n"
            f"原因：{error_summary or '未知错误'}"
        )

    proxy = global_proxy if cfg.get("use_proxy") else ""
    meta = {
        "event": "recovery" if is_recovery else "alert",
        "run_id": run_id,
        "task_id": task_id,
        "task_name": task_name,
        "status": status,
        "error_category": error_category,
        "error_summary": error_summary,
        "downloaded_count": downloaded_count,
        "duration_sec": duration_sec,
    }

    results = []
    any_ok = False
    now = utc_now_iso()
    for ch in enabled_channels:
        ok, detail = dispatch_channel(
            ch, cfg, title=title, message=body, event_meta=meta, proxy_url=proxy
        )
        any_ok = any_ok or ok
        results.append({"channel": ch, "ok": ok, "detail": detail})
        with db.session() as conn:
            conn.execute(
                "INSERT INTO notification_logs (run_id, channel, status, detail, created_at) VALUES (?, ?, ?, ?, ?)",
                (run_id, ch, "sent" if ok else "failed", detail, now),
            )

    if any_ok and not is_recovery:
        _record_cooldown(db, dedup_key)
    return results
