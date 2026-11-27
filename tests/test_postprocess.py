import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from app import postprocess


class PostprocessTests(unittest.TestCase):
    def test_parse_utc_date(self):
        dt = postprocess.parse_utc_date("2026-08-18T12:34:56")
        self.assertEqual(dt, datetime(2026, 8, 18, 12, 34, 56, tzinfo=timezone.utc))
        self.assertIsNone(postprocess.parse_utc_date("None"))
        self.assertIsNone(postprocess.parse_utc_date(""))

    def test_classify_media_and_video_command_uses_quicktime_utc(self):
        self.assertEqual(postprocess.classify_media(Path("a.JPG")), "image")
        self.assertEqual(postprocess.classify_media(Path("a.mp4")), "video")
        self.assertEqual(postprocess.classify_media(Path("a.webm")), "skip")

        dt = datetime(2026, 8, 18, 12, 0, 0, tzinfo=timezone.utc)
        cmd = postprocess.build_exiftool_command(Path("/tmp/v.mp4"), dt, "video", extra_args=["-Artist=Tester"])
        self.assertIn("QuickTimeUTC=1", cmd)
        self.assertIn("-MediaCreateDate=2026:08:18 12:00:00", cmd)
        self.assertIn("-DateTimeOriginal=2026:08:18 12:00:00", cmd)
        self.assertIn("-Artist=Tester", cmd)
        self.assertEqual(cmd[-1].replace("\\", "/"), "/tmp/v.mp4")

    def test_process_file_tolerates_exiftool_failure_and_sets_mtime(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "sample.jpg"
            p.write_bytes(b"not a real jpeg")
            dt_str = "2026-05-01T10:20:30"
            expected_ts = datetime(2026, 5, 1, 10, 20, 30, tzinfo=timezone.utc).timestamp()

            class FakeRes:
                returncode = 1
                stderr = "Warning: Bad format"
                stdout = ""

            with patch("app.postprocess.subprocess.run", return_value=FakeRes()):
                status = postprocess.process_file(p, dt_str)

            self.assertEqual(status, "warn")
            self.assertAlmostEqual(os.stat(p).st_mtime, expected_ts, delta=1.0)


if __name__ == "__main__":
    unittest.main()
