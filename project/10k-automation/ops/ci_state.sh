#!/usr/bin/env bash
# Carry the engine's state across stateless CI runs.
#
# A GitHub runner is destroyed after every job, so the Whoop refresh token, the
# run state and the decision log have to live in the repo between mornings.
# Everything in state/ is health data or a credential, which is why this repo
# is private - but a credential gets a second lock regardless, so the token is
# committed encrypted and never in the clear.
set -euo pipefail

STATE=state
TOKEN="$STATE/whoop_tokens.json"
SEALED="$TOKEN.enc"

die() { echo "ci_state: $*" >&2; exit 1; }

crypt() {   # crypt <-e|-d> <in> <out>
  [ -n "${STATE_KEY:-}" ] || die "STATE_KEY is not set; add it as a repository secret"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt "$1" \
    -pass env:STATE_KEY -in "$2" -out "$3"
}

case "${1:-}" in
  unseal)
    mkdir -p "$STATE"
    if [ -f "$SEALED" ]; then
      crypt -d "$SEALED" "$TOKEN"
      echo "ci_state: token unsealed"
    elif [ -n "${WHOOP_TOKEN_SEED:-}" ]; then
      # First run only. Paste the Mac's state/whoop_tokens.json into the
      # WHOOP_TOKEN_SEED secret once; from the next run the sealed copy in the
      # repo takes over and the seed can be deleted.
      printf '%s' "$WHOOP_TOKEN_SEED" > "$TOKEN"
      python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$TOKEN" \
        || die "WHOOP_TOKEN_SEED is not valid JSON"
      echo "ci_state: seeded from WHOOP_TOKEN_SEED"
    else
      die "no sealed token and no WHOOP_TOKEN_SEED; the engine cannot reach Whoop"
    fi
    ;;
  seal)
    # The run may have failed, but if it rotated the token first then this file
    # holds the only refresh token Whoop will still accept. Seal it anyway.
    if [ -f "$TOKEN" ]; then
      crypt -e "$TOKEN" "$SEALED"
      rm -f "$TOKEN"
      echo "ci_state: token sealed"
    else
      echo "ci_state: no token on disk to seal" >&2
    fi
    ;;
  *)
    die "usage: ci_state.sh unseal|seal"
    ;;
esac
