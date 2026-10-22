# Moving the engine off the MacBook

The engine ran under `launchd` on the MacBook. `launchd` only fires while the
machine is awake, and the machine is usually asleep at 5am, so mornings were
silently skipped: on 23 Oct the last write was 06:04 and the 06:30 run never
happened. A missed morning is not cosmetic. The day goes out unadjusted and
the watch gets a session the recovery data would have changed.

GitHub Actions runs on GitHub's clock instead. Nothing has to be awake.

## What changes

| | Before | After |
|---|---|---|
| Trigger | `launchd`, 05:00-10:00, only while awake | Actions cron, every 30 min 18:00-23:00 UTC |
| Secrets | `ops/secrets.env` on the Mac | Repository secrets |
| State | `state/` on the Mac | `state/` committed to this repo, token encrypted |
| Status file | copied to a synced Drive folder | `state/dashboard-status.json` in this repo |
| Calendar | Google OAuth on the Mac | off; the calendar is updated separately |

## Why this repo is private

`state/` holds recovery scores, HRV and resting heart rate. That is health
data and it is never going in a public repo. The Whoop refresh token gets a
second lock on top: `ops/ci_state.sh` encrypts it with `STATE_KEY` before it is
committed, so the repo alone is not enough to use it.

`.gitignore` still ignores `state/` entirely. CI force-adds the four files it
means to publish. A run on a laptop therefore still cannot commit health data
by accident, which is the behaviour worth keeping.

## Secrets to add

Settings -> Secrets and variables -> Actions -> New repository secret.

| Secret | Where it comes from |
|---|---|
| `WHOOP_CLIENT_ID` | `ops/secrets.env` on the Mac |
| `WHOOP_CLIENT_SECRET` | same |
| `INTERVALS_ICU_API_KEY` | same |
| `INTERVALS_ICU_ATHLETE_ID` | `config/config.yaml` on the Mac |
| `STATE_KEY` | invent one: `openssl rand -base64 32` |
| `WHOOP_TOKEN_SEED` | the whole contents of `state/whoop_tokens.json` |

`WHOOP_TOKEN_SEED` is needed once. Whoop's refresh tokens are single-use and
rotate on every call, so the engine cannot start from nothing; it needs the
token the Mac currently holds. After the first green run, the sealed copy in
`state/` takes over and the seed secret can be deleted.

This is the last thing the MacBook is needed for.

## First run

Actions -> Morning engine -> Run workflow, with **dry run** ticked. It will
classify the day and print every write without sending one. When that is
green, run it again unticked.

## Known limits

- Actions cron is best effort. GitHub delays scheduled runs under load,
  sometimes by several minutes. Eight attempts a morning covers it.
- Runs are serialised (`concurrency`). Two overlapping runs would spend the
  same single-use refresh token twice and lock the engine out of Whoop until
  it was re-authorised by hand.
- The cron hours assume AEDT (UTC+11). The block ends 22 Nov 2026, which is
  inside daylight saving. Reusing this outside it means shifting by an hour.
