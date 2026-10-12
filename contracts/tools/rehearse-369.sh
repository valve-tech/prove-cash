#!/usr/bin/env bash
#
# Rehearse the mainnet deploy on a fork of PulseChain 369, through the real scripts and the real
# guards, from a key that exists for about a minute.
#
#   contracts/tools/rehearse-369.sh
#   PULSECHAIN_RPC=… contracts/tools/rehearse-369.sh    # a different 369 endpoint
#   PROVE_RPC_KEY=… contracts/tools/rehearse-369.sh     # a gateway key other than vk_demo
#
# `test/Fork369Rehearsal.t.sol` asks whether the committed configuration deploys and fills. It
# cannot ask the other half, because it runs inside forge: `PROVE_DEPLOYER`, `PROVE_SETTLEMENT` and
# `PROVE_SETTLEMENT_OFF_RECORD` are process environment rather than EVM state, and forge runs test
# contracts in parallel, so a test that wrote them would race `Deploy.t.sol`. This script runs in a
# process of its own against an anvil it started, so it can set all three and drive the three deploy
# scripts exactly as an operator does — `forge script … --broadcast`, guards and all.
#
# What it proves, in order:
#
#   1. The fork really is chain 369, with mainnet's Permit2 at the canonical address.
#   2. `Deploy.s.sol` broadcasts the settlement and the executor from `config/369.json`.
#   3. `DeployBatchExecutor.s.sol` and `DeployRfqVenue.s.sol` bind to that settlement, through the
#      off-record acknowledgement a fork deploy is supposed to carry.
#   4. Every one of the seven addresses has code, and every pointer reads back off the chain.
#
# ## Two rules this script keeps
#
# **It never touches a real chain.** Every broadcast goes to 127.0.0.1 and nowhere else, and the
# script checks that the endpoint it is about to broadcast to is the local anvil before it signs
# anything. The mainnet endpoint is read from, never written to.
#
# **It never prints a key.** The throwaway key is generated into a variable, handed to forge, and
# never echoed — not to prove it was made, not while debugging. The address it derives is public and
# is printed instead. The mainnet deployer key is not read, not needed and not reachable from here:
# `PROVE_DEPLOYER` narrows the signer list to the throwaway address, which is what that variable is
# for and the reason it takes an address rather than a flag.
#
# **The gateway key travels in a header, never in the URL.** A key in a URL path reaches access logs
# and every upstream hop. The key comes from `PROVE_RPC_KEY`, or is the public `vk_demo`, and this
# script never prints it. Every line it prints is still scrubbed of a key in a URL path, because a
# caller can pass an old-style URL in `PULSECHAIN_RPC`, and of the key itself.
set -uo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

# Forge takes a gas price from ETH_GAS_PRICE and a tip from ETH_PRIORITY_GAS_PRICE. A value left
# from a testnet session would price this run, and the real deploy from the same shell. So refuse,
# and name the fix. The runbook's preflight unsets both.
for var in ETH_GAS_PRICE ETH_PRIORITY_GAS_PRICE; do
  if [ -n "${!var+x}" ]; then
    printf '%s is set in this shell. Forge would use it as the gas price. Run: unset %s\n' \
      "$var" "$var"
    exit 1
  fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8549
FORK=http://127.0.0.1:$PORT
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
# The endpoint `ci.yml` and both fork suites already name. It is the valve gateway, never a
# third-party node: a third-party node drops transactions silently, and the whole point of a
# rehearsal is that a failure means something.
RPC="${PULSECHAIN_RPC:-https://one.valve.city/rpc/evm/369}"

# The gateway refuses a call with no `X-API-Key` header (HTTP 401). The key goes into JSON and
# into a sed pattern below, so anything but a plain token is refused, without printing it.
RPC_KEY="${PROVE_RPC_KEY:-vk_demo}"
if ! [[ "$RPC_KEY" =~ ^[A-Za-z0-9_-]+$ ]]; then
  printf 'PROVE_RPC_KEY holds characters a gateway key never has. Nothing was started.\n'
  exit 1
fi
# Forge and cast read this list for every RPC call, so each alias lookup below authenticates.
# It replaces whatever `[profile.fork]` or the caller set, so `PROVE_RPC_KEY` is the one knob.
export FOUNDRY_ETH_RPC_HEADERS="[\"X-API-Key: $RPC_KEY\"]"

