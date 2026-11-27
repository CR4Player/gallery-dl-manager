"""Authentication, first-boot setup token, HMAC session cookies, and rate limiting."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from collections import defaultdict
from threading import Lock

from app.db import Database

SESSION_COOKIE_NAME = "gdlm_session"
SESSION_TTL_SECONDS = 30 * 24 * 3600  # 30 days


def is_auth_disabled() -> bool:
    return os.environ.get("WEB_AUTH_DISABLED", "false").strip().lower() == "true"


def cookie_secure_flag() -> bool:
    return os.environ.get("WEB_COOKIE_SECURE", "0").strip().lower() in ("1", "true", "yes")


def hash_password(password: str) -> str:
    """Hash password with scrypt and random 16-byte salt."""
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt${base64.b64encode(salt).decode('ascii')}${base64.b64encode(dk).decode('ascii')}"


def verify_password(password: str, stored: str) -> bool:
    """Verify password against stored scrypt hash."""
    try:
        alg, salt_b64, dk_b64 = stored.split("$", 2)
        if alg != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=len(expected))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


class RateLimiter:
    """Simple per-IP rate limiter: max 5 failures -> 60s cooldown."""

    def __init__(self, max_attempts: int = 5, window_sec: int = 60) -> None:
        self.max_attempts = max_attempts
        self.window_sec = window_sec
        self._failures: dict[str, list[float]] = defaultdict(list)
        self._lock = Lock()

    def check_blocked(self, key: str) -> int:
        now = time.monotonic()
        with self._lock:
            recent = [t for t in self._failures.get(key, []) if now - t < self.window_sec]
            self._failures[key] = recent
            if len(recent) >= self.max_attempts:
                retry_after = int(self.window_sec - (now - recent[0])) + 1
                return max(1, retry_after)
            return 0

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            recent = [t for t in self._failures.get(key, []) if now - t < self.window_sec]
            recent.append(now)
            self._failures[key] = recent

    def reset(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)


class AuthManager:
    """Manages setup token, web login password, and HMAC session cookies."""

    def __init__(self, db: Database) -> None:
        self.db = db
        self.limiter = RateLimiter()

    def ensure_initialized(self) -> str | None:
        """Ensure session secret exists; if no password set, ensure setup token exists and return it."""
        if not self.db.get_setting("auth_session_secret"):
            self.db.set_setting("auth_session_secret", secrets.token_hex(32))
        if not self.db.get_setting("auth_session_version"):
            self.db.set_setting("auth_session_version", "1")

        if is_auth_disabled() or self.is_configured():
            return None

        token = self.db.get_setting("auth_setup_token")
        if not token:
            token = secrets.token_urlsafe(18)
            self.db.set_setting("auth_setup_token", token)
        return token

    def is_configured(self) -> bool:
        return bool(self.db.get_setting("auth_password_hash"))

    def print_setup_banner(self, token: str) -> None:
        banner = (
            "\n"
            "============================================================\n"
            " [SETUP] gallery-dl-manager 首次启动初始化口令\n"
            f" [SETUP] SETUP_TOKEN={token}\n"
            " [SETUP] 请访问管理网页 /setup 完成管理员密码设置\n"
            "============================================================"
        )
        print(banner, flush=True)

    def complete_setup(self, token: str, password: str) -> bool:
        if self.is_configured():
            raise ValueError("站点已完成初始化")
        expected = self.db.get_setting("auth_setup_token") or ""
        if not expected or not hmac.compare_digest(token.strip(), expected):
            return False
        if len(password) < 6:
            raise ValueError("密码长度至少为 6 个字符")
        self.db.set_setting("auth_password_hash", hash_password(password))
        self.db.delete_setting("auth_setup_token")
        return True

    def verify_login(self, password: str) -> bool:
        stored = self.db.get_setting("auth_password_hash") or ""
        if not stored:
            return False
        return verify_password(password, stored)

    def change_password(self, current_password: str, new_password: str) -> bool:
        if not self.verify_login(current_password):
            return False
        if len(new_password) < 6:
            raise ValueError("新密码长度至少为 6 个字符")
        self.db.set_setting("auth_password_hash", hash_password(new_password))
        self.bump_session_version()
        return True

    def bump_session_version(self) -> int:
        cur = int(self.db.get_setting("auth_session_version", "1") or "1")
        nxt = cur + 1
        self.db.set_setting("auth_session_version", str(nxt))
        return nxt

    def reset_web_auth(self) -> str:
        """Clear web password, invalidate existing sessions, and issue a fresh setup token."""
        self.db.delete_setting("auth_password_hash")
        self.bump_session_version()
        token = secrets.token_urlsafe(18)
        self.db.set_setting("auth_setup_token", token)
        return token

    def create_session_cookie(self, ttl: int = SESSION_TTL_SECONDS) -> str:
        secret = (self.db.get_setting("auth_session_secret") or "").encode("utf-8")
        version = int(self.db.get_setting("auth_session_version", "1") or "1")
        payload = json.dumps(
            {"exp": int(time.time()) + ttl, "v": version},
            separators=(",", ":"),
        ).encode("utf-8")
        p_b64 = _b64u_encode(payload)
        sig = hmac.new(secret, p_b64.encode("ascii"), hashlib.sha256).digest()
        return f"{p_b64}.{_b64u_encode(sig)}"

    def verify_session_cookie(self, token: str | None) -> bool:
        if is_auth_disabled():
            return True
        if not token or "." not in token or not self.is_configured():
            return False
        try:
            p_b64, sig_b64 = token.split(".", 1)
            secret = (self.db.get_setting("auth_session_secret") or "").encode("utf-8")
            expected_sig = hmac.new(secret, p_b64.encode("ascii"), hashlib.sha256).digest()
            actual_sig = _b64u_decode(sig_b64)
            if not hmac.compare_digest(expected_sig, actual_sig):
                return False
            data = json.loads(_b64u_decode(p_b64).decode("utf-8"))
            if int(data.get("exp", 0)) < int(time.time()):
                return False
            cur_v = int(self.db.get_setting("auth_session_version", "1") or "1")
            if int(data.get("v", -1)) != cur_v:
                return False
            return True
        except Exception:
            return False
