"""`tenk check`: verify the setup and say precisely what is missing.

Every failure in getting this running has been a silent one - a wrong path, a
missing package, an unconnected account. This turns each of those into a named
line with the fix attached. It reads credentials but never prints them.
"""

from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass
from typing import Callable, List, Optional

from .config import Config, ConfigError
from .plan import Plan
from .state import TokenStore

log = logging.getLogger(__name__)

OK = "ok"
FAIL = "FAIL"
SKIP = "skip"
WARN = "warn"


@dataclass
class Check:
    name: str
    status: str
    detail: str
    fix: str = ""

    @property
    def blocking(self) -> bool:
        return self.status == FAIL


class Doctor:
    """Runs the checks. Network clients are injectable so this is testable."""

    def __init__(
        self,
        config: Config,
        *,
        intervals_factory: Optional[Callable] = None,
        whoop_factory: Optional[Callable] = None,
        today: Optional[dt.date] = None,
    ):
        self.config = config
        self.intervals_factory = intervals_factory
        self.whoop_factory = whoop_factory
        self.today = today or dt.date.today()
        self.checks: List[Check] = []

    def add(self, name: str, status: str, detail: str, fix: str = "") -> None:
        self.checks.append(Check(name, status, detail, fix))

    # ------------------------------------------------------------------ run

    def run(self) -> List[Check]:
        plan = self._check_plan()
        self._check_intervals()
        self._check_whoop()
        self._check_calendar()
        self._check_state()
        if plan is not None:
            self._check_today(plan)
        return self.checks

    # --------------------------------------------------------------- pieces

    def _check_plan(self) -> Optional[Plan]:
        try:
            plan = Plan.load(self.config.plan_file)
        except Exception as exc:
            self.add("plan", FAIL, f"could not read {self.config.plan_file}: {exc}",
                     "The plan file is the one thing with no fallback. Restore it from git.")
            return None
        weeks = len(plan.weeks)
        days_out = (plan.race_date - self.today).days
        self.add("plan", OK,
                 f"{weeks} weeks, goal pace {plan.goal_pace.human()}/km, "
                 f"{days_out} days to {plan.meta['race']['name']}")
        return plan

    def _check_intervals(self) -> None:
        settings = self.config.intervals
        if not settings.get("enabled", True):
            self.add("intervals.icu", SKIP, "disabled in config.yaml")
            return

        athlete_id = str(settings.get("athlete_id", "") or "")
        if not athlete_id or athlete_id == "i00000":
            self.add("intervals.icu", FAIL, "athlete_id is still the placeholder",
                     "Put your real id in config.yaml. It is the i##### in the "
                     "intervals.icu URL when you are logged in.")
            return

        try:
            Config.secret("INTERVALS_ICU_API_KEY")
        except ConfigError:
            self.add("intervals.icu", FAIL, "INTERVALS_ICU_API_KEY is not set",
                     "Put it in ops/secrets.env, then: source ops/secrets.env")
            return

        if self.intervals_factory is None:
            self.add("intervals.icu", SKIP, "credentials present, connection not tested")
            return

        try:
            client = self.intervals_factory()
            athlete = client.athlete()
        except Exception as exc:
            self.add("intervals.icu", FAIL, f"could not authenticate: {exc}",
                     "Check the API key and the athlete id. The key is under "
                     "Settings, Developer Settings on intervals.icu.")
            return

        name = athlete.get("name") or athlete.get("first_name") or athlete_id
        self.add("intervals.icu", OK, f"authenticated as {name} ({athlete_id})")

        try:
            connections = client.connections()
        except Exception as exc:
            self.add("garmin", WARN, f"could not read connections: {exc}")
            return

        if connections.get("garmin_training_connected"):
            self.add("garmin", OK, "intervals.icu is linked to Garmin, so planned "
                                   "workouts upload to the watch")
        else:
            self.add("garmin", FAIL,
                     "intervals.icu is NOT set up to upload planned workouts to Garmin",
                     "On intervals.icu open Settings, tick 'Upload planned workouts', "
                     "and approve the Garmin permission screen. Without this nothing "
                     "reaches the watch, however well the rest works.")

    def _check_whoop(self) -> None:
        settings = self.config.whoop
        if not settings.get("enabled", True):
            self.add("whoop", SKIP, "disabled in config.yaml; days are prescribed as written")
            return

        missing = []
        for name in ("WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET"):
            try:
                Config.secret(name)
            except ConfigError:
                missing.append(name)
        if missing:
            self.add("whoop", FAIL, f"{' and '.join(missing)} not set",
                     "Create an app at developer-dashboard.whoop.com with redirect URI "
                     f"{settings.get('redirect_uri', 'http://localhost:8723/callback')} "
                     "and put the credentials in ops/secrets.env")
            return

        store = TokenStore(self.config.token_file)
        if not store.exists or not store.load().get("refresh_token"):
            self.add("whoop", FAIL, "no stored refresh token",
                     "Run: .venv/bin/python -m tenk.cli authorize")
            return

        if self.whoop_factory is None:
            self.add("whoop", SKIP, "credentials and token present, connection not tested")
            return

        try:
            client = self.whoop_factory()
            records = client.recoveries(self.today, days=3)
        except Exception as exc:
            self.add("whoop", FAIL, f"could not read recovery: {exc}",
                     "If this says the token was rejected, re-run authorize. A refresh "
                     "token is single use and an interrupted run can strand it.")
            return

        todays = [r for r in records if r.date == self.today]
        if todays:
            record = todays[0]
            self.add("whoop", OK,
                     f"recovery {record.recovery_score:.0f}%, HRV {record.hrv_rmssd_milli:.1f} ms, "
                     f"resting HR {record.resting_heart_rate:.0f} bpm")
        else:
            self.add("whoop", WARN,
                     f"connected, but no scored recovery for {self.today} yet; "
                     f"{len(records)} recent record(s). The engine defaults to green and logs the gap.")

    def _check_calendar(self) -> None:
        settings = self.config.calendar
        if not settings.get("enabled", True):
            self.add("calendar", SKIP, "disabled in config.yaml; nothing else is affected")
            return
        try:
            import googleapiclient  # noqa: F401
            import google.auth  # noqa: F401
        except ImportError:
            self.add("calendar", FAIL, "Google client libraries are not installed",
                     ".venv/bin/pip install -r requirements-calendar.txt, or set "
                     "google_calendar.enabled: false to leave the calendar out.")
            return
        secrets_file = self.config.path(settings.get("client_secrets_file", ""))
        if not secrets_file.exists():
            self.add("calendar", FAIL, f"no OAuth client secrets at {secrets_file}",
                     "Download a Desktop app OAuth client from Google Cloud with the "
                     "Calendar API enabled, and save it there.")
            return
        token = self.config.path(settings.get("token_file", "state/gcal_token.json"))
        if token.exists():
            self.add("calendar", OK, f"libraries installed, authorised token at {token.name}")
        else:
            self.add("calendar", WARN, "libraries and client secrets present, not yet authorised; "
                                       "the first real run opens a browser once")

    def _check_state(self) -> None:
        try:
            directory = self.config.state_dir
            probe = directory / ".write-probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
        except Exception as exc:
            self.add("state", FAIL, f"cannot write to the state directory: {exc}",
                     "The engine needs it for tokens, logs and the decision trail.")
            return
        self.add("state", OK, f"writable at {directory}")

    def _check_today(self, plan: Plan) -> None:
        day = plan.day_plan(self.today)
        if day.week_number == 0:
            self.add("today", WARN, f"{self.today} is outside the block")
            return
        from .adjust import summarise_day
        self.add("today", OK,
                 f"{self.today:%a %d %b} (week {day.week_number}): {summarise_day(day)}")


def render(checks: List[Check]) -> str:
    lines = []
    width = max((len(c.name) for c in checks), default=10)
    for check in checks:
        lines.append(f"  {check.status:<4}  {check.name:<{width}}  {check.detail}")
        if check.fix:
            lines.append(f"        {'':<{width}}  -> {check.fix}")
    blocking = [c for c in checks if c.blocking]
    lines.append("")
    if blocking:
        lines.append(f"{len(blocking)} thing(s) to fix: " + ", ".join(c.name for c in blocking))
    else:
        lines.append("Nothing blocking. Next: run --dry-run, then run.")
    return "\n".join(lines)
