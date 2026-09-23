# 10k PB automation

A daily Python job for the 2XU Wellness Run 10k, St Kilda, **Sunday 22 November
2026**. Goal 37:00, stretch 36:30.

Every morning at 05:00 Melbourne time it reads Whoop recovery, decides whether
the day's prescribed session stands, writes it to intervals.icu (which pushes
to the Garmin), and mirrors it to Google Calendar with a plain-language
explanation of anything it changed. Once Garmin syncs the finished run back, the
calendar entry gets a ✅ and the actual numbers.

The plan lives in `config/plan.yaml`. It is data, not code, and it is meant to
be hand-edited.

---

## The one thing to know

`paces.goal_pace.range` in `config/plan.yaml` is the single variable the block
turns on. The parkrun time trial in week 4 recalibrates it, and 5k pace,
threshold, strides and the long-run progression all follow from that one line.
Nothing else needs touching.

```yaml
paces:
  goal_pace:
    range: "3:40-3:45"     # edit this after the time trial. That is the whole job.
```

## Setup

Needs Python 3.9 or newer. The system `python3` on a current macOS is 3.9 and is
enough — verified against 3.9 and 3.11.

Every command below runs from `project/10k-automation` inside a clone of this
repository, on the branch that carries it. Two things about pasting them into
zsh: no line has a trailing `#` comment, because interactive zsh passes `#`
through as an argument rather than starting a comment, and each block is chained
with `&&` so a failed step stops the rest instead of letting them run in the
wrong directory.

This lives on the branch `claude/new-session-90lpm4`, not on `main`. In an
existing clone:

```bash
cd ~/NW-Personal-Brand && git fetch origin && git checkout claude/new-session-90lpm4
```

Without a clone yet:

```bash
git clone https://github.com/nward-spec/NW-Personal-Brand.git ~/NW-Personal-Brand && cd ~/NW-Personal-Brand && git checkout claude/new-session-90lpm4
```

Then run the setup script. It finds its own directory, so it works from
wherever your shell happens to be, and it creates the virtualenv, installs the
core dependencies, runs the test suite and runs the scenarios:

```bash
~/NW-Personal-Brand/project/10k-automation/ops/setup.sh
```

Expect 164 tests passing, then 13 scenarios and 0 failures. Nothing it installs
is compiled, and it needs no credentials.

The Google Calendar libraries are a separate install, because they are the only
heavy thing here. Leave them until you actually want the calendar mirror; with
`google_calendar.enabled: false` in `config.yaml` everything else runs without
them:

```bash
cd ~/NW-Personal-Brand/project/10k-automation && .venv/bin/pip install -r requirements-calendar.txt
```

If that fails trying to compile `cryptography`, your pip is ignoring the
version ceiling in that file. From version 49, `cryptography` publishes macOS
wheels for Apple Silicon only, so an Intel Mac has to build it from source and
needs a Rust toolchain and OpenSSL headers. The ceiling picks 48.0.1, the
newest release with a universal2 wheel built for Python 3.9. Force it by hand
with `.venv/bin/pip install "cryptography<49"` before installing the rest.

## Connecting the accounts

Three things live outside this repo and only you can set them up.

**1. intervals.icu to Garmin.** On intervals.icu open Settings and tick
**Upload planned workouts**, then approve the Garmin permission screen. Without
this nothing reaches the watch, however well everything else works. A workout on
the calendar for today or tomorrow uploads automatically, and the Forerunner 965
accepts structured workouts. `tenk check` reports this as the `garmin` line, read
from `garmin_training_connected` on the intervals.icu API.

**2. intervals.icu API key.** Settings, then Developer Settings. Put it in
`ops/secrets.env` as `INTERVALS_ICU_API_KEY`, and put your athlete id (the
`i#####` in the intervals.icu URL) in `config/config.yaml`.

**3. Whoop app.** At `developer-dashboard.whoop.com`, create a team if you have
none, then an app. Set the redirect URI to `http://localhost:8723/callback` and
request the scopes `read:recovery read:sleep read:cycles read:workout offline`.
The client id and secret appear after creation; put both in `ops/secrets.env`.

Google Calendar is optional and off by default. Turn it on once you have
installed `requirements-calendar.txt` and downloaded a Desktop app OAuth client
from Google Cloud with the Calendar API enabled.

Then, from `project/10k-automation`:

```bash
source ops/secrets.env
.venv/bin/python -m tenk.cli check
.venv/bin/python -m tenk.cli authorize
.venv/bin/python -m tenk.cli check
.venv/bin/python -m tenk.cli run --dry-run --window
```

`check` names anything still missing and the fix for it, and never prints a
secret. When it is clean and the dry run looks right:

```bash
.venv/bin/python -m tenk.cli run
```

## Commands

