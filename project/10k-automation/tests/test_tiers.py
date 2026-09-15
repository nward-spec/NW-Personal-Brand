import datetime as dt
import unittest

from tenk.tiers import RecoveryRecord, Tier, build_baseline, classify

TODAY = dt.date(2026, 10, 31)


def history(days=14, hrv=60.0, rhr=46.0, score=70.0, jitter=True):
    out = []
    for offset in range(1, days + 1):
        wobble = ((offset % 5) - 2) if jitter else 0
        out.append(RecoveryRecord(TODAY - dt.timedelta(days=offset), score, hrv + wobble, rhr))
    return out


class ClassificationTests(unittest.TestCase):
    def classify(self, score, hrv, rhr, past=None):
        records = (past if past is not None else history()) + [
            RecoveryRecord(TODAY, score, hrv, rhr)
        ]
        return classify(TODAY, records)

    def test_green_above_sixty_seven(self):
        self.assertIs(self.classify(67, 50, 46).tier, Tier.GREEN)

    def test_green_at_fifty_with_hrv_at_baseline(self):
        flat = history(jitter=False)   # baseline HRV exactly 60.0
        self.assertIs(self.classify(50, 60, 46, past=flat).tier, Tier.GREEN)
        self.assertIs(self.classify(50, 59.9, 46, past=flat).tier, Tier.AMBER)

    def test_amber_at_fifty_with_hrv_below_baseline(self):
        self.assertIs(self.classify(50, 55, 46, past=history(jitter=False)).tier, Tier.AMBER)

    def test_amber_band(self):
        for score in (34, 45, 66):
            self.assertIs(self.classify(score, 40, 46).tier, Tier.AMBER, score)

    def test_red_at_or_below_thirty_three(self):
        for score in (33, 20, 1):
            self.assertIs(self.classify(score, 70, 46).tier, Tier.RED, score)

    def test_boundaries_are_exact(self):
        self.assertIs(self.classify(66, 40, 46).tier, Tier.AMBER)
        self.assertIs(self.classify(34, 40, 46).tier, Tier.AMBER)


class DowngradeTests(unittest.TestCase):
    """Both conditions, never either. That is the whole rule."""

    def setUp(self):
        self.past = history(hrv=60.0, rhr=46.0)

    def decide(self, hrv_recent, rhr):
        records = list(self.past)
        for offset in (1, 2):
            records = [r for r in records if r.date != TODAY - dt.timedelta(days=offset)]
            records.append(RecoveryRecord(TODAY - dt.timedelta(days=offset), 70, hrv_recent, rhr))
        records.append(RecoveryRecord(TODAY, 80, hrv_recent, rhr))
        return classify(TODAY, records)

    def test_both_conditions_downgrade(self):
        decision = self.decide(hrv_recent=40.0, rhr=55.0)
        self.assertTrue(decision.downgrade_applied)
        self.assertIs(decision.base_tier, Tier.GREEN)
        self.assertIs(decision.tier, Tier.AMBER)

    def test_low_hrv_alone_does_not_downgrade(self):
        decision = self.decide(hrv_recent=40.0, rhr=46.0)
        self.assertFalse(decision.downgrade_applied)
        self.assertIs(decision.tier, Tier.GREEN)

    def test_high_rhr_alone_does_not_downgrade(self):
        decision = self.decide(hrv_recent=60.0, rhr=55.0)
        self.assertFalse(decision.downgrade_applied)
        self.assertIs(decision.tier, Tier.GREEN)

    def test_red_cannot_be_downgraded_further(self):
        records = history(hrv=60.0, rhr=46.0)
        for offset in (1, 2):
            records = [r for r in records if r.date != TODAY - dt.timedelta(days=offset)]
            records.append(RecoveryRecord(TODAY - dt.timedelta(days=offset), 70, 40.0, 55.0))
        records.append(RecoveryRecord(TODAY, 20, 40.0, 55.0))
        self.assertIs(classify(TODAY, records).tier, Tier.RED)

    def test_there_are_no_upgrades(self):
        """Nothing in the module can move a tier towards green."""
        for score in (10, 40, 90):
            decision = self.decide(hrv_recent=40.0, rhr=55.0)
            self.assertIn(decision.tier, (decision.base_tier, decision.base_tier.downgraded()))


class BaselineTests(unittest.TestCase):
    def test_baseline_excludes_the_last_twenty_four_hours(self):
        records = history(hrv=60.0, jitter=False) + [RecoveryRecord(TODAY, 50, 1000.0, 46.0)]
        baseline = build_baseline(records, TODAY, days=14)
        self.assertAlmostEqual(baseline.hrv_mean, 60.0)
        self.assertEqual(baseline.days, 14)

    def test_baseline_window_is_fourteen_days(self):
        baseline = build_baseline(history(days=30, jitter=False), TODAY, days=14)
        self.assertEqual(baseline.days, 14)

    def test_thin_history_gives_no_baseline(self):
        baseline = build_baseline(history(days=1), TODAY)
        self.assertFalse(baseline.available)


class DataHygieneTests(unittest.TestCase):
    def test_no_recovery_today_defaults_green_and_logs_the_gap(self):
        decision = classify(TODAY, history())
        self.assertIs(decision.tier, Tier.GREEN)
        self.assertFalse(decision.data_available)
        self.assertTrue(decision.warnings)

    def test_no_data_at_all_defaults_green(self):
        decision = classify(TODAY, [])
        self.assertIs(decision.tier, Tier.GREEN)
        self.assertFalse(decision.data_available)

    def test_decision_log_carries_every_input(self):
        records = history() + [RecoveryRecord(TODAY, 44, 52.0, 48.0)]
        payload = classify(TODAY, records).as_log()
        for key in ("recovery_score", "hrv_rmssd_milli", "resting_heart_rate",
                    "baseline_hrv_mean", "baseline_hrv_sd", "tier", "reason"):
            self.assertIn(key, payload)
        self.assertEqual(payload["recovery_score"], 44)

    def test_calibrating_user_is_flagged(self):
        records = history() + [RecoveryRecord(TODAY, 70, 60.0, 46.0, user_calibrating=True)]
        self.assertTrue(classify(TODAY, records).warnings)


if __name__ == "__main__":
    unittest.main()
