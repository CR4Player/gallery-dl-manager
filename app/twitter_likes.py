"""Twitter/X liked Tweet ID aggregation, disk/like.js import, and Tampermonkey sync."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
from pathlib import Path
from typing import Any

from app.config_manager import get_download_dir
from app.db import Database, get_data_dir, utc_now_iso

SYNC_TOKEN_SETTING_KEY = "twitter_sync_token"

TWEET_ID_RE = re.compile(r"^\d{5,25}$")
ARCHIVE_TWITTER_RE = re.compile(r"^twitter[_-]?(\d{10,25})(?:_|$)")
DISK_TWEET_ID_RE = re.compile(r"(?<!\d)(\d{15,20})(?!\d)")
LIKE_JS_PREFIX_RE = re.compile(r"^\s*window\.YTD\.[^=]*=\s*", re.IGNORECASE)
STATUS_URL_RE = re.compile(r"/status/(\d{5,25})")
JSON_TWEET_ID_RE = re.compile(r'"tweetId"\s*:\s*"(\d{5,25})"')


def get_archive_sqlite_path() -> Path:
    """Return path to gallery-dl SQLite archive database."""
    return get_data_dir() / "archive.sqlite3"


def get_or_create_sync_token(db: Database) -> str:
    """Return existing Twitter sync token or generate and persist a new one."""
    token = (db.get_setting(SYNC_TOKEN_SETTING_KEY) or "").strip()
    if token:
        return token
    token = secrets.token_urlsafe(24)
    db.set_setting(SYNC_TOKEN_SETTING_KEY, token)
    return token


def rotate_sync_token(db: Database) -> str:
    """Generate and persist a new Twitter sync token."""
    token = secrets.token_urlsafe(24)
    db.set_setting(SYNC_TOKEN_SETTING_KEY, token)
    return token


def verify_sync_token(db: Database, token: str | None) -> bool:
    """Verify sync bearer token using constant-time comparison."""
    candidate = (token or "").strip()
    expected = (db.get_setting(SYNC_TOKEN_SETTING_KEY) or "").strip()
    if not candidate or not expected:
        return False
    return hmac.compare_digest(candidate, expected)


def read_twitter_ids_from_archive(archive_path: Path | None = None) -> set[str]:
    """Read Twitter tweet IDs stored in gallery-dl's archive.sqlite3."""
    path = archive_path if archive_path is not None else get_archive_sqlite_path()
    if not path.is_file():
        return set()
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
        rows = conn.execute("SELECT entry FROM archive WHERE entry LIKE 'twitter%'").fetchall()
    except sqlite3.Error:
        return set()
    finally:
        if conn is not None:
            conn.close()

    ids: set[str] = set()
    for (entry,) in rows:
        m = ARCHIVE_TWITTER_RE.match(str(entry or ""))
        if m:
            ids.add(m.group(1))
    return ids


def scan_twitter_disk_dir(db: Database, download_dir: Path | None = None) -> dict[str, int]:
    """Scan local /gallery-dl/twitter directory filenames and store tweet IDs."""
    base = download_dir if download_dir is not None else get_download_dir()
    tw_dir = base / "twitter"
    if not tw_dir.is_dir():
        return {"scanned_files": 0, "found_ids": 0, "inserted": 0}

    scanned_files = 0
    found_ids: set[str] = set()
    for root, _dirs, files in os.walk(tw_dir):
        _ = root
        for fname in files:
            scanned_files += 1
            for m in DISK_TWEET_ID_RE.finditer(fname):
                found_ids.add(m.group(1))

    if not found_ids:
        return {"scanned_files": scanned_files, "found_ids": 0, "inserted": 0}

    now = utc_now_iso()
    inserted = 0
    with db.session() as conn:
        before = conn.total_changes
        conn.executemany(
            "INSERT OR IGNORE INTO twitter_liked_ids (tweet_id, source, created_at) VALUES (?, 'disk', ?)",
            [(tid, now) for tid in sorted(found_ids)],
        )
        inserted = conn.total_changes - before

    return {"scanned_files": scanned_files, "found_ids": len(found_ids), "inserted": inserted}


