import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from app.api import create_app
except ImportError:
    create_app = None
from app.config_manager import (
    get_app_settings,
    get_postprocess_site_configs,
    save_global_config,
    save_input_file,
    save_postprocess_site_configs,
)
from app.db import Database
from app.insights import compute_effective_config
from app.runner import TaskManager


async def asgi_request(
    app,
    method: str,
    path: str,
    *,
    body: dict | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    raw_headers: list[tuple[bytes, bytes]] = []
    hdrs = dict(headers or {})
    if method in ("POST", "PUT", "DELETE", "PATCH"):
        hdrs.setdefault("X-Requested-With", "fetch")
    payload = b""
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
        hdrs.setdefault("Content-Length", str(len(payload)))
    for k, v in hdrs.items():
        raw_headers.append((k.lower().encode("latin-1"), v.encode("latin-1")))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path.split("?", 1)[0],
        "raw_path": path.split("?", 1)[0].encode("latin-1"),
        "query_string": (path.split("?", 1)[1] if "?" in path else "").encode("latin-1"),
        "headers": raw_headers,
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 8766),
    }

    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": payload, "more_body": False}
        return {"type": "http.disconnect"}

    status_code = 500
    resp_headers: dict[str, str] = {}
    chunks: list[bytes] = []

    async def send(message):
        nonlocal status_code, resp_headers
        if message["type"] == "http.response.start":
            status_code = int(message["status"])
            resp_headers = {
                k.decode("latin-1").lower(): v.decode("latin-1")
                for k, v in message.get("headers", [])
            }
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    await app(scope, receive, send)
    return status_code, resp_headers, b"".join(chunks)


class ApiAndRunnerFixesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / "data"
        self.dl_dir = self.root / "downloads"
        self.data_dir.mkdir()
        self.dl_dir.mkdir()
        self.env_patch = patch.dict(
            "os.environ",
            {
                "DATA_DIR": str(self.data_dir),
                "DOWNLOAD_DIR": str(self.dl_dir),
                "WEB_AUTH_DISABLED": "true",
            },
        )
        self.env_patch.start()
        self.db = Database(self.data_dir / "app.db")
        self.db.init_schema()

    def tearDown(self) -> None:
        self.env_patch.stop()
        self.tmp.cleanup()

    def test_combined_urls_and_input_file_effective_and_execution(self) -> None:
        save_input_file("batch.txt", "https://x.com/user1/likes\nhttps://x.com/user2/likes\n")
        eff = compute_effective_config(
            self.db,
            {"urls": "https://bsky.app/profile/alice", "input_file": "batch.txt"},
        )
        self.assertIn("-i /data/inputs/batch.txt", eff["command"])
        self.assertIn("2 + 1 条 URL", eff["command"])
        self.assertEqual(eff["sites"], ["bluesky", "twitter"])

        mgr = TaskManager(self.db)
        run_id = mgr.enqueue_adhoc(
            urls=["https://bsky.app/profile/alice"],
            input_file="batch.txt",
            subdir="mixed",
        )

        captured: dict[str, object] = {}

        class FakeProc:
            pid = 99999
            returncode = 0

            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_eof()

            async def wait(self):
                return 0

        async def fake_exec(*cmd, **kwargs):
            captured["cmd"] = list(cmd)
            if "-i" in cmd:
                idx = cmd.index("-i")
                captured["input_content"] = Path(cmd[idx + 1]).read_text(encoding="utf-8")
            return FakeProc()

        with patch("asyncio.create_subprocess_exec", side_effect=fake_exec):
            asyncio.run(mgr._execute_run(run_id))

        self.assertIn("-i", captured["cmd"])
        content = str(captured.get("input_content", ""))
        self.assertIn("https://x.com/user1/likes", content)
        self.assertIn("https://x.com/user2/likes", content)
        self.assertIn("https://bsky.app/profile/alice", content)

    @unittest.skipUnless(create_app is not None, "starlette not installed")
    def test_adhoc_retry_preserves_options_and_input_file(self) -> None:
        save_input_file("list1.txt", "https://x.com/u/likes\n")
        app = create_app(self.db)

        async def _scenario():
            st, _, body = await asgi_request(
                app,
                "POST",
                "/api/download",
                body={
                    "urls": [],
                    "input_file": "list1.txt",
                    "proxy_mode": "custom",
                    "proxy_url": "http://127.0.0.1:7890",
                    "subdir": "my-sub",
                    "skip_mode": "abort:5",
                    "filename_format": "{id}.{extension}",
                    "extra_args": "--range 1-10",
                    "use_archive": True,
                    "archive_backfill": True,
                    "postprocess_mode": "enabled",
                    "postprocess_date_field": "{date:%Y-%m-%d}",
                    "simulate": True,
                    "name": "测试临时",
                },
            )
            self.assertEqual(st, 201)
            run_id = json.loads(body)["run_id"]

            st2, _, body2 = await asgi_request(app, "POST", f"/api/runs/{run_id}/retry", body={})
            self.assertEqual(st2, 200)
            retry_id = json.loads(body2)["run_id"]
            self.assertNotEqual(retry_id, run_id)

            with self.db.session() as conn:
                row = conn.execute("SELECT * FROM runs WHERE id = ?", (retry_id,)).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["urls_json"], json.dumps(["file:list1.txt"]))
            self.assertEqual(row["simulate"], 1)
            opts = json.loads(row["adhoc_opts_json"])
            self.assertEqual(opts["input_file"], "list1.txt")
            self.assertEqual(opts["proxy_mode"], "custom")
            self.assertEqual(opts["proxy_url"], "http://127.0.0.1:7890")
            self.assertEqual(opts["subdir"], "my-sub")
            self.assertEqual(opts["skip_mode"], "abort:5")
            self.assertEqual(opts["filename_format"], "{id}.{extension}")
            self.assertEqual(opts["extra_args"], "--range 1-10")
            self.assertTrue(opts["use_archive"])
            self.assertTrue(opts["archive_backfill"])
            self.assertEqual(opts["postprocess_mode"], "enabled")
            self.assertEqual(opts["postprocess_date_field"], "{date:%Y-%m-%d}")

        asyncio.run(_scenario())

    @unittest.skipUnless(create_app is not None, "starlette not installed")
    def test_delete_site_cleans_postprocess_config(self) -> None:
        save_global_config(self.db, {"extractor": {"pixiv": {"username": "alice"}}})
        save_postprocess_site_configs(
            self.db,
            {
                "twitter": {"enabled": True, "mode": "builtin"},
                "pixiv": {"enabled": True, "mode": "builtin"},
            },
        )
        app = create_app(self.db)

        st, _, _ = asyncio.run(asgi_request(app, "DELETE", "/api/config/site/pixiv"))
        self.assertEqual(st, 200)
        settings = get_app_settings(self.db)
        pp_cfgs = get_postprocess_site_configs(self.db, settings["postprocess_default_sites"])
        self.assertNotIn("pixiv", pp_cfgs)
        self.assertIn("twitter", pp_cfgs)

    def test_reconfigure_concurrency_scales_up_and_down(self) -> None:
        mgr = TaskManager(self.db)

        async def _scenario():
            await mgr.start()
            try:
                self.assertEqual(len(mgr._workers), 1)
                mgr.reconfigure_concurrency(3)
                self.assertEqual(len(mgr._workers), 3)
                mgr.reconfigure_concurrency(1)
                # Excess idle workers exit after queue.get() 1s timeout
                await asyncio.sleep(1.3)
                alive = [w for w in mgr._workers if not w.done()]
                self.assertEqual(len(alive), 1)
            finally:
                await mgr.stop()

        asyncio.run(_scenario())

    @unittest.skipUnless(create_app is not None, "starlette not installed")
    def test_web_pages_and_static_assets_smoke(self) -> None:
        app = create_app(self.db)

        async def _scenario():
            for path, expected_ct in (
                ("/health", "application/json"),
                ("/", "text/html"),
                ("/static/app.css", "text/css"),
                ("/static/js/main.js", "javascript"),
                ("/static/js/icons.js", "javascript"),
                ("/static/js/ui.js", "javascript"),
                ("/api/dashboard", "application/json"),
                ("/api/sites/health", "application/json"),
                ("/api/tasks", "application/json"),
                ("/api/runs", "application/json"),
                ("/api/config/overview", "application/json"),
                ("/api/notifications", "application/json"),
            ):
                st, hdrs, _ = await asgi_request(app, "GET", path)
                self.assertEqual(st, 200, f"GET {path} returned {st}")
                self.assertIn(expected_ct, hdrs.get("content-type", ""), f"{path} headers={hdrs}")

        asyncio.run(_scenario())


if __name__ == "__main__":
    unittest.main()
