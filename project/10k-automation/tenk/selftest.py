"""End-to-end run against synthetic Whoop data. Touches no network, no calendar.

This is the thing to run before pointing the engine at the real calendar, and
after any edit to plan.yaml.
"""

from __future__ import annotations

import datetime as dt
import logging
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Sequence

from .adjust import summarise_day
from .config import Config
from .intervals_icu import Completion
from .tiers import RecoveryRecord
from .whoop import WhoopError, WhoopWorkout

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Scenario:
    name: str
    date: dt.date
    recovery: Optional[Sequence[float]]     # today first: (score, hrv, rhr)
    description: str
    whoop_down: bool = False
    prior_tiers: Mapping[str, str] = None
    gym_strain: Optional[float] = None
    wednesday_km: Optional[float] = None
    baseline_hrv: float = 62.0
    baseline_rhr: float = 46.0


SCENARIOS: List[Scenario] = [
    Scenario("green", dt.date(2026, 10, 31), (78, 64, 45),
             "Saturday keystone-style quality on a green morning: run what is written."),
    Scenario("amber-quality", dt.date(2026, 10, 31), (48, 55, 47),
             "Amber on a quality Saturday: reps come down 25%, pace untouched."),
    Scenario("red-quality", dt.date(2026, 10, 31), (28, 48, 52),
             "Red on a quality Saturday: same duration, all of it easy Z2."),
    Scenario("red-long-run", dt.date(2026, 11, 1), (25, 47, 53),
             "Red on the long run: 70% of the distance, progression dropped."),
    Scenario("amber-double", dt.date(2026, 10, 27), (45, 57, 47),
             "Amber on a double day: the PM run goes, the day stays."),
    Scenario("double-red", dt.date(2026, 10, 31), (22, 44, 54),
             "Second red in a row: full rest, session carried forward, loud flag.",
             prior_tiers={"2026-10-30": "RED"}),
    Scenario("wednesday-red", dt.date(2026, 10, 28), (20, 44, 55),
             "Red on run-club day: never modified, note only."),
    Scenario("race-week-amber", dt.date(2026, 11, 17), (40, 52, 49),
             "Amber in race week: ignored, because taper scores are noise."),
    Scenario("race-day-red", dt.date(2026, 11, 22), (18, 40, 56),
             "Red on race day: nothing changes. Race it."),
    Scenario("no-data", dt.date(2026, 10, 31), None,
             "No scored recovery: default green, prescribe as written, log the gap."),
    Scenario("whoop-down", dt.date(2026, 10, 31), None,
             "Whoop unreachable: the day is still written.", whoop_down=True),
    Scenario("heavy-gym", dt.date(2026, 10, 27), (72, 63, 45),
             "Heavy Monday gym: green, but the HR-cap note rides along.",
             gym_strain=16.5),
    Scenario("wednesday-short", dt.date(2026, 10, 29), (70, 63, 45),
             "Thursday after a short run club: the rest of the week rebalances.",
             wednesday_km=6.2),
]


class FakeWhoop:
    def __init__(self, scenario: Scenario, tz):
        self.scenario = scenario
        self.tz = tz

    def recoveries(self, today: dt.date, days: int = 21) -> List[RecoveryRecord]:
        if self.scenario.whoop_down:
            raise WhoopError("synthetic outage: connection reset by peer")
        records: List[RecoveryRecord] = []
        for offset in range(1, 15):
            day = today - dt.timedelta(days=offset)
            wobble = (offset % 5) - 2
            records.append(RecoveryRecord(
                day, 70.0, self.scenario.baseline_hrv + wobble, self.scenario.baseline_rhr + (wobble / 2)
            ))
        if self.scenario.recovery is not None:
            score, hrv, rhr = self.scenario.recovery
            records.append(RecoveryRecord(today, float(score), float(hrv), float(rhr)))
        return sorted(records, key=lambda r: r.date)

    def workouts(self, today: dt.date, days: int = 42) -> List[WhoopWorkout]:
        if self.scenario.whoop_down:
            raise WhoopError("synthetic outage")
        out: List[WhoopWorkout] = []
        cursor = today - dt.timedelta(days=28)
        while cursor < today:
            if cursor.weekday() in (0, 4):   # Mon, Fri
                out.append(WhoopWorkout(
                    date=cursor, strain=11.0, sport_name="weightlifting",
                    start=dt.datetime.combine(cursor, dt.time(6, 30)), raw={},
                ))
            cursor += dt.timedelta(days=1)
        if self.scenario.gym_strain is not None:
            yesterday = today - dt.timedelta(days=1)
            out.append(WhoopWorkout(
                date=yesterday, strain=self.scenario.gym_strain, sport_name="weightlifting",
                start=dt.datetime.combine(yesterday, dt.time(6, 30)), raw={},
            ))
        return sorted(out, key=lambda w: w.start)


