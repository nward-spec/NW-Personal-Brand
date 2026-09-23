"""End-to-end: every scenario in the selftest must produce the promised day."""

import datetime as dt
import unittest

from tenk.selftest import SCENARIOS, run_scenario


class SelftestScenarioTests(unittest.TestCase):
    def result(self, name):
        scenario = next(s for s in SCENARIOS if s.name == name)
        return run_scenario(scenario)

    def test_every_scenario_runs(self):
        for scenario in SCENARIOS:
            with self.subTest(scenario.name):
                result = run_scenario(scenario)
                self.assertIn(result["tier"], ("GREEN", "AMBER", "RED"))

    def test_green_writes_the_session_as_planned(self):
        result = self.result("green")
        self.assertEqual(result["today"], "2 x 4km @ 3:40-3:45")
        self.assertEqual(result["modifications"], [])

    def test_amber_cuts_reps_only(self):
        result = self.result("amber-quality")
        self.assertIn("3:40-3:45", result["today"])
        self.assertTrue(result["modifications"])

    def test_red_replaces_quality_with_easy(self):
        result = self.result("red-quality")
        self.assertIn("easy", result["today"])

    def test_whoop_outage_still_writes_the_day(self):
        result = self.result("whoop-down")
        self.assertEqual(result["tier"], "GREEN")
        self.assertTrue(result["events"])
        self.assertTrue(any("unreachable" in w for w in result["warnings"]))

    def test_no_data_defaults_green_and_logs_the_gap(self):
        result = self.result("no-data")
        self.assertEqual(result["tier"], "GREEN")
        self.assertTrue(any("No Whoop recovery" in w for w in result["warnings"]))

    def test_race_day_is_untouched_on_red(self):
        result = self.result("race-day-red")
        self.assertEqual(result["modifications"], [])
        self.assertIn("2XU", result["today"])

    def test_run_club_day_is_untouched_on_red(self):
        result = self.result("wednesday-red")
        self.assertEqual(result["modifications"], [])
        self.assertTrue(any("back group" in f for f in result["flags"]))

    def test_heavy_gym_note_rides_along_without_changing_the_session(self):
        result = self.result("heavy-gym")
        self.assertEqual(result["modifications"], [])

    def test_the_rolling_window_is_written_every_morning(self):
        result = self.result("green")
        self.assertGreaterEqual(len(result["events"]), 3)
        self.assertTrue(all(e.startswith("10k-w") for e in result["events"]))


class DryRunTests(unittest.TestCase):
    def test_a_dry_run_writes_no_status_file(self):
        """--dry-run promises to execute no writes. A file is a write."""
        import datetime as dt
        import tempfile
        from pathlib import Path
        from tenk.config import Config
        from tenk.engine import DailyEngine

        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as tmp:
            config = Config.from_mapping({
                "plan_file": "config/plan.yaml",
                "state_dir": tmp,
                "engine": {"window_days": 2},
                "whoop": {"enabled": False},
                "intervals_icu": {"enabled": False, "athlete_id": "i1"},
                "google_calendar": {"enabled": False},
                "summary": {"enabled": False},
                "status": {"enabled": True, "filename": "s.json",
                           "copy_to": [str(Path(tmp) / "synced")]},
            }, root=root)
            DailyEngine(config, dry_run=True, today=dt.date(2026, 10, 31)).run()
            self.assertFalse((Path(tmp) / "s.json").exists())
            self.assertFalse((Path(tmp) / "synced" / "s.json").exists())

            DailyEngine(config, dry_run=False, today=dt.date(2026, 10, 31)).run()
            self.assertTrue((Path(tmp) / "s.json").exists())
            self.assertTrue((Path(tmp) / "synced" / "s.json").exists())


class WindowTests(unittest.TestCase):
    def test_window_never_writes_days_outside_the_block(self):
        scenario = next(s for s in SCENARIOS if s.name == "race-day-red")
        result = run_scenario(scenario)
        self.assertEqual(result["events"], ["10k-w10-sun-am"])


if __name__ == "__main__":
    unittest.main()
