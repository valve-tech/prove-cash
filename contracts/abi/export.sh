#!/usr/bin/env bash
# Copy the ABI out of the Foundry build artefacts.
#
# Pass --check to compare instead of write. CI runs that, because this directory is the second
# copy of every ABI and nothing in the repo reads it. It drifted once already: four functions
# that no longer existed, three that did, and no test anywhere noticed.
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-write}"
status=0
for c in ProveSettlement ProveRelayer ProveExecutor ProveBatchExecutor ProveCallSink RfqVenue FeeDefaults ProveReader; do
  python3 - "$c" "$mode" <<'PY' || status=1
import json, sys
c, mode = sys.argv[1], sys.argv[2]
abi = json.load(open(f"out/{c}.sol/{c}.json"))["abi"]
text = json.dumps(abi, indent=2)
path = f"abi/{c}.json"
if mode == "--check":
    if open(path).read() != text:
        print(f"{c}: stale, run contracts/abi/export.sh")
        sys.exit(1)
    print(f"{c}: current, {len(abi)} entries")
else:
    open(path, "w").write(text)
    print(f"{c}: {len(abi)} entries")
PY
done
exit $status
