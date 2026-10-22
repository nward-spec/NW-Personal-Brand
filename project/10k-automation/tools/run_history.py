#!/usr/bin/env python3
"""Weekly running volume from intervals.icu, which has every run's real distance.

Whoop recorded no distance on roughly a quarter of runs, so tools/whoop_history.py
had to estimate those from duration. Once Garmin activity sync is on, intervals.icu
holds distance, moving time and heart rate for every activity, which makes this the
better record - and it reaches back as far as the Garmin import went.

    python tools/run_history.py                 last 26 weeks
    python tools/run_history.py --weeks 80      far enough back for a past peak
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tenk.config import Config                                  # noqa: E402
from tenk.intervals_icu import IntervalsClient, completions_by_date  # noqa: E402

RUN_TYPES = ("run", "trailrun", "virtualrun")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=None)
    parser.add_argument("--weeks", type=int, default=26)
    parser.add_argument("--all", action="store_true",
                        help="list every run, not just the weekly roll-up")
    args = parser.parse_args(argv)

    config = Config.load(args.config)
    settings = config.intervals
    client = IntervalsClient(
        athlete_id=str(settings.get("athlete_id", "")),
        api_key=None if settings.get("auth_via_proxy") else Config.secret("INTERVALS_ICU_API_KEY"),
        api_base=settings.get("api_base", "https://intervals.icu/api/v1"),
    )

    today = dt.date.today()
    start = today - dt.timedelta(weeks=args.weeks)
    # The events endpoint rejects very wide ranges; fetch activities in
    # 180-day slices so a long history does not come back empty.
    activities = []
    cursor = start
    while cursor <= today:
        chunk_end = min(cursor + dt.timedelta(days=180), today)
        activities.extend(client.activities(cursor, chunk_end))
        cursor = chunk_end + dt.timedelta(days=1)

    runs = [a for a in activities
            if str(a.get("type") or "").lower().replace(" ", "") in RUN_TYPES]
    print(f"{start} to {today}: {len(activities)} activities, {len(runs)} runs\n")
    if not runs:
        print("No runs in this window. If Garmin activity sync was only just "
              "enabled, the historical import may still be running.")
        return 0

    by_date = completions_by_date(runs)
    weekly = defaultdict(lambda: {"runs": 0, "km": 0.0, "secs": 0})
    longest = None
    for date, done in by_date.items():
        monday = date - dt.timedelta(days=date.weekday())
        for c in done:
            weekly[monday]["runs"] += 1
            weekly[monday]["km"] += c.distance_km
            weekly[monday]["secs"] += c.moving_time_s
            if longest is None or c.distance_km > longest[1]:
                longest = (date, c.distance_km)
            if args.all:
                print(f"  {date}  {c.distance_km:>6.2f} km  {c.pace_text:>8}  "
                      f"{(str(c.average_hr) + ' bpm') if c.average_hr else '':>8}  {c.name[:34]}")

    if args.all:
        print()
    print(f"{'week of':<12} {'runs':>5} {'km':>8} {'hours':>7}  {'':<24}")
    print("-" * 60)
    peak = max(weekly.values(), key=lambda b: b["km"]) if weekly else None
    for monday in sorted(weekly):
        b = weekly[monday]
        bar = "#" * int(round(b["km"] / 5.0))
        print(f"{monday.isoformat():<12} {b['runs']:>5} {b['km']:>8.1f} "
              f"{b['secs'] / 3600.0:>7.1f}  {bar}")

    weeks = sorted(weekly)
    recent = [weekly[m]["km"] for m in weeks[-6:]]
    print(f"\nlast 6 weeks   mean {sum(recent) / len(recent):.1f} km  "
          f"range {min(recent):.1f}-{max(recent):.1f}")
    if peak:
        print(f"peak week      {peak['km']:.1f} km over {peak['runs']} runs")
    if longest:
        print(f"longest run    {longest[1]:.2f} km on {longest[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
