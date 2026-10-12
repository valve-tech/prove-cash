# WalletConnect: what we chose, and what it buys

2026-09-18.

A phone wallet or a hardware wallet can now connect, beside the browser extension. This note says
which package does it, what it costs, which wallets can actually use it on PulseChain, and the
one production step that is not in any code.

## The decision

**`@walletconnect/universal-provider`, behind a dynamic import, with `uqr` for the QR grid.**

The owner asked for Reown without the prebuilt components. This is Reown: Reown maintains the
WalletConnect protocol SDKs, `@reown/appkit` is built on this exact package, and it takes the same
Reown Cloud project id and the same relay. It ships no UI at all — no custom element, no
stylesheet, no modal. We draw the wallet list and the QR code ourselves.

Three paths were measured. Here is why the other two lost.

### `@reown/appkit` headless — real, documented, and behind a paywall

AppKit does have a headless mode: `features: { headless: true }` plus the `useAppKitWallets` hook.
The flag works — `injectModalUi()` returns early and no custom element registers.

But `headless` is a **remote** feature. Reown's API decides it from your project id, remote config
beats local config, and the fallback is `false`. Reown's pricing puts it on Pro at $89 a month.
On a free project id you get no modal and a wallet list that misbehaves. It also costs 265 KB
gzipped in the eager entry chunk.

Paying $89 a month for the absence of a user interface is not what the owner was buying.

### `@walletconnect/ethereum-provider` — drags AppKit in

`showQrModal: false` is still there, still required in the type, still tested. It is not the
problem. The problem is that version 2.25.0 declares `@reown/appkit@1.8.19` as a **hard
dependency** — 41 MB unpacked. A split build of it emits a `w3m-modal` chunk and about sixty
Phosphor icon chunks. The import is dynamic and `showQrModal: false` never runs it, so you would
not download it, but it is in the tree and it is emitted.

`universal-provider` declares no AppKit. After the swap, `node_modules/@reown` is empty.

### What it cost

Measured here, minified and gzipped, whole-bundle:

| | gzipped |
| --- | --- |
| `@walletconnect/ethereum-provider` | 583 KB |
| `@walletconnect/universal-provider` | 146 KB |
| `uqr` | 3.9 KB |

Bundlephobia agrees within 8%: 141 KB and 134 KB.

And in the real build, before and after:

| chunk | before | after | change |
| --- | --- | --- | --- |
| App | 283,305 B | 289,212 B | **+5.8 KB** |
| index | 206,094 B | 208,074 B | **+1.9 KB** |
| the relay client | — | 132,411 B | a lazy chunk |

So **7.7 KB gzipped on first paint**, which is `uqr`, the picker and the new copy. The 132 KB relay
client is fetched when somebody presses "scan with a phone" and at no other moment. A reader who
uses an extension, or who never connects anything, never sees it.

The import must stay dynamic. That is the whole reason the number above is 7.7 and not 140.

## The project id

`VITE_REOWN_PROJECT_ID`, read at build time, never hard-coded.

It is **public**. It identifies the dapp to the relay and it travels inside every `wc:` URI a
phone scans. Reown ships a working one in their own repository. It is not a secret and must not
be handled as one. It still comes from the environment, because a fork, a preview deploy and a
local checkout each want their own.

**With no project id, WalletConnect is absent.** Not disabled, not a button that explains itself
when pressed — the "on a phone" half of the dialog is not drawn. The extension path is exactly
what it was before. This is checked two ways: by tests, and by a screenshot of the running app at
375px with and without the variable set.

Nothing throws without one. `UniversalProvider.init()` does not check it; the relay answers 401 or
403 and the socket dies quietly. So the check is ours, before anything is fetched.

## Before this works in production

**The Reown dashboard needs an origin allowlist entry for `prove.cash` and `www.prove.cash`.**

This is the step that fails silently. Without it the relay closes the socket with code 3000,
"origin not allowed" — no error the client surfaces, no event, nothing. Localhost is always
allowed, so a working development machine tells you nothing. **Allowlist changes take 15 minutes
to apply.**

The deploy steps, in order:

1. Create a project at `dashboard.reown.com`. Free tier is enough; we use no paid feature.
2. Add `https://prove.cash` and `https://www.prove.cash` to the project's origin allowlist. Wait
   15 minutes.
3. Set `VITE_REOWN_PROJECT_ID` in the build environment. It is inlined at build time, so it must
   be present when `npm run build` runs, not when the worker starts.
4. Deploy. Press "scan with a phone" on the live site and check a code appears.

Skip step 3 and the feature is simply absent, which is safe. Skip step 2 and the button appears
and never works — which is why the client now gives up after 12 seconds and says so.

Free-tier quota is 2.5M RPC calls and 500 monthly active users. Exceeding it pauses the project.

## PulseChain 369 and 943

The protocol is fine. The wallets are the wall.

Nothing in Reown blocks chain 369. The relay is chain-agnostic, the dashboard has no chain
setting, and 369 is in the WalletConnect chain registry. Chain 943 is not, and no wallet anywhere
in that registry declares it.

