"""The adjustment engine.

Takes the prescribed day and the morning's tier, and takes things away. It can
never add: green means run what is written, and there are no upgrades.

Every rule here is a promise the athlete can check:
  - a quality session loses reps, never pace
  - Wednesday is never modified
  - race day is never modified
  - race week ignores AMBER
  - two modifications a week, then it flags rather than quietly continuing
"""

from __future__ import annotations

import copy
import datetime as dt
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

from .plan import DayPlan, Plan, Run
from .state import RunState
from .tiers import Tier, TierDecision
from .whoop import WhoopWorkout
from .workout import Repeat, Step, Workout

GYM_DAYS = ("mon", "fri")


@dataclass
class Modification:
    date: dt.date
    weekday: str
    tier: str
    kind: str            # reps_cut | quality_to_easy | long_run_cut | double_dropped | full_rest
    summary: str
    original: str
    reason: str
    flagged_for_review: bool = False

    def as_log(self) -> Dict:
        return {
            "date": self.date.isoformat(),
            "weekday": self.weekday,
            "tier": self.tier,
            "kind": self.kind,
            "summary": self.summary,
            "original": self.original,
            "reason": self.reason,
            "flagged_for_review": self.flagged_for_review,
        }


@dataclass
class AdjustedDay:
    day: DayPlan
    decision: TierDecision
    modifications: List[Modification] = field(default_factory=list)
    flags: List[str] = field(default_factory=list)
    original_summary: str = ""

    @property
    def modified(self) -> bool:
        return bool(self.modifications)

    @property
    def tier(self) -> Tier:
        return self.decision.tier

    def add_flag(self, flag: str) -> None:
        if flag and flag not in self.flags:
            self.flags.append(flag)


def summarise_day(day: DayPlan) -> str:
    if day.gym is not None:
        return day.gym.name
    if not day.runs:
        return "Rest"
    return " + ".join(f"{r.workout.name}" for r in day.runs)


def gym_strain_note(
    workouts: Sequence[WhoopWorkout],
    yesterday: dt.date,
    *,
    sport_names: Sequence[str] = (),
    baseline_sessions: int = 6,
    over_baseline_pct: float = 20.0,
) -> Optional[str]:
    """Feed-forward flag after a heavy gym day. No structural change."""
    if yesterday.strftime("%a").lower()[:3] not in GYM_DAYS:
        return None
    wanted = {name.lower() for name in sport_names}

    def is_gym(workout: WhoopWorkout) -> bool:
        if not wanted:
            return True
        name = (workout.sport_name or "").lower()
        if not name:
            # Sport name missing: fall back to "any workout on a gym day".
            return workout.date.strftime("%a").lower()[:3] in GYM_DAYS
        return any(w in name for w in wanted)

    gym_sessions = [w for w in workouts if is_gym(w) and w.strain is not None]
    todays = [w for w in gym_sessions if w.date == yesterday]
    if not todays:
        return None
    strain = max(w.strain for w in todays)

    history = [w.strain for w in gym_sessions if w.date < yesterday][-baseline_sessions:]
    if len(history) < 2:
        return None
    baseline = sum(history) / len(history)
    if baseline <= 0:
        return None
    if strain <= baseline * (1 + over_baseline_pct / 100.0):
        return None
    return (
        f"Heavy gym yesterday — hold the HR cap hard, ignore pace entirely. "
        f"(strain {strain:.1f} against a {len(history)}-session baseline of {baseline:.1f})"
    )


