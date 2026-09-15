"""The rotating refresh token is the single most likely way this breaks."""

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from tenk.state import TokenStore
from tenk.tiers import RecoveryRecord
from tenk.whoop import WhoopAuthError, WhoopClient, WhoopError


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, token_payloads=None, get_payloads=None):
        self.token_payloads = list(token_payloads or [])
        self.get_payloads = list(get_payloads or [])
        self.posts = []
        self.gets = []

    def post(self, url, data=None, timeout=None, **kwargs):
        self.posts.append({"url": url, "data": dict(data or {})})
        payload = self.token_payloads.pop(0)
        if isinstance(payload, Exception):
            raise payload
        return FakeResponse(payload[0], payload[1]) if isinstance(payload, tuple) else FakeResponse(payload)

    def get(self, url, params=None, headers=None, timeout=None, **kwargs):
        self.gets.append({"url": url, "params": dict(params or {}), "headers": dict(headers or {})})
        payload = self.get_payloads.pop(0)
        return FakeResponse(payload[0], payload[1]) if isinstance(payload, tuple) else FakeResponse(payload)


def client(tmp, session, seed_refresh="refresh-1"):
    store = TokenStore(Path(tmp) / "tokens.json")
    if seed_refresh:
        store.save({"access_token": "access-0", "refresh_token": seed_refresh})
    return WhoopClient(
        client_id="id", client_secret="secret", token_store=store,
        session=session, timezone=dt.timezone.utc,
    ), store


class RotationTests(unittest.TestCase):
    def test_new_refresh_token_is_persisted_before_the_access_token_is_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = FakeSession(
                token_payloads=[{"access_token": "access-1", "refresh_token": "refresh-2", "expires_in": 3600}],
                get_payloads=[{"records": []}],
            )
            whoop, store = client(tmp, session)
            list(whoop.recoveries(dt.date(2026, 10, 31)))
            # The token on disk is the new one, written before the GET went out.
            self.assertEqual(store.load()["refresh_token"], "refresh-2")
            self.assertEqual(session.posts[0]["data"]["refresh_token"], "refresh-1")
            self.assertEqual(session.gets[0]["headers"]["Authorization"], "Bearer access-1")

    def test_offline_scope_is_requested_on_every_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = FakeSession(
                token_payloads=[{"access_token": "a", "refresh_token": "b", "expires_in": 3600}],
                get_payloads=[{"records": []}],
            )
            whoop, _ = client(tmp, session)
            whoop.recoveries(dt.date(2026, 10, 31))
            self.assertEqual(session.posts[0]["data"]["scope"], "offline")

    def test_a_response_without_a_refresh_token_is_refused_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = FakeSession(token_payloads=[{"access_token": "a", "expires_in": 3600}])
            whoop, store = client(tmp, session)
            with self.assertRaises(WhoopAuthError):
                whoop.refresh()
            self.assertEqual(store.load()["refresh_token"], "refresh-1")

    def test_missing_token_file_is_a_clear_instruction(self):
        with tempfile.TemporaryDirectory() as tmp:
            whoop, _ = client(tmp, FakeSession(), seed_refresh=None)
            with self.assertRaises(WhoopAuthError) as ctx:
                whoop.refresh()
            self.assertIn("authorize", str(ctx.exception))

    def test_access_token_is_reused_within_its_lifetime(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = FakeSession(
                token_payloads=[{"access_token": "a", "refresh_token": "b", "expires_in": 3600}],
                get_payloads=[{"records": []}, {"records": []}],
            )
            whoop, _ = client(tmp, session)
            whoop.recoveries(dt.date(2026, 10, 31))
            whoop.workouts(dt.date(2026, 10, 31))
            self.assertEqual(len(session.posts), 1)   # one refresh, not two


class ReadTests(unittest.TestCase):
    def payload(self, **overrides):
        record = {
            "cycle_id": 1, "created_at": "2026-10-31T19:30:00.000Z", "score_state": "SCORED",
            "score": {"recovery_score": 48, "hrv_rmssd_milli": 55.2,
                      "resting_heart_rate": 48, "user_calibrating": False},
        }
        record.update(overrides)
        return record

    def whoop(self, tmp, records, tz=dt.timezone.utc):
        session = FakeSession(
            token_payloads=[{"access_token": "a", "refresh_token": "b", "expires_in": 3600}],
            get_payloads=[{"records": records}],
        )
        store = TokenStore(Path(tmp) / "t.json")
        store.save({"refresh_token": "r"})
        return WhoopClient(client_id="i", client_secret="s", token_store=store,
                           session=session, timezone=tz), session

    def test_unscored_records_are_never_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            whoop, _ = self.whoop(tmp, [
                self.payload(score_state="PENDING_SCORE"),
                self.payload(score_state="UNSCORABLE"),
            ])
            self.assertEqual(whoop.recoveries(dt.date(2026, 11, 1)), [])

    def test_incomplete_scores_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            whoop, _ = self.whoop(tmp, [self.payload(score={"recovery_score": 48})])
            self.assertEqual(whoop.recoveries(dt.date(2026, 11, 1)), [])

    def test_records_are_attributed_to_the_local_date(self):
        from zoneinfo import ZoneInfo

        with tempfile.TemporaryDirectory() as tmp:
            melbourne = ZoneInfo("Australia/Melbourne")
            whoop, _ = self.whoop(tmp, [self.payload()], tz=melbourne)
            records = whoop.recoveries(dt.date(2026, 11, 1))
            # 19:30 UTC on 31 Oct is 06:30 on 1 Nov in Melbourne (AEDT).
            self.assertEqual(records[0].date, dt.date(2026, 11, 1))

    def test_the_newest_record_for_a_date_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            whoop, _ = self.whoop(tmp, [
                self.payload(score={"recovery_score": 30, "hrv_rmssd_milli": 40,
                                    "resting_heart_rate": 50}),
                self.payload(score={"recovery_score": 62, "hrv_rmssd_milli": 58,
                                    "resting_heart_rate": 47}),
            ])
            records = whoop.recoveries(dt.date(2026, 11, 1))
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0].recovery_score, 62)

    def test_rate_limiting_is_reported_not_retried_forever(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = FakeSession(
                token_payloads=[{"access_token": "a", "refresh_token": "b", "expires_in": 3600}],
                get_payloads=[({"error": "too many"}, 429)],
            )
            store = TokenStore(Path(tmp) / "t.json")
            store.save({"refresh_token": "r"})
            whoop = WhoopClient(client_id="i", client_secret="s", token_store=store,
                                session=session, timezone=dt.timezone.utc)
            with self.assertRaises(WhoopError):
                whoop.recoveries(dt.date(2026, 11, 1))

    def test_paging_follows_next_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = FakeSession(
                token_payloads=[{"access_token": "a", "refresh_token": "b", "expires_in": 3600}],
                get_payloads=[
                    {"records": [self.payload()], "next_token": "page-2"},
                    {"records": [self.payload(created_at="2026-10-30T19:30:00.000Z")]},
                ],
            )
            store = TokenStore(Path(tmp) / "t.json")
            store.save({"refresh_token": "r"})
            whoop = WhoopClient(client_id="i", client_secret="s", token_store=store,
                                session=session, timezone=dt.timezone.utc)
            records = whoop.recoveries(dt.date(2026, 11, 1))
            self.assertEqual(len(records), 2)
            self.assertEqual(session.gets[1]["params"]["nextToken"], "page-2")


if __name__ == "__main__":
    unittest.main()