**The one decision that makes this work at all: optional namespaces, never required.** A required
namespace is a condition of the session — a wallet that does not know 369 must refuse the whole
connection, and nearly every wallet does. An optional one is a request, so the wallet approves
what it has and ignores the rest. We send no required namespaces.

Which wallets a PulseChain reader can actually connect with:

| Wallet | 369 | Verdict |
| --- | --- | --- |
| Internet Money (IM Wallet) | ships it, **and 943** | works |
| Pulse Wallet | ships it | works |
| SafePal | native PLS since app v4.0.0 | works; the WalletConnect leg is unverified on a device |
| MetaMask mobile | must be added | works, and the only mainstream wallet where our app can add the chain over the session |
| OneKey, Tangem, Zeal | registry says yes | likely; not source-verified |
| Rabby extension | must be added | injected only, so it comes through EIP-6963, not this |
| Rabby mobile | — | **no** — it rejects `wallet_addEthereumChain` from WalletConnect outright |
| Trust, Coinbase, Zerion, imToken | must be added | **no** over WalletConnect; imToken says so in its own documentation |
| Rainbow, Uniswap Wallet | cannot add a custom chain | **no** |
| Ledger Live, Trezor Suite | hardcoded chain lists | **no** |
| Safe | — | contracts are live on 369, but a Safe there has no WalletConnect route out |

Both hardware devices are clean underneath: Trezor serves a signed PulseChain definition for 369
and 943, and Ledger has a production-signed descriptor for 369. The device is never the blocker;
the interface in front of it is. A Ledger behind MetaMask mobile works. Ledger Live does not.

This is worth building. Four of the working wallets need no setup at all, and three of those four
are the wallets a PulseChain user is most likely to own.

**Our shape helps here, by accident.** AppKit filters its wallet list by chain, and Internet
Money's registry entry is stale — it declares a retired testnet, never 369 — so AppKit would hide
the single best wallet for this chain. We never query that directory. One generic QR code reaches
every wallet in the table above.

## Traps found in the package source

Each of these has a test that fails without its fix.

**`eth_chainId` answers with a number.** Not hex. The provider serves the method itself, out of
the session, and returns `parseInt(defaultChain)`. Read that through `parseInt(x, 16)` and 943
becomes 2371, so `ensureChain` decides the wallet is on the wrong chain, asks it to switch to the
chain it is already on, and then throws at somebody with nothing to switch.

**`rpcMap` is read under two different key spellings.** `rpcMap['eip155:943']` when the package
builds its HTTP providers from the namespace chains, and `rpcMap['943']` when it falls back for a
chain it meets later. Fill one and the other path reaches for `rpc.walletconnect.org`, which does
not carry PulseChain — so reads time out instead of failing. We fill both.

**A wallet connects and then stays where it was.** Usually Ethereum. Nothing in the handshake
tells it to move, so without a guard the header shows an address and every signature after it is
made under another chain's domain. We run the same `ensureChain` ladder the extension path runs.

**A refused relay never gives up.** Measured in a browser against a project id the relay rejects:
the socket is refused, the client retries forever, and nothing comes back — no throw, no event, no
code. The dialog sat at "opening the connection" indefinitely. The wait is now bounded at 12
seconds, and bounded on the code ARRIVING rather than on somebody scanning it. Once a code is on
screen a person may take as long as they like.

**`wallet_addEthereumChain` must carry the chain's public endpoint, not our gateway.** MetaMask
compares the first URL in that payload against `chainid.network`, and raises an error-severity
warning when they disagree. Our payload already sends `https://rpc.pulsechain.com`; keep it that
way. The gateway is what the app reads through, which is a separate setting and none of the
wallet's business.

## What this does not do

- **No session survives a reload.** Close the tab and the next visit starts disconnected. The
  relay client is not loaded on a cold page, and loading 132 KB on every first paint to find out
  whether somebody once scanned a code is the wrong trade. Revisit if people ask.
- **No wallet directory, no deep links.** We list the extensions this browser announced and show
  one code. There is no ranked list of 500 wallets and no "open in Trust Wallet" button.
- **No device test.** Every wallet verdict above comes from reading source, registries and vendor
  documentation. An hour with a real phone against MetaMask mobile, Internet Money and SafePal
  would settle the paths this feature rests on.
- **Chain 943 will warn twice in MetaMask.** viem calls it "PulseChain V4" / `v4PLS`;
  `chainid.network` calls it "PulseChain Testnet v4" / `tPLS`. MetaMask compares both and
  complains about each. Testnet only, and not worth moving the registry for.

## Where the code is

- `app/src/lib/walletconnect.ts` — the session: the project id, the namespaces, the connect, the
  relay watchdog, the disconnect. The only dynamic import.
- `app/src/lib/wallet.ts` — unchanged in shape. It gained a session slot that `injected()` prefers,
  and a chain reader that tolerates a numeric answer. The EIP-6963 path is untouched.
- `app/src/components/WalletPicker.tsx` — the dialog. Our button, our list, our surface.
- `app/src/components/QrCode.tsx` — the code, as an SVG built from `uqr`'s grid.