class AdjustmentEngine:
    def __init__(self, plan: Plan, state: RunState, *, max_modifications_per_week: int = 2):
        self.plan = plan
        self.state = state
        self.max_modifications = int(max_modifications_per_week)

    # ------------------------------------------------------------------ main

    def apply(self, day: DayPlan, decision: TierDecision, *, gym_note: Optional[str] = None) -> AdjustedDay:
        day = copy.deepcopy(day)
        result = AdjustedDay(day=day, decision=decision, original_summary=summarise_day(day))
        week = self.plan.week_for(day.date)
        week_key = week.key if week else "w00"

        if gym_note:
            self._note_all(day, gym_note)

        if decision.data_available is False:
            day.add_note("No Whoop recovery this morning. Prescribed as written; the gap is logged.")

        # Nothing to take away from a gym day or a rest day.
        if day.gym is not None or not day.runs:
            return result

        # --- absolute immunities -------------------------------------------
        if day.race_day:
            day.add_note("Race day. Never modified, whatever the numbers say.")
            if decision.tier is not Tier.GREEN:
                day.add_note(
                    f"Recovery came back {decision.tier.value} — taper scores are noise. Race it."
                )
            return result

        if day.weekday == "wed":
            if decision.tier is Tier.RED:
                note = "Run club — sit in the back group, cap Z3."
                self._note_all(day, note)
                result.add_flag(f"RED on run-club day: {note}")
            day.add_note("Run club is never modified by the engine.")
            return result

        if day.race_week and decision.tier is Tier.AMBER:
            day.add_note(
                "Race week is immune to AMBER. Taper reliably produces poor recovery scores."
            )
            return result

        if decision.tier is Tier.GREEN:
            return result

        # --- two consecutive REDs ------------------------------------------
        if decision.tier is Tier.RED and self.state.consecutive_reds(day.date) >= 2:
            self._full_rest(result, week_key)
            return result

        # --- tier actions ---------------------------------------------------
        if decision.tier is Tier.AMBER:
            self._apply_amber(result)
        else:
            self._apply_red(result)

        self._enforce_circuit_breaker(result, week_key)
        for modification in result.modifications:
            self.state.record_modification(week_key, modification.as_log())
        return result

    # --------------------------------------------------------------- actions

    def _apply_amber(self, result: AdjustedDay) -> None:
        day = result.day
        reason = result.decision.reason
        for run in list(day.runs):
            if run.kind == "quality":
                self._cut_reps(result, run, reason)
            elif run.slot == "pm":
                self._drop_double(result, run, reason, "AMBER")
        day.add_note("AMBER: reps come down, pace does not. A slowed quality session is grey-zone work.")

    def _apply_red(self, result: AdjustedDay) -> None:
        day = result.day
        reason = result.decision.reason
        for run in list(day.runs):
            if run.kind == "quality":
                self._quality_to_easy(result, run, reason)
            elif run.kind == "long_run":
                self._cut_long_run(result, run, reason)
            elif run.slot == "pm":
                self._drop_double(result, run, reason, "RED")

    def _cut_reps(self, result: AdjustedDay, run: Run, reason: str) -> None:
        workout = run.workout
        repeat = next((e for e in workout.elements if isinstance(e, Repeat)), None)
        if repeat is None or repeat.reps <= 1:
            return
        original_reps = repeat.reps
        repeat.reps = max(1, math.floor(original_reps * 0.75))
        if repeat.reps == original_reps:
            return
        original_name = workout.name
        workout.name = original_name.replace(f"{original_reps} x", f"{repeat.reps} x", 1)
        if workout.name == original_name:
            workout.name = f"{original_name} (cut to {repeat.reps} reps)"
        workout.add_note(
            f"AMBER: {original_reps} reps cut to {repeat.reps}. Pace target unchanged — "
            f"hold it or stop, do not soften it."
        )
        run.km = workout.est_km()
        result.modifications.append(Modification(
            date=result.day.date, weekday=result.day.weekday, tier="AMBER", kind="reps_cut",
            summary=f"{original_reps} reps cut to {repeat.reps}, pace unchanged",
            original=original_name, reason=reason,
        ))

    def _quality_to_easy(self, result: AdjustedDay, run: Run, reason: str) -> None:
        original = run.workout
        seconds = original.est_seconds()
        minutes = int(round(seconds / 60))
        easy = Workout(
            kind="easy",
            name=f"{minutes}min easy Z2",
            elements=[Step("Easy", seconds=seconds, zone="Z2")],
        )
        easy.add_note(f"RED: replaces {original.name}. Same duration, no intensity.")
        easy.add_note("Heart rate governs this run. No pace target.")
        run.workout = easy
        run.km = easy.est_km()
        result.modifications.append(Modification(
            date=result.day.date, weekday=result.day.weekday, tier="RED", kind="quality_to_easy",
            summary=f"Quality replaced by {minutes}min easy Z2, same duration",
            original=original.name, reason=reason,
        ))

    def _cut_long_run(self, result: AdjustedDay, run: Run, reason: str) -> None:
        original = run.workout
        original_km = original.est_km()
        target_km = round(original_km * 0.7, 1)
        cut = Workout(
            kind="long_run",
            name=f"{target_km:g}km easy long run",
            elements=[Step("Easy", km=target_km, zone="Z2")],
        )
        cut.add_note(
            f"RED: cut to 70% of the prescribed {original_km:g}km. Progression finish dropped — "
            f"goal-pace work on a red day buys fatigue, not fitness."
        )
        cut.add_note("Heart rate governs this run. No pace target.")
        run.workout = cut
        run.km = cut.est_km()
        result.modifications.append(Modification(
            date=result.day.date, weekday=result.day.weekday, tier="RED", kind="long_run_cut",
            summary=f"Long run cut {original_km:g}km to {target_km:g}km (70%)",
            original=original.name, reason=reason,
        ))

    def _drop_double(self, result: AdjustedDay, run: Run, reason: str, tier: str) -> None:
        day = result.day
        day.runs = [r for r in day.runs if r is not run]
        day.add_note(f"{tier}: PM double dropped. Volume comes off the double, never off a day.")
        result.modifications.append(Modification(
            date=day.date, weekday=day.weekday, tier=tier, kind="double_dropped",
            summary=f"PM run dropped ({run.km:g}km)",
            original=run.workout.name, reason=reason,
        ))

    def _full_rest(self, result: AdjustedDay, week_key: str) -> None:
        day = result.day
        carried = [r for r in day.runs if r.kind in ("quality", "long_run")]
        original = summarise_day(day)
        day.runs = []
        day.rest = True
        day.add_note("TWO CONSECUTIVE REDS — full rest. This is not optional.")
        flag = (
            f"LOUD FLAG: second RED in a row on {day.date:%a %d %b}. Full rest today. "
            f"The week shifts rather than skips."
        )
        result.add_flag(flag)
        if carried:
            session = carried[0]
            self.state.set_carry_forward(day.date, {
                "from_date": day.date.isoformat(),
                "kind": session.kind,
                "name": session.workout.name,
                "week": week_key,
            })
            day.add_note(
                f"{session.workout.name} is carried forward to the next run day; the easy run "
                f"it displaces is the volume that comes off."
            )
            result.add_flag(f"Carried forward: {session.workout.name}. Review the rest of the week.")
        result.modifications.append(Modification(
            date=day.date, weekday=day.weekday, tier="RED", kind="full_rest",
            summary="Full rest — two consecutive REDs",
            original=original,
            reason=result.decision.reason,
            flagged_for_review=True,
        ))
        self.state.record_modification(week_key, result.modifications[-1].as_log())

    # ------------------------------------------------------------- breakers

    def _enforce_circuit_breaker(self, result: AdjustedDay, week_key: str) -> None:
        if not result.modifications:
            return
        already = self.state.modification_count(week_key, exclude_date=result.day.date)
        if already < self.max_modifications:
            return
        for modification in result.modifications:
            modification.flagged_for_review = True
        result.add_flag(
            f"REVIEW: this is modification {already + 1} in {week_key}, past the limit of "
            f"{self.max_modifications}. It has been applied, but the block needs a human look — "
            f"repeated downgrades mean the plan is wrong, not the athlete."
        )
        result.day.add_note("Flagged for review: more automatic modifications this week than the limit allows.")

    # ---------------------------------------------------------------- helpers

    @staticmethod
    def _note_all(day: DayPlan, note: str) -> None:
        day.add_note(note)
        for run in day.runs:
            run.workout.add_note(note)