def parse_like_js_content(text: str) -> set[str]:
    """Extract tweet IDs from X official like.js, JSON, status URLs, or plain ID lists."""
    stripped = text.strip()
    if not stripped:
        return set()

    ids: set[str] = set()
    cleaned = LIKE_JS_PREFIX_RE.sub("", stripped, count=1).rstrip("; \t\r\n")
    if cleaned.startswith("[") or cleaned.startswith("{"):
        try:
            data = json.loads(cleaned)
            items = data if isinstance(data, list) else [data]
            for item in items:
                if not isinstance(item, dict):
                    continue
                candidate = None
                if isinstance(item.get("like"), dict):
                    candidate = item["like"].get("tweetId")
                elif "tweetId" in item:
                    candidate = item.get("tweetId")
                elif "id" in item:
                    candidate = item.get("id")
                if candidate is not None:
                    s = str(candidate).strip()
                    if TWEET_ID_RE.match(s):
                        ids.add(s)
            if ids:
                return ids
        except json.JSONDecodeError:
            pass

    for m in JSON_TWEET_ID_RE.finditer(text):
        ids.add(m.group(1))
    for m in STATUS_URL_RE.finditer(text):
        ids.add(m.group(1))
    for ln in text.splitlines():
        tok = ln.strip()
        if re.fullmatch(r"\d{10,25}", tok):
            ids.add(tok)
    return ids


def import_like_js(db: Database, text: str) -> dict[str, int]:
    """Parse X archive like.js (or URL/ID text) and insert tweet IDs."""
    ids = parse_like_js_content(text)
    if not ids:
        raise ValueError("未从文件中解析出任何有效的 Tweet ID")

    now = utc_now_iso()
    with db.session() as conn:
        before = conn.total_changes
        conn.executemany(
            "INSERT OR IGNORE INTO twitter_liked_ids (tweet_id, source, created_at) VALUES (?, 'archive_js', ?)",
            [(tid, now) for tid in sorted(ids)],
        )
        inserted = conn.total_changes - before

    return {"parsed": len(ids), "inserted": inserted}


def update_browser_ids(
    db: Database,
    add_ids: list[str] | None = None,
    remove_ids: list[str] | None = None,
    source: str = "browser",
) -> dict[str, int]:
    """Record or remove live browser-side liked tweet IDs."""
    clean_source = source if source in ("browser", "archive_js", "disk") else "browser"
    to_add = sorted({str(x).strip() for x in (add_ids or []) if TWEET_ID_RE.match(str(x).strip())})
    to_remove = sorted({str(x).strip() for x in (remove_ids or []) if TWEET_ID_RE.match(str(x).strip())})
    now = utc_now_iso()
    added = 0
    removed = 0
    with db.session() as conn:
        if to_add:
            before = conn.total_changes
            conn.executemany(
                "INSERT OR IGNORE INTO twitter_liked_ids (tweet_id, source, created_at) VALUES (?, ?, ?)",
                [(tid, clean_source, now) for tid in to_add],
            )
            added = conn.total_changes - before
        if to_remove:
            before = conn.total_changes
            conn.executemany(
                "DELETE FROM twitter_liked_ids WHERE tweet_id = ? AND source = 'browser'",
                [(tid,) for tid in to_remove],
            )
            removed = conn.total_changes - before
    return {"added": added, "removed": removed}


