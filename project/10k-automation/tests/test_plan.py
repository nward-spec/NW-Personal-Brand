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

    def test_run_days_match_the_phase_of_the_block(self):
        """Weeks 1-5 run Tue/Wed/Thu/Sat/Sun; weeks 6-9 add Friday.

        Friday is a gym day up to week 5 and the key session from week 6, so
        "the run days never change" stopped being true at week 6.
        """
        for week in self.plan.weeks:
            for offset in range(7):
                day = week.start + dt.timedelta(days=offset)
                plan_day = self.plan.day_plan(day)
                weekday = plan_day.weekday
                if weekday == "mon":
                    self.assertFalse(plan_day.runs, f"{day} should be a gym day")
                if weekday in ("tue", "wed", "sat", "sun"):
                    self.assertTrue(plan_day.runs, f"{day} must be a run day")
                if weekday == "fri":
                    if 6 <= week.number <= 9:
                        self.assertTrue(plan_day.runs, f"{day} is the key session")
                    else:
                        self.assertFalse(plan_day.runs, f"{day} is gym or rest")
                if weekday == "thu":
                    # Basketball is Thursday night. From week 7 the day is a
                    # rest day from running, so Friday's key session is not
                    # run on legs that played the night before and also ran
                    # that morning.
                    if 7 <= week.number <= 9:
                        self.assertFalse(plan_day.runs, f"{day} is basketball")
                    else:
                        self.assertTrue(plan_day.runs, f"{day} must be a run day")

    def test_long_run_never_exceeds_the_cap(self):
        for week in self.plan.weeks[:-1]:
            self.assertLessEqual(self.plan.long_run_km(week), 20.0)

    def test_nothing_under_a_kilometre_after_week_four(self):
        """The block is deliberately weighted to long reps."""
        for week in self.plan.weeks[4:]:
            for weekday, spec in self.plan.quality_specs(week).items():
                rep = spec.get("rep") or {}
                if "km" in rep:
                    self.assertGreaterEqual(
                        float(rep["km"]), 1.0, f"week {week.number} {weekday}")


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
            expected = {"tue", "wed", "sat", "sun"}
            if 6 <= number <= 9:
                expected.add("fri")        # the key session day
            if not 7 <= number <= 9:
                expected.add("thu")        # rest for basketball from week 7
            self.assertEqual(set(allocation.day_km), expected, f"week {number}")
            for day, km in allocation.day_km.items():
                self.assertGreaterEqual(km, 5.0, f"week {number} {day}")

    def test_a_short_midweek_run_moves_volume_to_the_other_easy_day(self):
        """Thursday is a rest day from week 7, so Saturday is what flexes."""
        week = self.week(7)
        planned = self.plan.allocate(week)
        short = self.plan.allocate(week, {"wed": 4.0})
        self.assertGreater(short.day_km["sat"], planned.day_km["sat"])
        self.assertEqual(short.day_km["wed"], 4.0)
        self.assertNotIn("thu", planned.day_km)

    def test_a_long_midweek_run_takes_volume_off_the_other_easy_day(self):
        week = self.week(7)
        planned = self.plan.allocate(week)
        long_wed = self.plan.allocate(week, {"wed": 18.0})
        self.assertLess(long_wed.day_km["sat"], planned.day_km["sat"])

    def test_a_pinned_easy_day_never_absorbs_volume(self):
        """A week-6 Thursday is capped at 6km, whatever Wednesday came back as."""
        week = self.week(6)
        for actuals in ({}, {"wed": 6.0}, {"wed": 18.0}):
            self.assertEqual(self.plan.allocate(week, actuals).day_km["thu"], 6.0)

    def test_basketball_thursdays_carry_no_run_at_all(self):
        for number in (7, 8, 9):
            week = self.week(number)
            self.assertNotIn("thu", self.plan.allocate(week).day_km, f"week {number}")

    def test_quality_and_long_run_never_flex_for_volume(self):
        """Structural days carry their own distance. Easy days absorb the rest.

        In weeks 6-9 the structural days are Tuesday, Friday and Sunday.
        """
        week = self.week(7)
        planned = self.plan.allocate(week)
        rebalanced = self.plan.allocate(week, {"wed": 6.0})
        for structural in ("tue", "fri", "sun"):
            self.assertEqual(
                planned.day_km[structural], rebalanced.day_km[structural], structural)


class DoubleTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)

    def test_single_run_until_the_day_needs_more_than_twelve(self):
        day = self.plan.day_plan(dt.date(2026, 9, 15))   # week 1 Tuesday, 10 km
        self.assertEqual(len(day.runs), 1)

    def test_big_day_splits_with_both_runs_over_the_minimum(self):
        day = self.plan.day_plan(dt.date(2026, 10, 13))  # week 5 Tuesday, 19 km
        self.assertEqual(len(day.runs), 2)
        for run in day.runs:
            self.assertGreaterEqual(run.km, 5.0)
        self.assertEqual(day.runs[1].slot, "pm")

    def test_second_run_is_z1(self):
        day = self.plan.day_plan(dt.date(2026, 10, 13))
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

    def test_race_week_wednesday_is_a_short_easy_run(self):
        """Run club is dropped from week 6, so race-week Wednesday is just easy."""
        day = self.plan.day_plan(dt.date(2026, 11, 18))
        self.assertEqual(day.runs[0].workout.kind, "easy")
        self.assertLessEqual(day.runs[0].km, 6.0)


class QualityTests(unittest.TestCase):
    def setUp(self):
        self.plan = Plan.load(PLAN_FILE)

    def test_goal_pace_is_expanded_in_session_names(self):
        week = next(w for w in self.plan.weeks if w.number == 8)
        workout = self.plan.quality_workout(week, self.plan.quality_specs(week)["tue"])
        self.assertEqual(workout.name,
                         f"4 x 2km @ {self.plan.paces['goal_pace'].human()}")
        self.assertNotIn("GP", workout.name)

    def test_the_week_eight_tuesday_is_eight_kilometres_at_goal_pace(self):
        week = next(w for w in self.plan.weeks if w.number == 8)
        workout = self.plan.quality_workout(week, self.plan.quality_specs(week)["tue"])
        repeat = workout.elements[1]
        self.assertEqual(repeat.reps * repeat.steps[0].km, 8.0)

    def test_the_keystone_is_thirty_minutes_of_threshold(self):
        week = next(w for w in self.plan.weeks if w.number == 7)
        specs = self.plan.quality_specs(week)
        self.assertTrue(specs["fri"].get("keystone"), "Friday is the keystone")
        workout = self.plan.quality_workout(week, specs["fri"])
        repeat = workout.elements[1]
        self.assertEqual(repeat.reps * repeat.steps[0].seconds / 60, 30.0)
        self.assertIn(self.plan.paces["threshold_sharp"].icu(), workout.icu_text())

    def test_every_week_from_six_has_two_quality_sessions(self):
        for week in self.plan.weeks[5:9]:
            specs = self.plan.quality_specs(week)
            self.assertEqual(list(specs), ["tue", "fri"], f"week {week.number}")

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
        week = next(w for w in self.plan.weeks if w.number == 3)
        workout = self.plan.long_run_workout(week)
        self.assertIn(self.plan.paces["progression"].icu(), workout.icu_text())


if __name__ == "__main__":
    unittest.main()
