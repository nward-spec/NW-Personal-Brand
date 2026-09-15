import datetime as dt
import tempfile
import unittest
from pathlib import Path

from tenk.adjust import AdjustmentEngine, gym_strain_note, summarise_day
from tenk.plan import Plan
from tenk.state import RunState
from tenk.tiers import Baseline, Tier, TierDecision
from tenk.whoop import WhoopWorkout
from tenk.workout import Repeat

PLAN_FILE = Path(__file__).resolve().parent.parent / "config" / "plan.yaml"

QUALITY_DAY = dt.date(2026, 10, 31)     # week 7 Saturday, 2 x 4km @ GP
LONG_RUN_DAY = dt.date(2026, 11, 1)     # week 7 Sunday, 20km with progression
DOUBLE_DAY = dt.date(2026, 10, 27)      # week 7 Tuesday, 23km as a double
RUN_CLUB_DAY = dt.date(2026, 10, 28)
RACE_DAY = dt.date(2026, 11, 22)
RACE_WEEK_DAY = dt.date(2026, 11, 17)


def decision(day, tier, reason="synthetic"):
    return TierDecision(
        date=day, tier=tier, base_tier=tier, reason=reason,
        recovery_score=50.0, hrv=55.0, rhr=48.0, baseline=Baseline(60.0, 4.0, 46.0, 14),
    )


class EngineCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.plan = Plan.load(PLAN_FILE)
        self.state = RunState(Path(self.tmp.name) / "state.json")
        self.engine = AdjustmentEngine(self.plan, self.state)

    def apply(self, day, tier, **kwargs):
        return self.engine.apply(self.plan.day_plan(day), decision(day, tier), **kwargs)


class GreenTests(EngineCase):
    def test_green_changes_nothing(self):
        result = self.apply(QUALITY_DAY, Tier.GREEN)
        self.assertFalse(result.modified)
        self.assertEqual(result.original_summary, summarise_day(result.day))


class AmberTests(EngineCase):
    def test_reps_cut_by_a_quarter_rounded_down(self):
        week5 = dt.date(2026, 10, 17)          # 4 x 1500m
        result = self.apply(week5, Tier.AMBER)
        repeat = next(e for e in result.day.runs[0].workout.elements if isinstance(e, Repeat))
        self.assertEqual(repeat.reps, 3)

    def test_pace_is_never_softened(self):
        before = self.plan.day_plan(QUALITY_DAY).runs[0].workout
        target = next(e for e in before.elements if isinstance(e, Repeat)).steps[0].pace
        result = self.apply(QUALITY_DAY, Tier.AMBER)
        after = next(e for e in result.day.runs[0].workout.elements if isinstance(e, Repeat)).steps[0].pace
        self.assertEqual(after.human(), target.human())

    def test_long_run_is_untouched_on_amber(self):
        result = self.apply(LONG_RUN_DAY, Tier.AMBER)
        self.assertFalse(result.modified)
        self.assertIn("progression", result.day.runs[0].workout.name)

    def test_amber_drops_the_pm_run_but_keeps_the_day(self):
        result = self.apply(DOUBLE_DAY, Tier.AMBER)
        self.assertEqual(len(result.day.runs), 1)
        self.assertEqual(result.day.runs[0].slot, "am")
        self.assertEqual(result.modifications[0].kind, "double_dropped")

    def test_easy_single_run_is_untouched(self):
        result = self.apply(dt.date(2026, 9, 17), Tier.AMBER)   # week 1 Thursday, single
        self.assertFalse(result.modified)


class RedTests(EngineCase):
    def test_quality_becomes_easy_of_the_same_duration(self):
        original = self.plan.day_plan(QUALITY_DAY).runs[0].workout
        result = self.apply(QUALITY_DAY, Tier.RED)
        replaced = result.day.runs[0].workout
        self.assertEqual(replaced.kind, "easy")
        self.assertAlmostEqual(replaced.est_seconds() / 60, original.est_seconds() / 60, delta=1.0)
        self.assertIn("Z2", replaced.icu_text())

    def test_long_run_cut_to_seventy_percent(self):
        result = self.apply(LONG_RUN_DAY, Tier.RED)
        self.assertAlmostEqual(result.day.runs[0].km, 14.0, delta=0.2)
        self.assertNotIn("progression", result.day.runs[0].workout.name)

    def test_red_drops_the_pm_run(self):
        result = self.apply(DOUBLE_DAY, Tier.RED)
        self.assertEqual(len(result.day.runs), 1)


