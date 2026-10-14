#!/usr/bin/env bash
#
# Run what CI runs, here, before you push.
#
# The coverage gate was red on `master` for four days and nobody saw it, because CI triggers on
# push and 87 commits had never been pushed. Every gate this repository owns was working; none of
# them had been asked. So the gate is not the control — running it is, and this is the thing that
# runs it.
#
#   tools/run-ci.sh              every job, in CI's order
#   tools/run-ci.sh contracts    one job: contracts | sdk | app
#
# On a clean full run it writes `.ci-local-pass` holding the commit it passed at. `.githooks/
# pre-push` reads that file and refuses a push the stamp does not cover, so "CI passed on this
# tree" is a fact somebody can check rather than a thing somebody remembers.
#
# The step list below is the same list as `.github/workflows/ci.yml`, and
# `tools/check-ci-parity.py` fails the build if the two ever disagree. A second copy of anything
# in this repository has a checker, because every second copy here has gone stale at least once.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WANT="${1:-all}"

# job|working directory, relative to the repository root|command
#
# `uses:` steps are missing on purpose: `actions/checkout`, `setup-node` and
# `foundry-rs/foundry-toolchain` set up a runner, and this machine is already set up. The parity
# checker knows to skip them and fails if it meets a `uses:` it does not recognise.
STEPS=(
  "contracts|contracts|forge fmt --check"
  "contracts|contracts|forge build --sizes"
  "contracts|contracts|forge lint"
  "contracts|contracts|FOUNDRY_PROFILE=fork python3 tools/count-429.py --upstream https://one.valve.city/rpc/evm/369 --max-pct 10 -- forge test --match-path 'test/Fork*.t.sol' -vv -j 1 --compute-units-per-second 165"
  "contracts|contracts|forge test -vv"
  "contracts|contracts|python3 tools/coverage-gate.py"
  "contracts|contracts|python3 tools/src-fingerprint.py"
  "contracts|contracts|python3 tools/check-citations.py"
  "contracts|.|python3 tools/check-tree-pin.py"
  "contracts|.|python3 tools/check-ci-parity.py"
  "contracts|contracts|python3 tools/src-fingerprint.py --compare"
  "contracts|contracts|forge test --match-path test/Gas.t.sol -vv"
  "contracts|.|node app/scripts/gen-gas.mjs --check"
  "contracts|contracts|python3 tools/check-gas-figures.py"
  "contracts|contracts|bash abi/export.sh --check"
  "contracts|.|git diff --exit-code app/src/lib/__fixtures__/"

  "sdk|contracts|forge build"
  "sdk|sdk|npm ci"
  "sdk|sdk|npm run check:abi"
  "sdk|sdk|npm run lint"
  "sdk|sdk|npm run typecheck"
  "sdk|sdk|npm run build"
  "sdk|sdk|npm test"

  "app|.|python3 tools/check-typescript-match.py"
  "app|contracts|forge build"
  "app|sdk|npm ci"
  "app|sdk|npm run build"
  "app|app|npm ci"
  "app|app|npm run lint"
  "app|app|npx tsc -b"
  "app|app|npx tsc -p scripts/tsconfig.json"
  "app|.|python3 tools/check-redact.py"
  "app|app|npm test"
  "app|app|npm run check:addresses"
  "app|app|npm run check:fee-configs"
  "app|app|npm run build"
)

failed=0
declare -a RESULTS=()

for entry in "${STEPS[@]}"; do
  job="${entry%%|*}"
  rest="${entry#*|}"
  dir="${rest%%|*}"
  cmd="${rest#*|}"
  [ "$WANT" = all ] || [ "$WANT" = "$job" ] || continue

  printf '\n\033[1m── %s: %s\033[0m  (in %s)\n' "$job" "$cmd" "$dir"
  if ( cd "$ROOT/$dir" && eval "$cmd" ); then
    RESULTS+=("PASS  $job  $cmd")
  else
    RESULTS+=("FAIL  $job  $cmd")
    failed=1
  fi
done

printf '\n\033[1m── summary\033[0m\n'
printf '%s\n' "${RESULTS[@]}"

if [ "$failed" -ne 0 ]; then
  echo
  echo "FAIL: at least one step is red. Nothing is stamped."
  rm -f "$ROOT/.ci-local-pass"
  exit 1
fi

if [ "$WANT" = all ]; then
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo
    echo "OK, but the tree is dirty, so this run describes no commit and nothing is stamped."
    echo "Commit, run this again, and the stamp will cover what you push."
    rm -f "$ROOT/.ci-local-pass"
    exit 0
  fi
  git -C "$ROOT" rev-parse HEAD > "$ROOT/.ci-local-pass"
  echo
  echo "OK: every step green at $(git -C "$ROOT" rev-parse --short HEAD), and stamped."
else
  echo
  echo "OK: the $WANT job is green. A stamp needs the whole run — `tools/run-ci.sh`."
fi
