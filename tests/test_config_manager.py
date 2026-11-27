import json
import os
import tempfile
import unittest
from pathlib import Path

from app.config_manager import (
    delete_input_file,
    extract_secret_values,
    import_legacy_if_needed,
    list_input_files,
    load_global_config,
    parse_cookies_input,
    redact_text,
    save_input_file,
    synthesize_runtime_config,
    validate_input_filename,
    validate_safe_subdir,
)
from app.db import Database


class ConfigManagerTests(unittest.TestCase):
    def test_import_legacy_strips_windows_hooks_and_seeds_disabled_tasks(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db = Database(root / "app.db")
            db.init_schema()
            legacy = root / "legacy.conf"
            legacy.write_text(
                json.dumps(
                    {
                        "extractor": {
                            "base-directory": "./gallery-dl/",
                            "twitter": {
                                "cookies": {"auth_token": "secret_token_123456"},
                                "postprocessors": [
                                    {"name": "exec", "command": ["E:/exiftool/exiftool.exe", "{_path}"]},
                                    {"name": "exec", "command": ["powershell", "-Command", "foo"]},
                                ],
                            },
                            "bluesky": {"username": "u", "password": "pw_secret_value"},
                            "proxy": "",
                        },
                        "output": {"mode": "color"},
                    }
                ),
                encoding="utf-8",
            )
            changed = import_legacy_if_needed(db, legacy_path=legacy, import_tasks_enabled=False)
            self.assertTrue(changed)
            conf = load_global_config(db)
            self.assertNotIn("postprocessors", conf["extractor"]["twitter"])
            self.assertEqual(conf["extractor"]["twitter"]["cookies"]["auth_token"], "secret_token_123456")
            self.assertEqual(conf["output"]["mode"], "pipe")
            self.assertFalse(conf["output"]["shorten"])

            with db.session() as conn:
                tasks = conn.execute("SELECT * FROM tasks ORDER BY id").fetchall()
                self.assertEqual(len(tasks), 3)
                self.assertTrue(all(t["enabled"] == 0 for t in tasks))

            # Second call is a no-op
            self.assertFalse(import_legacy_if_needed(db, legacy_path=legacy, import_tasks_enabled=True))

    def test_parse_cookies_input_formats(self):
        # JSON dict
        self.assertEqual(parse_cookies_input('{"a": "1", "b": "2"}'), {"a": "1", "b": "2"})
        # JSON list
        self.assertEqual(
            parse_cookies_input('[{"name": "auth_token", "value": "xyz"}]'),
            {"auth_token": "xyz"},
        )
        # Netscape cookies.txt
        netscape = "# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t1800000000\tauth_token\tabc123\n#HttpOnly_.x.com\tTRUE\t/\tTRUE\t1800000000\tkdt\tdef456\n"
        self.assertEqual(parse_cookies_input(netscape), {"auth_token": "abc123", "kdt": "def456"})
        # Header string
        self.assertEqual(parse_cookies_input("ct0=111; auth_token=222"), {"ct0": "111", "auth_token": "222"})

    def test_synthesize_runtime_config_and_subdir_safety(self):
        base = {
            "extractor": {
                "twitter": {"cookies": {"auth_token": "super_secret_cookie_val"}},
                "bluesky": {},
            }
        }
        rt = synthesize_runtime_config(
            base,
            global_proxy="http://127.0.0.1:7890",
            proxy_mode="inherit",
            subdir="custom/folder",
            skip_mode="abort:15",
            use_archive=True,
            archive_path="/data/archive.sqlite3",
            postprocess_mode="inherit",
            postprocess_default_sites=["twitter"],
            download_dir="/gallery-dl",
        )
        self.assertEqual(rt["extractor"]["proxy"], "http://127.0.0.1:7890")
        self.assertEqual(rt["extractor"]["base-directory"].replace("\\", "/"), "/gallery-dl/custom/folder")
        self.assertEqual(rt["extractor"]["skip"], "abort:15")
        self.assertEqual(rt["extractor"]["archive"], "/data/archive.sqlite3")
        self.assertEqual(len(rt["extractor"]["twitter"]["postprocessors"]), 1)
        self.assertNotIn("postprocessors", rt["extractor"]["bluesky"])

        secrets = extract_secret_values(rt)
        self.assertIn("super_secret_cookie_val", secrets)
        self.assertEqual(redact_text("token=super_secret_cookie_val", secrets), "token=[REDACTED]")

        with self.assertRaises(ValueError):
            validate_safe_subdir("../etc")

    def test_per_site_and_task_custom_postprocess_and_db_migration(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / "legacy_schema.db"
            import sqlite3
            conn = sqlite3.connect(str(db_path))
            conn.execute(
                """
                CREATE TABLE tasks (
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
                    postprocess_mode TEXT NOT NULL DEFAULT 'inherit',
                    notes TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_run_id INTEGER,
                    last_status TEXT,
                    last_run_at TEXT,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.commit()
            conn.close()

            db = Database(db_path)
            db.init_schema()
            with db.session() as c2:
                cols = {r["name"] for r in c2.execute("PRAGMA table_info(tasks)").fetchall()}
                self.assertIn("postprocess_date_field", cols)
                self.assertIn("postprocess_command", cols)
                self.assertIn("filename_format", cols)
                self.assertIn("archive_backfill", cols)
                self.assertIn("input_file", cols)

            old_data_dir = os.environ.get("DATA_DIR")
            os.environ["DATA_DIR"] = td
            try:
                self.assertEqual(validate_input_filename("rule34-fav-123456-ids.txt"), "rule34-fav-123456-ids.txt")
                self.assertEqual(validate_input_filename("my_list"), "my_list.txt")
                with self.assertRaises(ValueError):
                    validate_input_filename("../evil.txt")
                meta = save_input_file(
                    "rule34-fav-123456-ids.txt",
                    "# comment\nhttps://rule34.xxx/index.php?page=post&s=view&id=1\n\nhttps://rule34.xxx/index.php?page=post&s=view&id=2\r\n",
                )
                self.assertEqual(meta["url_count"], 2)
                listed = list_input_files()
                self.assertEqual(len(listed), 1)
                self.assertTrue(delete_input_file("rule34-fav-123456-ids.txt"))
            finally:
                if old_data_dir is None:
                    os.environ.pop("DATA_DIR", None)
                else:
                    os.environ["DATA_DIR"] = old_data_dir

        base = {
            "extractor": {
                "rule34": {},
                "twitter": {
                    "filename": "[{date:%Y-%m-%d}] {conversation_id}.{extension}",
                    "skip": "abort:10",
                },
            }
        }
        rt_inherit = synthesize_runtime_config(
            base,
            skip_mode="true",
            filename_format="{id}.{extension}",
            use_archive=True,
            archive_backfill=True,
            archive_path="/data/archive.sqlite3",
            postprocess_mode="inherit",
            postprocess_site_configs={
                "rule34": {
                    "enabled": True,
                    "mode": "builtin",
                    "date_template": "{created_at:%Y-%m-%dT%H:%M:%S}",
                    "extra_args": "-Artist={tags_artist}",
                }
            },
        )
        self.assertTrue(rt_inherit["extractor"]["skip"])
        self.assertNotIn("skip", rt_inherit["extractor"]["twitter"])
        self.assertEqual(rt_inherit["extractor"]["filename"], "{id}.{extension}")
        self.assertNotIn("filename", rt_inherit["extractor"]["twitter"])
        self.assertEqual(rt_inherit["extractor"]["archive-event"], ["file", "skip"])
        cmd = rt_inherit["extractor"]["rule34"]["postprocessors"][0]["command"]
        self.assertIn("{created_at:%Y-%m-%dT%H:%M:%S}", cmd)
        self.assertIn("--extra-arg", cmd)
        self.assertIn("-Artist={tags_artist}", cmd)

        rt_custom = synthesize_runtime_config(
            base,
            postprocess_mode="custom",
            postprocess_command='exiftool -overwrite_original -DateTimeOriginal="{date:%Y:%m:%d %H:%M:%S}" "{_path}"',
        )
        self.assertEqual(
            rt_custom["extractor"]["postprocessors"][0]["command"][0],
            "exiftool",
        )


if __name__ == "__main__":
    unittest.main()