# **The URL never reaches a command line.** Every foundry tool below names the `pulsechain` alias
# from `foundry.toml`'s `[rpc_endpoints]`, which expands this variable out of the environment. A
# URL passed as an argument instead goes into that process's argv, and `ps` shows argv to every
# process on the machine — so a gateway key on a command line is a key handed to anyone with a
# shell. `scrub` covers the other half: anything this script prints, an error from a tool
# included, has its key replaced before it reaches a terminal or a log.
export PULSECHAIN_RPC="$RPC"

# The alias resolves only from the directory holding `foundry.toml`.
cd "$ROOT" || exit 1

fails=0

# Redact a gateway key out of anything before it reaches the terminal. A key in a path is still a
# key, and a rehearsal that leaks one has cost more than it proved.
scrub() { sed -E -e 's#(https?://[^/[:space:]]+/rpc/)[^/[:space:]]+/evm/#\1<key>/evm/#g' -e "s#$RPC_KEY#<key>#g"; }
say() { printf '%s\n' "$*" | scrub; }
ok() { printf '  ok    %s\n' "$*" | scrub; }
bad() { printf '  FAIL  %s\n' "$*" | scrub; fails=$((fails + 1)); }

# Assert two values are equal, and say which claim it was either way.
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, wanted $3"; fi
}

# Kill only the anvil this script started, by the pid it captured when it started it.
#
# This used to be `pkill -f "anvil --port $PORT"`. A pattern kill reaches every process on the
# machine that matches, not just this script's, and on a shared machine that means somebody else's
# work. It has already cost a run here: an agent cleaning up after its own CI with an unscoped
# `pkill` killed a fork test belonging to another. A captured pid cannot do that.
cleanup() {
  if [ -n "${ANVIL_PID:-}" ]; then kill "$ANVIL_PID" 2>/dev/null; fi
}
trap cleanup EXIT

say "── the chain being forked"
say "rpc        $RPC"
UPSTREAM_ID=$(cast chain-id --rpc-url pulsechain 2>&1 | tail -1)
if [ "$UPSTREAM_ID" != "369" ]; then
  say "That endpoint answers chain id $UPSTREAM_ID, not 369. Nothing was started."
  exit 1
fi
HEAD=$(cast block-number --rpc-url pulsechain)
say "head       $HEAD"

say ""
say "── forking it"
# Refuse to share the port rather than clearing it. Whatever is listening there belongs to
# somebody, and this script has no business deciding it does not.
if cast chain-id --rpc-url $FORK >/dev/null 2>&1; then
  say "Something already answers on $FORK. Refusing to take a port that is in use."
  exit 1
fi
# Native anvil, never a container. `DOCKER_DEFAULT_PLATFORM=linux/amd64` is exported on the
# development machine, so anything in Docker here runs emulated and slowly.
#
# Paced at 165 compute units a second, as the fork suite in `ci.yml` is. The gateway answers a
# faster caller with HTTP 429, and forge retries a 429 without a word, so a clean log proves little.
#
# Anvil reads no header from `foundry.toml` or the environment (measured on 1.8.0: both get a 401),
# so the header goes on its command line, and `ps` shows it on this machine while anvil runs. That
# is the one place the key is exposed. A CI runner is a single-use VM, so nobody else is there.
anvil --port $PORT --fork-url pulsechain --fork-header "X-API-Key: $RPC_KEY" \
  --compute-units-per-second 165 --silent >/dev/null 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  cast chain-id --rpc-url $FORK >/dev/null 2>&1 && break
  sleep 1
done

FORK_ID=$(cast chain-id --rpc-url $FORK 2>&1 | tail -1)
if [ "$FORK_ID" != "369" ]; then
  say "The fork answers chain id $FORK_ID. Without 369 the scripts read the wrong config file."
  exit 1
fi
# Belt and braces before anything is signed: the endpoint every broadcast below names is local.
case "$FORK" in
  http://127.0.0.1:*) ;;
  *) say "Refusing to broadcast to $FORK — a rehearsal signs against the local fork only."; exit 1 ;;
esac
say "fork       $FORK, chain $FORK_ID, at block $(cast block-number --rpc-url $FORK)"

