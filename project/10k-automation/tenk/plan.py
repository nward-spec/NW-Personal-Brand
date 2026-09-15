"""The plan: YAML in, prescribed days out.

Nothing here knows about Whoop, intervals.icu or the calendar. It answers one
question: what is written for this date, before any recovery adjustment?
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence

import yaml

from .paces import PaceBand, PaceTable
from .workout import Repeat, Step, Workout, summarise_steps

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
WEEKDAY_LABEL = {
    "mon": "Mon", "tue": "Tue", "wed": "Wed", "thu": "Thu",
    "fri": "Fri", "sat": "Sat", "sun": "Sun",
}


def weekday_key(day: dt.date) -> str:
    return WEEKDAYS[day.weekday()]


@dataclass
class Run:
    """One run on a day. `slot` is am or pm."""

    slot: str
    workout: Workout
    km: float

    @property
    def kind(self) -> str:
        return self.workout.kind


@dataclass
class DayPlan:
    """Everything prescribed for one calendar day, before adjustment."""

    date: dt.date
    weekday: str
    week_number: int
    runs: List[Run] = field(default_factory=list)
    gym: Optional[Workout] = None
    rest: bool = False
    race_day: bool = False
    race_week: bool = False
    keystone: bool = False
    notes: List[str] = field(default_factory=list)

    @property
    def total_km(self) -> float:
        return round(sum(r.km for r in self.runs), 2)

    @property
    def is_run_day(self) -> bool:
        return bool(self.runs)

    @property
    def has_double(self) -> bool:
        return len(self.runs) > 1

    def run(self, slot: str) -> Optional[Run]:
        for r in self.runs:
            if r.slot == slot:
                return r
        return None

    def add_note(self, note: str) -> None:
        if note and note not in self.notes:
            self.notes.append(note)

    def label(self) -> str:
        return WEEKDAY_LABEL[self.weekday]


@dataclass
class Week:
    number: int
    start: dt.date
    volume_km: float
    quality: Mapping
    long_run: Mapping
    days: Mapping = field(default_factory=dict)
    race_week: bool = False
    keystone: bool = False
    note: str = ""

    @property
    def end(self) -> dt.date:
        return self.start + dt.timedelta(days=6)

    def date_for(self, weekday: str) -> dt.date:
        return self.start + dt.timedelta(days=WEEKDAYS.index(weekday))

    def contains(self, day: dt.date) -> bool:
        return self.start <= day <= self.end

    @property
    def key(self) -> str:
        return f"w{self.number:02d}"


@dataclass
class WeekAllocation:
    """Kilometres per weekday for a week, plus why."""

    day_km: Dict[str, float]
    planned_total: float
    target: float
    notes: List[str] = field(default_factory=list)


class Plan:
    def __init__(self, raw: Mapping):
        self.raw = raw
        self.meta = raw["meta"]
        self.zones = raw.get("zones", {})
        self.paces = PaceTable.from_config(raw["paces"])
        self.rules = raw.get("rules", {})
        self.defaults = raw.get("defaults", {})
        self.week_template = raw.get("week_template", {})
        self.weeks = [
            Week(
                number=int(w["number"]),
                start=_as_date(w["start"]),
                volume_km=float(w["volume_km"]),
                quality=w.get("quality", {}),
                long_run=w.get("long_run", {}),
                days=w.get("days", {}) or {},
                race_week=bool(w.get("race_week", False)),
                keystone=bool(w.get("keystone", False)),
                note=w.get("note", "") or "",
            )
            for w in raw["weeks"]
        ]
        self.weeks.sort(key=lambda w: w.start)

    # ---------------------------------------------------------------- loading

    @classmethod
    def load(cls, path) -> "Plan":
        with open(path, "r", encoding="utf-8") as fh:
            return cls(yaml.safe_load(fh))

    # ------------------------------------------------------------- properties

    @property
    def timezone(self) -> str:
        return self.meta.get("timezone", "Australia/Melbourne")

    @property
    def race_date(self) -> dt.date:
        return _as_date(self.meta["race"]["date"])

    @property
    def goal_pace(self) -> PaceBand:
        return self.paces.goal_pace

    def rule(self, name: str, default=None):
        return self.rules.get(name, default)

    def week_for(self, day: dt.date) -> Optional[Week]:
        for week in self.weeks:
            if week.contains(day):
                return week
        return None

    # ------------------------------------------------------------- allocation

    def allocate(self, week: Week, actuals: Optional[Mapping[str, float]] = None) -> WeekAllocation:
        """Distribute the week's volume across its run days.

        Days in `actuals` are pinned to what was actually run; everything else
        is allocated. Saturday quality and the Sunday long run are structural
        and never flex to chase volume - the easy days absorb the difference,
        Thursday first. That is the Wednesday reconciliation in one function.
        """
        actuals = dict(actuals or {})
        notes: List[str] = []
        run_days = [d for d in self.rule("run_days", ["tue", "wed", "thu", "sat", "sun"])]

        if week.race_week and week.days:
            day_km = {}
            for weekday in run_days:
                spec = week.days.get(weekday, {})
                km = spec.get("km")
                if km is None and spec.get("kind") == "run_club":
                    km = spec.get("estimate_km", self._run_club_defaults().get("estimate_km", 10.0))
                if km is None and spec.get("kind") == "shakeout":
                    km = self._shakeout_km(spec)
                if km is None and spec.get("kind") == "race":
                    km = float(self.meta["race"]["distance_km"]) + float(spec.get("warmup_km", 0))
                if km is not None:
                    day_km[weekday] = float(km)
            day_km.update({d: v for d, v in actuals.items() if d in day_km})
            total = round(sum(day_km.values()), 2)
            notes.append("Race week is prescribed day by day; the allocator does not run.")
            if abs(total - week.volume_km) >= 2.0:
                notes.append(
                    f"Race-week days add to {total:.1f} km against a stated target of "
                    f"{week.volume_km:.0f} km. The prescribed days win; edit plan.yaml "
                    f"if the target is the number you meant."
                )
            return WeekAllocation(day_km, total, week.volume_km, notes)

        fixed: Dict[str, float] = {}
        fixed["sat"] = self.quality_workout(week).est_km()
        fixed["sun"] = self.long_run_km(week)
        fixed["wed"] = float(actuals.get("wed", self._run_club_defaults().get("estimate_km", 10.0)))

        flexible = [d for d in ("tue", "thu") if d in run_days]
        pinned_flex = {d: float(actuals[d]) for d in flexible if d in actuals}
        for day, km in actuals.items():
            if day in fixed:
                fixed[day] = float(km)

        remaining_days = [d for d in flexible if d not in pinned_flex]
        committed = sum(fixed.values()) + sum(pinned_flex.values())
        remainder = week.volume_km - committed

        day_km: Dict[str, float] = dict(fixed)
        day_km.update(pinned_flex)

        min_km = float(self.rule("double_min_km", 5.0))
        if remaining_days:
            per_day = remainder / len(remaining_days)
            if per_day < min_km:
                notes.append(
                    f"Weekly target leaves only {per_day:.1f} km for each remaining easy day; "
                    f"held at the {min_km:.0f} km floor, so the week will land over target."
                )
                per_day = min_km
            ceiling = float(self.rule("max_easy_day_km", 24.0))
            if per_day > ceiling:
                notes.append(
                    f"Each remaining easy day would need {per_day:.1f} km; capped at "
                    f"{ceiling:.0f} km, so the week will land under target. Drop nothing else."
                )
                per_day = ceiling
            for day in remaining_days:
                day_km[day] = _round_to(per_day, float(self.rule("round_to_km", 0.5)))
        elif abs(remainder) >= 1.0:
            # Nothing flexible left. Absorb into the long run, bounded, then say so.
            cap = float(self.rule("long_run_cap_km", 20.0))
            before = day_km["sun"]
            adjusted = max(before - 2.0, min(before + 2.0, before + remainder))
            day_km["sun"] = round(min(cap, max(min_km, adjusted)), 1)
            if abs(day_km["sun"] - before) >= 0.1:
                notes.append(
                    f"No easy day left to absorb {remainder:+.1f} km; long run moved "
                    f"{before:.1f} -> {day_km['sun']:.1f} km (bounded at 2 km)."
                )
            residual = week.volume_km - (sum(day_km.values()))
            if abs(residual) >= 1.0:
                notes.append(f"Week will land {residual:+.1f} km against the {week.volume_km:.0f} km target.")

        total = round(sum(day_km.values()), 2)
        return WeekAllocation(day_km, total, week.volume_km, notes)

    # ------------------------------------------------------------- day making

    def day_plan(self, day: dt.date, actuals: Optional[Mapping[str, float]] = None) -> DayPlan:
        """The prescribed day, before any recovery adjustment."""
        week = self.week_for(day)
        weekday = weekday_key(day)
        if week is None:
            return DayPlan(date=day, weekday=weekday, week_number=0, rest=True,
                           notes=["Outside the plan block."])

        spec = dict(self.week_template.get(weekday, {}))
        spec.update(week.days.get(weekday, {}) or {})
        kind = spec.get("kind", "rest")

        plan_day = DayPlan(
            date=day,
            weekday=weekday,
            week_number=week.number,
            race_week=week.race_week,
            race_day=(kind == "race"),
        )
        if week.note and weekday == "mon":
            plan_day.add_note(week.note)
        if spec.get("note"):
            plan_day.add_note(str(spec["note"]))

        if kind == "gym":
            focus = spec.get("focus") or self.defaults.get("gym", {}).get(weekday, "Strength")
            plan_day.gym = Workout(kind="gym", name=f"Gym — {focus.lower()}", sport="gym",
                                   elements=[], notes=["No running."])
            return plan_day
        if kind == "rest":
            plan_day.rest = True
            return plan_day

        allocation = self.allocate(week, actuals)
        km = allocation.day_km.get(weekday, 0.0)

        if kind == "quality":
            workout = self.quality_workout(week)
            plan_day.keystone = bool(week.quality.get("keystone") or week.keystone)
            plan_day.runs.append(Run("am", workout, workout.est_km()))
            extra = round(km - workout.est_km(), 1)
            if extra >= float(self.rule("double_min_km", 5.0)) and "sat" in self.rule("double_days", []):
                plan_day.runs.append(self._easy_run("pm", extra, zone="Z1"))
        elif kind == "long_run":
            workout = self.long_run_workout(week)
            plan_day.runs.append(Run("am", workout, workout.est_km()))
        elif kind == "run_club":
            workout = self.run_club_workout(week, km)
            plan_day.runs.append(Run("am", workout, km))
        elif kind == "easy":
            for run in self._split_day(km, weekday, strides=bool(spec.get("strides"))):
                plan_day.runs.append(run)
        elif kind == "shakeout":
            plan_day.runs.append(self._shakeout_run(spec))
        elif kind == "race":
            plan_day.runs.append(self._race_run(spec))
        else:
            raise ValueError(f"unknown session kind {kind!r} on {day}")

        for note in allocation.notes:
            plan_day.add_note(note)
        return plan_day

    # ------------------------------------------------------------- components

    def quality_workout(self, week: Week) -> Workout:
        spec = week.quality or {}
        kind = spec.get("kind", "intervals")
        warmup = float(self.defaults.get("quality_warmup_km", 3.0))
        cooldown = float(self.defaults.get("quality_cooldown_km", 2.0))

        if kind == "time_trial":
            distance = float(spec.get("distance_km", 5.0))
            pace = self.paces[spec.get("pace", "five_k")]
            workout = Workout(
                kind="quality",
                name=spec.get("name", f"{distance:g}km time trial"),
                elements=[
                    Step("Warmup", km=warmup, zone="Z2"),
                    Step("Strides", seconds=4 * 20, pace=self.paces["strides"]),
                    Step("Time trial", km=distance, pace=pace),
                    Step("Cooldown", km=cooldown, zone="Z1"),
                ],
            )
            workout.add_note("Race it. This result recalibrates goal pace for weeks 5-10.")
            return workout

        if kind == "shakeout":
            return self._shakeout_workout(spec)

        reps = int(spec["reps"])
        rep = spec.get("rep", {})
        recovery = spec.get("recovery", {})
        pace = self.paces[spec.get("pace", "threshold")]
        recovery_pace = self.paces[self.defaults.get("recovery_jog_pace", "recovery")]

        work_step = Step(
            "",
            km=float(rep["km"]) if "km" in rep else None,
            seconds=float(rep["minutes"]) * 60 if "minutes" in rep else None,
            pace=pace,
        )
        block = [work_step]
        if recovery:
            # Recovery jogs are governed by heart rate, like every other easy
            # kilometre. The recovery pace band is only used to estimate how
            # far the jog goes, which the volume allocator needs.
            block.append(Step(
                "Recovery",
                seconds=float(recovery.get("seconds", 120)),
                zone="Z1",
                note=f"jog, approx {recovery_pace.human()}/km",
            ))

        name = spec.get("name", f"{reps} x {work_step.duration_text()} @ {pace.human()}")
        # "2 x 4km @ GP" reads as goal pace everywhere it is shown, so the
        # calendar and Garmin both carry the actual numbers.
        name = name.replace("@ GP", f"@ {pace.human()}").replace("GP", pace.human())
        workout = Workout(
            kind="quality",
            name=name,
            elements=[
                Step("Warmup", km=warmup, zone="Z2"),
                Repeat(reps, block),
                Step("Cooldown", km=cooldown, zone="Z1"),
            ],
        )
        if spec.get("keystone"):
            workout.add_note(
                "KEYSTONE. 8km at goal pace with one break. Execute it and the race is there."
            )
        workout.add_note("Pace is the target. Heart rate is a readout only.")
        return workout

    def long_run_km(self, week: Week) -> float:
        km = float((week.long_run or {}).get("km", 0.0))
        return min(km, float(self.rule("long_run_cap_km", 20.0)))

    def long_run_workout(self, week: Week) -> Workout:
        spec = week.long_run or {}
        total = self.long_run_km(week)
        progression = float(spec.get("progression_km", 0) or 0)
        steps: List[Step] = []
        if progression > 0:
            steps.append(Step("Easy", km=round(total - progression, 2), zone="Z2"))
            steps.append(Step("Progression", km=progression, pace=self.paces["progression"]))
            name = f"{total:g}km long run, last {progression:g} progression"
        else:
            steps.append(Step("Easy", km=total, zone="Z2"))
            name = f"{total:g}km easy long run"
        workout = Workout(kind="long_run", name=name, elements=steps)
        if progression > 0:
            workout.add_note(
                "Progression finish: goal-pace-adjacent work under accumulated fatigue. "
                "Drift down through the band, do not start at the fast end."
            )
        else:
            workout.add_note("Governed by heart rate. Cap Z2 and let pace land where it lands.")
        return workout

    def run_club_workout(self, week: Week, km: float) -> Workout:
        defaults = self._run_club_defaults()
        spec = (week.days.get("wed") or {})
        minutes = max(20, int(round(km * 315 / 60)))
        workout = Workout(
            kind="run_club",
            name=f"Run club ({km:g}km est.)",
            elements=[Step("Run club", seconds=minutes * 60, zone="Z2")],
            placeholder=True,
        )
        workout.add_note(str(spec.get("note") or defaults.get("note", "Run club — placeholder only.")))
        workout.add_note("Duration estimate only. No structure, no pace targets. Reconciled Thursday.")
        return workout

    def _easy_run(self, slot: str, km: float, *, strides: bool = False, zone: str = "Z2") -> Run:
        steps = [Step("Easy" if zone == "Z2" else "Recovery", km=km, zone=zone)]
        name = f"{km:g}km {'easy' if zone == 'Z2' else 'recovery'}"
        if strides:
            count = int(self.defaults.get("strides", {}).get("count", 4))
            seconds = int(self.defaults.get("strides", {}).get("seconds", 20))
            steps.append(Step("Strides", seconds=count * seconds, pace=self.paces["strides"]))
            name += f" + {count} x {seconds}s strides"
        workout = Workout(kind="easy", name=name, elements=steps)
        workout.add_note("Heart rate governs this run. No pace target.")
        if slot == "pm":
            workout.add_note("Second run of the day: Z1 throughout.")
        return Run(slot, workout, round(sum(s.est_km() for s in steps), 2))

    def _split_day(self, km: float, weekday: str, *, strides: bool = False) -> List[Run]:
        """A single run until the day needs more than the threshold, then a double."""
        threshold = float(self.rule("double_threshold_km", 12.0))
        minimum = float(self.rule("double_min_km", 5.0))
        doubles_allowed = weekday in self.rule("double_days", [])
        if km <= threshold or not doubles_allowed or km - threshold < minimum:
            if km <= 0:
                return []
            return [self._easy_run("am", km, strides=strides)]
        pm = max(minimum, round(km - threshold, 1))
        am = round(km - pm, 1)
        return [
            self._easy_run("am", am, strides=strides),
            self._easy_run("pm", pm, zone="Z1"),
        ]

    def _shakeout_km(self, spec: Mapping) -> float:
        minutes = float(spec.get("minutes", 15))
        return round(minutes * 60 / 315, 1)

    def _shakeout_workout(self, spec: Mapping) -> Workout:
        minutes = float(spec.get("minutes", 15))
        count = int(self.defaults.get("strides", {}).get("count", 4))
        seconds = int(self.defaults.get("strides", {}).get("seconds", 20))
        steps = [Step("Easy", seconds=minutes * 60, zone="Z2")]
        if spec.get("strides", True):
            steps.append(Step("Strides", seconds=count * seconds, pace=self.paces["strides"]))
        workout = Workout(
            kind="shakeout",
            name=spec.get("name", f"{minutes:g}min easy + {count} x {seconds}s strides"),
            elements=steps,
        )
        workout.add_note("Legs open, nothing more. Tomorrow is the race.")
        return workout

    def _shakeout_run(self, spec: Mapping) -> Run:
        workout = self._shakeout_workout(spec)
        return Run("am", workout, workout.est_km())

    def _race_run(self, spec: Mapping) -> Run:
        distance = float(self.meta["race"]["distance_km"])
        warmup = float(spec.get("warmup_km", 3.0))
        count = int(self.defaults.get("strides", {}).get("count", 4))
        seconds = int(self.defaults.get("strides", {}).get("seconds", 20))
        steps = [
            Step("Warmup", km=warmup, zone="Z2"),
            Step("Strides", seconds=count * seconds, pace=self.paces["strides"]),
            Step("RACE", km=distance, pace=self.goal_pace),
        ]
        workout = Workout(kind="race", name=spec.get("name", self.meta["race"]["name"]), elements=steps)
        if spec.get("note"):
            workout.add_note(str(spec["note"]))
        workout.add_note(f"Goal pace {self.goal_pace.human()}/km. Drills and {count} strides before the gun.")
        return Run("am", workout, round(warmup + distance, 2))

    def _run_club_defaults(self) -> Mapping:
        return self.defaults.get("run_club", {}) or {}


def _as_date(value) -> dt.date:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    return dt.date.fromisoformat(str(value))


def _round_to(value: float, step: float) -> float:
    if step <= 0:
        return round(value, 2)
    return round(round(value / step) * step, 2)
