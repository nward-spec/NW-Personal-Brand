"""Google Calendar mirror.

One all-day event per training day. The title is the at-a-glance view:

    🏃 Sat — 2 × 4km @ 3:40-3:45 (KEYSTONE)
    🏋️ Mon — Gym, lower body
    [AMBER] 🏃 Sat — 3 × 4km @ 3:40-3:45
    ✅ Tue — 10.2km easy, 5:12/km, 147 avg HR

The description carries the full session, the tier that produced it, and - when
something changed - what it originally was and why.

Event ids are derived from the date, so a re-run updates the same event instead
of stacking duplicates. Google requires ids to use base32hex characters
(0-9, a-v); a hex digest qualifies.

The Google client libraries are imported lazily so that the engine, its tests
and `--dry-run` all work on a machine that has never installed them.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .adjust import AdjustedDay
from .intervals_icu import Completion
from .plan import DayPlan

log = logging.getLogger(__name__)

RUN_EMOJI = "🏃"
GYM_EMOJI = "🏋️"
REST_EMOJI = "😴"
RACE_EMOJI = "🏁"
DONE_EMOJI = "✅"

SCOPES = ["https://www.googleapis.com/auth/calendar"]


def event_id(prefix: str, day: dt.date) -> str:
    digest = hashlib.sha1(f"{prefix}:{day.isoformat()}".encode("utf-8")).hexdigest()
    return f"{prefix}{digest[:26]}".lower()


def build_title(day: DayPlan, *, tier: Optional[str] = None, modified: bool = False) -> str:
    label = day.label()
    if day.race_day:
        body = f"{RACE_EMOJI} {label} — RACE: {day.runs[0].workout.name}" if day.runs else f"{RACE_EMOJI} {label} — RACE"
        return body
    if day.rest or (not day.runs and day.gym is None):
        return f"{REST_EMOJI} {label} — Rest"
    if day.gym is not None:
        return f"{GYM_EMOJI} {label} — {day.gym.name.replace('—', '').replace('  ', ' ').strip()}"

    parts = [run.workout.name for run in day.runs]
    title = f"{RUN_EMOJI} {label} — {' + '.join(parts)}"
    # The keystone label belongs to the keystone session. Once recovery has
    # downgraded it to an easy run, calling it the keystone is a lie.
    if day.keystone and any(run.workout.kind == "quality" for run in day.runs):
        title += " (KEYSTONE)"
    if modified and tier:
        title = f"[{tier}] {title}"
    return title


def build_description(adjusted: AdjustedDay) -> str:
    day = adjusted.day
    decision = adjusted.decision
    lines: List[str] = []

    if day.gym is not None:
        lines.append(day.gym.name)
    for run in day.runs:
        lines.append(f"{run.slot.upper()} — {run.workout.name} ({run.km:g}km)")
        body = run.workout.icu_text()
        if body:
            lines.extend(f"    {line}" for line in body.splitlines() if line.strip())
        lines.append("")
    if day.rest and not day.runs:
        lines.append("Full rest.")

    lines.append(f"Tier: {decision.tier.value}")
    lines.append(f"Why: {decision.reason}")
    inputs = []
    if decision.recovery_score is not None:
        inputs.append(f"recovery {decision.recovery_score:.0f}%")
    if decision.hrv is not None:
        inputs.append(f"HRV {decision.hrv:.1f} ms")
    if decision.baseline.hrv_mean is not None:
        inputs.append(f"baseline HRV {decision.baseline.hrv_mean:.1f} ms")
    if decision.rhr is not None:
        inputs.append(f"RHR {decision.rhr:.0f} bpm")
    if decision.baseline.rhr_mean is not None:
        inputs.append(f"baseline RHR {decision.baseline.rhr_mean:.1f} bpm")
    if inputs:
        lines.append("Inputs: " + ", ".join(inputs))

    if adjusted.modifications:
        lines.append("")
        lines.append("Changed from the plan:")
        for modification in adjusted.modifications:
            lines.append(f"  • {modification.summary}")
            lines.append(f"    was: {modification.original}")
            lines.append(f"    why: {modification.reason}")
            if modification.flagged_for_review:
                lines.append("    FLAGGED FOR REVIEW — past the weekly modification limit.")
    if adjusted.flags:
        lines.append("")
        for flag in adjusted.flags:
            lines.append(f"!! {flag}")
    if day.notes:
        lines.append("")
        lines.extend(f"- {note}" for note in day.notes)
    for warning in decision.warnings:
        lines.append(f"- {warning}")

    return "\n".join(lines).strip()


def completion_title(day: DayPlan, completions: Sequence[Completion]) -> str:
    """✅ Tue — 10.2km easy, 5:12/km, 147 avg HR"""
    label = day.label()
    total_km = sum(c.distance_km for c in completions)
    total_time = sum(c.moving_time_s for c in completions)
    hrs = [c.average_hr for c in completions if c.average_hr]
    merged = Completion(
        date=day.date,
        name=completions[0].name if completions else "",
        distance_km=round(total_km, 2),
        moving_time_s=total_time,
        average_hr=int(round(sum(hrs) / len(hrs))) if hrs else None,
        type=completions[0].type if completions else "",
    )
    kind = day.runs[0].workout.kind.replace("_", " ") if day.runs else "session"
    if len(completions) > 1:
        kind += f" (x{len(completions)})"
    return f"{DONE_EMOJI} {label} — {kind}, {merged.headline()}"


@dataclass
class CalendarWrite:
    date: dt.date
    event_id: str
    title: str
    action: str          # insert | update | skip


class CalendarMirror:
    def __init__(
        self,
        *,
        calendar_id: str = "primary",
        client_secrets_file: str = "",
        token_file: str = "",
        event_id_prefix: str = "tenk",
        dry_run: bool = False,
        service: Any = None,
    ):
        self.calendar_id = calendar_id
        self.client_secrets_file = client_secrets_file
        self.token_file = token_file
        self.prefix = event_id_prefix
        self.dry_run = dry_run
        self._service = service

    # -------------------------------------------------------------- service

    def service(self):
        if self._service is not None:
            return self._service
        try:
            from google.auth.transport.requests import Request
            from google.oauth2.credentials import Credentials
            from google_auth_oauthlib.flow import InstalledAppFlow
            from googleapiclient.discovery import build
        except ImportError as exc:  # pragma: no cover - depends on the host
            raise RuntimeError(
                "Google Calendar libraries are not installed. "
                "pip install -r requirements.txt, or set google_calendar.enabled: false."
            ) from exc

        import json
        import os
        from pathlib import Path

        creds = None
        token_path = Path(self.token_file)
        if token_path.exists():
            creds = Credentials.from_authorized_user_info(
                json.loads(token_path.read_text(encoding="utf-8")), SCOPES
            )
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        if not creds or not creds.valid:
            flow = InstalledAppFlow.from_client_secrets_file(self.client_secrets_file, SCOPES)
            creds = flow.run_local_server(port=0)
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(creds.to_json(), encoding="utf-8")
        os.chmod(token_path, 0o600)
        self._service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        return self._service

    # ---------------------------------------------------------------- writes

    def upsert_day(self, day: DayPlan, title: str, description: str) -> CalendarWrite:
        identifier = event_id(self.prefix, day.date)
        body = {
            "id": identifier,
            "summary": title,
            "description": description,
            "start": {"date": day.date.isoformat()},
            "end": {"date": (day.date + dt.timedelta(days=1)).isoformat()},
            "transparency": "transparent",
            "reminders": {"useDefault": False},
        }
        if self.dry_run:
            log.info("DRY RUN calendar %s: %s", day.date.isoformat(), title)
            return CalendarWrite(day.date, identifier, title, "dry-run")

        service = self.service()
        try:
            service.events().insert(calendarId=self.calendar_id, body=body).execute()
            return CalendarWrite(day.date, identifier, title, "insert")
        except Exception as exc:  # googleapiclient.errors.HttpError, 409 on re-run
            if _status_of(exc) not in (409, 400):
                raise
            service.events().update(
                calendarId=self.calendar_id, eventId=identifier, body=body
            ).execute()
            return CalendarWrite(day.date, identifier, title, "update")

    def set_title(self, day: dt.date, title: str) -> CalendarWrite:
        """Completion write-back: retitle an existing day, leave its body alone."""
        identifier = event_id(self.prefix, day)
        if self.dry_run:
            log.info("DRY RUN calendar retitle %s: %s", day.isoformat(), title)
            return CalendarWrite(day, identifier, title, "dry-run")
        service = self.service()
        try:
            service.events().patch(
                calendarId=self.calendar_id, eventId=identifier, body={"summary": title}
            ).execute()
            return CalendarWrite(day, identifier, title, "update")
        except Exception as exc:
            if _status_of(exc) == 404:
                log.warning("no calendar event for %s to mark complete", day)
                return CalendarWrite(day, identifier, title, "skip")
            raise


def _status_of(exc: Exception) -> Optional[int]:
    status = getattr(getattr(exc, "resp", None), "status", None)
    if status is not None:
        try:
            return int(status)
        except (TypeError, ValueError):
            return None
    return getattr(exc, "status_code", None)
