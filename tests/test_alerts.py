import tempfile
import unittest
from pathlib import Path

from app.alerts import clear_alerts, list_alerts, mark_alerts_read
from app.db import Database, utc_now_iso


class AlertsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.tmp.name) / "app.db")
        self.db.init_schema()
        now = utc_now_iso()
        with self.db.session() as conn:
            conn.execute(
                """
                INSERT INTO runs (task_id, task_name, trigger_type, urls_json, status, error_summary, error_category, created_at, finished_at)
                VALUES (1, 'Rule34 收藏', 'manual', '[]', 'failed', 'ChallengeError 403', 'blocked', '2026-11-27T10:00:00+00:00', '2026-11-27T10:01:00+00:00')
                """
            )
            conn.execute(
                """
                INSERT INTO runs (task_id, task_name, trigger_type, urls_json, status, error_summary, error_category, created_at, finished_at)
                VALUES (2, 'Twitter 点赞', 'cron', '[]', 'auth_error', '401 Unauthorized', 'auth', '2026-11-27T11:00:00+00:00', '2026-11-27T11:01:00+00:00')
                """
            )
            conn.execute(
                """
                INSERT INTO runs (task_id, task_name, trigger_type, urls_json, status, created_at, finished_at)
                VALUES (3, 'Bluesky 点赞', 'cron', '[]', 'success', ?, ?)
                """,
                (now, now),
            )
            conn.execute(
                """
                INSERT INTO notification_logs (run_id, channel, status, detail, created_at)
                VALUES (1, 'telegram', 'failed', 'timeout', '2026-11-27T10:02:00+00:00')
                """
            )
            conn.execute(
                """
                INSERT INTO notification_logs (run_id, channel, status, detail, created_at)
                VALUES (3, 'bark', 'sent', 'ok', '2026-11-27T12:00:00+00:00')
                """
            )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_list_mark_read_and_clear_alerts(self) -> None:
        initial = list_alerts(self.db)
        self.assertEqual(initial["total"], 3)
        self.assertEqual(initial["unread_count"], 3)
        keys = {item["alert_key"] for item in initial["items"]}
        self.assertEqual(keys, {"run:1", "run:2", "notif:1"})

        marked = mark_alerts_read(self.db, alert_key="run:2")
        self.assertEqual(marked, 1)
        after_one_read = list_alerts(self.db)
        self.assertEqual(after_one_read["unread_count"], 2)
        self.assertTrue(next(x for x in after_one_read["items"] if x["alert_key"] == "run:2")["read"])

        cleared_one = clear_alerts(self.db, alert_key="run:2")
        self.assertEqual(cleared_one, 1)
        after_one_clear = list_alerts(self.db)
        self.assertEqual(after_one_clear["total"], 2)
        self.assertNotIn("run:2", {x["alert_key"] for x in after_one_clear["items"]})

        marked_all = mark_alerts_read(self.db, mark_all=True)
        self.assertEqual(marked_all, 2)
        self.assertEqual(list_alerts(self.db)["unread_count"], 0)

        cleared_all = clear_alerts(self.db, clear_all=True)
        self.assertEqual(cleared_all, 2)
        self.assertEqual(list_alerts(self.db)["total"], 0)

        # Underlying runs and notification_logs rows remain preserved
        with self.db.session() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 3)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM notification_logs").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
