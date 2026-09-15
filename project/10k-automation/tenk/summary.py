"""Sunday evening summary, delivered to Slack through the Ernest Ops relay.

The relay is an email: a Google Apps Script polls Gmail for the subject tag and
posts the body to Slack as the Ernest Ops bot, which is what makes it reach a
phone. Slack mrkdwn, not Markdown: *bold*, not **bold**.

If SMTP is not configured the message is written to state/outbox/ and reported
as undelivered. It is never silently dropped.
"""

from __future__ import annotations

import datetime as dt
import logging
import smtplib
from dataclasses import dataclass, field
from email.message import EmailMessage
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Sequence

from .config import Config
from .intervals_icu import Completion
from .plan import Plan, WEEKDAYS, Week
from .state import RunState

log = logging.getLogger(__name__)


@dataclass
class WeekSummary:
    week: Week
    planned_km: float
    actual_km: float
    sessions_planned: int
    sessions_completed: int
    tiers: Dict[str, int] = field(default_factory=dict)
    modifications: List[Mapping] = field(default_factory=list)
    flags: List[str] = field(default_factory=list)

    @property
    def downgrades(self) -> int:
        return self.tiers.get("AMBER", 0) + self.tiers.get("RED", 0)


def build_week_summary(
    plan: Plan,
    state: RunState,
    week: Week,
    completions: Mapping[dt.date, Sequence[Completion]],
) -> WeekSummary:
    planned = plan.allocate(week)
    planned_km = planned.planned_total
    actual_km = 0.0
    sessions_planned = 0
    sessions_completed = 0
    tiers: Dict[str, int] = {}

    for offset in range(7):
        day = week.start + dt.timedelta(days=offset)
        plan_day = plan.day_plan(day)
        sessions_planned += len(plan_day.runs)
        done = completions.get(day) or []
        sessions_completed += len(done)
        actual_km += sum(c.distance_km for c in done)
        tier = state.tier_on(day)
        if tier:
            tiers[tier] = tiers.get(tier, 0) + 1

    modifications = state.modifications(week.key)
    flags = [m["summary"] for m in modifications if m.get("flagged_for_review")]
    return WeekSummary(
        week=week,
        planned_km=round(planned_km, 1),
        actual_km=round(actual_km, 1),
        sessions_planned=sessions_planned,
        sessions_completed=sessions_completed,
        tiers=tiers,
        modifications=modifications,
        flags=flags,
    )


def render_slack(plan: Plan, summary: WeekSummary, *, today: dt.date) -> str:
    """Slack mrkdwn. First line does the work - it lands on a lock screen."""
    week = summary.week
    delta = summary.actual_km - summary.planned_km
    to_race = (plan.race_date - today).days
    weeks_to_race = max(0, round(to_race / 7))

    lines = [
        f"*Week {week.number} done: {summary.actual_km:.0f} km of {summary.planned_km:.0f} planned "
        f"({delta:+.0f}).* {to_race} days to the 10k.",
        "",
        f"• Sessions: {summary.sessions_completed}/{summary.sessions_planned} completed",
        f"• Goal pace: {plan.goal_pace.human()}/km",
    ]

    if summary.tiers:
        tier_text = ", ".join(f"{count} {name.lower()}" for name, count in sorted(summary.tiers.items()))
        lines.append(f"• Recovery tiers: {tier_text}")

    if summary.modifications:
        lines.append(f"• Adjustments made: {len(summary.modifications)}")
        for modification in summary.modifications[:4]:
            lines.append(f"    - {modification['date']}: {modification['summary']}")
    else:
        lines.append("• Adjustments made: none. Every session ran as written.")

    if summary.downgrades > 2:
        lines.append("")
        lines.append(
            f":rotating_light: *{summary.downgrades} downgraded days this week.* "
            f"That is the plan being wrong, not the athlete. Look at next week's volume before Monday."
        )
    if summary.flags:
        lines.append("")
        lines.append("*Flagged for review:*")
        lines.extend(f"    - {flag}" for flag in summary.flags)

    next_week = next((w for w in plan.weeks if w.number == week.number + 1), None)
    if next_week is not None:
        lines.append("")
        quality = next_week.quality.get("name", "quality session")
        quality = quality.replace("GP", plan.goal_pace.human())
        lines.append(
            f"*Next up — week {next_week.number}:* {next_week.volume_km:.0f} km, "
            f"Sat {quality}, Sun {next_week.long_run.get('km', 0):g} km."
        )
        if next_week.keystone:
            lines.append("That Saturday is the keystone. Everything else bends around it.")
    elif weeks_to_race == 0:
        lines.append("")
        lines.append("*Race week is done.* Go and run 37 minutes.")

    return "\n".join(lines)


@dataclass
class Delivery:
    delivered: bool
    detail: str
    path: Optional[Path] = None


def deliver(config: Config, message: str, *, title: str, dry_run: bool = False) -> Delivery:
    settings = config.summary
    channel = settings.get("channel_id", "")
    subject = f"{settings.get('subject_prefix', '[SLACK-RELAY]')} {title}"
    body = f"CHANNEL: {channel}\n\n{message}\n"

    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    path = config.outbox / f"{stamp}-summary.txt"
    path.write_text(f"To: {settings.get('relay_to', '')}\nSubject: {subject}\n\n{body}", encoding="utf-8")

    if dry_run:
        return Delivery(False, "Dry run: summary written to the outbox, not sent.", path)

    smtp = settings.get("smtp", {}) or {}
    if not smtp.get("enabled", False):
        return Delivery(
            False,
            "SMTP is not configured, so the summary was not sent. It is in the outbox; "
            "send it through the Gmail relay by hand or enable summary.smtp in config.",
            path,
        )

    password = Config.secret("SMTP_PASSWORD", required=False)
    if not password:
        return Delivery(False, "SMTP_PASSWORD is not set; the summary is in the outbox, unsent.", path)

    email = EmailMessage()
    email["To"] = settings.get("relay_to", "")
    email["From"] = smtp.get("from", smtp.get("username", ""))
    email["Subject"] = subject
    email.set_content(body)   # plain text: the relay reads the plain part

    try:
        with smtplib.SMTP(smtp.get("host", "smtp.gmail.com"), int(smtp.get("port", 587)), timeout=30) as server:
            if smtp.get("starttls", True):
                server.starttls()
            server.login(smtp.get("username", ""), password)
            server.send_message(email)
    except Exception as exc:
        return Delivery(False, f"SMTP delivery failed ({exc}); the summary is in the outbox.", path)

    return Delivery(True, "Summary sent to the Ernest Ops relay; it reaches Slack within about 90 seconds.", path)
