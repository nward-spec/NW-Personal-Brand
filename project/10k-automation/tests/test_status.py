"""The status file is the dashboard's only source of live truth."""

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from tenk.adjust import AdjustmentEngine
from tenk.intervals_icu import Completion
from tenk.plan import Plan
from tenk.state import RunState
from tenk.status import build_status, write_status
from tenk.tiers import Baseline, Tier, TierDecision

PLAN_FILE = Path(__file__).resolve().parent.parent / "config" / "plan.yaml"
TODAY = dt.date(2026, 10, 31)


def decision(tier, **kw):
    base = dict(recovery_score=48.0, hrv=55.2, rhr=48.4,
                baseline=Baseline(60.0, 4.0, 46.0, 14))
    base.update(kw)
    return TierDecision(date=TODAY, tier=tier, base_tier=tier,
                        reason="Recovery 48% sits in the 34-66% band.", **base)


class StatusCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.plan = Plan.load(PLAN_FILE)
        self.state = RunState(Path(self.tmp.name) / "state.json")

    def adjusted(self, tier=Tier.AMBER, day=TODAY):
        engine = AdjustmentEngine(self.plan, self.state)
        return engine.apply(self.plan.day_plan(day), decision(tier))


class BuildTests(StatusCase):
    def test_today_detail_carries_the_decision_and_its_inputs(self):
        result = self.adjusted()
        self.state.record_tier(TODAY, "AMBER")
        payload = build_status(self.plan, self.state, TODAY, result, {})
        detail = payload["today_detail"]
        self.assertEqual(detail["tier"], "AMBER")
        self.assertTrue(detail["modified"])
        self.assertEqual(detail["prescribed"], "2 x 4km @ 3:40-3:45")
        self.assertEqual(detail["recovery"], 48)
        self.assertEqual(detail["hrv"], 55.2)
        self.assertEqual(detail["hrv_baseline"], 60.0)

    def test_edits_carry_what_changed_and_why(self):
        self.adjusted()
        payload = build_status(self.plan, self.state, TODAY, None, {})
        self.assertTrue(payload["edits"])
        edit = payload["edits"][0]
        self.assertEqual(edit["date"], TODAY.isoformat())
        self.assertEqual(edit["tier"], "AMBER")
        self.assertIn("reps", edit["summary"])
        self.assertEqual(edit["was"], "2 x 4km @ 3:40-3:45")
        self.assertTrue(edit["why"])

    def test_edits_are_newest_first(self):
        self.adjusted(day=dt.date(2026, 10, 27))
        self.adjusted(day=TODAY)
        payload = build_status(self.plan, self.state, TODAY, None, {})
        dates = [e["date"] for e in payload["edits"]]
        self.assertEqual(dates, sorted(dates, reverse=True))

    def test_completions_are_summarised_per_day(self):
        done = {TODAY: [Completion(TODAY, "AM", 12.0, 3720, 148, "Run"),
                        Completion(TODAY, "PM", 11.0, 3630, 138, "Run")]}
        payload = build_status(self.plan, self.state, TODAY, None, done)
        entry = payload["days"][TODAY.isoformat()]["done"]
        self.assertEqual(entry["runs"], 2)
        self.assertEqual(entry["km"], 23.0)
        self.assertEqual(entry["avg_hr"], 143)
        self.assertEqual(entry["pace"], "5:20")

    def test_pace_rounds_up_into_the_next_minute(self):
        # 10 km in 3597 s is 359.7 s/km, which must read 6:00, never 5:60.
        done = {TODAY: [Completion(TODAY, "AM", 10.0, 3597, 150, "Run")]}
        payload = build_status(self.plan, self.state, TODAY, None, done)
        self.assertEqual(payload["days"][TODAY.isoformat()]["done"]["pace"], "6:00")

    def test_tiers_are_recorded_per_day(self):
        self.state.record_tier(TODAY, "RED")
        payload = build_status(self.plan, self.state, TODAY, None, {})
        self.assertEqual(payload["days"][TODAY.isoformat()]["tier"], "RED")

    def test_days_outside_the_window_are_not_included(self):
        old = TODAY - dt.timedelta(days=60)
        self.state.record_tier(old, "GREEN")
        payload = build_status(self.plan, self.state, TODAY, None, {})
        self.assertNotIn(old.isoformat(), payload["days"])

    def test_a_green_day_still_reports_its_tier(self):
        result = self.adjusted(Tier.GREEN)
        payload = build_status(self.plan, self.state, TODAY, result, {})
        self.assertEqual(payload["today_detail"]["tier"], "GREEN")
        self.assertFalse(payload["today_detail"]["modified"])
        self.assertEqual(payload["edits"], [])

    def test_payload_is_json_serialisable(self):
        result = self.adjusted()
        payload = build_status(self.plan, self.state, TODAY, result, {})
        json.loads(json.dumps(payload))

    def test_schema_and_anchors_are_present(self):
        payload = build_status(self.plan, self.state, TODAY, None, {})
        for key in ("schema", "generated", "today", "goal_pace", "race_date"):
            self.assertIn(key, payload)


class WriteTests(StatusCase):
    def test_writes_to_every_destination(self):
        root = Path(self.tmp.name)
        targets = [root / "a" / "s.json", root / "b" / "s.json"]
        written = write_status(targets, {"schema": 1})
        self.assertEqual(len(written), 2)
        for t in targets:
            self.assertEqual(json.loads(t.read_text())["schema"], 1)

    def test_an_unavailable_sync_folder_does_not_stop_the_others(self):
        # A regular file where a directory is expected: the same shape of
        # failure as a sync volume that is not mounted this morning.
        root = Path(self.tmp.name)
        blocker = root / "not-a-dir"
        blocker.write_text("", encoding="utf-8")
        good = root / "good" / "s.json"
        written = write_status([blocker / "s.json", good], {"schema": 1})
        self.assertEqual(written, [good])

    def test_sync_destinations_are_written_in_place(self):
        """A rename is what sync clients miss, so only the first path uses one."""
        import os
        root = Path(self.tmp.name)
        local, synced = root / "local.json", root / "synced.json"
        write_status([local, synced], {"schema": 1})
        before = os.stat(synced).st_ino
        write_status([local, synced], {"schema": 2})
        self.assertEqual(os.stat(synced).st_ino, before,
                         "the synced copy must keep its inode, not be replaced")
        self.assertEqual(json.loads(synced.read_text())["schema"], 2)

    def test_the_local_copy_is_still_written_atomically(self):
        import os
        root = Path(self.tmp.name)
        local = root / "local.json"
        write_status([local], {"schema": 1})
        before = os.stat(local).st_ino
        write_status([local], {"schema": 2})
        self.assertNotEqual(os.stat(local).st_ino, before)

    def test_the_file_is_readable_not_private(self):
        target = Path(self.tmp.name) / "s.json"
        write_status([target], {"schema": 1})
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)


if __name__ == "__main__":
    unittest.main()
