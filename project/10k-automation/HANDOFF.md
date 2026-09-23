# Handoff: finish setting up the 10k automation locally

Read this, then do it. Everything here has been verified on CI; what remains
needs a browser and Nick's credentials, which is why it has to happen on his
machine.

## Where things are

- Repo: `~/NW-Personal-Brand` on the branch `claude/new-session-90lpm4`.
  This work is **not on `main`**. If `project/10k-automation` is missing, the
  clone is on the wrong branch: `git fetch origin && git checkout claude/new-session-90lpm4`.
- Package: `project/10k-automation`. Read its `README.md` for what the engine does.
- The machine is an **Intel** MacBook Pro running the Command Line Tools
  Python 3.9. Homebrew is not working: `.zprofile` line 4 points at
  `/opt/homebrew/bin/brew`, which does not exist on an Intel Mac. Do not
  assume `brew` is available.

## What is already proven, so don't re-litigate it

GitHub Actions run 35100569980 on commit `3bec9fc` passed all five jobs,
including `macos-15-intel` with Python 3.9.25 — the same architecture and
interpreter as this laptop. On that runner:

- `ops/setup.sh` ran as documented: `Ran 157 tests`, `OK`, then
  `13 scenario(s) run, 0 failed`.
- The same script ran again from an unrelated working directory and passed,
  confirming it locates itself.
- `requirements-calendar.txt` installed
  `cryptography-48.0.1-cp39-abi3-macosx_10_9_universal2.whl` — a wheel, not a
  source build. The `cryptography<49` marker in that file is what makes this
  work on Intel; from version 49 upstream ships arm64-only macOS wheels. Do
  not remove or loosen that ceiling.
- The engine dry ran end to end and printed the ten-day window.

So the code and the documented setup work on this architecture. If something
fails locally, it is local, and worth diagnosing rather than rewriting.

## Step 1: setup

```
~/NW-Personal-Brand/project/10k-automation/ops/setup.sh
```

The script resolves its own directory, creates or reuses `.venv`, installs
PyYAML and requests, runs the tests and the scenarios. Expect 127 tests and 13
scenarios. There may be a stray unused virtualenv at `~/.venv` from an earlier
mistake; `rm -rf ~/.venv` if you want it gone, it is not used by anything.

Two things that caused repeated failures earlier, worth avoiding:

- Interactive zsh does **not** treat `#` as starting a comment. Never put a
  trailing `#` comment on a command you ask Nick to paste.
- The virtualenv is at `project/10k-automation/.venv`, not the repo root.
  Chain multi-step commands with `&&` so a failed `cd` stops the rest.

## Step 2: credentials

```
cd ~/NW-Personal-Brand/project/10k-automation
cp config/config.example.yaml config/config.yaml
cp ops/secrets.env.example ops/secrets.env
chmod 600 ops/secrets.env
```

- `config/config.yaml`: set `intervals_icu.athlete_id` (it looks like `i12345`,
  visible in the intervals.icu URL when logged in).
- `ops/secrets.env`: `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` from a Whoop
  developer app with redirect URI `http://localhost:8723/callback` and scopes
  `read:recovery read:sleep read:cycles read:workout offline`;
  `INTERVALS_ICU_API_KEY` from intervals.icu Settings → Developer.
- Both files are gitignored. Never commit either, and never echo a key into
  the transcript.

Leave `google_calendar.enabled: false` until step 4.

## Step 3: authorise Whoop and dry run

```
cd ~/NW-Personal-Brand/project/10k-automation
source ops/secrets.env
.venv/bin/python -m tenk.cli authorize
.venv/bin/python -m tenk.cli run --dry-run --window
```

`authorize` opens a browser once and stores rotating tokens at
`state/whoop_tokens.json`, 0600. The dry run reads real Whoop recovery and
prints every write without executing one. Check the logged recovery score and
tier look right for how he actually feels today.

## Step 4: calendar, then go live

```
.venv/bin/pip install -r requirements-calendar.txt
```

Set `google_calendar.enabled: true` and point `client_secrets_file` at an OAuth
client secret JSON downloaded from Google Cloud (Desktop app credentials, with
the Calendar API enabled). Dry run again, then write for real once:

```
.venv/bin/python -m tenk.cli run
```

**Before trusting the Garmin push, check two things by eye.** The intervals.icu
workout text grammar came from a community syntax guide, not an official
specification: paste one generated description into the intervals.icu workout
builder and confirm it parses into the intended structure. And confirm the
first written event shows the right distance, since events are written in
metres.

Then install the schedule. The plist has hard-coded paths — edit them to match
this machine before loading:

```
cp ops/com.nickward.tenk.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nickward.tenk.plist
```

## Things not to do

- Do not modify the adjustment rules, the tier thresholds or the circuit
  breakers to make a test pass. They encode deliberate coaching decisions;
  `README.md` explains each one.
- Do not skip the dry run before the first real write.
- Do not merge to `main` without asking Nick first.
