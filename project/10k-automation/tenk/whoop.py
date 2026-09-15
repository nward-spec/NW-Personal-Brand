"""Whoop API v2 client.

Verified against developer.whoop.com on 15 Sep 2026:

  authorize  https://api.prod.whoop.com/oauth/oauth2/auth
  token      https://api.prod.whoop.com/oauth/oauth2/token
  recovery   GET {base}/recovery       base = https://api.prod.whoop.com/developer/v2
  cycle      GET {base}/cycle
  workout    GET {base}/activity/workout
  paging     limit (max 25), start, end, nextToken

Refresh tokens are single use. Whoop's own documentation says the old refresh
token is invalidated the moment a new one is issued, so this client persists
the new token *before* returning the access token to the caller.

All endpoints are configurable because they are versioned and will move.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence

import requests

from .state import TokenStore
from .tiers import RecoveryRecord

log = logging.getLogger(__name__)

SCORED = "SCORED"


class WhoopError(RuntimeError):
    """Whoop could not be reached or refused us. Never fatal to a morning run."""


class WhoopAuthError(WhoopError):
    """The refresh token is gone or rejected. Needs a human and a browser."""


@dataclass
class WhoopWorkout:
    date: dt.date
    strain: Optional[float]
    sport_name: str
    start: dt.datetime
    raw: Mapping[str, Any]


class WhoopClient:
    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        token_store: TokenStore,
        api_base: str = "https://api.prod.whoop.com/developer/v2",
        token_url: str = "https://api.prod.whoop.com/oauth/oauth2/token",
        auth_url: str = "https://api.prod.whoop.com/oauth/oauth2/auth",
        scopes: Sequence[str] = (),
        timezone: Optional[dt.tzinfo] = None,
        session: Optional[requests.Session] = None,
        timeout: float = 20.0,
    ):
        self.client_id = client_id
        self.client_secret = client_secret
        self.tokens = token_store
        self.api_base = api_base.rstrip("/")
        self.token_url = token_url
        self.auth_url = auth_url
        self.scopes = list(scopes)
        self.tz = timezone or dt.timezone.utc
        self.session = session or requests.Session()
        self.timeout = timeout
        self._access_token: Optional[str] = None
        self._expires_at: float = 0.0

    # --------------------------------------------------------------- OAuth

    def authorize_url(self, state: str) -> str:
        from urllib.parse import urlencode

        query = urlencode({
            "client_id": self.client_id,
            "response_type": "code",
            "scope": " ".join(self.scopes),
            "state": state,
            "redirect_uri": self._redirect_uri,
        })
        return f"{self.auth_url}?{query}"

    _redirect_uri = ""

    def set_redirect_uri(self, uri: str) -> None:
        self._redirect_uri = uri

    def exchange_code(self, code: str) -> Dict[str, Any]:
        payload = {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uri": self._redirect_uri,
        }
        return self._token_request(payload)

    def refresh(self) -> str:
        stored = self.tokens.load()
        refresh_token = stored.get("refresh_token")
        if not refresh_token:
            raise WhoopAuthError(
                "No refresh token on disk. Run `python -m tenk.cli authorize` once, in a browser."
            )
        payload = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            # Whoop requires offline to be re-requested or it stops returning
            # a refresh token, which silently ends the automation.
            "scope": "offline",
        }
        tokens = self._token_request(payload)
        return tokens["access_token"]

    def _token_request(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        try:
            response = self.session.post(self.token_url, data=dict(payload), timeout=self.timeout)
        except requests.RequestException as exc:
            raise WhoopError(f"Whoop token endpoint unreachable: {exc}") from exc
        if response.status_code in (400, 401):
            raise WhoopAuthError(
                f"Whoop rejected the token request ({response.status_code}): {response.text[:300]}"
            )
        if response.status_code >= 400:
            raise WhoopError(f"Whoop token request failed ({response.status_code}): {response.text[:300]}")

        tokens = response.json()
        if "refresh_token" not in tokens:
            raise WhoopAuthError(
                "Whoop returned no refresh token. The offline scope was not granted; "
                "re-authorise before the stored token expires."
            )
        # Write then use. The old refresh token is already dead.
        self.tokens.save(tokens)
        self._access_token = tokens["access_token"]
        self._expires_at = time.time() + float(tokens.get("expires_in", 3600)) - 60
        log.info("whoop token refreshed; new refresh token persisted")
        return tokens

    def _bearer(self) -> str:
        if self._access_token and time.time() < self._expires_at:
            return self._access_token
        return self.refresh()

    # ----------------------------------------------------------------- HTTP

    def _get_collection(
        self,
        path: str,
        start: dt.datetime,
        end: dt.datetime,
        *,
        limit: int = 25,
        max_pages: int = 20,
    ) -> Iterator[Mapping[str, Any]]:
        url = f"{self.api_base}/{path.lstrip('/')}"
        params: Dict[str, Any] = {
            "start": _iso_z(start),
            "end": _iso_z(end),
            "limit": min(int(limit), 25),
        }
        pages = 0
        while True:
            headers = {"Authorization": f"Bearer {self._bearer()}"}
            try:
                response = self.session.get(url, params=params, headers=headers, timeout=self.timeout)
            except requests.RequestException as exc:
                raise WhoopError(f"Whoop {path} unreachable: {exc}") from exc
            if response.status_code == 401:
                # Access token died mid-window. One forced refresh, then give up.
                self._access_token = None
                headers = {"Authorization": f"Bearer {self.refresh()}"}
                response = self.session.get(url, params=params, headers=headers, timeout=self.timeout)
            if response.status_code == 429:
                raise WhoopError("Whoop rate limited this run; today proceeds unadjusted.")
            if response.status_code >= 400:
                raise WhoopError(f"Whoop {path} failed ({response.status_code}): {response.text[:300]}")

            body = response.json()
            for record in body.get("records", []):
                yield record
            next_token = body.get("next_token") or body.get("nextToken")
            pages += 1
            if not next_token or pages >= max_pages:
                return
            params["nextToken"] = next_token

    # ------------------------------------------------------------- readings

    def recoveries(self, today: dt.date, days: int = 21) -> List[RecoveryRecord]:
        start = _local_midnight(today - dt.timedelta(days=days), self.tz)
        end = _local_midnight(today + dt.timedelta(days=1), self.tz)
        records: Dict[dt.date, RecoveryRecord] = {}
        for raw in self._get_collection("recovery", start, end):
            if raw.get("score_state") != SCORED:
                log.info("skipping recovery %s: score_state=%s", raw.get("cycle_id"), raw.get("score_state"))
                continue
            score = raw.get("score") or {}
            stamp = _parse_ts(raw.get("created_at"))
            if stamp is None:
                continue
            local_date = stamp.astimezone(self.tz).date()
            if None in (score.get("recovery_score"), score.get("hrv_rmssd_milli"), score.get("resting_heart_rate")):
                log.info("skipping recovery on %s: incomplete score object", local_date)
                continue
            record = RecoveryRecord(
                date=local_date,
                recovery_score=float(score["recovery_score"]),
                hrv_rmssd_milli=float(score["hrv_rmssd_milli"]),
                resting_heart_rate=float(score["resting_heart_rate"]),
                user_calibrating=bool(score.get("user_calibrating", False)),
            )
            # Whoop can restate a day; the newest record for a date wins.
            records[local_date] = record
        return sorted(records.values(), key=lambda r: r.date)

    def workouts(self, today: dt.date, days: int = 42) -> List[WhoopWorkout]:
        start = _local_midnight(today - dt.timedelta(days=days), self.tz)
        end = _local_midnight(today + dt.timedelta(days=1), self.tz)
        out: List[WhoopWorkout] = []
        for raw in self._get_collection("activity/workout", start, end):
            if raw.get("score_state") != SCORED:
                continue
            stamp = _parse_ts(raw.get("start"))
            if stamp is None:
                continue
            local = stamp.astimezone(self.tz)
            score = raw.get("score") or {}
            out.append(WhoopWorkout(
                date=local.date(),
                strain=_maybe_float(score.get("strain")),
                sport_name=str(raw.get("sport_name") or raw.get("sport_id") or ""),
                start=local,
                raw=raw,
            ))
        return sorted(out, key=lambda w: w.start)

    def cycles(self, today: dt.date, days: int = 21) -> List[Mapping[str, Any]]:
        start = _local_midnight(today - dt.timedelta(days=days), self.tz)
        end = _local_midnight(today + dt.timedelta(days=1), self.tz)
        return [r for r in self._get_collection("cycle", start, end) if r.get("score_state") == SCORED]


def _iso_z(stamp: dt.datetime) -> str:
    return stamp.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _local_midnight(day: dt.date, tz: dt.tzinfo) -> dt.datetime:
    return dt.datetime(day.year, day.month, day.day, tzinfo=tz)


def _parse_ts(value: Optional[str]) -> Optional[dt.datetime]:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        stamp = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=dt.timezone.utc)
    return stamp


def _maybe_float(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
