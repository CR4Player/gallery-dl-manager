import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.db import Database
from app.twitter_likes import (
    get_or_create_sync_token,
    get_twitter_ids_payload,
    import_like_js,
    parse_like_js_content,
    read_twitter_ids_from_archive,
    render_userscript,
    rotate_sync_token,
    scan_twitter_disk_dir,
    update_browser_ids,
    verify_sync_token,
)


class TwitterLikesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = Database(self.root / "app.db")
        self.db.init_schema()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_token_lifecycle(self) -> None:
        t1 = get_or_create_sync_token(self.db)
        self.assertTrue(len(t1) >= 20)
        self.assertEqual(get_or_create_sync_token(self.db), t1)
        self.assertTrue(verify_sync_token(self.db, t1))
        self.assertFalse(verify_sync_token(self.db, "wrong-token"))
        self.assertFalse(verify_sync_token(self.db, ""))

        t2 = rotate_sync_token(self.db)
        self.assertNotEqual(t1, t2)
        self.assertFalse(verify_sync_token(self.db, t1))
        self.assertTrue(verify_sync_token(self.db, t2))

    def test_read_archive_sqlite(self) -> None:
        arch = self.root / "archive.sqlite3"
        conn = sqlite3.connect(str(arch))
        conn.execute("CREATE TABLE archive (entry TEXT PRIMARY KEY) WITHOUT ROWID")
        conn.executemany(
            "INSERT INTO archive (entry) VALUES (?)",
            [
                ("twitter1890123456789012345_0_1",),
                ("twitter_435898800909979648_1",),
                ("blueskybafkreia2mpiaz5llobqmkreqkd",),
            ],
        )
        conn.commit()
        conn.close()

        ids = read_twitter_ids_from_archive(arch)
        self.assertEqual(ids, {"435898800909979648", "1890123456789012345"})

    def test_scan_twitter_disk_dir(self) -> None:
        tw_sub = self.root / "dl" / "twitter" / "user_a"
        tw_sub.mkdir(parents=True)
        (tw_sub / "[2014-02-18] 435898800909979648_p1 @modelsmcgurk.jpg").write_bytes(b"x")
        (tw_sub / "[2017-05-03] 859815316649648128_p2 @QueerMeNow.jpg").write_bytes(b"x")
        (tw_sub / "1890123456789012345_1.mp4").write_bytes(b"x")
        (tw_sub / "readme.txt").write_text("no ids", encoding="utf-8")

        res1 = scan_twitter_disk_dir(self.db, self.root / "dl")
        self.assertEqual(res1["scanned_files"], 4)
        self.assertEqual(res1["found_ids"], 3)
        self.assertEqual(res1["inserted"], 3)

        # Re-scanning should insert 0 duplicates
        res2 = scan_twitter_disk_dir(self.db, self.root / "dl")
        self.assertEqual(res2["inserted"], 0)

    def test_parse_and_import_like_js(self) -> None:
        sample = """window.YTD.like.part0 = [
          {"like": {"tweetId": "1111111111111111111", "fullText": "hi"}},
          {"like": {"tweetId": "2222222222222222222", "expandedUrl": "https://twitter.com/i/web/status/2222222222222222222"}}
        ]"""
        parsed = parse_like_js_content(sample)
        self.assertEqual(parsed, {"1111111111111111111", "2222222222222222222"})

        res = import_like_js(self.db, sample)
        self.assertEqual(res["parsed"], 2)
        self.assertEqual(res["inserted"], 2)

        plain_urls = "https://x.com/user/status/3333333333333333333\n4444444444444444444\n"
        self.assertEqual(parse_like_js_content(plain_urls), {"3333333333333333333", "4444444444444444444"})

    def test_browser_updates_preserve_historical_records(self) -> None:
        import_like_js(self.db, '[{"like": {"tweetId": "1111111111111111111"}}]')
        res_add = update_browser_ids(self.db, add_ids=["999999999999999999", "invalid", "1111111111111111111"])
        self.assertEqual(res_add["added"], 1)

        # Trying to remove historical archive_js ID via browser remove does not delete it
        res_rem = update_browser_ids(self.db, remove_ids=["1111111111111111111", "999999999999999999"])
        self.assertEqual(res_rem["removed"], 1)

        payload = get_twitter_ids_payload(self.db, archive_path=self.root / "missing.sqlite3")
        self.assertEqual(payload["ids"], ["1111111111111111111"])

    def test_payload_union_and_etag(self) -> None:
        arch = self.root / "archive.sqlite3"
        conn = sqlite3.connect(str(arch))
        conn.execute("CREATE TABLE archive (entry TEXT PRIMARY KEY) WITHOUT ROWID")
        conn.execute("INSERT INTO archive (entry) VALUES ('twitter555555555555555555_0_1')")
        conn.commit()
        conn.close()

        import_like_js(self.db, "https://x.com/a/status/666666666666666666")
        p1 = get_twitter_ids_payload(self.db, archive_path=arch)
        self.assertEqual(p1["count"], 2)
        self.assertEqual(p1["sources"]["archive_sqlite"], 1)
        self.assertEqual(p1["sources"]["archive_js"], 1)
        self.assertEqual(len(p1["etag"]), 16)

        update_browser_ids(self.db, add_ids=["777777777777777777"])
        p2 = get_twitter_ids_payload(self.db, archive_path=arch)
        self.assertEqual(p2["count"], 3)
        self.assertNotEqual(p1["etag"], p2["etag"])

    def test_render_userscript(self) -> None:
        script = render_userscript("http://192.0.2.10:8766/", "abc_token_123", "192.0.2.10")
        self.assertIn("==UserScript==", script)
        self.assertIn("// @version      1.1.0", script)
        self.assertIn('"http://192.0.2.10:8766"', script)
        self.assertIn('"abc_token_123"', script)
        self.assertIn("// @connect      192.0.2.10", script)
        self.assertIn("/api/archive/twitter-ids", script)
        self.assertIn("rgb(168, 85, 247)", script)
        self.assertIn("M20.884 13.19", script)
        self.assertIn("gdlmOrigD", script)
        self.assertNotIn("gdlm-archived-tag", script)
        self.assertNotIn("已存", script)


if __name__ == "__main__":
    unittest.main()
