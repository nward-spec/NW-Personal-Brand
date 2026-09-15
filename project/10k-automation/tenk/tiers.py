"""Recovery tier classification.

Green means run what is written. There are no upgrades, ever - the only thing
this module can do is leave the plan alone or take something away from it.
"""

from __future__ import annotations

import datetime as dt
import statistics
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence


class Tier(str, Enum):
    GREEN = "GREEN"
    AMBER = "AMBER"
    RED = "RED"

    def downgraded(self) -> "Tier":
        if self is Tier.GREEN:
            return Tier.AMBER
        if self is Tier.AMBER:
            return Tier.RED
        return Tier.RED


@dataclass(frozen=True)
class RecoveryRecord:
    """One SCORED Whoop recovery, attributed to a local date."""

    date: dt.date
    recovery_score: float
    hrv_rmssd_milli: float
    resting_heart_rate: float
    user_calibrating: bool = False


@dataclass
class Baseline:
    """Rolling HRV and RHR baseline, excluding the last 24 hours."""

    hrv_mean: Optional[float] = None
    hrv_sd: Optional[float] = None
    rhr_mean: Optional[float] = None
    days: int = 0

    @property
    def available(self) -> bool:
        return self.hrv_mean is not None and self.rhr_mean is not None


@dataclass
class TierDecision:
    """The morning's call, with every input that produced it."""

    date: dt.date
    tier: Tier
    base_tier: Tier
    reason: str
    downgrade_applied: bool = False
    data_available: bool = True
    recovery_score: Optional[float] = None
    hrv: Optional[float] = None
    rhr: Optional[float] = None
    hrv_3day: Optional[float] = None
    baseline: Baseline = field(default_factory=Baseline)
    warnings: List[str] = field(default_factory=list)

    def as_log(self) -> Dict:
        return {
            "date": self.date.isoformat(),
            "tier": self.tier.value,
            "base_tier": self.base_tier.value,
            "downgrade_applied": self.downgrade_applied,
            "reason": self.reason,
            "data_available": self.data_available,
            "recovery_score": self.recovery_score,
            "hrv_rmssd_milli": self.hrv,
            "resting_heart_rate": self.rhr,
            "hrv_3day_mean": self.hrv_3day,
            "baseline_hrv_mean": self.baseline.hrv_mean,
            "baseline_hrv_sd": self.baseline.hrv_sd,
            "baseline_rhr_mean": self.baseline.rhr_mean,
            "baseline_days": self.baseline.days,
            "warnings": list(self.warnings),
        }


def build_baseline(records: Sequence[RecoveryRecord], today: dt.date, days: int = 14) -> Baseline:
    """Rolling baseline over `days`, excluding the last 24 hours.

    Excluding today is the point: a baseline that includes this morning's
    reading cannot tell you this morning is unusual.
    """
    cutoff_newest = today - dt.timedelta(days=1)
    cutoff_oldest = cutoff_newest - dt.timedelta(days=days - 1)
    window = [r for r in records if cutoff_oldest <= r.date <= cutoff_newest]
    if len(window) < 2:
        return Baseline(days=len(window))
    hrvs = [r.hrv_rmssd_milli for r in window]
    rhrs = [r.resting_heart_rate for r in window]
    return Baseline(
        hrv_mean=statistics.fmean(hrvs),
        hrv_sd=statistics.stdev(hrvs),
        rhr_mean=statistics.fmean(rhrs),
        days=len(window),
    )


def rolling_hrv(records: Sequence[RecoveryRecord], today: dt.date, days: int = 3) -> Optional[float]:
    oldest = today - dt.timedelta(days=days - 1)
    window = [r.hrv_rmssd_milli for r in records if oldest <= r.date <= today]
    return statistics.fmean(window) if window else None


def classify(
    today: dt.date,
    records: Sequence[RecoveryRecord],
    *,
    baseline_days: int = 14,
    short_window_days: int = 3,
    hrv_sd_multiple: float = 1.0,
    rhr_over_baseline_bpm: float = 5.0,
) -> TierDecision:
    """Classify the day. No recovery data means GREEN, logged as a gap."""
    records = sorted(records, key=lambda r: r.date)
    todays = next((r for r in reversed(records) if r.date == today), None)
    baseline = build_baseline(records, today, baseline_days)

    if todays is None:
        return TierDecision(
            date=today,
            tier=Tier.GREEN,
            base_tier=Tier.GREEN,
            reason="No scored recovery for today. Defaulting to GREEN and prescribing as written.",
            data_available=False,
            baseline=baseline,
            warnings=["No Whoop recovery record for today; the gap is logged, nothing is guessed."],
        )

    score = todays.recovery_score
    hrv = todays.hrv_rmssd_milli
    rhr = todays.resting_heart_rate

    if score <= 33:
        base = Tier.RED
        reason = f"Recovery {score:.0f}% is at or under 33%."
    elif score >= 67:
        base = Tier.GREEN
        reason = f"Recovery {score:.0f}% is at or over 67%."
    elif score >= 50 and baseline.hrv_mean is not None and hrv >= baseline.hrv_mean:
        base = Tier.GREEN
        reason = (
            f"Recovery {score:.0f}% with HRV {hrv:.1f} ms at or above the "
            f"{baseline.days}-day baseline of {baseline.hrv_mean:.1f} ms."
        )
    else:
        base = Tier.AMBER
        if score >= 50 and baseline.hrv_mean is not None:
            reason = (
                f"Recovery {score:.0f}% but HRV {hrv:.1f} ms is below the "
                f"{baseline.days}-day baseline of {baseline.hrv_mean:.1f} ms."
            )
        elif score >= 50:
            reason = f"Recovery {score:.0f}% and no HRV baseline yet to lift it to green."
        else:
            reason = f"Recovery {score:.0f}% sits in the 34-66% band."

    decision = TierDecision(
        date=today,
        tier=base,
        base_tier=base,
        reason=reason,
        recovery_score=score,
        hrv=hrv,
        rhr=rhr,
        hrv_3day=rolling_hrv(records, today, short_window_days),
        baseline=baseline,
    )
    if todays.user_calibrating:
        decision.warnings.append("Whoop reports the user is still calibrating; scores are provisional.")

    # Downgrade override: both conditions, never either.
    if baseline.available and baseline.hrv_sd is not None and decision.hrv_3day is not None:
        hrv_floor = baseline.hrv_mean - hrv_sd_multiple * baseline.hrv_sd
        rhr_ceiling = baseline.rhr_mean + rhr_over_baseline_bpm
        if decision.hrv_3day < hrv_floor and rhr > rhr_ceiling:
            decision.tier = base.downgraded()
            decision.downgrade_applied = True
            decision.reason += (
                f" Downgraded one tier: {short_window_days}-day HRV {decision.hrv_3day:.1f} ms is "
                f"below baseline minus {hrv_sd_multiple:g} SD ({hrv_floor:.1f} ms) and resting HR "
                f"{rhr:.0f} bpm is over baseline plus {rhr_over_baseline_bpm:g} "
                f"({rhr_ceiling:.1f} bpm)."
            )
    elif not baseline.available:
        decision.warnings.append(
            f"Only {baseline.days} baseline day(s) available; the downgrade override was not evaluated."
        )

    return decision
