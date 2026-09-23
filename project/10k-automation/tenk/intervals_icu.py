"""intervals.icu client and event building.

Auth is basic, with the literal username ``API_KEY`` and the key as password.

Endpoints used (verified against the published OpenAPI document at
https://intervals.icu/api/v1/docs on 15 Sep 2026):

  POST /api/v1/athlete/{id}/events/bulk?upsert=true
  GET  /api/v1/athlete/{id}/events?oldest=&newest=
  GET  /api/v1/athlete/{id}/activities?oldest=&newest=

Idempotency comes from `external_id`: 10k-w07-sat-am. Re-running the morning
job, or running it twice, overwrites rather than duplicates.
"""

from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

import requests

from .adjust import AdjustedDay
from .plan import DayPlan, Run

log = logging.getLogger(__name__)

DEFAULT_TIMES = {"am": "06:00:00", "pm": "17:30:00", "gym": "06:00:00"}


def external_id(prefix: str, week_number: int, weekday: str, slot: str) -> str:
    return f"{prefix}-w{week_number:02d}-{weekday}-{slot}"


@dataclass
class IntervalsEvent:
    payload: Dict[str, Any]

    @property
    def external_id(self) -> str:
        return self.payload["external_id"]

    @property
    def name(self) -> str:
        return self.payload["name"]


def build_events(
    day: DayPlan,
    *,
    prefix: str = "10k",
    run_type: str = "Run",
    gym_type: str = "WeightTraining",
    times: Mapping[str, str] = DEFAULT_TIMES,
    tier: Optional[str] = None,
    modified: bool = False,
) -> List[IntervalsEvent]:
    """One event per run, plus one for a gym day. Rest days write nothing."""
    events: List[IntervalsEvent] = []
    stamp = day.date.isoformat()

    def description(body: str, notes: Sequence[str]) -> str:
        blocks = [body] if body else []
        extra = [n for n in notes if n]
        if extra:
            blocks.append("\n".join(f"# {n}" for n in extra))
        return "\n\n".join(b for b in blocks if b).strip()

    for run in day.runs:
        workout = run.workout
        name = workout.name
        if modified and tier:
            name = f"[{tier}] {name}"
        payload: Dict[str, Any] = {
            "category": "WORKOUT",
            "type": run_type,
            "start_date_local": f"{stamp}T{times.get(run.slot, DEFAULT_TIMES['am'])}",
            "name": name,
            "description": description(workout.icu_text(), day.notes),
            "external_id": external_id(prefix, day.week_number, day.weekday, run.slot),
            "moving_time": workout.est_seconds(),
            "distance": round(run.km * 1000, 1),   # intervals.icu stores metres
        }
        if day.race_day:
            payload["category"] = "RACE_A"
        events.append(IntervalsEvent(payload))

    if day.gym is not None:
        events.append(IntervalsEvent({
            "category": "WORKOUT",
            "type": gym_type,
            "start_date_local": f"{stamp}T{times.get('gym', DEFAULT_TIMES['gym'])}",
            "name": day.gym.name,
            "description": description("", list(day.gym.notes) + list(day.notes)),
            "external_id": external_id(prefix, day.week_number, day.weekday, "gym"),
            "moving_time": 45 * 60,
        }))

    return events


