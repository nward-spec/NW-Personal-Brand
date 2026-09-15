"""Durable state: the Whoop token, what the engine has already done, and why.

Every write is atomic (temp file, fsync, rename). The token store matters most:
Whoop rotates the refresh token on every exchange, so a half-written file is a
re-authorisation by hand.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional


def atomic_write_json(path: Path, payload: Mapping, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True, default=str)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


class TokenStore:
    """Whoop OAuth tokens on disk, 0600.

    The rotation rule is the whole point of this class: persist the new refresh
    token *before* the caller uses the new access token. Write then use, never
    use then write.
    """

    def __init__(self, path: Path):
        self.path = Path(path)

    def load(self) -> Dict[str, Any]:
        if not self.path.exists():
            return {}
        with open(self.path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def save(self, tokens: Mapping[str, Any]) -> Dict[str, Any]:
        payload = dict(tokens)
        payload["saved_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        atomic_write_json(self.path, payload)
        return payload

    @property
    def exists(self) -> bool:
        return self.path.exists()


class RunState:
    """What the engine has done: tiers, modifications, carried sessions.

    Keyed by plan week (``w07``) for the circuit breaker and by ISO date for
    everything else.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.data: Dict[str, Any] = {
            "tiers": {},
            "modifications": {},
            "carry_forward": {},
            "gym_flag": {},
            "wednesday_actual": {},
            "last_run": None,
        }
        if self.path.exists():
            with open(self.path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
            self.data.update(loaded)
            for key in ("tiers", "modifications", "carry_forward", "gym_flag", "wednesday_actual"):
                self.data.setdefault(key, {})

    # ------------------------------------------------------------------ tiers

    def record_tier(self, day: dt.date, tier: str) -> None:
        self.data["tiers"][day.isoformat()] = tier

    def tier_on(self, day: dt.date) -> Optional[str]:
        return self.data["tiers"].get(day.isoformat())

    def consecutive_reds(self, day: dt.date) -> int:
        """How many REDs in a row end on `day`, today included."""
        count = 0
        cursor = day
        while True:
            tier = self.data["tiers"].get(cursor.isoformat())
            if tier != "RED":
                break
            count += 1
            cursor -= dt.timedelta(days=1)
        return count

    # ---------------------------------------------------------- modifications

    def modifications(self, week_key: str) -> List[Dict[str, Any]]:
        return list(self.data["modifications"].get(week_key, []))

    def modification_count(self, week_key: str, *, exclude_date: Optional[dt.date] = None) -> int:
        entries = self.data["modifications"].get(week_key, [])
        if exclude_date is not None:
            stamp = exclude_date.isoformat()
            entries = [e for e in entries if e.get("date") != stamp]
        return len(entries)

    def record_modification(self, week_key: str, entry: Mapping[str, Any]) -> None:
        bucket = self.data["modifications"].setdefault(week_key, [])
        stamp = entry.get("date")
        bucket[:] = [e for e in bucket if e.get("date") != stamp]
        bucket.append(dict(entry))

    # ----------------------------------------------------------------- misc

    def set_carry_forward(self, day: dt.date, payload: Optional[Mapping[str, Any]]) -> None:
        key = day.isoformat()
        if payload is None:
            self.data["carry_forward"].pop(key, None)
        else:
            self.data["carry_forward"][key] = dict(payload)

    def carry_forward(self, day: dt.date) -> Optional[Dict[str, Any]]:
        return self.data["carry_forward"].get(day.isoformat())

    def set_gym_flag(self, day: dt.date, note: Optional[str]) -> None:
        key = day.isoformat()
        if note is None:
            self.data["gym_flag"].pop(key, None)
        else:
            self.data["gym_flag"][key] = note

    def gym_flag(self, day: dt.date) -> Optional[str]:
        return self.data["gym_flag"].get(day.isoformat())

    def set_actual(self, day: dt.date, km: float) -> None:
        self.data["wednesday_actual"][day.isoformat()] = round(float(km), 2)

    def actual(self, day: dt.date) -> Optional[float]:
        return self.data["wednesday_actual"].get(day.isoformat())

    def save(self) -> None:
        self.data["last_run"] = dt.datetime.now(dt.timezone.utc).isoformat()
        atomic_write_json(self.path, self.data, mode=0o644)
