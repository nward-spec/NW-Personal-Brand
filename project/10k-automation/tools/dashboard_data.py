"""Emit the slim schedule the mobile dashboard embeds.

The dashboard shows two things layered: the prescribed schedule, which comes
from here and works offline, and the live overlay of what the engine actually
did, which the page reads from Google Calendar at view time.

Only the plan goes in this file. No recovery data, no personal readings.

    python3 tools/dashboard_data.py > dashboard.json
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tenk.plan import Plan  # noqa: E402

PLAN_FILE = Path(__file__).resolve().parent.parent / "config" / "plan.yaml"


def day_entry(plan: Plan, date: dt.date) -> dict:
    day = plan.day_plan(date)
    if day.gym is not None:
        kind, name = "gym", day.gym.name.replace("Gym — ", "")
    elif day.race_day:
        kind, name = "race", day.runs[0].workout.name
    elif not day.runs:
        kind, name = "rest", "Rest"
    else:
        kind = day.runs[0].workout.kind
        name = " + ".join(r.workout.name for r in day.runs)
    return {
        "date": date.isoformat(),
        "dow": day.label(),
        "dom": date.day,
        "kind": kind,
        "name": name,
        "km": day.total_km or None,
        "double": len(day.runs) > 1,
        "keystone": day.keystone,
        "runs": [
            {"slot": r.slot, "name": r.workout.name, "km": round(r.km, 1),
             "min": round(r.workout.est_seconds() / 60)}
            for r in day.runs
        ],
    }


def build() -> dict:
    plan = Plan.load(PLAN_FILE)
    weeks = []
    for week in plan.weeks:
        weeks.append({
            "n": week.number,
            "start": week.start.isoformat(),
            "end": week.end.isoformat(),
            "target": week.volume_km,
            "planned": plan.allocate(week).planned_total,
            "quality": (week.quality or {}).get("name", "").replace(
                "GP", plan.goal_pace.human()),
            "long": plan.long_run_km(week) if not week.race_week else None,
            "keystone": week.keystone,
            "race_week": week.race_week,
            "note": week.note or "",
            "days": [day_entry(plan, week.start + dt.timedelta(days=i)) for i in range(7)],
        })
    return {
        "meta": {
            "race": plan.meta["race"]["name"],
            "where": plan.meta["race"]["location"],
            "race_date": plan.race_date.isoformat(),
            "goal": plan.meta["race"]["goal"],
            "goal_pace": plan.goal_pace.human(),
            "paces": {n: plan.paces[n].human() for n in plan.paces.names()},
            "zones": plan.zones,
            "generated": dt.date.today().isoformat(),
        },
        "weeks": weeks,
    }


if __name__ == "__main__":
    json.dump(build(), sys.stdout, separators=(",", ":"))