class FakeIntervals:
    def __init__(self, scenario: Scenario):
        self.scenario = scenario
        self.written: List[Mapping] = []
        self.dry_run = True

    def bulk_upsert(self, events) -> Dict[str, int]:
        self.written = [e.payload for e in events]
        return {"written": 0, "dry_run": True, "would_write": len(self.written)}

    def activities(self, oldest: dt.date, newest: dt.date) -> List[Mapping]:
        if self.scenario.wednesday_km is None:
            return []
        wednesday = newest - dt.timedelta(days=(newest.weekday() - 2) % 7 or 7)
        return [{
            "start_date_local": f"{wednesday.isoformat()}T05:50:00",
            "name": "Run club",
            "type": "Run",
            "distance": self.scenario.wednesday_km * 1000,
            "moving_time": int(self.scenario.wednesday_km * 315),
            "average_heartrate": 151,
        }]


def _config(state_dir: Path) -> Config:
    return Config.from_mapping({
        "plan_file": "config/plan.yaml",
        "state_dir": str(state_dir),
        "engine": {"window_days": 4, "max_modifications_per_week": 2},
        "whoop": {"enabled": True},
        "intervals_icu": {"enabled": True, "athlete_id": "i00000", "external_id_prefix": "10k"},
        "google_calendar": {"enabled": False},
        "summary": {"enabled": False, "channel_id": "C0BG5NWRWLA"},
    }, root=ROOT)


def run_scenario(scenario: Scenario) -> Dict:
    from .engine import DailyEngine

    with tempfile.TemporaryDirectory() as tmp:
        config = _config(Path(tmp))
        engine = DailyEngine(config, dry_run=True, today=scenario.date)
        for stamp, tier in (scenario.prior_tiers or {}).items():
            engine.state.record_tier(dt.date.fromisoformat(stamp), tier)

        fake_whoop = FakeWhoop(scenario, engine.tz)
        fake_intervals = FakeIntervals(scenario)
        engine._whoop_client = lambda: fake_whoop            # type: ignore[assignment]
        engine._intervals_client = lambda: fake_intervals    # type: ignore[assignment]

        report = engine.run()
        return {
            "scenario": scenario.name,
            "date": scenario.date.isoformat(),
            "tier": report.tier,
            "originally": report.original_summary,
            "today": report.today_summary,
            "modifications": [m["summary"] for m in report.modifications],
            "flags": report.flags,
            "warnings": report.warnings,
            "events": [e["external_id"] for e in fake_intervals.written],
            "description": scenario.description,
        }


def run_selftest(scenario: str = "all", date: Optional[dt.date] = None) -> int:
    wanted = [s for s in SCENARIOS if scenario in ("all", s.name)]
    if not wanted:
        print(f"No such scenario: {scenario}. Known: {', '.join(s.name for s in SCENARIOS)}")
        return 2

    failures = 0
    for item in wanted:
        if date is not None:
            item = Scenario(**{**item.__dict__, "date": date})
        try:
            result = run_scenario(item)
        except Exception as exc:  # a scenario that raises is a real failure
            failures += 1
            print(f"\n--- {item.name}: FAILED ({exc.__class__.__name__}: {exc})")
            continue
        print(f"\n--- {result['scenario']}  [{result['tier']}]  {item.date:%a %d %b}")
        print(f"    {result['description']}")
        print(f"    written  : {result['today']}")
        if result["originally"] != result["today"]:
            print(f"    was      : {result['originally']}")
        for modification in result["modifications"]:
            print(f"    change   : {modification}")
        for flag in result["flags"]:
            print(f"    FLAG     : {flag}")
        for warning in result["warnings"]:
            print(f"    warning  : {warning}")
        print(f"    events   : {', '.join(result['events'])}")

    print(f"\n{len(wanted)} scenario(s) run, {failures} failed.")
    return 1 if failures else 0
