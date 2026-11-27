import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.config_manager import save_global_config, save_input_file, save_postprocess_site_configs
from app.db import Database, utc_now_iso
from app.insights import (
    compute_effective_config,
    compute_sites_health,
    compute_task_detail,
    fetch_tasks_recent_statuses,
    match_sites,
    parse_gallery_dl_k_output,
)
from app.runner import TaskManager


class InsightsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / "data"
        self.dl_dir = self.root / "downloads"
        self.data_dir.mkdir()
        self.dl_dir.mkdir()
        self.env_patch = patch.dict(
            "os.environ",
            {"DATA_DIR": str(self.data_dir), "DOWNLOAD_DIR": str(self.dl_dir)},
        )
        self.env_patch.start()
        self.db = Database(self.data_dir / "app.db")
        self.db.init_schema()

    def tearDown(self) -> None:
        self.env_patch.stop()
        self.tmp.cleanup()

    def test_match_sites_and_input_file_expansion(self) -> None:
        save_input_file("favs.txt", "https://rule34.xxx/index.php?page=post&id=1\nhttps://x.com/user/status/2\n")
        matched = match_sites(
            ["https://bsky.app/profile/alice", "https://customhost.org/post/1"],
            known_sites=["customhost"],
            input_file="favs.txt",
        )
        self.assertEqual(matched, ["bluesky", "customhost", "rule34", "twitter"])
        self.assertEqual(match_sites(["file:favs.txt"]), ["rule34", "twitter"])

    def test_compute_effective_config_inheritance_and_redaction(self) -> None:
        self.db.set_setting("global_proxy", "http://user:secretpass@127.0.0.1:7890")
        save_global_config(
            self.db,
            {
                "extractor": {
                    "skip": "abort:7",
                    "twitter": {
                        "cookies": {"auth_token": "super_secret_auth_token_val"},
                        "skip": "abort:20",
                        "filename": "{tweet_id}.{extension}",
                    },
                }
            },
        )
        save_postprocess_site_configs(
            self.db,
            {
                "twitter": {
                    "enabled": True,
                    "mode": "builtin",
                    "date_template": "{date:%Y-%m-%dT%H:%M:%S}",
                    "extra_args": "",
                    "custom_command": "",
                }
            },
        )

        eff = compute_effective_config(
            self.db,
            {"urls": "https://x.com/test/likes", "use_archive": True, "archive_backfill": True},
        )
        self.assertEqual(eff["sites"], ["twitter"])
        self.assertEqual(eff["fields"]["proxy"]["source"], "global")
        self.assertNotIn("secretpass", eff["fields"]["proxy"]["value"])
        self.assertEqual(eff["fields"]["skip"], {"value": "abort:20", "source": "site:twitter"})
        self.assertEqual(eff["fields"]["filename"], {"value": "{tweet_id}.{extension}", "source": "site:twitter"})
        self.assertTrue(eff["fields"]["archive"]["value"])
        self.assertTrue(eff["fields"]["archive"]["backfill"])
        self.assertEqual(len(eff["fields"]["postprocess"]), 1)
        self.assertEqual(eff["fields"]["postprocess"][0]["site"], "twitter")
        self.assertNotIn("super_secret_auth_token_val", eff["config_json"])
        self.assertNotIn("secretpass", eff["config_json"])
        self.assertIn("[REDACTED]", eff["config_json"])

        eff_override = compute_effective_config(
            self.db,
            {
                "urls": "https://x.com/test/likes",
                "proxy_mode": "direct",
                "skip_mode": "exit:5",
                "filename_format": "{id}.{extension}",
                "postprocess_mode": "disabled",
            },
        )
        self.assertEqual(eff_override["fields"]["proxy"], {"value": "", "source": "direct"})
        self.assertEqual(eff_override["fields"]["skip"], {"value": "exit:5", "source": "task"})
        self.assertEqual(eff_override["fields"]["filename"], {"value": "{id}.{extension}", "source": "task"})
        self.assertEqual(eff_override["fields"]["postprocess"], [])

    def test_sites_health_task_detail_and_sparkline(self) -> None:
        save_global_config(
            self.db,
            {
                "extractor": {
                    "twitter": {"cookies": {"auth_token": "tok"}},
                    "bluesky": {"username": "alice", "password": "pw"},
                }
            },
        )
        now = utc_now_iso()
        with self.db.session() as conn:
            t1 = conn.execute(
                """
                INSERT INTO tasks (name, urls_json, enabled, cron_expr, created_at, updated_at)
                VALUES ('Twitter Likes', ?, 1, '0 */6 * * *', ?, ?)
                """,
                (json.dumps(["https://x.com/a/likes"]), now, now),
            ).lastrowid
            t2 = conn.execute(
                """
                INSERT INTO tasks (name, urls_json, enabled, cron_expr, created_at, updated_at)
                VALUES ('Bluesky Likes', ?, 1, '0 */6 * * *', ?, ?)
                """,
                (json.dumps(["https://bsky.app/profile/a"]), now, now),
            ).lastrowid

            conn.execute(
                """
                INSERT INTO runs (task_id, task_name, trigger_type, urls_json, status, duration_sec, downloaded_count, created_at, finished_at)
                VALUES (?, 'Twitter Likes', 'cron', ?, 'success', 4.0, 5, '2026-11-27T01:00:00+00:00', '2026-11-27T01:00:04+00:00')
                """,
                (t1, json.dumps(["https://x.com/a/likes"])),
            )
            conn.execute(
                """
                INSERT INTO runs (task_id, task_name, trigger_type, urls_json, status, duration_sec, downloaded_count, error_summary, created_at, finished_at)
                VALUES (?, 'Twitter Likes', 'manual', ?, 'auth_error', 2.0, 0, '401 Unauthorized', '2026-11-27T02:00:00+00:00', '2026-11-27T02:00:02+00:00')
                """,
                (t1, json.dumps(["https://x.com/a/likes"])),
            )
            conn.execute(
                """
                INSERT INTO runs (task_id, task_name, trigger_type, urls_json, status, duration_sec, downloaded_count, created_at, finished_at)
                VALUES (?, 'Bluesky Likes', 'cron', ?, 'success', 6.0, 3, '2026-11-27T03:00:00+00:00', '2026-11-27T03:00:06+00:00')
                """,
                (t2, json.dumps(["https://bsky.app/profile/a"])),
            )
            row_t1 = conn.execute("SELECT * FROM tasks WHERE id = ?", (t1,)).fetchone()

        detail = compute_task_detail(self.db, row_t1, known_sites=["twitter", "bluesky"])
        self.assertEqual(detail["sites"], ["twitter"])
        self.assertEqual(detail["health"]["total"], 2)
        self.assertEqual(detail["health"]["success"], 1)
        self.assertEqual(detail["health"]["auth_error"], 1)
        self.assertEqual(detail["health"]["success_rate"], 0.5)
        self.assertEqual(detail["health"]["avg_duration_sec"], 3.0)
        self.assertEqual(detail["health"]["total_downloaded"], 5)

        spark = fetch_tasks_recent_statuses(self.db, limit_per_task=10)
        self.assertEqual([x["status"] for x in spark[int(t1)]], ["success", "auth_error"])

        from app.config_manager import get_app_settings, load_global_config

        health_list = compute_sites_health(self.db, load_global_config(self.db), get_app_settings(self.db))
        by_site = {x["site"]: x for x in health_list}
        self.assertEqual(by_site["twitter"]["health"], "error")
        self.assertEqual(by_site["twitter"]["last_auth_error_summary"], "401 Unauthorized")
        self.assertEqual(by_site["twitter"]["task_ids"], [int(t1)])
        self.assertEqual(by_site["bluesky"]["health"], "ok")
        self.assertTrue(by_site["bluesky"]["has_credentials"])

    def test_parse_gallery_dl_k_and_global_events(self) -> None:
        sample_k = (
            "author[name]\n  alice\n"
            "created_at\n  2026-11-27 12:34:56\n"
            "date\n  2026-11-27T12:34:56\n"
            "tweet_id\n  189012345\n"
        )
        parsed = parse_gallery_dl_k_output(sample_k)
        self.assertTrue(parsed[0]["is_date"])
        keys = {p["key"]: p for p in parsed}
        self.assertTrue(keys["date"]["is_date"])
        self.assertTrue(keys["created_at"]["is_date"])
        self.assertFalse(keys["tweet_id"]["is_date"])

        mgr = TaskManager(self.db)
        q = mgr.subscribe_global()
        mgr.emit_global({"type": "tasks_changed"})
        ev = q.get_nowait()
        self.assertEqual(ev["type"], "tasks_changed")
        mgr.unsubscribe_global(q)
        self.assertEqual(len(mgr.global_subscribers), 0)


if __name__ == "__main__":
    unittest.main()
