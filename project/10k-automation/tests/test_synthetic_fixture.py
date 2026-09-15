"""The synthetic fixture is shaped like the real Whoop collection responses.

If Whoop changes its payload shape, this test is where it shows up first.
"""

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from zoneinfo import ZoneInfo

from tenk.adjust import gym_strain_note
from tenk.state import TokenStore
from tenk.tiers import Tier, classify
from tenk.whoop import WhoopClient

FIXTURE = json.loads((Path(__file__).resolve().parent.parent / "synthetic" / "whoop_sample.json").read_text())
MELBOURNE = ZoneInfo("Australia/Melbourne")


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.text = "{}"

    def json(self):
        return self._payload


class FixtureSession:
    def __init__(self):
        self.calls = []

    def post(self, url, data=None, timeout=None, **kwargs):
        return FakeResponse({"access_token": "a", "refresh_token": "b", "expires_in": 3600})

    def get(self, url, params=None, headers=None, timeout=None, **kwargs):
        self.calls.append(url)
        key = "workout" if "workout" in url else "recovery"
        return FakeResponse(FIXTURE[key])


def client(tmp):
    store = TokenStore(Path(tmp) / "t.json")
    store.save({"refresh_token": "r"})
    return WhoopClient(client_id="i", client_secret="s", token_store=store,
                       session=FixtureSession(), timezone=MELBOURNE)


class FixtureTests(unittest.TestCase):
    def test_the_fixture_parses_into_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            records = client(tmp).recoveries(dt.date(2026, 10, 31))
        self.assertEqual(len(records), 15)      # 15 scored, the pending one dropped
        self.assertTrue(all(r.hrv_rmssd_milli > 0 for r in records))

    def test_the_poor_morning_classifies_red(self):
        with tempfile.TemporaryDirectory() as tmp:
            records = client(tmp).recoveries(dt.date(2026, 10, 31))
        decision = classify(dt.date(2026, 10, 31), records)
        self.assertIs(decision.tier, Tier.RED)
        self.assertEqual(decision.recovery_score, 29)
        self.assertGreater(decision.baseline.days, 10)

    def test_the_heavy_gym_day_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            workouts = client(tmp).workouts(dt.date(2026, 10, 31))
        # The fixture's last gym session is the Friday before, at strain 16.8.
        note = gym_strain_note(workouts, workouts[-1].date, sport_names=["weightlifting"])
        self.assertIsNotNone(note)
        self.assertIn("ignore pace entirely", note)


if __name__ == "__main__":
    unittest.main()