class ImmunityTests(EngineCase):
    def test_wednesday_is_never_modified(self):
        result = self.apply(RUN_CLUB_DAY, Tier.RED)
        self.assertFalse(result.modified)
        self.assertTrue(any("back group" in f for f in result.flags))

    def test_race_day_is_never_modified(self):
        result = self.apply(RACE_DAY, Tier.RED)
        self.assertFalse(result.modified)
        self.assertEqual(result.day.runs[0].workout.kind, "race")

    def test_race_week_ignores_amber(self):
        result = self.apply(RACE_WEEK_DAY, Tier.AMBER)
        self.assertFalse(result.modified)
        self.assertTrue(any("immune to AMBER" in n for n in result.day.notes))

    def test_race_week_still_responds_to_red(self):
        result = self.apply(dt.date(2026, 11, 21), Tier.RED)   # race-week Saturday shakeout
        self.assertTrue(any("Race week" not in n for n in result.day.notes))


class ConsecutiveRedTests(EngineCase):
    def test_two_reds_in_a_row_force_full_rest(self):
        self.state.record_tier(QUALITY_DAY - dt.timedelta(days=1), "RED")
        self.state.record_tier(QUALITY_DAY, "RED")
        result = self.apply(QUALITY_DAY, Tier.RED)
        self.assertTrue(result.day.rest)
        self.assertFalse(result.day.runs)
        self.assertTrue(any("LOUD FLAG" in f for f in result.flags))

    def test_the_missed_session_is_carried_not_skipped(self):
        self.state.record_tier(QUALITY_DAY - dt.timedelta(days=1), "RED")
        self.state.record_tier(QUALITY_DAY, "RED")
        self.apply(QUALITY_DAY, Tier.RED)
        carried = self.state.carry_forward(QUALITY_DAY)
        self.assertIsNotNone(carried)
        self.assertEqual(carried["kind"], "quality")

    def test_a_single_red_does_not_force_rest(self):
        self.state.record_tier(QUALITY_DAY, "RED")
        result = self.apply(QUALITY_DAY, Tier.RED)
        self.assertFalse(result.day.rest)


class CircuitBreakerTests(EngineCase):
    def test_third_modification_fires_but_is_flagged(self):
        for stamp in ("2026-10-27", "2026-10-29"):
            self.state.record_modification("w07", {"date": stamp, "summary": "earlier"})
        result = self.apply(QUALITY_DAY, Tier.AMBER)
        self.assertTrue(result.modified)                    # it still fires
        self.assertTrue(all(m.flagged_for_review for m in result.modifications))
        self.assertTrue(any("REVIEW" in f for f in result.flags))

    def test_first_two_are_not_flagged(self):
        self.state.record_modification("w07", {"date": "2026-10-27", "summary": "earlier"})
        result = self.apply(QUALITY_DAY, Tier.AMBER)
        self.assertFalse(any(m.flagged_for_review for m in result.modifications))

    def test_modifications_are_recorded_against_the_plan_week(self):
        self.apply(QUALITY_DAY, Tier.AMBER)
        self.assertEqual(len(self.state.modifications("w07")), 1)

    def test_rerunning_the_same_day_does_not_double_count(self):
        self.apply(QUALITY_DAY, Tier.AMBER)
        self.apply(QUALITY_DAY, Tier.AMBER)
        self.assertEqual(len(self.state.modifications("w07")), 1)


class GymFeedForwardTests(unittest.TestCase):
    def workouts(self, strains, yesterday):
        out = []
        day = yesterday - dt.timedelta(days=28)
        for strain in strains[:-1]:
            while day.weekday() not in (0, 4):
                day += dt.timedelta(days=1)
            out.append(WhoopWorkout(day, strain, "weightlifting",
                                    dt.datetime.combine(day, dt.time(6, 30)), {}))
            day += dt.timedelta(days=1)
        out.append(WhoopWorkout(yesterday, strains[-1], "weightlifting",
                                dt.datetime.combine(yesterday, dt.time(6, 30)), {}))
        return out

    def test_heavy_gym_day_raises_a_note(self):
        yesterday = dt.date(2026, 10, 26)      # Monday
        note = gym_strain_note(self.workouts([10, 10, 10, 10, 15], yesterday), yesterday)
        self.assertIsNotNone(note)
        self.assertIn("hold the HR cap hard", note)

    def test_normal_gym_day_is_quiet(self):
        yesterday = dt.date(2026, 10, 26)
        self.assertIsNone(gym_strain_note(self.workouts([10, 10, 10, 10, 11], yesterday), yesterday))

    def test_non_gym_day_is_ignored(self):
        yesterday = dt.date(2026, 10, 27)      # Tuesday
        self.assertIsNone(gym_strain_note(self.workouts([10, 10, 10, 10, 20], yesterday), yesterday))

    def test_thin_history_makes_no_claim(self):
        yesterday = dt.date(2026, 10, 26)
        self.assertIsNone(gym_strain_note(self.workouts([10, 20], yesterday), yesterday))


if __name__ == "__main__":
    unittest.main()
