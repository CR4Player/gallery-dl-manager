import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import notifier
from app.db import Database


class NotifierTests(unittest.TestCase):
    def test_feishu_sign_deterministic(self):
        sig = notifier.compute_feishu_sign("my-secret", 1700000000)
        self.assertEqual(sig, notifier.compute_feishu_sign("my-secret", 1700000000))
        self.assertEqual(len(sig), 44)

    def test_cooldown_and_recovery(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "app.db")
            db.init_schema()
            notifier.save_notification_config(
                db,
                {
                    "enabled": True,
                    "notify_on": ["failed", "auth_error"],
                    "notify_on_recovery": True,
                    "cooldown_minutes": 60,
                    "bark": {"enabled": True, "device_key": "testkey"},
                },
            )

            sent_calls = []

            def fake_post(url, payload, **kwargs):
                sent_calls.append((url, payload))
                return True, "HTTP 200: ok"

            with patch("app.notifier._http_post_json", side_effect=fake_post):
                r1 = notifier.notify_run_finished(
                    db,
                    run_id=1,
                    task_id=10,
                    task_name="Twitter",
                    status="failed",
                    previous_status=None,
                    error_category="runtime_error",
                    error_summary="timeout",
                    downloaded_count=0,
                    duration_sec=5.0,
                )
                self.assertEqual(len(r1), 1)
                self.assertEqual(len(sent_calls), 1)

                # Same failure within cooldown is deduplicated
                r2 = notifier.notify_run_finished(
                    db,
                    run_id=2,
                    task_id=10,
                    task_name="Twitter",
                    status="failed",
                    previous_status="failed",
                    error_category="runtime_error",
                    error_summary="timeout",
                    downloaded_count=0,
                    duration_sec=4.0,
                )
                self.assertEqual(r2, [])
                self.assertEqual(len(sent_calls), 1)

                # Recovery sends notification
                r3 = notifier.notify_run_finished(
                    db,
                    run_id=3,
                    task_id=10,
                    task_name="Twitter",
                    status="success",
                    previous_status="failed",
                    error_category="",
                    error_summary="",
                    downloaded_count=3,
                    duration_sec=6.0,
                )
                self.assertEqual(len(r3), 1)
                self.assertEqual(len(sent_calls), 2)
                self.assertIn("恢复正常", sent_calls[1][1]["title"])


if __name__ == "__main__":
    unittest.main()
