"""The morning run, start to finish.

Order matters. Whoop first, because the tier changes what gets written; then
intervals.icu, because Garmin pulls from it; then the calendar, which is the
human-facing mirror of both.

Nothing here is allowed to be fatal except a broken plan file. If Whoop is
unreachable the day is still written - the adjustment is an enhancement, not a
dependency.
"""

from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo

from .adjust import AdjustedDay, AdjustmentEngine, apply_carry_forward, gym_strain_note, summarise_day
from .config import Config
from .gcal import CalendarMirror, build_description, build_title, completion_title
from .intervals_icu import (
    Completion,
    IntervalsClient,
    IntervalsEvent,
    build_events,
    completions_by_date,
)
from .logging_setup import log_decision
from .status import build_status, write_status
from .plan import DayPlan, Plan, WEEKDAYS, weekday_key
from .state import RunState, TokenStore
from .tiers import Tier, TierDecision, classify
from .whoop import WhoopClient, WhoopError

log = logging.getLogger(__name__)


@dataclass
class RunReport:
    date: dt.date
    tier: str
    today_summary: str
    original_summary: str
    modifications: List[Dict[str, Any]] = field(default_factory=list)
    flags: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    events_written: int = 0
    calendar_writes: int = 0
    completions_marked: int = 0
    dry_run: bool = False
    window: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "date": self.date.isoformat(),
            "tier": self.tier,
            "today": self.today_summary,
            "originally": self.original_summary,
            "modifications": self.modifications,
            "flags": self.flags,
            "warnings": self.warnings,
            "events_written": self.events_written,
            "calendar_writes": self.calendar_writes,
            "completions_marked": self.completions_marked,
            "dry_run": self.dry_run,
        }