# ── The key that exists for a minute ──────────────────────────────────────────
#
# Generated here, into a variable, and never printed. `fund only recoverable accounts` does not
# apply: this account holds forked play money on a chain that stops existing when this script ends.
KEY=$(cast wallet new --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["private_key"])')
SIGNER=$(cast wallet address --private-key "$KEY")
# PulseChain charges a large gas price, and a deploy that runs out halfway is the worst place for
# one to stop. A round million PLS on a fork costs nothing.
cast rpc anvil_setBalance "$SIGNER" 0xD3C21BCECCEDA1000000 --rpc-url $FORK >/dev/null
say "signer     $SIGNER  (throwaway, derived locally, never printed)"

# It narrows the allowed signer list to this one address. It never widens it — a real chain with a
# stale value here fails closed rather than waving a wrong key through.
export PROVE_DEPLOYER="$SIGNER"

say ""
say "── preconditions"
PERMIT2_SIZE=$(( $(cast code $PERMIT2 --rpc-url $FORK | wc -c | tr -d ' ') / 2 - 1 ))
is "Permit2 carries mainnet's code at its canonical address" "$PERMIT2_SIZE" "9152"

CONFIG="$ROOT/config/369.json"
CFG_OWNER=$(python3 -c "import json;print(json.load(open('$CONFIG'))['owner'])")
CFG_PROCEEDS=$(python3 -c "import json;print(json.load(open('$CONFIG'))['defaultProceeds'])")
CFG_PERMIT2=$(python3 -c "import json;print(json.load(open('$CONFIG'))['permit2'])")
is "config/369.json names Permit2's canonical deployment" "$CFG_PERMIT2" "$PERMIT2"

