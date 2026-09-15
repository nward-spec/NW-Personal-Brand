import datetime as dt
import unittest
from pathlib import Path

from tenk.plan import Plan

PLAN_FILE = Path(__file__).resolve().parent.parent / "config" / "plan.yaml"


class PlanShapeTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)

    def test_ten_weeks_ending_on_race_day(self):
        self.assertEqual(len(self.plan.weeks), 10)
        self.assertEqual(self.plan.weeks[-1].end, self.plan.race_date)
        self.assertEqual(self.plan.race_date, dt.date(2026, 11, 22))

    def test_every_week_starts_on_a_monday(self):
        for week in self.plan.weeks:
            self.assertEqual(week.start.weekday(), 0, week.number)

    def test_run_days_never_change(self):
        for week in self.plan.weeks:
            for offset in range(7):
                day = week.start + dt.timedelta(days=offset)
                plan_day = self.plan.day_plan(day)
                weekday = plan_day.weekday
                if weekday in ("mon",):
                    self.assertFalse(plan_day.runs, f"{day} should be a gym day")
                if weekday in ("tue", "wed", "thu", "sat", "sun"):
                    self.assertTrue(plan_day.runs, f"{day} must be a run day")

    def test_long_run_never_exceeds_the_cap(self):
        for week in self.plan.weeks[:-1]:
            self.assertLessEqual(self.plan.long_run_km(week), 20.0)

    def test_nothing_under_a_kilometre_after_week_four(self):
        """The block is deliberately weighted to long reps."""
        for week in self.plan.weeks[4:]:
            spec = week.quality or {}
            rep = spec.get("rep") or {}
            if "km" in rep:
                self.assertGreaterEqual(float(rep["km"]), 1.0, f"week {week.number}")


class AllocationTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)

    def week(self, number):
        return next(w for w in self.plan.weeks if w.number == number)

    def test_allocation_lands_on_the_weekly_target(self):
        for number in range(1, 10):
            week = self.week(number)
            allocation = self.plan.allocate(week)
            self.assertLess(
                abs(allocation.planned_total - week.volume_km), 2.0,
                f"week {number}: {allocation.planned_total} vs {week.volume_km}",
            )

    def test_every_run_day_is_present_in_every_week(self):
        for number in range(1, 10):
            allocation = self.plan.allocate(self.week(number))
            self.assertEqual(set(allocation.day_km), {"tue", "wed", "thu", "sat", "sun"})
            for day, km in allocation.day_km.items():
                self.assertGreaterEqual(km, 5.0, f"week {number} {day}")

    def test_wednesday_reconciliation_moves_volume_to_thursday(self):
        week = self.week(7)
        planned = self.plan.allocate(week)
        short = self.plan.allocate(week, {"tue": planned.day_km["tue"], "wed": 6.0})
        self.assertGreater(short.day_km["thu"], planned.day_km["thu"])
        self.assertEqual(short.day_km["wed"], 6.0)

    def test_a_long_wednesday_takes_volume_off_thursday(self):
        week = self.week(7)
        planned = self.plan.allocate(week)
        long_wed = self.plan.allocate(week, {"tue": planned.day_km["tue"], "wed": 14.0})
        self.assertLess(long_wed.day_km["thu"], planned.day_km["thu"])

    def test_quality_and_long_run_never_flex_for_volume(self):
        week = self.week(7)
        planned = self.plan.allocate(week)
        rebalanced = self.plan.allocate(week, {"tue": 18.0, "wed": 6.0})
        self.assertEqual(planned.day_km["sat"], rebalanced.day_km["sat"])
        self.assertEqual(planned.day_km["sun"], rebalanced.day_km["sun"])


class DoubleTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)

    def test_single_run_until_the_day_needs_more_than_twelve(self):
        day = self.plan.day_plan(dt.date(2026, 9, 15))   # week 1 Tuesday, 10 km
        self.assertEqual(len(day.runs), 1)

    def test_big_day_splits_with_both_runs_over_the_minimum(self):
        day = self.plan.day_plan(dt.date(2026, 10, 27))  # week 7 Tuesday, 23 km
        self.assertEqual(len(day.runs), 2)
        for run in day.runs:
            self.assertGreaterEqual(run.km, 5.0)
        self.assertEqual(day.runs[1].slot, "pm")

    def test_second_run_is_z1(self):
        day = self.plan.day_plan(dt.date(2026, 10, 27))
        text = day.runs[1].workout.icu_text()
        self.assertIn("Z1 HR", text)

    def test_wednesday_never_doubles(self):
        for week in self.plan.weeks[:-1]:
            day = self.plan.day_plan(week.date_for("wed"))
            self.assertEqual(len(day.runs), 1, week.number)


class RaceWeekTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)

    def test_race_day_is_the_race(self):
        day = self.plan.day_plan(dt.date(2026, 11, 22))
        self.assertTrue(day.race_day)
        self.assertEqual(day.runs[0].workout.kind, "race")

    def test_no_gym_on_race_week_friday(self):
        day = self.plan.day_plan(dt.date(2026, 11, 20))
        self.assertIsNone(day.gym)
        self.assertTrue(day.rest)

    def test_saturday_is_a_shakeout(self):
        day = self.plan.day_plan(dt.date(2026, 11, 21))
        self.assertEqual(day.runs[0].workout.kind, "shakeout")
        self.assertIn("strides", day.runs[0].workout.name)

    def test_run_club_is_capped_in_race_week(self):
        day = self.plan.day_plan(dt.date(2026, 11, 18))
        self.assertIn("CAPPED", " ".join(day.notes) + " ".join(day.runs[0].workout.notes))


class QualityTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)

    def test_goal_pace_is_expanded_in_session_names(self):
        week = next(w for w in self.plan.weeks if w.number == 7)
        workout = self.plan.quality_workout(week)
        self.assertEqual(workout.name, "2 x 4km @ 3:40-3:45")
        self.assertNotIn("GP", workout.name)

    def test_keystone_session_is_eight_kilometres_at_goal_pace(self):
        week = next(w for w in self.plan.weeks if w.number == 7)
        workout = self.plan.quality_workout(week)
        repeat = workout.elements[1]
        self.assertEqual(repeat.reps * repeat.steps[0].km, 8.0)

    def test_week_four_is_a_time_trial(self):
        week = next(w for w in self.plan.weeks if w.number == 4)
        workout = self.plan.quality_workout(week)
        self.assertIn("TIME TRIAL", workout.name.upper())
        self.assertIn("recalibrates goal pace", " ".join(workout.notes))

    def test_easy_runs_carry_no_pace_target(self):
        day = self.plan.day_plan(dt.date(2026, 9, 17))   # week 1 Thursday
        text = day.runs[0].workout.icu_text()
        self.assertNotIn("Pace", text.split("# ")[0].replace("Strides", ""))
        self.assertIn("Z2 HR", text)

    def test_long_run_progression_uses_the_progression_band(self):
        week = next(w for w in self.plan.weeks if w.number == 7)
        workout = self.plan.long_run_workout(week)
        self.assertIn("4:05/km-4:15/km Pace", workout.icu_text())


if __name__ == "__main__":
    unittest.main()