class IntervalsClient:
    def __init__(
        self,
        *,
        athlete_id: str,
        api_key: str,
        api_base: str = "https://intervals.icu/api/v1",
        session: Optional[requests.Session] = None,
        timeout: float = 30.0,
        dry_run: bool = False,
    ):
        self.athlete_id = athlete_id
        self.api_base = api_base.rstrip("/")
        self.session = session or requests.Session()
        self.session.auth = ("API_KEY", api_key)
        self.timeout = timeout
        self.dry_run = dry_run

    def _url(self, path: str) -> str:
        return f"{self.api_base}/athlete/{self.athlete_id}/{path.lstrip('/')}"

    def bulk_upsert(self, events: Sequence[IntervalsEvent]) -> Dict[str, Any]:
        payload = [e.payload for e in events]
        if not payload:
            return {"written": 0}
        if self.dry_run:
            for event in payload:
                log.info("DRY RUN intervals.icu upsert %s: %s", event["external_id"], event["name"])
            return {"written": 0, "dry_run": True, "would_write": len(payload)}
        params = {"upsert": "true", "upsertOnUid": "false", "updatePlanApplied": "false"}
        response = self.session.post(
            self._url("events/bulk"), params=params, json=payload, timeout=self.timeout
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"intervals.icu bulk upsert failed ({response.status_code}): {response.text[:400]}"
            )
        log.info("intervals.icu: wrote %d events", len(payload))
        return {"written": len(payload), "response": _safe_json(response)}

    def athlete(self) -> Mapping[str, Any]:
        """GET /athlete/{id} — the cheapest way to prove the key and id are right."""
        response = self.session.get(
            f"{self.api_base}/athlete/{self.athlete_id}", timeout=self.timeout
        )
        if response.status_code in (401, 403):
            raise RuntimeError(
                f"intervals.icu rejected the API key ({response.status_code})"
            )
        if response.status_code == 404:
            raise RuntimeError(f"intervals.icu has no athlete {self.athlete_id!r}")
        if response.status_code >= 400:
            raise RuntimeError(
                f"intervals.icu athlete lookup failed ({response.status_code}): {response.text[:200]}"
            )
        body = _safe_json(response)
        return body if isinstance(body, Mapping) else {}

    def connections(self) -> Mapping[str, Any]:
        """GET /athlete/{id}/connections — carries garmin_training_connected,
        which is what decides whether a planned workout reaches the watch."""
        response = self.session.get(
            f"{self.api_base}/athlete/{self.athlete_id}/connections", timeout=self.timeout
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"intervals.icu connections failed ({response.status_code}): {response.text[:200]}"
            )
        body = _safe_json(response)
        return body if isinstance(body, Mapping) else {}

    def activities(self, oldest: dt.date, newest: dt.date) -> List[Mapping[str, Any]]:
        response = self.session.get(
            self._url("activities"),
            params={"oldest": oldest.isoformat(), "newest": newest.isoformat()},
            timeout=self.timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"intervals.icu activities failed ({response.status_code}): {response.text[:300]}"
            )
        body = _safe_json(response)
        return body if isinstance(body, list) else []

    def events(self, oldest: dt.date, newest: dt.date) -> List[Mapping[str, Any]]:
        response = self.session.get(
            self._url("events"),
            params={"oldest": oldest.isoformat(), "newest": newest.isoformat()},
            timeout=self.timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"intervals.icu events failed ({response.status_code}): {response.text[:300]}"
            )
        body = _safe_json(response)
        return body if isinstance(body, list) else []


@dataclass
class Completion:
    """A finished run, read back after Garmin synced it to intervals.icu."""

    date: dt.date
    name: str
    distance_km: float
    moving_time_s: int
    average_hr: Optional[int]
    type: str

    @property
    def pace_text(self) -> str:
        if self.distance_km <= 0:
            return "—"
        # Round before splitting, or 359.7 s/km renders as "5:60/km".
        seconds_per_km = int(round(self.moving_time_s / self.distance_km))
        return f"{seconds_per_km // 60}:{seconds_per_km % 60:02d}/km"

    def headline(self) -> str:
        bits = [f"{self.distance_km:.1f}km", self.pace_text]
        if self.average_hr:
            bits.append(f"{self.average_hr} avg HR")
        return ", ".join(bits)


def completions_by_date(activities: Iterable[Mapping[str, Any]]) -> Dict[dt.date, List[Completion]]:
    """Group synced activities by local date."""
    out: Dict[dt.date, List[Completion]] = {}
    for activity in activities:
        stamp = activity.get("start_date_local") or activity.get("start_date")
        if not stamp:
            continue
        try:
            local_date = dt.date.fromisoformat(str(stamp)[:10])
        except ValueError:
            continue
        metres = activity.get("distance") or activity.get("icu_distance") or 0
        completion = Completion(
            date=local_date,
            name=str(activity.get("name") or activity.get("type") or "Activity"),
            distance_km=round(float(metres) / 1000.0, 2),
            moving_time_s=int(activity.get("moving_time") or activity.get("elapsed_time") or 0),
            average_hr=_maybe_int(activity.get("average_heartrate")),
            type=str(activity.get("type") or ""),
        )
        out.setdefault(local_date, []).append(completion)
    return out


def _maybe_int(value) -> Optional[int]:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def _safe_json(response: requests.Response):
    try:
        return response.json()
    except ValueError:
        return {}
