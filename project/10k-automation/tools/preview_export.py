"""Export the whole block, and what each recovery tier would do to it, as JSON.

This is what feeds the preview page. It runs the real engine - the plan model,
the workout renderer and the adjustment engine - so what the page shows is what
the job would write, not a mock-up.

Each day is evaluated against each tier in isolation, with fresh state, so the
amber column shows amber's effect on that day alone rather than the effect of
whatever happened earlier in the week.

    python3 tools/preview_export.py > preview.json
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tenk.adjust import AdjustmentEngine, summarise_day          # noqa: E402
from tenk.gcal import build_description, build_title, completion_title  # noqa: E402
from tenk.intervals_icu import build_events                      # noqa: E402
from tenk.plan import Plan                                       # noqa: E402
from tenk.state import RunState                                  # noqa: E402
from tenk.tiers import Baseline, Tier, TierDecision              # noqa: E402

PLAN_FILE = Path(__file__).resolve().parent.parent / "config" / "plan.yaml"

# Representative readings for each tier, so the page can show the inputs that
# produced the decision rather than just the label.
READINGS = {
    Tier.GREEN: {"recovery_score": 78.0, "hrv": 64.0, "rhr": 45.0,
                 "reason": "Recovery 78% is at or over 67%."},
    Tier.AMBER: {"recovery_score": 48.0, "hrv": 55.0, "rhr": 48.0,
                 "reason": "Recovery 48% sits in the 34-66% band."},
    Tier.RED: {"recovery_score": 28.0, "hrv": 48.0, "rhr": 52.0,
               "reason": "Recovery 28% is at or under 33%."},
}
BASELINE = Baseline(hrv_mean=60.0, hrv_sd=4.0, rhr_mean=46.0, days=14)


def decision_for(day: dt.date, tier: Tier) -> TierDecision:
    reading = READINGS[tier]
    return TierDecision(
        date=day, tier=tier, base_tier=tier, reason=reading["reason"],
        recovery_score=reading["recovery_score"], hrv=reading["hrv"], rhr=reading["rhr"],
        hrv_3day=reading["hrv"], baseline=BASELINE,
    )


def run_detail(run) -> dict:
    workout = run.workout
    return {
        "slot": run.slot,
        "name": workout.name,
        "kind": workout.kind,
        "km": round(run.km, 2),
        "minutes": round(workout.est_seconds() / 60),
        "icu_text": workout.icu_text(),
        "notes": list(workout.notes),
        "placeholder": workout.placeholder,
    }


def export() -> dict:
    plan = Plan.load(PLAN_FILE)
    weeks = []

    for week in plan.weeks:
        allocation = plan.allocate(week)
        days = []
        for offset in range(7):
            date = week.start + dt.timedelta(days=offset)
            prescribed = plan.day_plan(date)
            events = build_events(prescribed)

            tiers = {}
            for tier in (Tier.GREEN, Tier.AMBER, Tier.RED):
                with tempfile.TemporaryDirectory() as tmp:
                    state = RunState(Path(tmp) / "state.json")
                    engine = AdjustmentEngine(plan, state)
                    result = engine.apply(plan.day_plan(date), decision_for(date, tier))
                tiers[tier.value] = {
                    "summary": summarise_day(result.day),
                    "changed": result.modified,
                    "modifications": [
                        {"kind": m.kind, "summary": m.summary, "original": m.original}
                        for m in result.modifications
                    ],
                    "flags": list(result.flags),
                    "notes": list(result.day.notes),
                    "total_km": result.day.total_km,
                    "calendar_title": build_title(
                        result.day, tier=tier.value, modified=result.modified
                    ),
                    "calendar_description": build_description(result),
                    "runs": [run_detail(r) for r in result.day.runs],
                }

            days.append({
                "date": date.isoformat(),
                "weekday": prescribed.weekday,
                "label": prescribed.label(),
                "day_of_month": date.day,
                "month": date.strftime("%b"),
                "total_km": prescribed.total_km,
                "rest": prescribed.rest,
                "race_day": prescribed.race_day,
                "keystone": prescribed.keystone,
                "gym": prescribed.gym.name if prescribed.gym else None,
                "runs": [run_detail(r) for r in prescribed.runs],
                "notes": list(prescribed.notes),
                "calendar_title": build_title(prescribed),
                "events": [
                    {"external_id": e.payload["external_id"], "name": e.payload["name"],
                     "type": e.payload["type"], "category": e.payload["category"],
                     "distance_m": e.payload.get("distance"),
                     "moving_time_s": e.payload["moving_time"],
                     "start": e.payload["start_date_local"],
                     "description": e.payload["description"]}
                    for e in events
                ],
                "tiers": tiers,
            })

        weeks.append({
            "number": week.number,
            "start": week.start.isoformat(),
            "end": week.end.isoformat(),
            "volume_target": week.volume_km,
            "volume_planned": allocation.planned_total,
            "note": week.note,
            "keystone": week.keystone,
            "race_week": week.race_week,
            "quality_name": (week.quality or {}).get("name", "").replace(
                "GP", plan.goal_pace.human()),
            "long_run_km": plan.long_run_km(week) if not week.race_week else None,
            "allocation": allocation.day_km,
            "allocation_notes": allocation.notes,
            "days": days,
        })

    return {
        "meta": {
            "race_name": plan.meta["race"]["name"],
            "race_location": plan.meta["race"]["location"],
            "race_date": plan.race_date.isoformat(),
            "goal": plan.meta["race"]["goal"],
            "goal_pace": plan.goal_pace.human(),
            "timezone": plan.timezone,
            "max_hr": plan.meta["max_hr"],
            "lthr": plan.meta["lthr"],
            "paces": {name: plan.paces[name].human() for name in plan.paces.names()},
            "zones": plan.zones,
            "generated": dt.datetime.now().isoformat(timespec="seconds"),
        },
        "weeks": weeks,
    }


if __name__ == "__main__":
    json.dump(export(), sys.stdout, indent=2)
