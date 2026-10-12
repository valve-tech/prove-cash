#!/usr/bin/env python3
"""
Run a fork suite through a counting proxy, and fail when the gateway refused too much of it.

    python3 tools/count-429.py --upstream https://one.valve.city/rpc/evm/369 --max-pct 10 -- \\
        forge test --match-path 'test/Fork*.t.sol' -vv -j 1 --compute-units-per-second 165

Forge retries an HTTP 429 without a word. Measured on 2026-09-28: a run at RUST_LOG=debug took
29 refusals of 1394 requests and logged not one line about them. On 2026-09-16 a counting proxy found 35% of a fork run refused while the suite reported
19 of 19 passed. A pass is therefore not proof that the endpoint answered. This counts.

It starts a proxy on 127.0.0.1, points PULSECHAIN_RPC at it, and runs the command. The proxy
forwards each request to the upstream with its headers (so the X-API-Key header from
FOUNDRY_ETH_RPC_HEADERS still reaches the gateway) and tallies the status. The command's exit
code wins; then the check fails if 429s exceed --max-pct of all requests.

It never prints a header or a URL beyond the upstream the caller passed, which holds no key.
A client that hangs up mid-answer is counted and ignored: the instrument must not fail the suite.
"""

import argparse
import http.server
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from collections import Counter

HOP = {"host", "content-length", "connection", "accept-encoding", "transfer-encoding"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--upstream", required=True)
    ap.add_argument("--max-pct", type=float, default=10.0)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    if not cmd:
        ap.error("no command after --")

    tally: Counter = Counter()
    lock = threading.Lock()

    class Proxy(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", 0)))
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
            req = urllib.request.Request(a.upstream, data=body, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    status, data, ctype = r.status, r.read(), r.headers.get("content-type")
            except urllib.error.HTTPError as e:
                status, data, ctype = e.code, e.read(), e.headers.get("content-type")
            except Exception:
                status, data, ctype = 502, b"proxy: upstream unreachable", "text/plain"
            with lock:
                tally[status] += 1
            try:
                self.send_response(status)
                self.send_header("content-type", ctype or "application/json")
                self.send_header("content-length", str(len(data)))
                if status == 429:
                    self.send_header("retry-after", "1")
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                with lock:
                    tally["client hung up"] += 1

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = dict(os.environ, PULSECHAIN_RPC=f"http://127.0.0.1:{server.server_address[1]}")

    code = subprocess.run(cmd, env=env).returncode
    server.shutdown()

    total = sum(v for k, v in tally.items() if isinstance(k, int))
    refused = tally[429]
    pct = 100.0 * refused / total if total else 0.0
    print(f"\n429 count: {refused} of {total} requests refused ({pct:.1f}%), limit {a.max_pct}%")
    print("by status: " + ", ".join(f"{k}={v}" for k, v in sorted(tally.items(), key=str)))
    if code != 0:
        return code
    if total == 0:
        print("FAIL: no request reached the proxy, so the fork suite asked no chain anything.")
        return 1
    if pct > a.max_pct:
        print("FAIL: the gateway refused more than the limit. Forge retried in silence;")
        print("      the green result above rests on retries. Check pacing and the key.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