def _compute_etag(sorted_ids: list[str]) -> str:
    h = hashlib.sha256()
    for tid in sorted_ids:
        h.update(tid.encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()[:16]


def get_twitter_ids_payload(
    db: Database,
    archive_path: Path | None = None,
    include_ids: bool = True,
) -> dict[str, Any]:
    """Collect unified Twitter tweet IDs from archive.sqlite3 and twitter_liked_ids."""
    archive_ids = read_twitter_ids_from_archive(archive_path)
    source_counts = {
        "archive_sqlite": len(archive_ids),
        "disk": 0,
        "archive_js": 0,
        "browser": 0,
    }
    db_ids: set[str] = set()
    with db.session() as conn:
        rows = conn.execute("SELECT tweet_id, source FROM twitter_liked_ids").fetchall()
    for row in rows:
        tid = str(row["tweet_id"])
        src = str(row["source"])
        db_ids.add(tid)
        if src in source_counts:
            source_counts[src] += 1

    all_ids = sorted(archive_ids | db_ids)
    etag = _compute_etag(all_ids)
    out: dict[str, Any] = {
        "count": len(all_ids),
        "etag": etag,
        "sources": source_counts,
    }
    if include_ids:
        out["ids"] = all_ids
    return out


def render_userscript(server_url: str, token: str, connect_host: str = "") -> str:
    """Render pre-configured Tampermonkey userscript for X/Twitter permanent likes."""
    server_clean = server_url.strip().rstrip("/")
    connect_lines = ""
    if connect_host.strip():
        connect_lines += f"// @connect      {connect_host.strip()}\n"
    connect_lines += "// @connect      *"

    server_js = json.dumps(server_clean)
    token_js = json.dumps(token.strip())

    return f"""// ==UserScript==
// @name         gallery-dl-manager X 永久红心同步
// @namespace    gallery-dl-manager
// @version      1.0.0
// @description  将 NAS 上的 Twitter 历史存档与 X 官方 like.js 同步到浏览器，永久标出“已存”红心，避免重复点赞打断增量抓取
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
{connect_lines}
// @run-at       document-idle
// ==/UserScript==

(function () {{
  "use strict";

  const DEFAULT_SERVER = {server_js};
  const DEFAULT_TOKEN = {token_js};
  const DB_NAME = "gdlm_x_permanent_likes";
  const STORE_NAME = "ids";
  const SYNC_INTERVAL_MS = 30 * 60 * 1000;
  const HEART_PATH = "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z";

  GM_addStyle(`
    [data-testid="like"].gdlm-archived-like {{
      color: rgb(249, 24, 128) !important;
    }}
    [data-testid="like"].gdlm-archived-like svg {{
      color: rgb(249, 24, 128) !important;
      fill: rgb(249, 24, 128) !important;
    }}
    .gdlm-archived-tag {{
      display: inline-flex;
      align-items: center;
      margin-left: 4px;
      padding: 0 5px;
      height: 16px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      color: #fff;
      background: rgba(249, 24, 128, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.25);
      pointer-events: none;
      vertical-align: middle;
      white-space: nowrap;
    }}
  `);

  const likedSet = new Set();
  let dbPromise = null;
  let rafScheduled = false;

  function getServerUrl() {{
    return String(GM_getValue("server_url", DEFAULT_SERVER) || DEFAULT_SERVER).trim().replace(/\\/+$/, "");
  }}

  function getToken() {{
    return String(GM_getValue("sync_token", DEFAULT_TOKEN) || DEFAULT_TOKEN).trim();
  }}

  function openDb() {{
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {{
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {{
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {{
          db.createObjectStore(STORE_NAME);
        }}
      }};
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }});
    return dbPromise;
  }}

  async function loadAllFromIdb() {{
    try {{
      const db = await openDb();
      return await new Promise((resolve, reject) => {{
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).getAllKeys();
        req.onsuccess = () => {{
          for (const k of req.result || []) {{
            likedSet.add(String(k));
          }}
          resolve(likedSet.size);
        }};
        req.onerror = () => reject(req.error);
      }});
    }} catch (err) {{
      console.warn("[gdlm-likes] IndexedDB load failed:", err);
      return 0;
    }}
  }}

  async function putIdsToIdb(ids) {{
    if (!ids || !ids.length) return;
    for (const id of ids) likedSet.add(String(id));
    try {{
      const db = await openDb();
      await new Promise((resolve, reject) => {{
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const id of ids) {{
          store.put(1, String(id));
        }}
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }});
    }} catch (err) {{
      console.warn("[gdlm-likes] IndexedDB write failed:", err);
    }}
  }}

  function gmRequest(method, url, headers = {{}}, data = null) {{
    return new Promise((resolve, reject) => {{
      GM_xmlhttpRequest({{
        method,
        url,
        headers,
        data,
        timeout: 25000,
        onload: (resp) => resolve(resp),
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error("Request timeout")),
      }});
    }});
  }}

  async function syncFromNas(force = false) {{
    const server = getServerUrl();
    const token = getToken();
    if (!server || !token) return;
    const lastSync = Number(GM_getValue("last_sync_ts", 0));
    if (!force && likedSet.size > 0 && Date.now() - lastSync < SYNC_INTERVAL_MS) {{
      return;
    }}
    const headers = {{ Authorization: `Bearer ${{token}}` }};
    const etag = force ? "" : String(GM_getValue("last_etag", "") || "");
    if (etag) headers["If-None-Match"] = `"${{etag}}"`;
    try {{
      const resp = await gmRequest("GET", `${{server}}/api/archive/twitter-ids`, headers);
      if (resp.status === 304) {{
        GM_setValue("last_sync_ts", Date.now());
        if (force) alert(`与 NAS 数据已是最新（当前共缓存 ${{likedSet.size}} 条推文 ID）`);
        return;
      }}
      if (resp.status < 200 || resp.status >= 300) {{
        console.warn("[gdlm-likes] Sync HTTP", resp.status);
        if (force) alert(`同步失败: HTTP ${{resp.status}}`);
        return;
      }}
      const payload = JSON.parse(resp.responseText);
      const ids = Array.isArray(payload.ids) ? payload.ids : [];
      await putIdsToIdb(ids);
      if (payload.etag) GM_setValue("last_etag", String(payload.etag));
      GM_setValue("last_sync_ts", Date.now());
      scheduleScan();
      if (force) alert(`同步完成！NAS 共返回 ${{ids.length}} 条，本地当前共缓存 ${{likedSet.size}} 条推文 ID`);
    }} catch (err) {{
      console.warn("[gdlm-likes] Sync error:", err);
      if (force) alert(`连接 NAS 失败：${{err?.message || err}}`);
    }}
  }}

  async function pushBrowserLike(tweetId) {{
    const server = getServerUrl();
    const token = getToken();
    if (!server || !token || !tweetId) return;
    try {{
      await gmRequest(
        "POST",
        `${{server}}/api/archive/twitter-ids`,
        {{
          Authorization: `Bearer ${{token}}`,
          "Content-Type": "application/json",
        }},
        JSON.stringify({{ add: [tweetId], source: "browser" }})
      );
    }} catch (err) {{
      console.warn("[gdlm-likes] Push browser like failed:", err);
    }}
  }}

  function extractTweetIdFromArticle(article) {{
    const timeLinks = article.querySelectorAll('a[href*="/status/"]');
    for (const a of timeLinks) {{
      if (a.querySelector("time")) {{
        const nestedQuote = a.closest('[role="link"]');
        if (nestedQuote && nestedQuote !== a && article.contains(nestedQuote)) {{
          continue;
        }}
        const m = (a.getAttribute("href") || "").match(/\\/status\\/(\\d{{5,25}})/);
        if (m) return m[1];
      }}
    }}
    const locMatch = location.pathname.match(/\\/status\\/(\\d{{5,25}})/);
    if (locMatch && article.querySelector('a[href*="/analytics"]')) {{
      return locMatch[1];
    }}
    for (const a of timeLinks) {{
      const m = (a.getAttribute("href") || "").match(/\\/status\\/(\\d{{5,25}})/);
      if (m) return m[1];
    }}
    return null;
  }}

  function markArticle(article) {{
    const tweetId = extractTweetIdFromArticle(article);
    if (!tweetId) return;

    const unlikeBtn = article.querySelector('[data-testid="unlike"]');
    if (unlikeBtn) {{
      unlikeBtn.classList.remove("gdlm-archived-like");
      unlikeBtn.querySelectorAll(".gdlm-archived-tag").forEach((el) => el.remove());
      return;
    }}

    const likeBtn = article.querySelector('[data-testid="like"]');
    if (!likeBtn) return;

    if (!likedSet.has(tweetId)) {{
      if (likeBtn.classList.contains("gdlm-archived-like")) {{
        likeBtn.classList.remove("gdlm-archived-like");
        likeBtn.querySelectorAll(".gdlm-archived-tag").forEach((el) => el.remove());
      }}
      return;
    }}

    likeBtn.classList.add("gdlm-archived-like");
    likeBtn.title = "已在 gallery-dl-manager 历史喜欢/存档中（X 未显示红心），无需重复点赞";
    const svgPath = likeBtn.querySelector("svg path");
    if (svgPath && svgPath.getAttribute("d") !== HEART_PATH) {{
      svgPath.setAttribute("d", HEART_PATH);
    }}
    if (!likeBtn.querySelector(".gdlm-archived-tag")) {{
      const tag = document.createElement("span");
      tag.className = "gdlm-archived-tag";
      tag.textContent = "已存";
      likeBtn.appendChild(tag);
    }}
  }}

  function scanVisibleTweets() {{
    rafScheduled = false;
    document.querySelectorAll('article[data-testid="tweet"]').forEach(markArticle);
  }}

  function scheduleScan() {{
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(scanVisibleTweets);
  }}

  function parseLikeJsIds(text) {{
    const ids = new Set();
    const cleaned = text.trim().replace(/^\\s*window\\.YTD\\.[^=]*=\\s*/i, "").replace(/;\\s*$/, "");
    if (cleaned.startsWith("[") || cleaned.startsWith("{{")) {{
      try {{
        const data = JSON.parse(cleaned);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {{
          const cand = item?.like?.tweetId || item?.tweetId || item?.id;
          if (cand && /^\\d{{5,25}}$/.test(String(cand).trim())) {{
            ids.add(String(cand).trim());
          }}
        }}
        if (ids.size) return [...ids];
      }} catch {{}}
    }}
    for (const m of text.matchAll(/"tweetId"\\s*:\\s*"(\\d{{5,25}})"/g)) ids.add(m[1]);
    for (const m of text.matchAll(/\\/status\\/(\\d{{5,25}})/g)) ids.add(m[1]);
    return [...ids];
  }}

  function triggerLocalLikeJsImport() {{
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".js,.json,.txt";
    input.style.display = "none";
    input.addEventListener("change", async () => {{
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const text = await file.text();
      const ids = parseLikeJsIds(text);
      if (!ids.length) {{
        alert("未解析到任何 tweetId，请确认选择的是 X 官方存档中的 like.js");
        return;
      }}
      await putIdsToIdb(ids);
      scheduleScan();
      const server = getServerUrl();
      const token = getToken();
      if (server && token) {{
        for (let i = 0; i < ids.length; i += 5000) {{
          await gmRequest(
            "POST",
            `${{server}}/api/archive/twitter-ids`,
            {{ Authorization: `Bearer ${{token}}`, "Content-Type": "application/json" }},
            JSON.stringify({{ add: ids.slice(i, i + 5000), source: "archive_js" }})
          ).catch(() => {{}});
        }}
      }}
      alert(`成功导入 ${{ids.length}} 条历史喜欢记录并已缓存到浏览器！`);
    }});
    document.body.appendChild(input);
    input.click();
  }}

  document.addEventListener(
    "click",
    (e) => {{
      const btn = e.target?.closest?.('[data-testid="like"]');
      if (!btn) return;
      const article = btn.closest('article[data-testid="tweet"]');
      if (!article) return;
      const tweetId = extractTweetIdFromArticle(article);
      if (tweetId) {{
        putIdsToIdb([tweetId]);
        pushBrowserLike(tweetId);
      }}
    }},
    true
  );

  GM_registerMenuCommand("🔄 立即从 NAS 同步历史喜欢", () => syncFromNas(true));
  GM_registerMenuCommand("📂 本地导入 X 官方 like.js", triggerLocalLikeJsImport);
  GM_registerMenuCommand("⚙️ 配置 NAS 地址与同步 Token", () => {{
    const nextUrl = prompt("gallery-dl-manager 地址（如 http://nas-ip:8766）：", getServerUrl());
    if (nextUrl !== null) GM_setValue("server_url", nextUrl.trim().replace(/\\/+$/, ""));
    const nextTok = prompt("同步 Token（留空保持不变）：", getToken());
    if (nextTok !== null && nextTok.trim()) GM_setValue("sync_token", nextTok.trim());
    GM_setValue("last_etag", "");
    syncFromNas(true);
  }});
  GM_registerMenuCommand("📊 查看当前已缓存推文数", () => {{
    alert(`当前浏览器已缓存 ${{likedSet.size}} 条历史喜欢 Tweet ID\\nNAS 地址: ${{getServerUrl()}}`);
  }});

  loadAllFromIdb().then(() => {{
    scheduleScan();
    syncFromNas(false);
    setInterval(() => syncFromNas(false), SYNC_INTERVAL_MS);
  }});

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.body, {{ childList: true, subtree: true }});
}})();
"""
