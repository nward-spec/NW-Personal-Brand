import unittest
from pathlib import Path

import yaml

from tenk.paces import PaceBand, PaceTable, format_pace, parse_pace

PLAN = yaml.safe_load((Path(__file__).resolve().parent.parent / "config" / "plan.yaml").read_text())


class ParseTests(unittest.TestCase):
    def test_round_trip(self):
        self.assertEqual(parse_pace("3:45"), 225)
        self.assertEqual(format_pace(225), "3:45")
        self.assertEqual(format_pace(224.6), "3:45")

    def test_rejects_nonsense(self):
        for bad in ("345", "3:xx", "", "0:00"):
            with self.assertRaises(ValueError):
                parse_pace(bad)

    def test_band_must_be_ordered(self):
        with self.assertRaises(ValueError):
            PaceBand("bad", 240, 220)


class TableTests(unittest.TestCase):
    def setUp(self):
        self.table = PaceTable.from_config(PLAN["paces"])

    def test_derived_bands_follow_goal_pace(self):
        """Offsets, not literals: the goal pace moves when fitness is retested.

        Pinning the derived values broke this suite twice - once at the Tue/Fri
        restructure and again when the goal went from 37:00 to 38:00. The
        offsets are the contract; the numbers are whatever goal pace says.
        """
        goal = self.table["goal_pace"]
        spec = PLAN["paces"]
        for name in ("five_k", "threshold", "threshold_sharp", "vo2", "progression"):
            entry = spec[name]
            self.assertEqual(entry.get("from"), "goal_pace", name)
            band = self.table[name]
            self.assertEqual(band.fast, goal.fast + float(entry["offset_fast"]), name)
            if "offset_slow" in entry:
                self.assertEqual(band.slow, goal.slow + float(entry["offset_slow"]), name)

    def test_absolute_bands_do_not_move_with_goal_pace(self):
        """Aerobic paces are deliberately not tied to 10k fitness."""
        self.assertEqual(self.table["steady"].human(), "4:25-4:35")
        self.assertEqual(self.table["recovery"].human(), "5:20-5:50")
        self.assertEqual(self.table["easy"].human(), "5:00-5:30")

    def test_goal_pace_is_a_single_variable(self):
        """The whole point: the time trial moves one line and the block follows."""
        recalibrated = dict(PLAN["paces"])
        recalibrated["goal_pace"] = {"range": "3:35-3:38"}
        table = PaceTable.from_config(recalibrated)
        self.assertEqual(table["goal_pace"].human(), "3:35-3:38")
        self.assertEqual(table["five_k"].human(), "3:30-3:33")
        self.assertEqual(table["threshold"].human(), "3:55-4:01")
        # Aerobic paces are deliberately not tied to 10k fitness.
        self.assertEqual(table["easy"].human(), "5:00-5:30")

    def test_icu_target_syntax(self):
        goal = self.table["goal_pace"]
        self.assertEqual(goal.icu(), f"{goal.human().replace('-', '/km-')}/km Pace")
        # A zero-width band is a single pace, not a range.
        strides = self.table["strides"]
        self.assertEqual(strides.icu(), f"{strides.human()}/km Pace")
        self.assertNotIn("-", strides.icu())

    def test_unresolvable_reference_is_an_error(self):
        with self.assertRaises(ValueError):
            PaceTable.from_config({"goal_pace": {"range": "3:40"}, "x": {"from": "nope"}})

    def test_goal_pace_is_required(self):
        with self.assertRaises(ValueError):
            PaceTable.from_config({"easy": {"range": "5:00-5:30"}})


if __name__ == "__main__":
    unittest.main()
