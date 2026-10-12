#!/usr/bin/env bash
#
# A whole prove.cash on a chain you control, in about a minute.
#
#   app/scripts/lab/up.sh          # bring it up, print the exports
#   eval "$(app/scripts/lab/up.sh --quiet)"   # and put them in this shell
#
# Why not fork 943. A forked anvil inherits the gateway, and on 2026-08-28 that gateway was
# returning 502s — which surfaced as failed receipt fetches that looked exactly like protocol
# bugs. A fresh deployment answers in milliseconds and never lies about why something failed.
#
# What this buys that a live chain cannot: the scenarios that will not happen on their own. A
# three-leg coincidence of wants, a leg nobody can arm, and a clock running eight seconds fast —
# that last one turned out to be a real bug the live board had been hiding behind a wrong error
# for days. See app/scripts/lab/clock-skew.ts.
set -uo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

QUIET=${1:-}
LAB=http://127.0.0.1:8547
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Anvil's first dev account, published in every foundry doc. Not a secret, and it holds nothing
# anywhere but here.
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
say() { [ "$QUIET" = "--quiet" ] || echo "$@"; }

# A fresh clone or a `git worktree add` has empty `contracts/lib/` directories, and forge's own
# error for that does not say what to run. Say it before anything is started.
[ -f "$ROOT/contracts/lib/forge-std/src/Script.sol" ] || {
  echo "lab: the contract submodules are missing. Run: git submodule update --init" >&2; exit 1
}

pkill -f "anvil --port 8547" 2>/dev/null
sleep 1
# Chain id 943 so every config file in the repo loads unchanged.
anvil --port 8547 --chain-id 943 --silent --accounts 10 --balance 1000000 >/dev/null 2>&1 &
for _ in $(seq 1 30); do
  cast chain-id --rpc-url $LAB >/dev/null 2>&1 && break
  sleep 1
done

# Permit2, at its canonical address, with the runtime code the real chain runs. Its domain is
# built from name, chain id and verifying contract, so etching it here reproduces the real domain
# separator exactly — 0x9b4eac43… on 943, checked. Storage starts empty, which is what a fresh
# chain should have: no nonce has been spent yet.
CODE_FILE="$ROOT/contracts/config/permit2.runtime.hex"
if [ -f "$CODE_FILE" ]; then
  cast rpc anvil_setCode "$PERMIT2" "$(cat "$CODE_FILE")" --rpc-url $LAB >/dev/null
  say "permit2  etched, domain $(cast call $PERMIT2 'DOMAIN_SEPARATOR()(bytes32)' --rpc-url $LAB)"
else
  say "permit2  NOT etched — no $CODE_FILE, so the permit2 rung will not work here."
  say "         Fetch it once with eth_getCode against a chain that has Permit2."
fi

