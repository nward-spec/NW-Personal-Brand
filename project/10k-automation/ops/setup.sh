#!/usr/bin/env bash
# One-shot setup and verification.
#
# Finds its own directory, so it works whatever your shell is currently in and
# there is no cd to get wrong:
#
#     ~/NW-Personal-Brand/project/10k-automation/ops/setup.sh
#
# Creates the virtualenv if it is missing, installs the core dependencies
# (PyYAML and requests, pure-Python wheels everywhere, nothing compiled), then
# runs the test suite and the scenarios. Needs no credentials and writes
# nothing outside this folder.
#
# The Google Calendar libraries are deliberately NOT installed here. See
# requirements-calendar.txt.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

echo "==> Project: $HERE"

PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "No '$PYTHON' on PATH. Install Python 3.9 or newer, or set PYTHON=/path/to/python3." >&2
  exit 1
fi

"$PYTHON" - <<'PYCHECK' || exit 1
import sys
if sys.version_info < (3, 9):
    sys.stderr.write(
        f"Python 3.9 or newer is needed; this is {sys.version.split()[0]}.\n"
    )
    raise SystemExit(1)
print(f"==> Interpreter: {sys.executable} ({sys.version.split()[0]})")
PYCHECK

if [[ ! -x .venv/bin/python ]]; then
  echo "==> Creating .venv"
  "$PYTHON" -m venv .venv
else
  echo "==> Reusing .venv"
fi

# Old pip ships with the system Python and mishandles some modern wheels.
# Worth upgrading, not worth failing over.
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || \
  echo "    (could not upgrade pip inside the venv; carrying on)"

echo "==> Installing core dependencies"
.venv/bin/python -m pip install --quiet -r requirements.txt

echo "==> Running the test suite"
.venv/bin/python -m unittest discover -s tests -t .

echo "==> Running the scenarios against synthetic Whoop data"
.venv/bin/python -m tenk.cli selftest

# Scaffold the two files that hold settings and secrets, so there is nothing to
# copy by hand. Existing files are never touched.
NEW_CONFIG=0
if [[ ! -f config/config.yaml ]]; then
  cp config/config.example.yaml config/config.yaml
  NEW_CONFIG=1
  echo "==> Created config/config.yaml"
fi
if [[ ! -f ops/secrets.env ]]; then
  cp ops/secrets.env.example ops/secrets.env
  chmod 600 ops/secrets.env
  NEW_CONFIG=1
  echo "==> Created ops/secrets.env (0600)"
fi

echo "==> Checking what is still missing"
set +e
.venv/bin/python -m tenk.cli check --offline
CHECK=$?
set -e

cat <<'DONE'

==> Setup finished. The tests and scenarios passed.

Fill in the two files the check above named, then:

    source ops/secrets.env
    .venv/bin/python -m tenk.cli check
    .venv/bin/python -m tenk.cli authorize
    .venv/bin/python -m tenk.cli check
    .venv/bin/python -m tenk.cli run --dry-run --window

`check` names anything still missing and what to do about it. The dry run
prints every write and executes none.
DONE

exit 0
