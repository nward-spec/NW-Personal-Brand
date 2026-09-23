"""The daily status file the mobile dashboard reads.

The engine runs on a laptop; the dashboard runs on a phone. This file is the
bridge. It is written to an ordinary folder, so any sync service the athlete
already uses - Google Drive, iCloud, Dropbox - carries it without the
automation holding a single credential of its own.

It carries what the plan cannot know: the tier each morning, what the engine
changed and why, and which sessions came back completed.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .adjust import AdjustedDay, summarise_day
from .intervals_icu import Completion
from .plan import Plan
from .state import RunState, atomic_write_json

log = logging.getLogger(__name__)

SCHEMA = 1


def build_status(
    plan: Plan,
    state: RunState,
    today: dt.date,
    adjusted: Optional[AdjustedDay],
    completions: Mapping[dt.date, Sequence[Completion]],
    *,
    history_days: int = 21,
    horizon_days: int = 10,
) -> Dict[str, Any]:
    """Everything the dashboard needs that is not already in the plan."""
    days: Dict[str, Any] = {}

    for offset in range(-history_days, horizon_days + 1):
        date = today + dt.timedelta(days=offset)
        entry: Dict[str, Any] = {}

        tier = state.tier_on(date)
        if tier:
            entry["tier"] = tier

        done = completions.get(date) or []
        if done:
            total_km = round(sum(c.distance_km for c in done), 2)
            total_time = sum(c.moving_time_s for c in done)
            hrs = [c.average_hr for c in done if c.average_hr]
            entry["done"] = {
                "runs": len(done),
                "km": total_km,
                "moving_time_s": total_time,
                "pace": _pace(total_km, total_time),
                "avg_hr": int(round(sum(hrs) / len(hrs))) if hrs else None,
            }

        if entry:
            days[date.isoformat()] = entry

    # Modifications, newest first, across every week the engine has touched.
    edits: List[Dict[str, Any]] = []
    for week_key in sorted(state.data.get("modifications", {})):
        for record in state.modifications(week_key):
            edits.append({
                "date": record.get("date"),
                "weekday": record.get("weekday"),
                "tier": record.get("tier"),
                "kind": record.get("kind"),
                "summary": record.get("summary"),
                "was": record.get("original"),
                "why": record.get("reason"),
                "flagged": bool(record.get("flagged_for_review")),
            })
    edits.sort(key=lambda e: e.get("date") or "", reverse=True)
    for edit in edits:
        entry = days.setdefault(edit["date"], {})
        entry.setdefault("edits", []).append(edit)

    payload: Dict[str, Any] = {
        "schema": SCHEMA,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "goal_pace": plan.goal_pace.human(),
        "race_date": plan.race_date.isoformat(),
        "days": days,
        "edits": edits[:20],
    }

    if adjusted is not None:
        decision = adjusted.decision
        payload["today_detail"] = {
            "tier": decision.tier.value,
            "why": decision.reason,
            "prescribed": adjusted.original_summary,
            "written": summarise_day(adjusted.day),
            "modified": adjusted.modified,
            "flags": list(adjusted.flags),
            "notes": list(adjusted.day.notes),
            "data_available": decision.data_available,
        }
        # Readings are deliberately rounded and kept coarse. They travel
        # through whatever folder the athlete syncs, so they carry no more
        # precision than a person actually reads.
        if decision.recovery_score is not None:
            payload["today_detail"]["recovery"] = round(decision.recovery_score)
        if decision.hrv is not None:
            payload["today_detail"]["hrv"] = round(decision.hrv, 1)
        if decision.rhr is not None:
            payload["today_detail"]["rhr"] = round(decision.rhr)
        if decision.baseline.hrv_mean is not None:
            payload["today_detail"]["hrv_baseline"] = round(decision.baseline.hrv_mean, 1)

    return payload


def write_status(paths: Sequence[Path], payload: Mapping[str, Any]) -> List[Path]:
    """Write the status to each configured location. A sync folder that is
    not there today is skipped with a warning, never a crash."""
    written: List[Path] = []
    for path in paths:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_json(path, payload, mode=0o644)
            written.append(path)
        except Exception as exc:
            log.warning("could not write status to %s: %s", path, exc)
    return written


def _pace(km: float, seconds: int) -> Optional[str]:
    if km <= 0 or seconds <= 0:
        return None
    # Round the whole value before splitting, or 359.7 s/km renders "5:60".
    per_km = int(round(seconds / km))
    return f"{per_km // 60}:{per_km % 60:02d}"