class DailyEngine:
    def __init__(self, config: Config, *, dry_run: bool = False, today: Optional[dt.date] = None):
        self.config = config
        self.dry_run = dry_run
        self.plan = Plan.load(config.plan_file)
        self.tz = ZoneInfo(self.plan.timezone)
        self.today = today or dt.datetime.now(self.tz).date()
        self.state = RunState(config.run_state_file)
        self.engine = AdjustmentEngine(
            self.plan,
            self.state,
            max_modifications_per_week=int(config.engine.get("max_modifications_per_week", 2)),
        )

    # ------------------------------------------------------------------ whoop

    def _whoop_client(self) -> Optional[WhoopClient]:
        settings = self.config.whoop
        if not settings.get("enabled", True):
            return None
        client = WhoopClient(
            client_id=Config.secret("WHOOP_CLIENT_ID"),
            client_secret=Config.secret("WHOOP_CLIENT_SECRET"),
            token_store=TokenStore(self.config.token_file),
            api_base=settings.get("api_base", "https://api.prod.whoop.com/developer/v2"),
            token_url=settings.get("token_url", "https://api.prod.whoop.com/oauth/oauth2/token"),
            auth_url=settings.get("auth_url", "https://api.prod.whoop.com/oauth/oauth2/auth"),
            scopes=settings.get("scopes", []),
            timezone=self.tz,
        )
        client.set_redirect_uri(settings.get("redirect_uri", "http://localhost:8723/callback"))
        return client

    def read_recovery(self) -> tuple[TierDecision, Optional[str], List[str]]:
        """Tier for today, the gym feed-forward note, and anything that went wrong."""
        settings = self.config.whoop
        warnings: List[str] = []
        try:
            client = self._whoop_client()
        except Exception as exc:
            warnings.append(f"Whoop not configured: {exc}")
            client = None

        if client is None:
            decision = classify(self.today, [])
            decision.warnings.extend(warnings or ["Whoop is disabled; prescribing as written."])
            return decision, None, warnings

        try:
            recoveries = client.recoveries(self.today, days=max(21, int(settings.get("baseline_days", 14)) + 7))
        except WhoopError as exc:
            warnings.append(f"Whoop unreachable ({exc}). Day written as prescribed.")
            decision = classify(self.today, [])
            decision.warnings.append(str(exc))
            return decision, None, warnings

        decision = classify(
            self.today,
            recoveries,
            baseline_days=int(settings.get("baseline_days", 14)),
            short_window_days=int(settings.get("short_window_days", 3)),
            hrv_sd_multiple=float(settings.get("hrv_sd_multiple", 1.0)),
            rhr_over_baseline_bpm=float(settings.get("rhr_over_baseline_bpm", 5.0)),
        )

        note = None
        gym_settings = settings.get("gym", {}) or {}
        try:
            workouts = client.workouts(self.today, days=42)
            note = gym_strain_note(
                workouts,
                self.today - dt.timedelta(days=1),
                sport_names=gym_settings.get("sport_names", []),
                baseline_sessions=int(gym_settings.get("baseline_sessions", 6)),
                over_baseline_pct=float(gym_settings.get("strain_over_baseline_pct", 20)),
            )
        except WhoopError as exc:
            warnings.append(f"Whoop workouts unavailable ({exc}); no gym feed-forward this morning.")
        return decision, note, warnings

    # -------------------------------------------------------------- intervals

    def _intervals_client(self) -> Optional[IntervalsClient]:
        settings = self.config.intervals
        if not settings.get("enabled", True):
            return None
        return IntervalsClient(
            athlete_id=str(settings.get("athlete_id", "")),
            api_key=Config.secret("INTERVALS_ICU_API_KEY"),
            api_base=settings.get("api_base", "https://intervals.icu/api/v1"),
            dry_run=self.dry_run,
        )

    def read_completions(self, client: Optional[IntervalsClient], days_back: int = 10
                         ) -> Dict[dt.date, List[Completion]]:
        if client is None:
            return {}
        try:
            activities = client.activities(self.today - dt.timedelta(days=days_back), self.today)
        except Exception as exc:
            log.warning("could not read completed activities: %s", exc)
            return {}
        by_date = completions_by_date(activities)
        return {day: [c for c in items if _is_run(c)] for day, items in by_date.items()}

    # ------------------------------------------------------------------- days

    def actuals_for_week(self, week, completions: Mapping[dt.date, List[Completion]]) -> Dict[str, float]:
        """What was actually run earlier this week, keyed by weekday."""
        actuals: Dict[str, float] = {}
        for offset in range(7):
            day = week.start + dt.timedelta(days=offset)
            if day >= self.today:
                break
            done = completions.get(day)
            if done:
                actuals[WEEKDAYS[day.weekday()]] = round(sum(c.distance_km for c in done), 2)
        return actuals

    def build_day(self, day: dt.date, completions: Mapping[dt.date, List[Completion]]) -> DayPlan:
        week = self.plan.week_for(day)
        actuals = self.actuals_for_week(week, completions) if week else {}
        plan_day = self.plan.day_plan(day, actuals)
        carried = apply_carry_forward(self.plan, plan_day, self.state)
        if carried:
            log.info("%s", carried)
        return plan_day

    # -------------------------------------------------------------------- run

    def run(self) -> RunReport:
        log.info("=== 10k engine, %s (%s)%s", self.today, self.plan.timezone,
                 " DRY RUN" if self.dry_run else "")
        decision, gym_note, warnings = self.read_recovery()
        log.info("tier %s: %s", decision.tier.value, decision.reason)
        if gym_note:
            log.info("gym feed-forward: %s", gym_note)

        self.state.record_tier(self.today, decision.tier.value)
        log_decision(self.config.decision_log, decision.as_log())

        intervals = None
        try:
            intervals = self._intervals_client()
        except Exception as exc:
            warnings.append(f"intervals.icu not configured: {exc}")
        completions = self.read_completions(intervals)

        wednesday = self._last_wednesday()
        if wednesday in completions:
            km = round(sum(c.distance_km for c in completions[wednesday]), 2)
            self.state.set_actual(wednesday, km)
            log.info("run club on %s came back as %.1f km; the rest of the week rebalances", wednesday, km)

        today_plan = self.build_day(self.today, completions)
        adjusted = self.engine.apply(today_plan, decision, gym_note=gym_note)
        for flag in adjusted.flags:
            log.warning("%s", flag)

        report = RunReport(
            date=self.today,
            tier=decision.tier.value,
            today_summary=summarise_day(adjusted.day),
            original_summary=adjusted.original_summary,
            modifications=[m.as_log() for m in adjusted.modifications],
            flags=list(adjusted.flags),
            dry_run=self.dry_run,
        )

        # --- the rolling window --------------------------------------------
        window_days = int(self.config.engine.get("window_days", 10))
        events: List[IntervalsEvent] = []
        calendar_days: List[tuple[DayPlan, AdjustedDay]] = [(adjusted.day, adjusted)]
        prefix = self.config.intervals.get("external_id_prefix", "10k")
        run_type = self.config.intervals.get("run_type", "Run")
        gym_type = self.config.intervals.get("gym_type", "WeightTraining")

        events.extend(build_events(
            adjusted.day, prefix=prefix, run_type=run_type, gym_type=gym_type,
            tier=decision.tier.value, modified=adjusted.modified,
        ))
        report.window.append(f"{self.today} {summarise_day(adjusted.day)}")

        for offset in range(1, window_days):
            day = self.today + dt.timedelta(days=offset)
            if self.plan.week_for(day) is None:
                continue
            future = self.build_day(day, completions)
            events.extend(build_events(future, prefix=prefix, run_type=run_type, gym_type=gym_type))
            future_adjusted = AdjustedDay(day=future, decision=_as_written(day))
            calendar_days.append((future, future_adjusted))
            report.window.append(f"{day} {summarise_day(future)}")

        if intervals is not None:
            try:
                result = intervals.bulk_upsert(events)
                report.events_written = result.get("written", 0) or result.get("would_write", 0)
            except Exception as exc:
                warnings.append(f"intervals.icu write failed: {exc}")
                log.error("intervals.icu write failed: %s", exc)

        # --- calendar --------------------------------------------------------
        mirror = self._calendar()
        if mirror is not None:
            for plan_day, day_adjusted in calendar_days:
                try:
                    mirror.upsert_day(
                        plan_day,
                        build_title(
                            plan_day,
                            tier=day_adjusted.decision.tier.value,
                            modified=day_adjusted.modified,
                        ),
                        build_description(day_adjusted),
                    )
                    report.calendar_writes += 1
                except Exception as exc:
                    warnings.append(f"calendar write failed for {plan_day.date}: {exc}")
                    log.error("calendar write failed for %s: %s", plan_day.date, exc)

            report.completions_marked = self._write_back_completions(mirror, completions)

        self._write_status(adjusted, completions, warnings)

        self.state.save()
        report.warnings = _unique(warnings + list(decision.warnings))
        log.info("today: %s", report.today_summary)
        return report

    def _write_back_completions(
        self, mirror: CalendarMirror, completions: Mapping[dt.date, List[Completion]]
    ) -> int:
        """✅ the days Garmin has already synced back."""
        marked = 0
        for offset in range(1, 8):
            day = self.today - dt.timedelta(days=offset)
            done = completions.get(day)
            if not done:
                continue
            plan_day = self.plan.day_plan(day)
            if not plan_day.runs:
                continue
            try:
                mirror.set_title(day, completion_title(plan_day, done))
                marked += 1
            except Exception as exc:
                log.warning("could not mark %s complete: %s", day, exc)
        return marked

    def _write_status(self, adjusted, completions, warnings: List[str]) -> None:
        """The dashboard's data file. Never fatal: a failure here costs a
        phone screen, not the day's training."""
        settings = self.config.raw.get("status") or {}
        if not settings.get("enabled", True):
            return
        filename = settings.get("filename", "dashboard-status.json")
        paths = [self.config.state_dir / filename]
        for extra in settings.get("copy_to", []) or []:
            paths.append(Path(str(extra)).expanduser() / filename)

        try:
            payload = build_status(
                self.plan, self.state, self.today, adjusted, completions
            )
        except Exception as exc:
            warnings.append(f"could not build the dashboard status: {exc}")
            log.error("status build failed: %s", exc)
            return

        written = write_status(paths, payload)
        if self.dry_run:
            log.info("DRY RUN status would be written to %s",
                     ", ".join(str(p) for p in paths))
            return
        if not written:
            warnings.append("dashboard status could not be written anywhere")
        else:
            log.info("status written to %s", ", ".join(str(p) for p in written))

    def _calendar(self) -> Optional[CalendarMirror]:
        settings = self.config.calendar
        if not settings.get("enabled", True):
            return None
        return CalendarMirror(
            calendar_id=settings.get("calendar_id", "primary"),
            client_secrets_file=str(self.config.path(settings.get("client_secrets_file", ""))),
            token_file=str(self.config.path(settings.get("token_file", "state/gcal_token.json"))),
            event_id_prefix=settings.get("event_id_prefix", "tenk"),
            dry_run=self.dry_run,
        )

    def _last_wednesday(self) -> dt.date:
        offset = (self.today.weekday() - 2) % 7
        if offset == 0:
            offset = 7
        return self.today - dt.timedelta(days=offset)


def _unique(items: Sequence[str]) -> List[str]:
    """Same warning from two paths is one warning to read."""
    seen: List[str] = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


def _as_written(day: dt.date) -> TierDecision:
    return TierDecision(
        date=day,
        tier=Tier.GREEN,
        base_tier=Tier.GREEN,
        reason="Future day: written as planned. Recovery is read on the morning itself.",
    )


def _is_run(completion: Completion) -> bool:
    kind = (completion.type or "").lower()
    return kind in ("", "run", "virtualrun", "trailrun") or "run" in kind
