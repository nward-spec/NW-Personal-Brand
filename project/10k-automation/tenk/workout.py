"""Workout structure, distance/duration estimation, and rendering.

One structure serves three outputs: the intervals.icu workout-builder text, the
calendar title, and the distance estimate the volume allocator needs.

The intervals.icu plain-text grammar used here (verified against the
Workout Builder Syntax Quick Guide, forum.intervals.icu/t/123701, Sep 2026):

    - <duration|distance> <target>      steps start with a dash
    m = minutes, s = seconds, h = hours, km = kilometres, mtr = metres
    4x                                  repeat count on its own line
    3:40/km-3:45/km Pace                absolute pace range
    Z2 HR                               heart-rate zone
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Union

from .paces import PaceBand, format_pace

# Pace used to estimate the distance covered by a time-based step when the step
# is governed by heart rate rather than pace. Seconds per km.
ZONE_ESTIMATE_PACE = {"Z1": 350, "Z2": 315, "Z3": 270, "Z4": 245, "Z5": 218}


@dataclass
class Step:
    """One leg of a workout. Exactly one of `seconds` or `km` is set."""

    label: str
    seconds: Optional[float] = None
    km: Optional[float] = None
    pace: Optional[PaceBand] = None
    zone: Optional[str] = None
    note: Optional[str] = None

    def __post_init__(self) -> None:
        if (self.seconds is None) == (self.km is None):
            raise ValueError(f"step {self.label!r} needs exactly one of seconds or km")

    @property
    def _pace_seconds_per_km(self) -> float:
        if self.pace is not None:
            return self.pace.mid
        if self.zone is not None:
            return ZONE_ESTIMATE_PACE[self.zone]
        return ZONE_ESTIMATE_PACE["Z2"]

    def est_km(self) -> float:
        if self.km is not None:
            return self.km
        return self.seconds / self._pace_seconds_per_km

    def est_seconds(self) -> float:
        if self.seconds is not None:
            return self.seconds
        return self.km * self._pace_seconds_per_km

    def target(self) -> str:
        if self.pace is not None:
            return self.pace.icu()
        if self.zone is not None:
            return f"{self.zone} HR"
        return "Z2 HR"

    def duration_text(self) -> str:
        if self.km is not None:
            if abs(self.km * 1000 - round(self.km * 1000)) < 1e-6 and self.km < 1:
                return f"{int(round(self.km * 1000))}mtr"
            return f"{self.km:g}km"
        total = int(round(self.seconds))
        if total % 60 == 0:
            return f"{total // 60}m"
        if total < 60:
            return f"{total}s"
        return f"{total // 60}m{total % 60}s"

    def icu_line(self) -> str:
        return f"- {self.label} {self.duration_text()} {self.target()}".replace("  ", " ")


@dataclass
class Repeat:
    """A repeated block of steps."""

    reps: int
    steps: List[Step] = field(default_factory=list)

    def est_km(self) -> float:
        return self.reps * sum(s.est_km() for s in self.steps)

    def est_seconds(self) -> float:
        return self.reps * sum(s.est_seconds() for s in self.steps)


Element = Union[Step, Repeat]


@dataclass
class Workout:
    """A single run (or gym slot), start to finish."""

    kind: str                     # easy | quality | long_run | run_club | race | ...
    name: str                     # calendar-facing summary
    elements: List[Element] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    placeholder: bool = False     # true for run club: duration only, no structure
    sport: str = "run"            # run | gym

    def est_km(self) -> float:
        return round(sum(e.est_km() for e in self.elements), 2)

    def est_seconds(self) -> int:
        return int(round(sum(e.est_seconds() for e in self.elements)))

    def add_note(self, note: str) -> None:
        if note and note not in self.notes:
            self.notes.append(note)

    def icu_text(self) -> str:
        """The description body intervals.icu parses into a structured workout."""
        lines: List[str] = []
        for element in self.elements:
            if isinstance(element, Step):
                lines.append(element.icu_line())
            else:
                if lines and lines[-1] != "":
                    lines.append("")
                lines.append(f"{element.reps}x")
                lines.extend(step.icu_line() for step in element.steps)
                lines.append("")
        text = "\n".join(lines).strip("\n")
        if self.notes:
            text = text + "\n\n" + "\n".join(f"# {n}" for n in self.notes)
        return text

    def human(self) -> str:
        """One line for a calendar title."""
        return self.name


def pace_per_km_text(seconds_per_km: float) -> str:
    return f"{format_pace(seconds_per_km)}/km"


def summarise_steps(elements: Sequence[Element]) -> str:
    """Compact human description, e.g. '3km w/u, 2 x 4km @ 3:40-3:45, 2km c/d'."""
    parts: List[str] = []
    for element in elements:
        if isinstance(element, Step):
            parts.append(f"{element.label or 'run'} {element.duration_text()}".strip())
        else:
            work = element.steps[0]
            target = work.pace.human() if work.pace else (work.zone or "Z2")
            parts.append(f"{element.reps} x {work.duration_text()} @ {target}")
    return ", ".join(parts)
