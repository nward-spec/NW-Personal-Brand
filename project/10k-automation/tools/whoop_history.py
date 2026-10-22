#!/usr/bin/env python3
"""What the athlete has actually been doing, from Whoop.

intervals.icu holds no completed activities because the Garmin-to-intervals
sync has never been on, so the plan has been written against an assumed
training volume. Whoop records every workout it scores, which makes it the
one source of truth for what was really run.

Reports each scored workout and a weekly roll-up, alongside the recovery
trend, so the plan can be set from the record rather than from memory.

    python tools/whoop_history.py              last 42 days
    python tools/whoop_history.py --days 21
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from collections import defaultdict
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from zoneinfo import ZoneInfo                   # noqa: E402

from tenk.config import Config                  # noqa: E402
from tenk.plan import Plan                      # noqa: E402
from tenk.state import TokenStore               # noqa: E402
from tenk.whoop import WhoopClient              # noqa: E402

RUN_SPORTS = ("running", "run", "trail running", "treadmill")


def _f(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _km(workout) -> Optional[float]:
    """Whoop reports distance on the score, in metres, when the sport has one."""
    score = workout.raw.get("score") or {}
    for key in ("distance_meter", "distance_meters", "distance"):
        metres = _f(score.get(key)) or _f(workout.raw.get(key))
        if metres:
            return round(metres / 1000.0, 2)
    return None


def _minutes(workout) -> Optional[float]:
    start, end = workout.raw.get("start"), workout.raw.get("end")
    if not (start and end):
        return None
    try:
        a = dt.datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        b = dt.datetime.fromisoformat(str(end).replace("Z", "+00:00"))
    except ValueError:
        return None
    return round((b - a).total_seconds() / 60.0, 1)


def _monday(date: dt.date) -> dt.date:
    return date - dt.timedelta(days=date.weekday())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=None)
    parser.add_argument("--days", type=int, default=42)
    args = parser.parse_args(argv)

    config = Config.load(args.config)
    plan = Plan.load(config.plan_file)
    tz = ZoneInfo(plan.timezone)
    settings = config.whoop

    client = WhoopClient(
        client_id=Config.secret("WHOOP_CLIENT_ID"),
        client_secret=Config.secret("WHOOP_CLIENT_SECRET"),
        token_store=TokenStore(config.token_file),
        api_base=settings.get("api_base", "https://api.prod.whoop.com/developer/v2"),
        token_url=settings.get("token_url", "https://api.prod.whoop.com/oauth/oauth2/token"),
        auth_url=settings.get("auth_url", "https://api.prod.whoop.com/oauth/oauth2/auth"),
        scopes=settings.get("scopes", []),
        timezone=tz,
    )
    client.set_redirect_uri(settings.get("redirect_uri", "http://localhost:8723/callback"))

    today = dt.datetime.now(tz).date()
    workouts = client.workouts(today, days=args.days)

    print(f"Whoop workouts, {today - dt.timedelta(days=args.days)} to {today} "
          f"({len(workouts)} scored)\n")
    if not workouts:
        print("Nothing scored in this window. Either no workouts were recorded on "
              "the Whoop, or it has not scored them.")
        return 0

    print(f"{'date':<12} {'day':<4} {'sport':<22} {'min':>6} {'km':>7} {'strain':>7}")
    print("-" * 64)
    weekly = defaultdict(lambda: {"runs": 0, "km": 0.0, "min": 0.0, "other": 0})
    for w in workouts:
        km, mins = _km(w), _minutes(w)
        is_run = any(s in w.sport_name.lower() for s in RUN_SPORTS)
        bucket = weekly[_monday(w.date)]
        if is_run:
            bucket["runs"] += 1
            bucket["km"] += km or 0.0
            bucket["min"] += mins or 0.0
        else:
            bucket["other"] += 1
        print(f"{w.date.isoformat():<12} {w.date.strftime('%a'):<4} "
              f"{w.sport_name[:22]:<22} {mins if mins is not None else '':>6} "
              f"{km if km is not None else '':>7} "
              f"{round(w.strain, 1) if w.strain is not None else '':>7}")

    print(f"\n{'week of':<12} {'runs':>5} {'km':>8} {'hours':>7} {'other':>6}")
    print("-" * 42)
    for monday in sorted(weekly):
        b = weekly[monday]
        print(f"{monday.isoformat():<12} {b['runs']:>5} {round(b['km'], 1):>8} "
              f"{round(b['min'] / 60.0, 1):>7} {b['other']:>6}")

    records = client.recoveries(today, days=min(args.days, 30))
    scores = [r.recovery_score for r in records if r.recovery_score is not None]
    if scores:
        print(f"\nrecovery, last {len(scores)} scored days")
        print(f"  mean {round(sum(scores) / len(scores))}%  "
              f"min {round(min(scores))}%  max {round(max(scores))}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
