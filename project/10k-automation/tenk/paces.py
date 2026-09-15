"""Pace arithmetic.

Every pace in the plan is a band of seconds per kilometre. Goal pace is the
anchor; derived paces are expressed as an offset from it, so recalibrating
after the week 4 time trial is a one-line edit to plan.yaml.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Mapping, Optional


def parse_pace(text: str) -> int:
    """'3:45' -> 225 seconds per km."""
    parts = str(text).strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"pace must look like m:ss, got {text!r}")
    minutes, seconds = parts
    try:
        total = int(minutes) * 60 + int(seconds)
    except ValueError as exc:
        raise ValueError(f"pace must look like m:ss, got {text!r}") from exc
    if not 0 < total < 3600:
        raise ValueError(f"implausible pace {text!r}")
    return total


def format_pace(seconds: float) -> str:
    """225 -> '3:45'. Rounds to the nearest second."""
    total = int(round(seconds))
    return f"{total // 60}:{total % 60:02d}"


@dataclass(frozen=True)
class PaceBand:
    """A closed pace band. `fast` is the quicker (smaller) number of seconds."""

    name: str
    fast: int
    slow: int

    def __post_init__(self) -> None:
        if self.fast > self.slow:
            raise ValueError(f"{self.name}: fast end {self.fast} is slower than {self.slow}")

    @property
    def mid(self) -> float:
        return (self.fast + self.slow) / 2

    def shifted(
        self,
        name: str,
        offset_fast: float,
        offset_slow: Optional[float] = None,
        width: Optional[float] = None,
    ) -> "PaceBand":
        """Derive a band from this one.

        `width` pins the derived band's own width, which matters because the
        anchor band's width changes when goal pace is recalibrated. Strides are
        a single pace, not a band, so they are derived with width 0 and stay a
        single pace whatever the time trial says.
        """
        fast = self.fast + offset_fast
        if width is not None:
            slow = fast + width
        else:
            slow = self.slow + (offset_fast if offset_slow is None else offset_slow)
        if slow < fast:
            raise ValueError(
                f"pace {name!r} derives an inverted band ({format_pace(fast)} to "
                f"{format_pace(slow)}). Give it a 'width' instead of an 'offset_slow', "
                f"or widen the offsets."
            )
        return PaceBand(name, int(round(fast)), int(round(slow)))

    def seconds_for_km(self, km: float) -> float:
        """Duration of a distance at the middle of the band."""
        return self.mid * km

    def km_for_seconds(self, seconds: float) -> float:
        return seconds / self.mid

    def human(self) -> str:
        """'3:40-3:45' — how it reads on a calendar."""
        if self.fast == self.slow:
            return format_pace(self.fast)
        return f"{format_pace(self.fast)}-{format_pace(self.slow)}"

    def icu(self) -> str:
        """intervals.icu workout-builder pace target, e.g. '3:40/km-3:45/km Pace'."""
        if self.fast == self.slow:
            return f"{format_pace(self.fast)}/km Pace"
        return f"{format_pace(self.fast)}/km-{format_pace(self.slow)}/km Pace"


class PaceTable:
    """The plan's pace section, resolved.

    Entries either carry an absolute ``range`` or derive from another entry via
    ``from`` plus ``offset_fast`` / ``offset_slow`` in seconds per km.
    """

    ANCHOR = "goal_pace"

    def __init__(self, bands: Mapping[str, PaceBand]):
        self._bands: Dict[str, PaceBand] = dict(bands)

    @classmethod
    def from_config(cls, spec: Mapping[str, Mapping]) -> "PaceTable":
        bands: Dict[str, PaceBand] = {}
        pending = dict(spec)

        # Resolve absolutes first, then derived entries until nothing moves.
        for name, entry in list(pending.items()):
            if "range" in entry:
                fast_text, _, slow_text = str(entry["range"]).partition("-")
                fast = parse_pace(fast_text)
                slow = parse_pace(slow_text) if slow_text else fast
                bands[name] = PaceBand(name, fast, slow)
                pending.pop(name)

        while pending:
            progressed = False
            for name, entry in list(pending.items()):
                parent = entry.get("from")
                if parent is None:
                    raise ValueError(f"pace {name!r} has neither 'range' nor 'from'")
                if parent not in bands:
                    continue
                width = entry.get("width")
                bands[name] = bands[parent].shifted(
                    name,
                    float(entry.get("offset_fast", 0)),
                    None if "offset_slow" not in entry else float(entry["offset_slow"]),
                    None if width is None else float(width),
                )
                pending.pop(name)
                progressed = True
            if not progressed:
                raise ValueError(
                    "unresolvable pace references (cycle or unknown parent): "
                    + ", ".join(sorted(pending))
                )

        if cls.ANCHOR not in bands:
            raise ValueError("plan paces must define goal_pace")
        return cls(bands)

    def __contains__(self, name: str) -> bool:
        return name in self._bands

    def __getitem__(self, name: str) -> PaceBand:
        try:
            return self._bands[name]
        except KeyError as exc:
            raise KeyError(f"unknown pace {name!r}; known: {', '.join(sorted(self._bands))}") from exc

    @property
    def goal_pace(self) -> PaceBand:
        return self._bands[self.ANCHOR]

    def names(self):
        return sorted(self._bands)