| Command | What it does |
|---|---|
| `python -m tenk.cli run` | The morning job |
| `python -m tenk.cli run --dry-run --window` | Same, executing nothing, printing the rolling window |
| `python -m tenk.cli run --date 2026-10-31` | Pretend it is another day |
| `python -m tenk.cli show --week 7` | Print a week as it currently stands |
| `python -m tenk.cli selftest` | 13 scenarios against synthetic Whoop data |
| `python -m tenk.cli summary` | Build and deliver the Sunday Slack summary |
| `python -m tenk.cli authorize` | One-time Whoop OAuth |
| `ops/setup.sh` | Create the venv, install, test, scaffold config, report what is missing |
| `python -m tenk.cli check` | Verify every connection and name anything missing |
| `python -m unittest discover -s tests -t .` | The test suite (164 tests) |

## How the morning works

1. **Read Whoop.** Recovery, HRV and resting HR, plus gym strain. Records
   without `score_state == "SCORED"` are dropped, never interpolated.
2. **Classify the day.** Green, amber or red, from the rules below.
3. **Adjust.** The engine can only take things away. There are no upgrades.
4. **Write intervals.icu.** A rolling ten-day window, upserted on a
   deterministic `external_id` so re-runs overwrite rather than duplicate.
5. **Mirror to the calendar.** One all-day event per training day, carrying the
   tier, the reasoning, and what the session originally was.
6. **Write back completions.** Days Garmin has already synced get a ✅ and the
   actual distance, pace and average heart rate.

If Whoop is unreachable the day is still written. The adjustment is an
enhancement, not a dependency.

### Tiers

| Tier | Condition |
|---|---|
| GREEN | Recovery ≥ 67%, or ≥ 50% with HRV at or above baseline |
| AMBER | Recovery 34–66% |
| RED | Recovery ≤ 33% |

Baseline is a rolling 14-day mean of HRV (RMSSD) and resting HR that **excludes
the last 24 hours** — a baseline containing this morning cannot tell you this
morning is unusual.

**Downgrade override.** If the 3-day rolling HRV is below baseline minus one
standard deviation **and** resting HR is more than 5 bpm over baseline, the day
drops one tier. Both conditions. Never either.

### What each tier does

**GREEN** — run what is written.

**AMBER**
- Quality: reps cut 25%, rounded down. **Pace target unchanged.** A slowed
  quality session is grey-zone work: it costs the recovery without buying the
  adaptation.
- Long run: unchanged.
- Easy runs: unchanged, because the heart-rate cap already self-regulates.
- Doubles: the PM run goes.

**RED**
- Quality becomes easy Z2 of the same duration.
- Long run drops to 70% of the prescribed distance, progression finish removed.
- Doubles: the PM run goes.

**Two consecutive REDs** — full rest, flagged loudly. The missed quality or long
run is carried onto the next easy day rather than skipped; the easy run it
displaces is the volume that comes off.

### Circuit breakers

- **Two automatic modifications per plan week.** A third still fires, but every
  modification that week is flagged for review. Repeated downgrades mean the
  plan is wrong, not the athlete.
- **Wednesday is never modified.** Run club cannot be prescribed. On a red
  Wednesday the engine writes a note instead: *sit in the back group, cap Z3.*
- **Race week ignores AMBER.** Taper reliably produces poor recovery scores.
  Only red modifies anything, and never race day.
- **Race day is never modified.**

### Gym feed-forward

Monday and Friday gym strain is compared to a rolling gym-day baseline. More
than 20% over, and the next day's session carries a note: *hold the HR cap hard,
ignore pace entirely.* No structural change, just the flag.

## Wednesday reconciliation

Run club is written to intervals.icu as a **duration placeholder** — no
structure, no pace targets. Garmin syncs the completed run back, and Thursday
morning the engine reads what was actually run and rebalances the rest of the
week to the volume target.

A short Wednesday is not a missed session. Being late and doing fewer reps than
the group just moves kilometres to Thursday.

The allocator pins Saturday quality and the Sunday long run: they are structural
and never flex to chase a volume number. The easy days absorb the difference,
Thursday first. If no easy day is left, the long run moves by up to 2 km and the
engine says so in the day's notes.

## Structural rules the engine will not break

- Run days are Tuesday, Wednesday, Thursday, Saturday, Sunday. Never add or
  remove a day.
- No run under 5 km. A day stays a single run until it needs more than 12 km,
  then splits, and the second run is always Z1.
- Long run capped at 20 km.
- To cut volume, drop a double. Never drop a day.
- Easy running is governed by heart rate; no pace target is ever written on an
  easy run. Quality is governed by pace; heart rate is a readout only.

## When it runs, and why more than once

