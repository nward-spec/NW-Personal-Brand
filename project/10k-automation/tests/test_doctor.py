"""The check command must name the real problem, and never print a secret."""

import datetime as dt
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tenk.config import Config
from tenk.doctor import FAIL, OK, SKIP, WARN, Doctor, render
from tenk.state import TokenStore
from tenk.tiers import RecoveryRecord

ROOT = Path(__file__).resolve().parent.parent
TODAY = dt.date(2026, 9, 19)


def config(state_dir, **overrides):
    raw = {
        "plan_file": "config/plan.yaml",
        "state_dir": str(state_dir),
        "engine": {"window_days": 10},
        "whoop": {"enabled": True, "redirect_uri": "http://localhost:8723/callback"},
        "intervals_icu": {"enabled": True, "athlete_id": "i12345"},
        "google_calendar": {"enabled": False},
        "summary": {"enabled": False},
    }
    raw.update(overrides)
    return Config.from_mapping(raw, root=ROOT)


class FakeIntervals:
    def __init__(self, garmin=True, fail=False):
        self.garmin = garmin
        self.fail = fail

    def athlete(self):
        if self.fail:
            raise RuntimeError("intervals.icu rejected the API key (401)")
        return {"name": "Nick Ward"}

    def connections(self):
        return {"garmin_training_connected": self.garmin, "whoop_connected": True}


class FakeWhoop:
    def __init__(self, records=None, fail=False):
        self.records = records or []
        self.fail = fail

    def recoveries(self, today, days=3):
        if self.fail:
            raise RuntimeError("Whoop rejected the token request (401)")
        return self.records


def find(checks, name):
    return next(c for c in checks if c.name == name)


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)

    def run_doctor(self, cfg=None, **kwargs):
        return Doctor(cfg or config(self.state), today=TODAY, **kwargs).run()

    def test_plan_always_reports(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            checks = self.run_doctor()
        plan = find(checks, "plan")
        self.assertEqual(plan.status, OK)
        self.assertIn("3:40-3:45", plan.detail)

    def test_placeholder_athlete_id_is_a_blocking_failure(self):
        cfg = config(self.state, intervals_icu={"enabled": True, "athlete_id": "i00000"})
        with mock.patch.dict(os.environ, {}, clear=True):
            checks = self.run_doctor(cfg)
        check = find(checks, "intervals.icu")
        self.assertEqual(check.status, FAIL)
        self.assertIn("placeholder", check.detail)
        self.assertTrue(check.fix)

    def test_missing_api_key_names_the_variable_and_the_fix(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            checks = self.run_doctor()
        check = find(checks, "intervals.icu")
        self.assertEqual(check.status, FAIL)
        self.assertIn("INTERVALS_ICU_API_KEY", check.detail)
        self.assertIn("secrets.env", check.fix)

    def test_missing_whoop_credentials_points_at_the_dashboard(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            checks = self.run_doctor()
        check = find(checks, "whoop")
        self.assertEqual(check.status, FAIL)
        self.assertIn("developer-dashboard.whoop.com", check.fix)

    def test_missing_token_tells_you_to_authorize(self):
        env = {"WHOOP_CLIENT_ID": "id", "WHOOP_CLIENT_SECRET": "secret"}
        with mock.patch.dict(os.environ, env, clear=True):
            checks = self.run_doctor()
        check = find(checks, "whoop")
        self.assertEqual(check.status, FAIL)
        self.assertIn("authorize", check.fix)

    def test_disabled_integrations_are_skipped_not_failed(self):
        cfg = config(self.state, whoop={"enabled": False},
                     intervals_icu={"enabled": False, "athlete_id": "i1"})
        with mock.patch.dict(os.environ, {}, clear=True):
            checks = self.run_doctor(cfg)
        self.assertEqual(find(checks, "whoop").status, SKIP)
        self.assertEqual(find(checks, "intervals.icu").status, SKIP)
        self.assertEqual(find(checks, "calendar").status, SKIP)
        self.assertFalse([c for c in checks if c.blocking])

    def test_todays_session_is_reported(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            checks = self.run_doctor()
        check = find(checks, "today")
        self.assertEqual(check.status, OK)
        self.assertIn("4 x 8min threshold", check.detail)

    def test_state_directory_is_checked_for_writability(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            checks = self.run_doctor()
        self.assertEqual(find(checks, "state").status, OK)


class OnlineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.env = {
            "INTERVALS_ICU_API_KEY": "super-secret-key",
            "WHOOP_CLIENT_ID": "client-id",
            "WHOOP_CLIENT_SECRET": "client-secret",
        }
        TokenStore(config(self.state).token_file).save({"refresh_token": "r"})

    def run_doctor(self, intervals, whoop):
        with mock.patch.dict(os.environ, self.env, clear=True):
            return Doctor(
                config(self.state),
                intervals_factory=lambda: intervals,
                whoop_factory=lambda: whoop,
                today=TODAY,
            ).run()

    def test_everything_connected(self):
        records = [RecoveryRecord(TODAY, 71.0, 63.0, 46.0)]
        checks = self.run_doctor(FakeIntervals(garmin=True), FakeWhoop(records))
        self.assertEqual(find(checks, "intervals.icu").status, OK)
        self.assertIn("Nick Ward", find(checks, "intervals.icu").detail)
        self.assertEqual(find(checks, "garmin").status, OK)
        self.assertEqual(find(checks, "whoop").status, OK)
        self.assertIn("71%", find(checks, "whoop").detail)
        self.assertFalse([c for c in checks if c.blocking])

    def test_garmin_not_connected_is_the_headline_failure(self):
        checks = self.run_doctor(FakeIntervals(garmin=False), FakeWhoop([]))
        garmin = find(checks, "garmin")
        self.assertEqual(garmin.status, FAIL)
        self.assertIn("Upload planned workouts", garmin.fix)

    def test_bad_api_key_is_reported_with_its_fix(self):
        checks = self.run_doctor(FakeIntervals(fail=True), FakeWhoop([]))
        check = find(checks, "intervals.icu")
        self.assertEqual(check.status, FAIL)
        self.assertIn("Developer Settings", check.fix)

    def test_no_recovery_yet_is_a_warning_not_a_failure(self):
        checks = self.run_doctor(FakeIntervals(), FakeWhoop([]))
        check = find(checks, "whoop")
        self.assertEqual(check.status, WARN)
        self.assertFalse(check.blocking)

    def test_stranded_whoop_token_explains_single_use(self):
        checks = self.run_doctor(FakeIntervals(), FakeWhoop(fail=True))
        check = find(checks, "whoop")
        self.assertEqual(check.status, FAIL)
        self.assertIn("single use", check.fix)

    def test_no_secret_value_ever_appears_in_the_output(self):
        records = [RecoveryRecord(TODAY, 71.0, 63.0, 46.0)]
        checks = self.run_doctor(FakeIntervals(), FakeWhoop(records))
        text = render(checks)
        for secret in self.env.values():
            self.assertNotIn(secret, text)


class RenderTests(unittest.TestCase):
    def test_blocking_failures_are_summarised(self):
        from tenk.doctor import Check
        text = render([
            Check("plan", OK, "fine"),
            Check("garmin", FAIL, "not connected", "tick the box"),
        ])
        self.assertIn("1 thing(s) to fix: garmin", text)
        self.assertIn("-> tick the box", text)

    def test_all_clear_says_what_to_do_next(self):
        from tenk.doctor import Check
        self.assertIn("Next:", render([Check("plan", OK, "fine")]))


if __name__ == "__main__":
    unittest.main()
