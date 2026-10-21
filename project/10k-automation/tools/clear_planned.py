#!/usr/bin/env python3
"""Remove planned workouts this project put on intervals.icu.

Garmin caps how many workouts a watch will hold, and intervals.icu forwards
its calendar to the watch, so a wide push can overflow the device. This
deletes the planned events again, newest-first, and touches only events whose
external_id carries the project's prefix - never an activity, and never
anything another tool created.

It lists and exits unless you pass --confirm, because a delete has no undo.

    python tools/clear_planned.py                      what it would remove
    python tools/clear_planned.py --from 2026-11-01     only past that date
    python tools/clear_planned.py --confirm             actually remove them
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tenk.config import Config                      # noqa: E402
from tenk.intervals_icu import IntervalsClient      # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=None)
    parser.add_argument("--from", dest="start", default=None,
                        help="only events on or after this date (default: today)")
    parser.add_argument("--to", dest="end", default=None,
                        help="only events on or before this date (default: race day)")
    parser.add_argument("--confirm", action="store_true",
                        help="perform the deletion instead of listing it")
    args = parser.parse_args(argv)

    config = Config.load(args.config)
    settings = config.intervals
    prefix = str(settings.get("external_id_prefix", "10k"))
    client = IntervalsClient(
        athlete_id=str(settings.get("athlete_id", "")),
        api_key=None if settings.get("auth_via_proxy") else Config.secret("INTERVALS_ICU_API_KEY"),
        api_base=settings.get("api_base", "https://intervals.icu/api/v1"),
    )

    from tenk.plan import Plan
    plan = Plan.load(config.plan_file)

    start = dt.date.fromisoformat(args.start) if args.start else dt.date.today()
    # Bounded by race day rather than an arbitrary year ahead. A 400-day
    # range came back as something other than a list, which the client used
    # to swallow as an empty calendar.
    end = dt.date.fromisoformat(args.end) if args.end else plan.race_date

    events = client.events(start, end)
    ours = [
        e for e in events
        if str(e.get("external_id") or "").startswith(prefix + "-")
    ]
    if events and not ours:
        # The list endpoint may omit external_id. Say so instead of reporting
        # an empty result as though the calendar were clean.
        has_field = any("external_id" in e for e in events)
        print(f"{len(events)} events found, none carrying an '{prefix}-' external_id.")
        if not has_field:
            print("The events list does not include external_id at all, so this "
                  "tool cannot tell which events are ours. Nothing deleted.")
        return 1
    # Newest first: if the run is interrupted, the days closest to today -
    # the ones the watch actually needs - are the last to go.
    ours.sort(key=lambda e: str(e.get("start_date_local") or ""), reverse=True)

    skipped = len(events) - len(ours)
    print(f"{start} to {end}: {len(events)} events, {len(ours)} written by this project"
          + (f", {skipped} left alone" if skipped else ""))
    for e in ours:
        print(f"  {str(e.get('start_date_local'))[:10]}  {e.get('external_id')}  {e.get('name')}")

    if not ours:
        return 0
    if not args.confirm:
        print(f"\nNothing deleted. Re-run with --confirm to remove these {len(ours)}.")
        return 0

    gone = missing = 0
    for e in ours:
        if client.delete_event(e.get("id")):
            gone += 1
        else:
            missing += 1
    print(f"\ndeleted {gone}" + (f", {missing} were already gone" if missing else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
