import unittest
from datetime import datetime, timedelta, timezone

from app import cron


class CronTests(unittest.TestCase):
    def test_parse_and_sunday_0_and_7(self):
        spec = cron.parse_cron("0 3 * * 7")
        tz = timezone(timedelta(hours=8))
        sun = datetime(2026, 11, 29, 3, 0, tzinfo=tz)  # Sunday
        mon = datetime(2026, 11, 30, 3, 0, tzinfo=tz)
        self.assertTrue(cron.matches(sun, spec))
        self.assertFalse(cron.matches(mon, spec))

    def test_dom_and_dow_or_semantics(self):
        spec = cron.parse_cron("15 10 1 * 1")  # 1st of month OR Monday
        tz = timezone(timedelta(hours=8))
        # 2026-11-30 is Monday (not 1st)
        self.assertTrue(cron.matches(datetime(2026, 11, 30, 10, 15, tzinfo=tz), spec))
        # 2026-12-01 is Tuesday 1st
        self.assertTrue(cron.matches(datetime(2026, 12, 1, 10, 15, tzinfo=tz), spec))
        # 2026-12-02 is Wednesday 2nd
        self.assertFalse(cron.matches(datetime(2026, 12, 2, 10, 15, tzinfo=tz), spec))

    def test_next_runs_and_description(self):
        tz = timezone(timedelta(hours=8))
        base = datetime(2026, 11, 27, 5, 50, tzinfo=tz)
        nxt = cron.next_runs("0 */6 * * *", count=3, now=base)
        self.assertEqual(
            [d.strftime("%Y-%m-%d %H:%M") for d in nxt],
            ["2026-11-27 06:00", "2026-11-27 12:00", "2026-11-27 18:00"],
        )
        self.assertIn("每 6 小时", cron.describe_cron_zh("0 */6 * * *"))

    def test_invalid_cron_raises(self):
        with self.assertRaises(ValueError):
            cron.validate_cron("0 3 * *")
        with self.assertRaises(ValueError):
            cron.validate_cron("99 3 * * *")


if __name__ == "__main__":
    unittest.main()