say ""
say "── 1/3  Deploy.s.sol"
cd "$ROOT" || exit 1
core=$(forge script script/Deploy.s.sol --rpc-url $FORK --broadcast --private-key "$KEY" 2>&1)
SETTLEMENT=$(printf '%s' "$core" | sed -n 's/.*ProveSettlement *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)
EXECUTOR=$(printf '%s' "$core" | sed -n 's/.*ProveExecutor *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)
if [ -z "$SETTLEMENT" ] || [ -z "$EXECUTOR" ]; then
  printf '%s\n' "$core" | tail -30 | scrub
  say "Deploy.s.sol did not produce a settlement. Nothing below can run."
  exit 1
fi
RELAYER=$(cast call "$SETTLEMENT" 'relayer()(address)' --rpc-url $FORK)
CALL_SINK=$(cast call "$EXECUTOR" 'sinkTemplate()(address)' --rpc-url $FORK)
say "settlement $SETTLEMENT"
say "relayer    $RELAYER"
say "executor   $EXECUTOR"
say "call sink  $CALL_SINK"

# Both periphery scripts hold the settlement against `deployments/369.json`, and a rehearsal
# deploys one no record can know about. Naming the same address in a second variable is how a
# fork dry run says so — an address rather than a flag, so a value left in a shell cannot wave
# through tomorrow's different one.
export PROVE_SETTLEMENT="$SETTLEMENT"
export PROVE_SETTLEMENT_OFF_RECORD="$SETTLEMENT"

say ""
say "── 2/3  DeployBatchExecutor.s.sol"
be=$(forge script script/DeployBatchExecutor.s.sol --rpc-url $FORK --broadcast --private-key "$KEY" 2>&1)
BATCH=$(printf '%s' "$be" | sed -n 's/.*ProveBatchExecutor *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)
if [ -z "$BATCH" ]; then
  printf '%s\n' "$be" | tail -30 | scrub
  bad "DeployBatchExecutor.s.sol deployed nothing"
else
  BATCH_SINK=$(cast call "$BATCH" 'sinkTemplate()(address)' --rpc-url $FORK)
  say "batch      $BATCH"
  say "its sink   $BATCH_SINK"
fi

say ""
say "── 3/3  DeployRfqVenue.s.sol"
rfq=$(forge script script/DeployRfqVenue.s.sol --rpc-url $FORK --broadcast --private-key "$KEY" 2>&1)
VENUE=$(printf '%s' "$rfq" | sed -n 's/.*RfqVenue *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | head -1)
if [ -z "$VENUE" ]; then
  printf '%s\n' "$rfq" | tail -30 | scrub
  bad "DeployRfqVenue.s.sol deployed nothing"
else
  say "venue      $VENUE"
fi

# ── What is actually on the fork ──────────────────────────────────────────────
#
# Read back off the chain, never out of the script's own output. A script that printed an address
# is a script that ran; it is not evidence that the address holds what the operator thinks.
say ""
say "── every address has code"
for pair in \
  "ProveSettlement:$SETTLEMENT" \
  "ProveRelayer:$RELAYER" \
  "ProveExecutor:$EXECUTOR" \
  "ProveCallSink:$CALL_SINK" \
  "ProveBatchExecutor:${BATCH:-}" \
  "ProveBatchExecutorCallSink:${BATCH_SINK:-}" \
  "RfqVenue:${VENUE:-}"; do
  name="${pair%%:*}"
  addr="${pair#*:}"
  if [ -z "$addr" ]; then
    bad "$name has no address"
    continue
  fi
  size=$(( $(cast code "$addr" --rpc-url $FORK | wc -c | tr -d ' ') / 2 - 1 ))
  if [ "$size" -gt 0 ]; then ok "$name  $size bytes"; else bad "$name has no code at $addr"; fi
done

say ""
say "── the wiring reads back off the chain"
is "settlement.owner() is the owner config/369.json names" \
  "$(cast call "$SETTLEMENT" 'owner()(address)' --rpc-url $FORK)" "$CFG_OWNER"
is "settlement.defaultProceeds() is what the file names" \
  "$(cast call "$SETTLEMENT" 'defaultProceeds()(address)' --rpc-url $FORK)" "$CFG_PROCEEDS"
is "relayer.settlement() answers the settlement that made it" \
  "$(cast call "$RELAYER" 'settlement()(address)' --rpc-url $FORK)" "$SETTLEMENT"
is "relayer.permit2() is the canonical Permit2" \
  "$(cast call "$RELAYER" 'permit2()(address)' --rpc-url $FORK)" "$PERMIT2"
is "executor.settlement() fills at the new settlement" \
  "$(cast call "$EXECUTOR" 'settlement()(address)' --rpc-url $FORK)" "$SETTLEMENT"
is "executor.relayer() read the same relayer" \
  "$(cast call "$EXECUTOR" 'relayer()(address)' --rpc-url $FORK)" "$RELAYER"
is "the call sink answers only to its executor" \
  "$(cast call "$CALL_SINK" 'executor()(address)' --rpc-url $FORK)" "$EXECUTOR"

if [ -n "${BATCH:-}" ]; then
  is "batch executor settles at the new settlement" \
    "$(cast call "$BATCH" 'settlement()(address)' --rpc-url $FORK)" "$SETTLEMENT"
  is "batch executor read the same relayer" \
    "$(cast call "$BATCH" 'relayer()(address)' --rpc-url $FORK)" "$RELAYER"
  is "its sink answers only to it" \
    "$(cast call "$BATCH_SINK" 'executor()(address)' --rpc-url $FORK)" "$BATCH"
  if [ "$BATCH_SINK" != "$CALL_SINK" ]; then
    ok "the two call sinks are different addresses"
  else
    bad "both executors share one call sink, so whichever calls second is refused"
  fi
fi

if [ -n "${VENUE:-}" ]; then
  is "venue settles at the new settlement" \
    "$(cast call "$VENUE" 'settlement()(address)' --rpc-url $FORK)" "$SETTLEMENT"
  is "venue read the same relayer" \
    "$(cast call "$VENUE" 'relayer()(address)' --rpc-url $FORK)" "$RELAYER"
fi

say ""
say "── the signer check refuses a key this chain does not name"
# The guard is what stands between a tired operator and a mainnet settlement signed by the testnet
# key. Proving it refuses is worth more than proving it accepts, because the accepting path is the
# one every line above already walked.
OTHER=$(cast wallet new --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["private_key"])')
OTHER_ADDR=$(cast wallet address --private-key "$OTHER")
cast rpc anvil_setBalance "$OTHER_ADDR" 0xD3C21BCECCEDA1000000 --rpc-url $FORK >/dev/null
if forge script script/Deploy.s.sol --rpc-url $FORK --private-key "$OTHER" >/dev/null 2>&1; then
  bad "a key PROVE_DEPLOYER does not name was allowed to deploy"
else
  ok "a key the narrowed list does not name is refused before anything is signed"
fi

say ""
if [ "$fails" -ne 0 ]; then
  say "FAIL: $fails check(s) red. The fork is gone; nothing reached a real chain."
  exit 1
fi
say "OK: the whole set deploys on a fork of 369 and every pointer reads back."
say "Nothing reached a real chain. The fork and the key are gone."
