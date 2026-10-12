# How specs work here

A spec states intent: what a part of the system must do, what it must never do, and why. It
quotes the owner's decisions in the owner's words, so you can check the code against what was
asked for and not against what somebody remembers. Every spec is dated in its file name and
carries a **Status** line under its title, with one of four values: **Proposed** (argued, not
agreed), **Approved** (the owner agreed, not built yet), **Built** (in the code on `master`, with
the commits named), or **Superseded by X** (kept as history; X is the document that replaced
it). **Built in part** says which parts are built and which are still Proposed or Approved.

A spec cites code by symbol name — `ProveSettlement.sweepUnowned`, not
`ProveSettlement.sol:1424` — where it can, because line numbers move. When the code and an
Approved or Built spec disagree, that is a bug in one of the two. Write it down and let the owner
decide which one is wrong. Never resolve it silently in either direction.

`docs/README.md` indexes every spec with its true status. When you add a spec, add its row there
in the same commit. When a spec's status changes, change the Status line and the index row
together, and name the commit or the decision that changed it.

## The 2026-09-23 set

Five specs state the whole system as intent, and one file gathers their open questions. The
full index, with every older spec, is in `docs/README.md`.

| Spec | Status |
|---|---|
| [`2026-09-23-fee-sink-fixed-destination.md`](2026-09-23-fee-sink-fixed-destination.md) | **Built in part.** Contracts in `4d48379` and `64224af`, not yet on `master`. SDK and app in progress on `sinks-app` |
| [`2026-09-23-settlement.md`](2026-09-23-settlement.md) | **Proposed.** FE-6 to FE-10, B-1 and B-2 are built |
| [`2026-09-23-executors-and-venue.md`](2026-09-23-executors-and-venue.md) | **Proposed** |
| [`2026-09-23-solver-graph-and-bots.md`](2026-09-23-solver-graph-and-bots.md) | **Proposed** |
| [`2026-09-23-sdk-and-app.md`](2026-09-23-sdk-and-app.md) | **Proposed** |

`2026-09-23-fee-sink-registry.md` is **Superseded by** the fixed-destination spec, which is itself
**Superseded by** [`2026-10-03-fee-config-hash.md`](2026-10-03-fee-config-hash.md) (**Built**, local branch).