cd "$ROOT/contracts"
# A copy left by an earlier run must never stand in for this run's tokens.
rm -f /tmp/lab.tokens.943.json
core=$(forge script script/Deploy.s.sol --rpc-url $LAB --broadcast --private-key "$ANVIL_KEY" 2>&1)
SETTLEMENT=$(printf '%s' "$core" | sed -n 's/.*ProveSettlement *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)
# An empty address here used to flow on into every export below, and the lab came up "fine"
# pointing at nothing. Stop at the first deploy that did not say where it went.
[ -n "$SETTLEMENT" ] || { printf '%s\n' "$core" | tail -20; echo "lab: ProveSettlement did not deploy" >&2; exit 1; }
export PROVE_SETTLEMENT="$SETTLEMENT"
# `available` moved to `ProveReader`; the solver and the exercises read it there.
READER=$(printf '%s' "$core" | sed -n 's/.*ProveReader *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)
[ -n "$READER" ] || { printf '%s\n' "$core" | tail -20; echo "lab: ProveReader did not deploy" >&2; exit 1; }
export PROVE_READER="$READER"
# The lab's settlement is one `contracts/deployments/943.json` cannot name: that file records the
# real testnet. `DeployBatchExecutor` and `DeployRfqVenue` check the record (`script/Guards.sol`)
# and refused a fresh lab with `SettlementNotRecorded` until this line. The guard takes the
# address rather than a flag, so this acknowledges exactly the settlement deployed above and
# nothing a later run deploys.
export PROVE_SETTLEMENT_OFF_RECORD="$SETTLEMENT"
be=$(forge script script/DeployBatchExecutor.s.sol --rpc-url $LAB --broadcast --private-key "$ANVIL_KEY" 2>&1)
BATCH=$(printf '%s' "$be" | sed -n 's/.*ProveBatchExecutor *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)
[ -n "$BATCH" ] || { printf '%s\n' "$be" | tail -20; echo "lab: ProveBatchExecutor did not deploy" >&2; exit 1; }
if ! rfq=$(forge script script/DeployRfqVenue.s.sol --rpc-url $LAB --broadcast --private-key "$ANVIL_KEY" 2>&1); then
  printf '%s\n' "$rfq" | tail -20; echo "lab: DeployRfqVenue failed" >&2; exit 1
fi

# `DeployTestTokens` writes config/deployed.<chainid>.json, which is a TRACKED file holding the
# live testnet addresses. Take a copy for the lab and put the real one back, or the app ends up
# pointed at a chain that stops existing when this anvil does.
# Without this copy the trap below has nothing to restore, so refuse to go on.
cp config/deployed.943.json /tmp/deployed.943.live.json || { echo "lab: cannot back up config/deployed.943.json" >&2; exit 1; }
# Put it back on ANY exit, not just the happy one.
#
# The restore used to be a plain line further down, and everything between the copy and it was a
# path that could leave the repository holding anvil addresses for a chain that stops existing
# when this script's anvil does. A venue that would not deploy did exactly that: the script
# exited on the error, the tracked file kept the lab's addresses, and `git status` was the only
# thing that noticed. A trap covers the error paths and the interrupt as well.
trap 'cp /tmp/deployed.943.live.json "$ROOT/contracts/config/deployed.943.json" 2>/dev/null' EXIT
# The deployer owns the lab's tokens.
#
# `DeployTestTokens` takes its owner from the config file, which names the real 943 owner — an
# address whose key is not here and should not be. Every token then refused `mint` from this
# script, which is right on a chain somebody else runs and useless on one you brought up yourself
# thirty seconds ago. The lab exists precisely so that the whole portfolio is yours to move.
PROVE_TOKEN_OWNER=$(cast wallet address --private-key "$ANVIL_KEY")
export PROVE_TOKEN_OWNER
# If the token deploy fails, config/deployed.943.json still holds the LIVE 943 tokens, and copying
# it here would point the lab at a chain it is not. So a failure stops the lab, and the file must
# have changed before it counts as the lab's.
if ! tok=$(forge script script/DeployTestTokens.s.sol --rpc-url $LAB --broadcast --private-key "$ANVIL_KEY" 2>&1); then
  printf '%s\n' "$tok" | tail -20; echo "lab: DeployTestTokens failed" >&2; exit 1
fi
if cmp -s config/deployed.943.json /tmp/deployed.943.live.json; then
  echo "lab: DeployTestTokens left config/deployed.943.json unchanged; refusing the live 943 tokens" >&2; exit 1
fi
cp config/deployed.943.json /tmp/lab.tokens.943.json

# A venue, so a plan can close through something.
#
# Without one the lab can only exercise a coincidence of wants, because `ProveBatchExecutor` holds
# nothing between transactions: a leg hands it token A and leaves it owing token B, and unless
# another leg supplies that B — which is a cycle — nobody gets paid. `packed-batch.ts` found this
# by sending four perfectly good independent offers and watching them revert, correctly, for
# 81,900 gas having filled nothing.
#
# It runs while `config/deployed.943.json` still holds the lab's own token addresses, which is
# the window between the copy above and the restore below.
venue=$(forge script script/DeployLabVenue.s.sol --rpc-url $LAB --broadcast --private-key "$ANVIL_KEY" 2>&1)
VENUE=$(printf '%s' "$venue" | grep -oE 'venue +0x[0-9a-fA-F]{40}' | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
[ -n "$VENUE" ] || { echo "$venue" | tail -20; echo "lab venue did not deploy"; exit 1; }

# A market, so the solver can find and PRICE a pool leg.
#
# The venue above pays a fixed rate out of a float. It has no factory, no pair and no reserves, so
# `loadPools` cannot see it at all — every plan that needed a priced pool leg was refused, and no
# ring with a pool in it could exist here. This deploys a factory, a router and a triangle of
# tPLSX/tUSDC, tUSDC/tWETH and tWETH/tPLSX, arbitrage-free by construction.
#
# It runs inside the same window as the venue above: `config/deployed.943.json` still holds the
# lab's own token addresses, and the trap puts the live file back on the way out.
xyk=$(forge script script/DeployLabXyk.s.sol --rpc-url $LAB --broadcast --private-key "$ANVIL_KEY" 2>&1)
pick() { printf '%s' "$xyk" | sed -n "s/.*$1 *\(0x[0-9a-fA-F]\{40\}\).*/\1/p" | head -1; }
XYK_FACTORY=$(pick factory)
XYK_ROUTER=$(pick router)
# The fee comes out of the script rather than being written here. The pairs take none, and the SDK
# reads a venue's fee from its registry entry — so the two numbers have to travel together with
# the addresses, or every quote the SDK computes disagrees with the router that will fill it.
XYK_FEE_NUM=$(printf '%s' "$xyk" | sed -n 's/.*feeNum *\([0-9]\{1,\}\).*/\1/p' | head -1)
XYK_FEE_DEN=$(printf '%s' "$xyk" | sed -n 's/.*feeDen *\([0-9]\{1,\}\).*/\1/p' | head -1)
[ -n "$XYK_ROUTER" ] && [ -n "$XYK_FACTORY" ] && [ -n "$XYK_FEE_NUM" ] && [ -n "$XYK_FEE_DEN" ] || {
  echo "$xyk" | tail -20; echo "lab xyk market did not deploy"; exit 1
}

say "settlement    $SETTLEMENT"
say "reader        $READER"
say "batchExecutor $BATCH"
say "tokens        /tmp/lab.tokens.943.json"
say "venue         $VENUE"
say "xyk factory   $XYK_FACTORY"
say "xyk router    $XYK_ROUTER  (fee $XYK_FEE_NUM/$XYK_FEE_DEN)"
say ""
say "Run an exercise or a scenario against it:"
cat <<EOF
export RPC=$LAB
export DEPLOYER_PK=$ANVIL_KEY
export PROVE_SETTLEMENT=$SETTLEMENT
export PROVE_READER=$READER
export PROVE_BATCH_EXECUTOR=$BATCH
export PROVE_TOKENS=/tmp/lab.tokens.943.json
export LAB_VENUE=$VENUE
export PROVE_XYK_ROUTER=$XYK_ROUTER
export PROVE_XYK_FACTORY=$XYK_FACTORY
export PROVE_XYK_FEE_NUM=$XYK_FEE_NUM
export PROVE_XYK_FEE_DEN=$XYK_FEE_DEN
export GAS_GWEI=1
EOF
say ""
say "  npx tsx scripts/lab/clock-skew.ts     the bug that cost a day"
say "  npx tsx scripts/lab/three-leg.ts      a cycle that needs no market"
say "  npx tsx scripts/lab/failed-arming.ts  a leg nobody can arm"
say "  npx tsx scripts/lab/packed-batch.ts   a batch that survives losing a leg"
say "  npx tsx scripts/lab/xyk-triangle.ts   a market the solver can price"
say "  npx tsx scripts/e2e/ring.ts           the ordinary suite, locally"
