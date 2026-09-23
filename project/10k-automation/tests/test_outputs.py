"""intervals.icu events, calendar rendering, state durability, the summary."""

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from tenk.adjust import AdjustedDay, AdjustmentEngine
from tenk.gcal import build_description, build_title, completion_title, event_id
from tenk.intervals_icu import Completion, build_events, completions_by_date, external_id
from tenk.plan import Plan
from tenk.state import RunState, TokenStore, atomic_write_json
from tenk.summary import build_week_summary, render_slack
from tenk.tiers import Baseline, Tier, TierDecision

PLAN_FILE = Path(__file__).resolve().parent.parent / "config" / "plan.yaml"
QUALITY_DAY = dt.date(2026, 10, 31)


def green(day):
    return TierDecision(date=day, tier=Tier.GREEN, base_tier=Tier.GREEN, reason="Recovery 78%.",
                        recovery_score=78.0, hrv=64.0, rhr=45.0,
                        baseline=Baseline(60.0, 4.0, 46.0, 14))


class EventTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)

    def test_external_id_scheme(self):
        self.assertEqual(external_id("10k", 7, "sat", "am"), "10k-w07-sat-am")

    def test_ids_are_stable_across_runs(self):
        first = [e.external_id for e in build_events(self.plan.day_plan(QUALITY_DAY))]
        second = [e.external_id for e in build_events(self.plan.day_plan(QUALITY_DAY))]
        self.assertEqual(first, second)

    def test_a_double_writes_two_events(self):
        events = build_events(self.plan.day_plan(dt.date(2026, 10, 27)))
        self.assertEqual([e.external_id for e in events], ["10k-w07-tue-am", "10k-w07-tue-pm"])

    def test_gym_day_writes_a_gym_event(self):
        events = build_events(self.plan.day_plan(dt.date(2026, 10, 26)))
        self.assertEqual(events[0].payload["type"], "WeightTraining")

    def test_distance_is_written_in_metres(self):
        event = build_events(self.plan.day_plan(QUALITY_DAY))[0]
        self.assertAlmostEqual(event.payload["distance"] / 1000, self.plan.day_plan(QUALITY_DAY).total_km, places=1)

    def test_quality_carries_pace_targets(self):
        event = build_events(self.plan.day_plan(QUALITY_DAY))[0]
        self.assertIn("3:40/km-3:45/km Pace", event.payload["description"])

    def test_easy_run_carries_a_heart_rate_ceiling_only(self):
        event = build_events(self.plan.day_plan(dt.date(2026, 9, 17)))[0]
        body = event.payload["description"].split("#")[0]
        self.assertIn("Z2 HR", body)
        self.assertNotIn("Pace", body.replace("Strides", ""))

    def test_run_club_is_a_placeholder_with_no_structure(self):
        day = self.plan.day_plan(dt.date(2026, 10, 28))
        event = build_events(day)[0]
        self.assertTrue(day.runs[0].workout.placeholder)
        self.assertNotIn("Pace", event.payload["description"])
        self.assertIn("Reconciled Thursday", event.payload["description"])

    def test_modified_sessions_are_prefixed(self):
        event = build_events(self.plan.day_plan(QUALITY_DAY), tier="AMBER", modified=True)[0]
        self.assertTrue(event.payload["name"].startswith("[AMBER] "))

    def test_race_day_is_written_as_a_race(self):
        event = build_events(self.plan.day_plan(dt.date(2026, 11, 22)))[0]
        self.assertEqual(event.payload["category"], "RACE_A")

    def test_rest_day_writes_nothing(self):
        self.assertEqual(build_events(self.plan.day_plan(dt.date(2026, 11, 20))), [])


class CalendarTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)

    def test_event_id_is_deterministic_and_legal(self):
        identifier = event_id("tenk", QUALITY_DAY)
        self.assertEqual(identifier, event_id("tenk", QUALITY_DAY))
        self.assertTrue(all(c in "0123456789abcdefghijklmnopqrstuv" for c in identifier))
        self.assertNotEqual(identifier, event_id("tenk", QUALITY_DAY + dt.timedelta(days=1)))

    def test_run_title_shape(self):
        title = build_title(self.plan.day_plan(QUALITY_DAY))
        self.assertTrue(title.startswith("🏃 Sat — 2 x 4km @ 3:40-3:45"))
        self.assertIn("(KEYSTONE)", title)

    def test_gym_title_shape(self):
        self.assertTrue(build_title(self.plan.day_plan(dt.date(2026, 10, 26))).startswith("🏋️ Mon — Gym"))

    def test_modified_title_is_prefixed(self):
        title = build_title(self.plan.day_plan(dt.date(2026, 9, 15)), tier="RED", modified=True)
        self.assertTrue(title.startswith("[RED] "))

    def test_description_explains_the_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = RunState(Path(tmp) / "s.json")
            engine = AdjustmentEngine(self.plan, state)
            amber = TierDecision(date=QUALITY_DAY, tier=Tier.AMBER, base_tier=Tier.AMBER,
                                 reason="Recovery 48% sits in the 34-66% band.",
                                 recovery_score=48.0, hrv=55.0, rhr=48.0,
                                 baseline=Baseline(60.0, 4.0, 46.0, 14))
            result = engine.apply(self.plan.day_plan(QUALITY_DAY), amber)
        body = build_description(result)
        self.assertIn("Tier: AMBER", body)
        self.assertIn("Changed from the plan:", body)
        self.assertIn("was: 2 x 4km @ 3:40-3:45", body)
        self.assertIn("Recovery 48%", body)
        self.assertIn("baseline HRV 60.0 ms", body)

    def test_keystone_label_is_dropped_once_the_session_is_downgraded(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = AdjustmentEngine(self.plan, RunState(Path(tmp) / "s.json"))
            red = TierDecision(date=QUALITY_DAY, tier=Tier.RED, base_tier=Tier.RED,
                               reason="Recovery 28%.", recovery_score=28.0,
                               baseline=Baseline(60.0, 4.0, 46.0, 14))
            result = engine.apply(self.plan.day_plan(QUALITY_DAY), red)
        title = build_title(result.day, tier="RED", modified=result.modified)
        self.assertNotIn("KEYSTONE", title)
        self.assertIn("easy", title)

    def test_keystone_label_survives_a_rep_cut(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = AdjustmentEngine(self.plan, RunState(Path(tmp) / "s.json"))
            amber = TierDecision(date=QUALITY_DAY, tier=Tier.AMBER, base_tier=Tier.AMBER,
                                 reason="Recovery 48%.", recovery_score=48.0,
                                 baseline=Baseline(60.0, 4.0, 46.0, 14))
            result = engine.apply(self.plan.day_plan(QUALITY_DAY), amber)
        self.assertIn("KEYSTONE", build_title(result.day, tier="AMBER", modified=True))

    def test_completion_title(self):
        day = self.plan.day_plan(dt.date(2026, 9, 15))
        title = completion_title(day, [Completion(day.date, "Easy", 10.0, 3120, 147, "Run")])
        self.assertEqual(title, "✅ Tue — easy, 10.0km, 5:12/km, 147 avg HR")

    def test_completion_pace_rounds_up_into_the_next_minute(self):
        self.assertEqual(Completion(dt.date(2026, 9, 19), "R", 10.0, 3597, 150, "Run")
                         .pace_text, "6:00/km")

    def test_completion_title_merges_a_double(self):
        day = self.plan.day_plan(dt.date(2026, 10, 27))
        runs = [
            Completion(day.date, "AM", 12.0, 3720, 148, "Run"),
            Completion(day.date, "PM", 11.0, 3630, 138, "Run"),
        ]
        title = completion_title(day, runs)
        self.assertIn("23.0km", title)
        self.assertIn("(x2)", title)


class CompletionParsingTests(unittest.TestCase):
    def test_groups_by_local_date_and_converts_metres(self):
        grouped = completions_by_date([
            {"start_date_local": "2026-10-28T05:50:00", "distance": 9840.0,
             "moving_time": 3050, "average_heartrate": 151.4, "type": "Run", "name": "Run club"},
            {"start_date_local": "2026-10-28T17:30:00", "distance": 5000.0,
             "moving_time": 1700, "type": "Run", "name": "PM"},
        ])
        day = dt.date(2026, 10, 28)
        self.assertEqual(len(grouped[day]), 2)
        self.assertAlmostEqual(grouped[day][0].distance_km, 9.84)
        self.assertEqual(grouped[day][0].average_hr, 151)
        self.assertEqual(grouped[day][0].pace_text, "5:10/km")

    def test_bad_rows_are_skipped_not_guessed(self):
        self.assertEqual(completions_by_date([{"name": "no date"}, {"start_date_local": "junk"}]), {})


class StateTests(unittest.TestCase):
    def test_atomic_write_and_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tokens.json"
            atomic_write_json(path, {"refresh_token": "abc"})
            self.assertEqual(json.loads(path.read_text())["refresh_token"], "abc")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_token_store_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = TokenStore(Path(tmp) / "t.json")
            self.assertEqual(store.load(), {})
            store.save({"access_token": "a", "refresh_token": "r"})
            self.assertEqual(store.load()["refresh_token"], "r")
            store.save({"access_token": "a2", "refresh_token": "r2"})
            self.assertEqual(store.load()["refresh_token"], "r2")

    def test_consecutive_reds(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = RunState(Path(tmp) / "s.json")
            for offset, tier in enumerate(["RED", "RED", "AMBER"]):
                state.record_tier(dt.date(2026, 10, 31) - dt.timedelta(days=offset), tier)
            self.assertEqual(state.consecutive_reds(dt.date(2026, 10, 31)), 2)
            self.assertEqual(state.consecutive_reds(dt.date(2026, 10, 29)), 0)

    def test_state_survives_a_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.json"
            state = RunState(path)
            state.record_tier(dt.date(2026, 10, 31), "AMBER")
            state.record_modification("w07", {"date": "2026-10-31", "summary": "cut"})
            state.save()
            self.assertEqual(RunState(path).tier_on(dt.date(2026, 10, 31)), "AMBER")
            self.assertEqual(len(RunState(path).modifications("w07")), 1)


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = RunState(Path(self.tmp.name) / "s.json")
        self.week = next(w for w in self.plan.weeks if w.number == 6)

    def completions(self):
        out = {}
        for offset in range(7):
            day = self.week.start + dt.timedelta(days=offset)
            plan_day = self.plan.day_plan(day)
            if plan_day.runs:
                out[day] = [Completion(day, r.workout.name, r.km, int(r.km * 300), 145, "Run")
                            for r in plan_day.runs]
        return out

    def test_summary_reports_planned_against_actual(self):
        summary = build_week_summary(self.plan, self.state, self.week, self.completions())
        self.assertGreater(summary.actual_km, 0)
        self.assertEqual(summary.sessions_completed, summary.sessions_planned)
        message = render_slack(self.plan, summary, today=self.week.end)
        self.assertIn("Week 6 done", message)
        self.assertIn("Next up — week 7", message)
        self.assertIn("keystone", message)

    def test_more_than_two_downgrades_raises_a_siren(self):
        for offset in range(3):
            self.state.record_tier(self.week.start + dt.timedelta(days=offset), "AMBER")
        summary = build_week_summary(self.plan, self.state, self.week, self.completions())
        message = render_slack(self.plan, summary, today=self.week.end)
        self.assertIn("rotating_light", message)

    def test_slack_mrkdwn_not_markdown(self):
        summary = build_week_summary(self.plan, self.state, self.week, self.completions())
        message = render_slack(self.plan, summary, today=self.week.end)
        self.assertNotIn("**", message)
        self.assertNotIn("# ", message)


if __name__ == "__main__":
    unittest.main()
