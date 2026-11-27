import tempfile
import time
import unittest
from pathlib import Path

from app.db import Database
from app.runner import TaskManager, classify_run_result, parse_gallery_dl_line, tail_log_lines


class RunnerParserTests(unittest.TestCase):
    def test_parse_lines_distinguishes_downloaded_vs_skipped(self):
        dl = parse_gallery_dl_line("/gallery-dl/twitter/user/img.jpg", "/gallery-dl")
        self.assertEqual(dl["kind"], "downloaded_file")
        self.assertEqual(dl["path"], "/gallery-dl/twitter/user/img.jpg")

        sk = parse_gallery_dl_line("# /gallery-dl/twitter/user/old.jpg", "/gallery-dl")
        self.assertEqual(sk["kind"], "skipped_file")

        pp = parse_gallery_dl_line("[postprocess][ok] exiftool (image) /gallery-dl/twitter/user/img.jpg", "/gallery-dl")
        self.assertEqual(pp["kind"], "postprocess_ok")

        err = parse_gallery_dl_line("[rule34][error] ChallengeError: Cloudflare challenge (403 Forbidden)", "/gallery-dl")
        self.assertEqual(err["kind"], "error")

    def test_classify_run_result(self):
        self.assertEqual(classify_run_result(0, [], 2, False)[0], "success")
        self.assertEqual(classify_run_result(8, ["ChallengeError: Cloudflare challenge (403 Forbidden)"], 3, False)[0], "partial")
        self.assertEqual(classify_run_result(8, ["ChallengeError: Cloudflare challenge (403 Forbidden)"], 0, False)[0], "failed")
        self.assertEqual(classify_run_result(16, ["401 Unauthorized"], 0, False)[0], "auth_error")
        self.assertEqual(classify_run_result(143, [], 0, True)[0], "cancelled")

    def test_task_manager_live_snapshot(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "app.db")
            db.init_schema()
            mgr = TaskManager(db)
            self.assertIsNone(mgr.get_live_snapshot(99))
            mgr.live_runs[99] = {
                "started_mono": time.monotonic() - 2.0,
                "downloaded_count": 2,
                "skipped_count": 5,
                "postprocess_ok": 1,
                "postprocess_warn": 0,
                "files": ["/gallery-dl/a.jpg", "/gallery-dl/b.mp4"],
            }
            snap = mgr.get_live_snapshot(99)
            self.assertIsNotNone(snap)
            self.assertEqual(snap["downloaded_count"], 2)
            self.assertEqual(snap["skipped_count"], 5)
            self.assertGreaterEqual(snap["duration_sec"], 1.5)
            self.assertEqual(snap["files"], ["/gallery-dl/a.jpg", "/gallery-dl/b.mp4"])
            mgr.live_runs.pop(99, None)
            self.assertIsNone(mgr.get_live_snapshot(99))

    def test_tail_log_lines(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.assertEqual(tail_log_lines(None, max_lines=100), ([], False))
            self.assertEqual(tail_log_lines(root / "missing.log", max_lines=100), ([], False))

            empty = root / "empty.log"
            empty.write_bytes(b"")
            self.assertEqual(tail_log_lines(empty, max_lines=100), ([], False))

            short = root / "short.log"
            short.write_text("line 1\nline 2\nline 3\n", encoding="utf-8")
            self.assertEqual(tail_log_lines(short, max_lines=10), (["line 1", "line 2", "line 3"], False))

            # Multi-chunk UTF-8 file (>150 KB, 3000+ lines) to exercise backwards chunking & line boundary alignment
            big = root / "big.log"
            lines = [f"[{i:04d}] 测试中文日志路径 /gallery-dl/twitter/user/文件_{i:04d}.jpg" for i in range(3200)]
            big.write_text("\n".join(lines) + "\n", encoding="utf-8")
            self.assertGreater(big.stat().st_size, 150 * 1024)

            tail, truncated = tail_log_lines(big, max_lines=300)
            self.assertTrue(truncated)
            self.assertEqual(len(tail), 300)
            self.assertEqual(tail, lines[-300:])


if __name__ == "__main__":
    unittest.main()