Whoop does not score a night until you wake, so a single 05:00 run usually
finds no recovery and falls back to green. The job therefore fires nine times:
05:00, then every half hour to 08:00, then 09:00 and 10:00. The first exists
for Wednesday, so the session reaches the watch before run club at 05:50. The
rest catch the recovery score whenever it lands and rewrite the day with the
right tier. The last is 10:00, past the latest wake time this plan assumes.

Running repeatedly is safe by construction:

- intervals.icu events upsert on their `external_id`, so a re-run overwrites
  rather than duplicates.
- A modification is recorded against its date, so the two-a-week circuit
  breaker does not count the same day five times.
- **A session already logged as completed is never rewritten.** If you run at
  07:00 and an amber score arrives at 09:30, the engine leaves the finished
  session exactly as you ran it.

The Sunday summary is sent only on the 10:00 firing, so it arrives once.

## Logs and state

Everything lands in `state/` (gitignored):

| File | What it holds |
|---|---|
| `decisions.jsonl` | One line per morning: recovery, HRV, baseline, SD, resting HR, tier, reasoning |
| `run_state.json` | Tier history, modifications per week, carried-forward sessions |
| `whoop_tokens.json` | OAuth tokens, 0600, written atomically |
| `engine.log`, `cron.log` | Human-readable run logs |
| `outbox/` | Slack summaries that could not be delivered |

## The Sunday summary

Sunday evening the engine builds a planned-versus-actual summary — volume,
session completion, tier distribution — and sends it to Slack through the
Ernest Ops email relay, which is what makes it reach a phone. More than two
downgraded days in a week gets a siren in the message.

Without SMTP configured the message is written to `state/outbox/` and reported
as undelivered. It is never silently dropped.

## What was verified, and what to re-check

Checked against live documentation on 15 September 2026:

- **Whoop OAuth** — authorize `https://api.prod.whoop.com/oauth/oauth2/auth`,
  token `https://api.prod.whoop.com/oauth/oauth2/token`. Whoop's own docs state
  that using a refresh token invalidates it, so the client persists the new
  token *before* using the access token it came with. Write then use.
- **Whoop v2 endpoints** — `https://api.prod.whoop.com/developer/v2/recovery`,
  `/cycle`, `/activity/workout`. Paging via `limit` (max 25), `start`, `end`,
  `nextToken`. Recovery score fields: `recovery_score`, `hrv_rmssd_milli`,
  `resting_heart_rate`, `user_calibrating`.
- **intervals.icu** — verified against the published OpenAPI document at
  `https://intervals.icu/api/v1/docs`: `POST /api/v1/athlete/{id}/events/bulk`
  with `upsert`, and the event fields used here (`start_date_local`, `category`,
  `type`, `name`, `description`, `external_id`, `moving_time`, `distance`).

Two things worth confirming on the first live run rather than trusting:

1. **The workout-builder text grammar.** The syntax used here (`- 3km Z2 HR`,
   `4x` blocks, `3:40/km-3:45/km Pace`) comes from the intervals.icu community
   syntax guide, not from an official specification. Run `--dry-run`, paste one
   description into the intervals.icu workout builder, and check it parses into
   the structure you expect before trusting the Garmin push.
2. **Event distance units.** Distances are written in metres, matching how
   intervals.icu stores activity distance. Check the first written event shows
   the right number of kilometres.

Whoop's gym-session matching uses `sport_name`, which I could not confirm is
populated on every v2 workout record. When it is missing, any workout on a
Monday or Friday counts as gym. Adjust `whoop.gym.sport_names` in the config
once you have seen real records.

## Layout

```
config/plan.yaml            the block: weeks, sessions, paces. Hand-edit this.
config/config.example.yaml  runtime settings; secrets come from the environment
tenk/paces.py               pace bands, goal-pace derivation
tenk/plan.py                plan model, weekly volume allocation, doubles
tenk/workout.py             workout structure, estimates, intervals.icu text
tenk/tiers.py               recovery classification and the downgrade override
tenk/adjust.py              the adjustment engine and the circuit breakers
tenk/whoop.py               Whoop v2 client, rotating refresh tokens
tenk/intervals_icu.py       bulk event upsert, completion read-back
tenk/gcal.py                calendar mirror and ✅ write-back
tenk/summary.py             Sunday Slack summary via the Ernest Ops relay
tenk/engine.py              the morning run, start to finish
tenk/selftest.py            13 scenarios against synthetic Whoop data
tenk/doctor.py              the check command: verifies every connection
tenk/status.py              the daily status file the mobile dashboard reads
requirements.txt            core dependencies: PyYAML and requests, nothing compiled
requirements-calendar.txt   the Google Calendar libraries, installed separately
ops/setup.sh                one-shot setup and verification, run it from anywhere
ops/                        launchd job, crontab, secrets template
synthetic/                  synthetic Whoop payloads and their generator
tests/                      164 tests, standard library only
```