def apply_carry_forward(plan: Plan, day: DayPlan, state: RunState) -> Optional[str]:
    """Move a session missed to a double-RED onto the next available easy day."""
    if day.rest or not day.runs or day.weekday == "wed":
        return None
    if any(r.kind in ("quality", "long_run", "race") for r in day.runs):
        return None
    for stamp, payload in sorted(state.data.get("carry_forward", {}).items()):
        missed_date = dt.date.fromisoformat(stamp)
        if missed_date >= day.date:
            continue
        week = plan.week_for(missed_date)
        if week is None:
            state.set_carry_forward(missed_date, None)
            continue
        if payload.get("kind") == "quality":
            workout = plan.quality_workout(week)
        else:
            workout = plan.long_run_workout(week)
        workout.add_note(
            f"Carried forward from {missed_date:%a %d %b}, which became a full rest day after "
            f"two consecutive REDs. The easy run this displaces is the volume that comes off."
        )
        displaced = day.runs[0].workout.name
        day.runs = [Run("am", workout, workout.est_km())]
        day.add_note(f"Carried-forward {payload.get('kind', 'session')} replaces {displaced}.")
        state.set_carry_forward(missed_date, None)
        return f"Carried {payload.get('name')} from {missed_date.isoformat()} onto {day.date.isoformat()}."
    return None
