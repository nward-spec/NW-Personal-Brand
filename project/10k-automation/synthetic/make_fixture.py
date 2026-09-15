"""Regenerate synthetic/whoop_sample.json.

Timestamps are built from *local* Melbourne mornings and converted to UTC,
which is how the real data behaves and the only way the weekday-sensitive
rules (gym days are Monday and Friday) line up.

    python3 synthetic/make_fixture.py
"""

from __future__ import annotations

import datetime as dt
import json
import random
from pathlib import Path
from zoneinfo import ZoneInfo

MELBOURNE = ZoneInfo("Australia/Melbourne")
TODAY = dt.date(2026, 10, 31)          # a Saturday, mid-block, after the AEDT change


def utc_stamp(day: dt.date, hour: int, minute: int) -> str:
    local = dt.datetime(day.year, day.month, day.day, hour, minute, tzinfo=MELBOURNE)
    return local.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def build() -> dict:
    random.seed(7)
    recoveries = []
    # Fourteen ordinary mornings, then a deliberately poor one today.
    for offset in range(14, 0, -1):
        day = TODAY - dt.timedelta(days=offset)
        stamp = utc_stamp(day, 6, 30)
        recoveries.append({
            "cycle_id": 1000 + offset,
            "sleep_id": f"00000000-0000-0000-0000-{offset:012d}",
            "user_id": 12345,
            "created_at": stamp,
            "updated_at": stamp,
            "score_state": "SCORED",
            "score": {
                "user_calibrating": False,
                "recovery_score": random.randint(62, 84),
                "resting_heart_rate": round(45 + random.uniform(-1.5, 1.5), 1),
                "hrv_rmssd_milli": round(61 + random.uniform(-6, 6), 1),
                "spo2_percentage": 96.5,
                "skin_temp_celsius": 33.2,
            },
        })

    today_stamp = utc_stamp(TODAY, 6, 30)
    recoveries.append({
        "cycle_id": 1015,
        "sleep_id": "00000000-0000-0000-0000-000000001015",
        "user_id": 12345,
        "created_at": today_stamp,
        "updated_at": today_stamp,
        "score_state": "SCORED",
        "score": {
            "user_calibrating": False,
            "recovery_score": 29,
            "resting_heart_rate": 52.0,
            "hrv_rmssd_milli": 41.3,
            "spo2_percentage": 95.8,
            "skin_temp_celsius": 33.9,
        },
    })
    # An unscored record. The engine must drop it, not guess around it.
    tomorrow_stamp = utc_stamp(TODAY + dt.timedelta(days=1), 6, 30)
    recoveries.append({
        "cycle_id": 1016,
        "sleep_id": "00000000-0000-0000-0000-000000001016",
        "user_id": 12345,
        "created_at": tomorrow_stamp,
        "updated_at": tomorrow_stamp,
        "score_state": "PENDING_SCORE",
        "score": None,
    })

    workouts = []
    day = TODAY - dt.timedelta(days=28)
    while day < TODAY:
        if day.weekday() in (0, 4):        # Monday and Friday gym
            start = utc_stamp(day, 6, 30)
            end = utc_stamp(day, 7, 20)
            workouts.append({
                "id": f"workout-{day.isoformat()}",
                "user_id": 12345,
                "start": start,
                "end": end,
                "timezone_offset": "+11:00",
                "sport_name": "weightlifting",
                "score_state": "SCORED",
                "score": {"strain": round(10.5 + random.uniform(-1, 1), 1),
                          "average_heart_rate": 118, "max_heart_rate": 152},
            })
        day += dt.timedelta(days=1)
    # The most recent gym day is heavy: the feed-forward note should fire.
    workouts[-1]["score"]["strain"] = 16.8

    return {
        "recovery": {"records": recoveries, "next_token": None},
        "workout": {"records": workouts, "next_token": None},
    }


if __name__ == "__main__":
    target = Path(__file__).resolve().parent / "whoop_sample.json"
    payload = build()
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {target} — {len(payload['recovery']['records'])} recoveries, "
          f"{len(payload['workout']['records'])} workouts")
