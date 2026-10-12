# The SDK and the app: what they must do

**Status: Proposed.** Written on 2026-09-23 against commit `70bff5e` (local master). Nothing here
is approved yet. The owner approves it or edits it.

## Why this document exists

The owner: "we should be writing specs so that we can reference our intent against a formal
document."

This spec states the intent for `sdk/src` and `app/src`. It is not a code tour. Each rule has a
MUST or a MUST NEVER, and a WHY. Each WHY cites its source: a spec, a doc, a code comment or a
commit. Where no source records the intent, the rule is an **OPEN QUESTION (owner)**. I did not
promote code into intent without a source.

Code is cited by file and symbol name, never by line number. Line numbers rot (see
`keep-cited-source-edits-line-neutral`).

### How to read the keywords

- **MUST** and **MUST NEVER** are requirements. Code that breaks one is a defect.
- **SHOULD** is a strong default. Break it only with a written reason.
- Each requirement has an ID, for example `SDK-INT-1`. The traceability table at the end maps
  each ID to the tests that pin it.

### What this spec depends on

| Document | Status | Used for |
|---|---|---|
| `2026-08-10-prove-cash-design.md` | Design of record | §6.4 custody, §10.1 keepalive, §11.5 ladder |
| `2026-08-12-surfaces-and-claims.md` | Live (per `docs/README.md`) | APP-CLAIM |
| `2026-08-17-i18n.md` | Built | APP-I18N |
| `2026-08-17-responsive-visuals.md` | Built | APP-UI |
| `2026-08-26-neutral-protocol.md` | Built | SDK-CFG, APP-SIGN |
| `2026-09-03-the-signed-intent-before-mainnet.md` | Built | SDK-INT |
| `2026-09-23-fee-sink-fixed-destination.md` | Approved 2026-09-23, on branch `feat/fee-sink-fixed` (`ce37983`), not built | SDK-CFG, APP-SIGN |
| `docs/WALLETCONNECT.md` | Built | APP-WAL |
| `ui-layout-standards` | Owner policy, recorded outside the repo | APP-UI |

Where this spec and the contract disagree, `contracts/src/ProveSettlement.sol` is the authority.
The SDK and the app copy the contract. They never lead it.

---

# Part 1. The SDK (`sdk/src`)

## SDK-INT. Build and sign an intent (`intent.ts`)

**SDK-INT-1. The SDK MUST hash an intent exactly as the contract does.** `TYPES` MUST list the
fields in the order of the contract's `INTENT_TYPEHASH`. `intentHashOf` MUST name every field.

WHY: the `TYPES` comment says "change one line here and every signature this package produces
becomes unspendable." A past bug hard-coded `feeTo` as `ZERO` in `intentHashOf`. The test
"intentHashOf itself matches the fixture, field for field" exists because of it.

**SDK-INT-2. The typed-data fixture MUST be the only binding between Solidity and TypeScript.**
`contracts/test/Fixture.t.sol` `test_WriteEip712Fixture` writes
`app/src/lib/__fixtures__/eip712.json`. CI MUST fail when a contract run changes that file. CI
does this with `git diff --exit-code app/src/lib/__fixtures__/` in `.github/workflows/ci.yml`.
The SDK tests MUST read the fixture, never a copy of its numbers.

WHY: the fixture header says "This is the only thing that binds them… CI fails if a run changes
it." `test_ATypeScriptSignatureRecoversOnChain` proves that a signature made by viem recovers on
chain.

**SDK-INT-3. `signingDomain` MUST throw when the chain has no live settlement.** `domain()` MAY
stay permissive, because reading is not signing. Every signature path MUST go through
`signingDomain`.

WHY: commit `1655e35`: "A maker could sign a mainnet intent against `verifyingContract = 0x0`…
Seven offers reached the public mainnet archive." The `signingDomain` comment: the guard "sits
under every signature rather than in front of one form."

**SDK-INT-4. `decodeIntent` MUST return null for an unknown version or bad bytes. It MUST NEVER
throw, and it MUST NEVER guess.** A new optional field MUST use a presence bit, not a version
bump. A new custody form MUST be a new kind.

WHY: the codec comment: "a misread intent is worse than a dropped one." Presence bits save bytes
"because proof of work charges by the byte." Spec `2026-09-03-the-signed-intent-before-mainnet.md`
Part 1 sets the wire rules.

**SDK-INT-5. Rounding MUST favour the maker.** `grossOut` rounds up. The fee rounds down.

WHY: `2026-08-12-surfaces-and-claims.md` claim "Rounding always favours the maker", and
`docs/FEE-MODEL.md`.

**SDK-INT-6. `minOutAt` MUST price an unknown curve kind as the straight line,** exactly as the
contract does.

WHY: the `minOutAt` comment: "The two readers agree deliberately, and they change together on
the day a settlement implements one."

**SDK-INT-7. `liveWindow` and `authUsableWindow` MUST treat EIP-3009 bounds as exclusive at both
ends.** An empty overlap means a dead offer.

WHY: the `authUsableWindow` comment: "this function is the only thing that will say so."

> **OPEN QUESTION (owner) — one signing path.** The SDK exports `signingDomain` and `TYPES`, but
> not a `signIntent`. The app signs in `app/src/lib/wallet.ts` `signIntent`, and 24 scripts
> build their own call (commit `1655e35`). Options: (a) the SDK exports `signIntent`, and every
> caller uses it; (b) keep today's shape, and rely on `signingDomain` alone.

> **OPEN QUESTION (owner) — flag combinations.** `_termsOk` refuses `FLAG_PERMIT2` together with
> `FLAG_ESCROW`. `encodeIntent` does not. Options: (a) `encodeIntent` refuses every combination
> `_termsOk` refuses; (b) the chain stays the only check.

## SDK-CUS. Custody detection and approvals (`custody.ts`, `settlement.ts`)

### The ladder as it is today

§11.5 of the design predates the relayer, Permit2 and park. This spec replaces §11.5 for the
ladder. The differences:

| §11.5 said | The code does | Source |
|---|---|---|
| Three rungs: authorization, escrow, approval | Five rungs: authorization, escrow, permit2, permit, approval (`app/src/lib/custody.ts` `RUNGS`) | `7f4620c` |
| Two rungs lock "on deploy" | All five rungs lock when the settlement is not live | `1655e35` |
| The allowance goes to the settlement | The allowance goes to `ProveRelayer`, read with `approvalTarget` | `NETWORKS[943]` comment |
| Escrow exit is a pending unlock with a countdown | No cooldown. `withdraw` is one transaction. `park` moves escrow to parked capital | `66c43fa`, `2026-09-08-delegation-and-bulk-maker-actions.md` |
| Permit2 AllowanceTransfer (§6.4, before amendment) | Permit2 SignatureTransfer | §6.4 as amended |

**SDK-CUS-1. `strongestRung` MUST pick the first unlocked rung in `LADDER` order.** The order is
authorization, escrow, permit2, permit, approval. Security leads, and gas breaks ties.

WHY: the `RUNGS` comment: "Security leads and gas breaks ties… neither permit2 nor permit is ever
auto-selected. Both are overrides."

**SDK-CUS-2. The fallback rung MUST NEVER be permission to act.** A caller MUST ask
`RUNGS[mode](ctx).lock` before it signs or sends.

WHY: the `RUNGS` comment: "The fallback is a rung to draw, not permission to use one." The
zero-domain incident (`1655e35`) went through the fallback.

**SDK-CUS-3. Every rung MUST lock when `settlementLive` is false.** `approveToken`,
`approvePermit2` and `approveRelayer` MUST throw on such a chain.

WHY: `1655e35`. `app/src/lib/signGate.test.ts` holds all three guards "because a fix in one of
them is worth nothing if the other two are the ones a future change removes."

**SDK-CUS-4. An EIP-3009 authorization MUST use `ReceiveWithAuthorization`, never
`TransferWithAuthorization`.**

WHY: commit `4c1d7ba`. A stranger can relay a Transfer-type authorization to the token directly
and strand the maker's funds.

**SDK-CUS-5. A permit or Permit2 spender MUST be the relayer, never the settlement.**
`permit2Domain` MUST NEVER carry a `version` field.

WHY: the `permitRequest` comment. The `permit2Domain` comment: a version field "recovers to the
wrong address — silently… reaches the solver as `EscrowShort`."

**SDK-CUS-6. `setAllowance` MUST zero an allowance first only when the raise reverts in an
`eth_call`.** A probe that fails for another reason MUST NEVER count as an answer.

WHY: USDT-shaped tokens refuse a non-zero to non-zero raise. `approve.test.ts` pins nine cases.

**SDK-CUS-7. `supports3009` and `supportsPermit` MUST key their cache by chain and token.**

WHY: one address can be two tokens on two chains (commit `659a737`). See SDK-TOK-1.

> **OPEN QUESTION (owner) — request builders on a dead chain.** `authorizationRequest`,
> `permitRequest` and `permit2Request` have no `settlementLive` guard. Only the app's ladder lock
> stops them. Options: (a) guard every builder in the SDK; (b) rely on the ladder and
> `signingDomain`.

> **OPEN QUESTION (owner) — the facilitator cache.** `supports3009` caches for one hour. Its
> comment says the capability "never changes". Options: (a) cache forever per chain and token;
> (b) keep one hour.

## SDK-MKT. Market quotes (`market.ts`)

**SDK-MKT-1. `quoteAll` MUST give each key one of three answers:**

| Answer | Meaning |
|---|---|
| a `Quote` | At least one leg priced. |
| `null` | No route. Every venue probe and every leg answered, and none priced. |
| key absent | Unknown. A 429, a timeout or an unreadable probe. It is not a fact about the market. |

**SDK-MKT-2. The SDK and the app MUST NEVER turn "unknown" into "no route".** A read failure
MUST leave the key absent. A consumer MUST draw an absent key as loading, never as "no route".
`app/src/hooks/useBoard.ts` does this with `quotes.has(p.key) ? quotes.get(p.key) : p.quote`.

WHY: the `quoteAll` comment: "A `null` here once put 'no route' on every board row during a rate
limit." Commit `2ed4f0c`: "mistaking a revert for a rate limit costs a retry, mistaking a rate
limit for a revert prints a falsehood." Commit `94acd6e`: "an unknown quote keeps its loader."

**SDK-MKT-3. `confirmVenues` MUST NEVER cache `unknown`.** It MUST report a failed probe to every
caller that shares the batch.

WHY: commit `b56cf74`.

> **OPEN QUESTION (owner) — bad input.** `quoteAll` answers `null` for a same-token pair or a zero
> amount. That is a claim about the input, not about the market. Options: (a) keep `null`;
> (b) throw a caller error; (c) omit the key.

## SDK-DEP. The deployed-ABI guard (`deployed.ts`)

**SDK-DEP-1. `batchRead` MUST refuse a call to a function newer than the chain's deployment.**
`assertDeployedAbi` compares `Network.deployedOn` with `ABI_CHANGES[].landed`. A build from the
same day as the change counts as older. The error MUST name the date, the commit and what the
chain runs instead. A chain with no settlement is not judged.

WHY: commit `f71905d`: "refusing a call that would have worked is one loud error somebody fixes,
and allowing one that cannot work is the silent revert." Not redeploying 943 was a decision: "a
redeploy mints a new relayer and costs every approval-rung maker a second re-approval."

**SDK-DEP-2. An `ABI_CHANGES` entry MUST be added when a deploy is skipped,** not when the source
changes. `deployedOn` MUST copy `deployedAt` from `contracts/deployments/<id>.json`.

WHY: the `ABI_CHANGES` comment.

**SDK-DEP-3. ABIs MUST be generated, never typed by hand.** CI runs `npm run check:abi`.

WHY: commit `238e0a3` and the `gen-abi.mjs` header: "six entries went stale… every escrow and
fill call would have failed on chain."

> **OPEN QUESTION (owner) — reach of the guard.** The guard covers `batchRead` only. Direct
> `readContract` calls (`approvalTarget`, `permit2Target`) and every write skip it. Options:
> (a) wrap writes and direct reads too; (b) narrow `Call.functionName` to the ABI's names;
> (c) keep the gap and document it.

## SDK-MC. Multicall and batch reads (`multicall.ts`)

**SDK-MC-1. A call result MUST be `reverted` only with positive evidence of a reply.** Everything
else MUST be `unreadable`. A rejected `aggregate3` chunk MUST make every call in it `unreadable`.

WHY: commits `2ed4f0c` and `94acd6e` (see SDK-MKT-2). A 429 on a whole chunk once read as "revert"
on every call.

**SDK-MC-2. A failed Multicall3 probe MUST NEVER be cached as "absent".**

WHY: commit `da10477`: "one dropped packet at startup demoted every batch read for the life of
the tab."

**SDK-MC-3. No `eth_call` MUST exceed `MULTICALL_MAX_CALLDATA` (40 000 bytes).**

WHY: the gateway accepts 100 KB and refuses 104 KB with HTTP 413 (the `MULTICALL_MAX_CALLDATA`
comment).

## SDK-KA. Keepalive (`keepalive.ts`)

**SDK-KA-1. The keepalive list MUST be one list per chain,** stored under
`provecash.mine.<chainId>`. The chain MUST be in the key, not in a field on the row.

WHY: commit `9844e97` and `mainnetFlip.test.ts`. Design §10.1: "Anyone may re-post… Nobody pays
for this."

**SDK-KA-2. `migrate` MUST move legacy rows to `DEFAULT_CHAIN`. It MUST NEVER drop them.**

WHY: the `migrate` comment: "Dropping them was the alternative and it is the worst one." A kept
intent is a signed offer that nothing can rebuild (commit `659a737`).

**SDK-KA-3. `keepAlive` MUST stop when the process moves to another chain during a pass.** It MUST
run one pass at a time.

**SDK-KA-4. Expiry SHOULD be judged against the chain clock.** `myIntents` uses `Date.now()`
today.

WHY: owner memory "Price against the chain clock": "Date.now() runs seconds ahead of
block.timestamp; it broke three things in one day." Commit `be0d39c`. This is a finding, not a
built rule.

## SDK-TOK. Tokens and the token list (`tokens.ts`, `tokenlist.ts`)

**SDK-TOK-1. The token cache MUST be keyed by chain AND address.** `chainId` MUST be a required
argument. It MUST NEVER default to `getChainId()`.

WHY: commit `659a737`: "HEX sits at one address on both 369 and 943, so the registry's two entries
already shared a single slot… The mainnet flip is what makes it reachable."

**SDK-TOK-2. `tokenInfo` MUST return null when it cannot read `decimals`. It MUST NEVER guess 18,
and it MUST NEVER cache a failed read.** Zero decimals is a real answer.

WHY: commit `da10477`: a guessed 18 "signs `parse(amountIn, 18)` for a six-decimal token: an offer
a million million times the size… The maker's whole balance for nothing."

**SDK-TOK-3. Legacy token rows MAY be dropped.** A token row is a cached answer to a public read,
and a read rebuilds it (commit `659a737`). Contrast SDK-KA-2.

> **OPEN QUESTION (owner) — the token list cache.** `tokenlist.ts` stores one list under
> `provecash.tokenlist` and filters rows by a `chainId` field. Commit `659a737` rejected that
> shape for the other caches: "a tagged single list puts that back in a predicate every future
> reader has to remember." Options: (a) key the list per chain; (b) record an exemption, because
> the upstream list is tagged by chain.

## SDK-CFG. Networks, the registry and fee sinks (`config.ts`, `fee.ts`)

**SDK-CFG-1. `settlement(chainId)` MUST be the one resolver.** The order is: in-process override,
stored override, registry. `settlementLive` MUST read the resolver. `deployedOn` MUST read the
registry.

**SDK-CFG-2. A chain with no settlement MUST carry the zero address in `NETWORKS`.** Today 369
has `settlement: ZERO_ADDRESS` and `deployedOn: null`. The SDK, the store and the app MUST treat
such a chain as dead: no signature, no ingest, no board.

WHY: `1655e35`. `store/` `ingest` refuses on `!settlementLive(chainId)`.

**SDK-CFG-3. `DEFAULT_CHAIN` MUST be a chain that can settle.** It MUST NEVER be
`NETWORK_LIST[0]` by position.

WHY: the `DEFAULT_CHAIN` comment cites the seven mainnet offers.

**SDK-CFG-4. Turning mainnet on MUST change nothing for testnet.** The flip is an override, never
an edit to the registry.

WHY: commit `87caeb1` and `mainnetFlip.test.ts`.

**SDK-CFG-5. Every address in `NETWORKS` MUST be checksummed.**

**SDK-CFG-6. `MAX_FEE_RATE` (1e18) MUST be the only ceiling in the SDK.** It is arithmetic, not
policy. `grossForNet` MUST throw at or above it.

WHY: `2026-08-26-neutral-protocol.md`: "prove.cash takes no fee."

### Fee sinks, once the approved redesign lands

The owner approved `2026-09-23-fee-sink-fixed-destination.md` on 2026-09-23. It is not built at
`70bff5e`. The rules below apply when it lands. Until then, SDK-CFG-7 to SDK-CFG-9 are untested
by definition.

The owner's words, from that spec: "we need one destination, we need 1 sink per intent" and "a
fee sink should be linked to a destination for all time."

**SDK-CFG-7. `sdk/src/config.ts` MUST list the registered sinks per chain.** Each entry MUST carry
the sink address, its `destination` and its `minRate`. The list MUST come from the chain's
registrations (`FeeSinkRegistered`), not from a hand-typed guess.

**SDK-CFG-8. The SDK MUST NEVER model a split.** One fee goes to one destination. `splitByWad`
and `FEE_SINK_WAD` from `feat/fee-sink-registry` MUST NOT survive the redesign.

WHY: the fixed-destination spec: "Splitting one fee across destinations, anywhere" is out of
scope, and "One fee is never divided."

**SDK-CFG-9. An intent with a non-zero `feeTo` MUST name a registered sink, and its rate MUST be
at least that sink's `minRate`, zero included.** An intent with `feeTo = 0` MUST sign
`feeRate = 0`, and it pays no fee.

WHY: settlement spec FE-8. The contract refuses an unregistered `feeTo` at every rate.

**SDK-CFG-10. "The default" MUST be resolved at signing, never at fill time.** When a maker
chooses the default fee, the SDK and the app MUST read `defaultFeeSink()` and write that sink's
address as `feeTo` and its rate as `feeRate` into the intent they sign. They MUST NEVER sign
`feeTo = 0` to mean "the default". If the default cannot be read, or names a retired sink, they
MUST refuse to sign the default choice rather than sign zero or a stale value. A display of an
intent with `feeTo = 0` MUST show a fee of zero.

WHY: the owner, 2026-10-01: "no exceptions for the default. they should all be the same. override
the intent if you need to." Settlement spec OW-2: no owner action may change the rate or the
destination of a signed intent, so the default is a sign-time choice.

> **OPEN QUESTION (owner) — `suggestFeeRate`.** `fee.ts` `suggestFeeRate` has no consumer and no
> test. Options: (a) delete it; (b) wire it into the sign form, bounded below by the chosen
> sink's `minRate`.

> **OPEN QUESTION (owner) — where the sink list comes from.** Options: (a) a static list in
> `config.ts`, checked in CI against `feeSinks(address)` on chain; (b) read `FeeSinkRegistered`
> logs at run time. Option (b) is always current but costs a log query per load.

## SDK-RFQ. Quotes and their encryption (`rfq.ts`, `rfq-crypto.ts`)

### What is encrypted, and to whom

- A sealed quote (wire version 2) is `counterparty(20) ‖ ephemeral(32) ‖ nonce(24) ‖ ciphertext`.
  The plaintext is a whole version 1 quote.
- It is sealed to one counterparty: the taker the maker names.
- It hides the size, the price, the expiry, the maker's address and both signatures.
- It does not hide the post size, the post time, or the counterparty address. The board and any
  reader can see those. The `rfq.ts` comment: "It hides nothing else."

### Key derivation

1. The counterparty signs the fixed message `RFQ_KEY_MESSAGE` = `prove.cash rfq key v1`.
2. HKDF-SHA256 over the 65 signature bytes, info `prove.cash/rfq/x25519/v1`, gives the x25519
   secret.
3. `seal` makes a fresh ephemeral x25519 key per quote. ECDH output goes into HKDF-SHA256, with
   the counterparty address as salt and info `prove.cash/rfq/seal/v1`.
4. The cipher is XChaCha20-Poly1305, with a random 24-byte nonce.

### Threat model

| Party | Can see | Cannot see |
|---|---|---|
| The board, the relay, any reader | counterparty, size of the post, time | terms, maker, signatures |
| The counterparty | everything | — |
| Anyone with the counterparty's key signature | everything, forever | — |

**SDK-RFQ-1. `RFQ_KEY_MESSAGE` MUST NEVER change.**

WHY: the comment: "Never change it — it IS the key."

**SDK-RFQ-2. The counterparty address MUST be the HKDF salt, and the envelope MUST NOT open under
another address.**

WHY: a re-headed copy must fail (`rfq-crypto.test.ts` "the envelope is bound to the address it
names").

**SDK-RFQ-3. `open` MUST return null for every AEAD or point failure. It MUST NEVER say why.**

WHY: the `open` comment: "a guess about why a decryption failed is a side channel."

**SDK-RFQ-4. A reader MUST recover the announcer's address from the signature. It MUST NEVER take
an address off the wire.** The newest signed `issuedAt` wins.

**SDK-RFQ-5. The app MUST NEVER persist the derived key.** `app/src/rfq/useRfqKey.ts` keeps it in
memory and drops it when the account changes.

WHY: the `useRfqKey` comment: "`localStorage` would turn a key that can be re-derived in one
signature into a key that can be stolen."

**SDK-RFQ-6. Quotes MUST travel on `RFQ_CATEGORY` only,** and an exclusive quote MUST NEVER reach
the public book. `mirrorFor` MUST clamp the mirror's expiry to `MIRROR_TTL`.

WHY: the `mirrorFor` comment: copying the quote's expiry "handed the maker a free option."

**SDK-RFQ-7. Contract wallets MUST NOT announce a key.** They give no deterministic signature.

WHY: `rfq-crypto.ts` header. That header also records why `eth_decrypt` was rejected: "MetaMask
deprecated it."

> **OPEN QUESTION (owner) — key rotation.** The key derives from one fixed signature. A leaked
> secret stays valid forever, and "newest `issuedAt`" cannot revoke it. The header records the
> risk: "Determinism is convention, not specification… XMTP shipped this pattern and later moved
> off it." Options: (a) add a version counter to the message (`v2`, `v3`) and announce the
> current one; (b) accept the risk and state it in the UI.

## SDK-BRD. The board wire and proof of work (`board.ts`, `submit.ts`, `store/`)

**SDK-BRD-1. Every board post MUST carry proof of work.** The difficulty is
`(2^24 + len·10 000)·workMultiplier/workDivisor` (`difficultyFor`). The client MUST hash exactly
as the node does: `SHA256(version ‖ blockHash ‖ payloadHash ‖ M ‖ D ‖ nonce)` below `2^256 / D`.
The node's `msgboard_` module checks the work. That check is not in this repo.

WHY: commit `857ce2c`. A change in the node's hash went unexamined for a week.

**SDK-BRD-2. `PROVECASH_CATEGORY` and `RFQ_CATEGORY` MUST stay different.**

**SDK-BRD-3. The delta watermark MUST come from the messages, never from the chain head.**

**SDK-BRD-4. `grindAndSubmit` MUST believe the board over the transport.** A transport error
followed by the message on the board is a success.

WHY: the `submit.ts` comment. `msgboard_addMessage` returned -32603 on every post while the post
landed (measured on 943, 2026-08-19).

**SDK-BRD-5. Every intent MUST enter through `store/` `ingest`.** `ingest` MUST refuse a chain
with no settlement and an intent that fails `verifyOnce`. The board, the archive backfill and a
solver all arrive through it.

WHY: the `ingest` comment. `archive.ts` "proves nothing", so every archive row is verified
locally.

> **OPEN QUESTION (owner) — the verify cache.** `verifyOnce` keys its cache on
> `chainId:intentKey`, not on the settlement. After a settlement override, a cached verdict can be
> stale. Options: (a) add `settlement(chainId)` to the key; (b) clear the cache in
> `setSettlementOverride`.

## SDK-ERR. Error text

**SDK-ERR-1. `explainRevert` MUST return one line.** When nothing decodes, it MUST print the raw
selector rather than guess a cause.

WHY: `0xe450d38c` "wore three different causes in one afternoon on 943" (`revert.ts`).

**SDK-ERR-2. Error text MUST NEVER carry a credential.** A viem error carries the whole RPC URL,
and a key in a path is a credential.

WHY: owner memory "viem errors carry the whole URL": "logging a caught error printed the registry
key 32 times; redact at the print." CI `tools/check-redact.py` scans `app/scripts/**` only.

> **OPEN QUESTION (owner) — redaction in the SDK.** `explainRevert` can return `shortMessage` or
> `message`. Options: (a) move `redact` into the SDK and apply it in `explainRevert`; (b) extend
> `check-redact.py` to `sdk/src`; (c) leave redaction to each caller.

---

# Part 2. The app (`app/src`)

## APP-BRD. The board and its filters (`App.tsx`, `hooks/useBoard.ts`)

**APP-BRD-1. The board MUST show public offers only.** `boardQuery` MUST ask for
`executor: { open: true }`. It MUST NEVER name an executor of its own.

WHY: the `boardQuery` comment: "It is the definition of a public order book: an intent pinned to
any executor is spoken for."

**APP-BRD-2. The board MUST NEVER draw a row it cannot price.** A row whose token decimals are
unknown is hidden. See SDK-TOK-2.

**APP-BRD-3. The board MUST be withheld on a chain with no settlement.** `boardOff(chainId)`
hides the figures, the filters, the table and the tray. Only `empty.board.off` shows.

WHY: the `boardOff` comment: "every one of them is a way of offering these rows to somebody."

**APP-BRD-4. The app MUST NEVER claim an absence before the source answers.** `awaitingBook`,
`quotesAnswered`, `boardPresence` and `health` MUST be null until the first answer. The stats MUST
show a pulse, not "0" or "—".

WHY: commit `94acd6e`, "nothing claims empty before it asks". Owner memory "Null before the first
answer": "the app said 'closed' and 'off-board' on every load."

**APP-BRD-5. The token filter MUST filter by address, never by symbol.** A `dir` with no token
MUST be dropped. Two tokens with one symbol MUST show their short address.

**APP-BRD-6. Keepalive MUST read the unfiltered poll only.**

WHY: the `useBoard` comment: "a filter must not trigger re-posts."

**APP-BRD-7. The selection MUST live in memory only.** It MUST NEVER enter the URL. A chain switch
MUST clear it. An expired row MUST NOT be selectable.

> **OPEN QUESTION (owner) — the sort.** Code orders open rows first, then expired rows by newest
> expiry, then the chosen sort. Rows with no quote sort last under `size`. No source records
> this. Options: (a) adopt it as written; (b) hide rows with no quote under `size`.

> **OPEN QUESTION (owner) — offers that the chain will refuse.** After the sink redesign, an
> offer with `feeRate > 0` and an unregistered `feeTo` fails `_termsOk` at every fill. Options:
> (a) hide it; (b) show it with a badge; (c) show it and let the fill simulation refuse it.

## APP-SIGN. The sign form (`components/Compose.tsx`, `rfq/MakeQuote.tsx`)

The sign button is enabled only when `canSign` is true. `canSign` is `ready && fault === null`.

**APP-SIGN-1. The form MUST refuse to sign in each of these cases:**

| # | Case | Code | Source |
|---|---|---|---|
| a | No account. The button opens the wallet picker instead. | `account` | — |
| b | The chain has no live settlement (a dead chain). | `live`, and SDK-INT-3 under it | `1655e35` |
| c | A token is missing, or both tokens are the same. | `tokensOk` | — |
| d | An amount is zero, will not parse, or has more decimals than the token. | `amountError` | `Compose.tsx`: "a floor that will not parse is a floor of zero, and an intent asking zero is a gift to whoever fills it." |
| e | A fee rate will not parse. | `rateError` | `Compose.tsx`: a maker typing `0,5` once "signs an offer charging nothing." |
| f | A fee rate at or above 100%. | `rateError`, `sign.rate.refused` | SDK-CFG-6 |
| g | A fee rate above 20% (`MAX_TYPED_RATE`). | `rateError`, `sign.rate.invalid` | `Compose.tsx`: "a form catching a typo… It binds this form and nothing else." |
| h | A custom fee destination that is not a valid address. It MUST NEVER fall back to the default. | `feeTo` | `Compose.tsx`: "silently paying the default something the maker meant to redirect is the one outcome this control must not produce." |
| i | An EIP-3009 authorization that opens after the offer expires. | `faultOf` → `'dead'` | `Compose.tsx`: "a dead schedule is the one mistake nothing downstream will catch." |

**APP-SIGN-2. When the fee-sink redesign lands, the form MUST also refuse:**

| # | Case | Source |
|---|---|---|
| j | A fee rate above zero with a `feeTo` that is not a registered sink on this chain. | fixed-destination spec, "Terms check" |
| k | A fee rate above zero and below the chosen sink's `minRate`. | fixed-destination spec: "refuses a rate below the sink's floor before signing" |
| l | Any offer that `fillability` answers `BadTerms_` for. | fixed-destination spec: "The app calls the same view before a maker signs" |

The form MUST offer one choice per registered sink. The console MUST show one destination, never
a split. None of this is built at `70bff5e`. Today the form offers the registry default
(`feeTarget()`, the PulseX buy-and-burn address) or any typed address. The app never calls
`fillability`.

WHY: the fixed-destination spec, "What each layer must do". Note: commit `cf61733` (2026-09-03)
quoted the owner as "FEESINK is never ever going to be used." The 2026-09-23 approval reverses
that.

> **OPEN QUESTION (owner) — the custom address.** After the redesign, a typed address is valid
> only if it is a registered sink. Options: (a) remove the custom chip; (b) keep it for
> `feeRate == 0` only; (c) keep it and refuse any unregistered address.

> **OPEN QUESTION (owner) — the default fee destination.** The PulseX buy-and-burn address is a
> raw address, not a `FeeSink`. At any rate above zero, `_termsOk` will refuse it. Options:
> (a) deploy and register a sink for it at redeploy time (the spec's runbook note says so);
> (b) default to no fee.

> **OPEN QUESTION (owner) — an empty rate on a sink with a floor.** An empty rate means zero fee,
> and the contract then refuses the sink if its floor is above zero (FE-8). Options: (a) allow it, and label it "no fee"; (b) fill
> the sink's `minRate` in for the maker; (c) refuse until the maker types a rate.

**APP-SIGN-3. The typed amount MUST be the floor, net of the fee.** The form MUST sign
`grossForNet(net, rate)`, rounded up. Decay MUST be on by default.

WHY: commit `0fa8c47`: "The typed field is the floor now, not the start. A field labelled 'you
want at least' is a guarantee." Commit `d1dd385`: "the fee comes out of the maker's number."

**APP-SIGN-4. The form MUST NEVER move a maker's number while they read it.** A change of rung
MUST NOT clamp the start time.

WHY: `Compose.tsx`: "a clamp that moves a maker's number while they read it hands them a
signature they did not agree to."

**APP-SIGN-5. `grossForNet` MUST run only after `rateError` is null.**

WHY: it throws at the ceiling, and "a throw during render is a blank page."

**APP-SIGN-6. `MakeQuote` MUST apply APP-SIGN-1 (b) to (h).** It MUST also refuse a counterparty
without a valid checksum, and a quote to oneself (`selfQuote`).

## APP-MINE. The Mine tab (`components/Portfolio.tsx`)

**APP-MINE-1. The parked table MUST render in every branch, above the offers.** It MUST show even
when the maker has no offers. A failed log read MUST delete nothing.

WHY: the `Portfolio` comment: "Hiding this behind the offers table would tell that maker their
money is gone."

**APP-MINE-2. `needsAction` MUST keep any row that holds money or a live signature.** An escrow
read that failed counts as money.

WHY: "Hiding a row hides a deposit."

**APP-MINE-3. Each row MUST offer withdraw where the contract holds money, and cancel where it
holds only a signature.** An unfunded live escrow offer gets a cancel, because solvers can fund
it.

**APP-MINE-4. `withdrawParked` MUST be one call per token, with no recipient field.** The contract
pays `msg.sender`.

**APP-MINE-5. The bulk switch (`invalidateBefore`) MUST be drawn only when the maker is the
connected account, the floor has been read, and `bulkRetire` returns a plan.** Otherwise there
MUST be no button at all. The switch MUST take two steps, list what it kills and what it spares,
and say that it returns no money.

WHY: `Portfolio.tsx`: "a disabled control is a claim that the action exists and is unavailable."
Lanes: `2026-09-08-delegation-and-bulk-maker-actions.md`, recommendation 1.

**APP-MINE-6. A reader of someone else's cleanup link MUST see no action buttons.**

> **OPEN QUESTION (owner) — fee claim.** No `claim` UI exists in `app/src`. After the redesign,
> `claim(sink, token)` pays the sink's destination. Options: (a) no UI; the sink operator uses
> the admin CLI; (b) a read-only "booked" line per sink; (c) a claim button anyone can press,
> since `claim` pays a fixed destination.

## APP-FILL. The fill tray (`components/BatchTray.tsx`)

**APP-FILL-1. The fill button MUST stay disabled until `simulateFills` returns ok,** and while the
chain is not live or a fill is in flight.

WHY: `BatchTray.tsx`: "an executor never pays to learn an intent went stale."

**APP-FILL-2. The tray MUST cap the fee it accepts with `maxFeeRateFor(items)`.**

## APP-LAND. The landing page and the fill console (`landing/`)

**APP-LAND-1. The landing page MUST NEVER import viem, the SDK, the board client or the proof of
work worker.** The dapp MUST arrive through `React.lazy` (`Root.tsx`). A landing module that needs
SDK logic MUST copy it and pin the copy with a parity test.

WHY: `2026-08-12-surfaces-and-claims.md`: "**Anything added to the landing page that pulls in the
SDK undoes the only reason the split exists.**"

**APP-LAND-2. The landing page MUST make only the claims in APP-CLAIM.**

## APP-RFQ. Exclusive quotes (`rfq/`)

**APP-RFQ-1. A quote MUST be flat: no decay, no partial fill, no curve.** Its executor MUST be the
venue.

**APP-RFQ-2. `rfqVenue(chainId)` MUST return null on a chain with no settlement.**

**APP-RFQ-3. The key MUST follow SDK-RFQ-5.**

> **OPEN QUESTION (owner) — a stale venue.** `venue.ts` records that a stale venue fails "silent
> through five steps". Options: (a) read `venue.settlement()` and compare it with the resolver
> before quoting; (b) keep `check-addresses.ts` as the only check.

## APP-WAL. Wallets (`lib/wallet.ts`, `lib/walletconnect.ts`, `components/WalletPicker.tsx`)

**APP-WAL-1. The app MUST prefer EIP-6963 discovery over `window.ethereum`.** The order is: an open
WalletConnect session, the preferred rdns, the lowest rdns, then `window.ethereum`. The choice
MUST be the same on every load.

WHY: commit `dfcf71d`. The `wallet.ts` comment: "A person must not get one wallet this morning and
another this afternoon."

**APP-WAL-2. The app MUST survive a provider whose Proxy breaks a JS invariant.** Every injected
read MUST go through `readFrom`, which falls back to a property descriptor. `hasWallet` MUST
NEVER throw.

WHY: commit `dfcf71d`: Brave's proxy threw "'get' on proxy: property 'on' is a read-only and
non-configurable data property…" in a mount effect, and "prove.cash/app went white."

**APP-WAL-3. WalletConnect MUST use `@walletconnect/universal-provider`, headless, with our own
UI.** The owner "asked for Reown without the prebuilt components" (`docs/WALLETCONNECT.md`).

**APP-WAL-4. The WalletConnect import MUST stay dynamic.**

WHY: `docs/WALLETCONNECT.md`: "The import must stay dynamic. That is the whole reason the number
above is 7.7 and not 140."

**APP-WAL-5. Without `VITE_REOWN_PROJECT_ID`, the phone half MUST be absent, not disabled.** An
empty variable counts as absent.

**APP-WAL-6. The picker MUST NEVER print the raw `wc:` URI.** It MAY offer a copy button.

**APP-WAL-7. WalletConnect MUST ask for chains as optional namespaces only,** and MUST give up on
a silent relay after 12 s.

## APP-I18N. Languages (`lib/i18n.ts`, `i18n/`)

The app ships **35 locales**: English and 34 translations. (The brief for this spec said 34
locales. The code, the i18n spec and commit `78e0ef4` all say thirty-five.)

**APP-I18N-1. Every locale MUST hold every English key, add only CLDR plural forms, keep every
placeholder, and leave no string empty.**

**APP-I18N-2. A missing key MUST fall back to English. The app MUST NEVER show a key.**

WHY: `2026-08-17-i18n.md`: "Missing key = English string, never the key."

**APP-I18N-3. Every `t()` and `tCount()` call MUST pass exactly the placeholders its key uses.**

**APP-I18N-4. Arabic and Hebrew, and only they, MUST set `dir="rtl"`.** `applyLocale` MUST set
`lang` and `dir` on `<html>`. Layout MUST use logical utilities (`ms-*`, `text-end`). Figures MUST
be isolated with `.num` or `.ltr`.

**APP-I18N-5. Route tokens, token symbols, addresses and units MUST NEVER be translated.**

WHY: `2026-08-17-i18n.md`: route tokens "are protocol, not copy."

**APP-I18N-6. Each language MUST have its own prerendered URL,** with a complete, mutual
`hreflang` set.

> **OPEN QUESTION (owner) — review records.** `npm run i18n:status` finds stale translation
> reviews. Its own comment calls that "the state worth failing a build over." CI does not run it.
> Options: (a) add it to CI as a gate; (b) run it by hand before a release.

## APP-ERR. The error boundary (`ErrorBoundary.tsx`, `lib/errors.ts`)

**APP-ERR-1. The error boundary MUST show only the first line of an error.** The full error goes
to `console.error` only.

WHY: `ErrorBoundary.tsx`: "viem puts the URL and the request body in the message — and an
endpoint with a key in its path is a credential. `errorLine` is that redaction."

**APP-ERR-2. No surface MUST put an unredacted error into the DOM,** including an attribute.

**Finding (defect):** `App.tsx` draws the board error as
`<span role="alert" title={error}>{firstLine(error)}</span>`. The `title` attribute carries the
whole raw message. That breaks APP-ERR-2. No test covers it.

**APP-ERR-3. `firstLine` alone is not redaction.** A URL can sit on the first line.

> **OPEN QUESTION (owner) — redact the first line too?** Options: (a) run a URL redactor over the
> line before display; (b) accept the first line as enough.

## APP-UI. Layout standards

These rules are owner policy. The owner stated them in the `ui-layout-standards` skill, which is
**recorded outside the repo** (in the owner's private checklist). The repo carries them only in
comments in `app/src/index.css` and in `2026-08-17-responsive-visuals.md`, which says: "The house
rules are the `ui-layout-standards` checklist."

The skill marks each rule **[stated]** (the owner said it) or **[inferred]** (read out of shipped
prove.cash code). Both are standing policy here.

| ID | Rule | Kind | Why (owner's words where recorded) |
|---|---|---|---|
| APP-UI-1 | One padding layer. A padded container MUST NOT hold a padded child. | stated | Two layers of `p-4` cost 64 px on a 375 px phone. `index.css` `.gutter`: "One gutter, one layer." |
| APP-UI-2 | Padding MUST be `p-2 sm:p-4`. `p-6` and above need a written reason. | stated | A 2026-07-21 sweep moved 58 wrappers to `p-2 sm:p-4`. `App.tsx`: "A centred empty state earns its p-8; nothing else on this page does." |
| APP-UI-3 | Outlines MUST be outset box shadows (`ring-1` is fine). No CSS `border`, no `divide-*`, no `ring-inset`, except on controls. | stated | An outset shadow costs no layout width. `index.css` `.hair`: "Borders survive only on controls." |
| APP-UI-4 | An element that can reach a viewport edge MUST have square corners. | stated | "if you are going to use curves only do so on buttons that will always be in padding, not on cards that will hit the edge of a viewport." |
| APP-UI-5 | Radius MUST appear only on buttons, inputs, chips and avatars. | stated | Same quote. |
| APP-UI-6 | The app MUST NEVER use a native `<select>`, checkbox, radio or `<progress>`. Use `Menu` and `Toggle`. | stated | A native select is "a mortal sin". "do not use checkboxes, selects or anything else that is difficult to style." |
| APP-UI-7 | Text MUST wrap at 375 px. It MUST NEVER clip, and the page body MUST NEVER scroll sideways. Long values use `break-all`; truncation is desktop only. | stated | The tail is the part that identifies an address. `index.css` sets `overflow-x: clip`. |
| APP-UI-8 | Every number a user compares MUST carry `.num`. | inferred | `index.css`: "Numbers are the content here." |
| APP-UI-9 | Text MUST clear 4.5:1 contrast on every surface it sits on. | inferred | `--color-dim` comment: "owes WCAG AA 4.5:1… This clears 5.4:1." |
| APP-UI-10 | There MUST be one focus ring, defined outside Tailwind's layers. No `outline-none`. | inferred | `index.css`: "One focus ring, everywhere, and nothing switches it off." |
| APP-UI-11 | Animation MUST honour `prefers-reduced-motion`, and MUST stop on its final frame. | inferred | `index.css` global block. |

**Findings against APP-UI-7.** `truncate` appears in `Menu.tsx`, `LanguagePicker.tsx`,
`TokenPicker.tsx`, `Portfolio.tsx`, `MarketPanel.tsx` and `landing/IntentCard.tsx`. Some are
`sm:truncate`, which is allowed. The others need a check at 375 px. I did not render them.

**Finding: app-wide enforcement is thin.** Only three test files check layout rules
(`landing/console/Console.test.tsx`, `ErrorBoundary.test.tsx`, `WalletPicker.test.tsx`). No lint
rule and no app-wide test covers native controls, borders, contrast, the focus ring, reduced
motion or sideways scroll. The Playwright `scrollWidth === clientWidth` check that
`2026-08-17-responsive-visuals.md` describes is not in the repo.

> **OPEN QUESTION (owner) — record the rules in the repo?** The rules live outside the repo, so a
> contributor without the skill cannot see them. Options: (a) copy the checklist into
> `docs/UI-RULES.md` and cite it; (b) keep this spec as the in-repo record; (c) add an app-wide
> test that greps `app/src` for the banned patterns.

## APP-CLAIM. Surfaces and claims

`2026-08-12-surfaces-and-claims.md` is marked Live in `docs/README.md`. It is "the binding list:
every user-facing claim" (commit `1a97368`). I checked each claim against the code at `70bff5e`.

**APP-CLAIM-1. The app MUST NEVER make a claim that the contract does not make true.** When the
contract changes, the claim list and the copy MUST change in the same commit.

WHY: the surfaces doc: "the temptation on a landing page is to say the thing that is almost
true."

**APP-CLAIM-2. The app MUST NEVER claim smart-account features, 7702, maker hooks, atomic
unstake-and-swap, or a uniform clearing price.** This holds today.

### Claims the app breaks now

| Claim | Where the app says it | Why it is false | Since |
|---|---|---|---|
| "you receive exactly the rate you signed" / "The fee is charged on top" | `seo.description` | The fee comes out of the maker's signed gross. With a fee set, the maker receives less than the signed number. The app raises the gross to cover the fee, so the *typed* net holds, but the sentence is about the signed rate. | `d1dd385`, 2026-09-05 |
| "An offer left in your wallet expires within the hour whatever you choose." | `tour.cancel.body` | `MAX_WALLET_WINDOW` is gone. The form warns (`adviceOf` `'zombie'`) and still signs a longer window. | `a7c5d7f`, 2026-09-03 |
| "no transaction from you" | `landing.hero.lede` | False on the approval, escrow and Permit2 rungs. The landing page's own `landing.rung.*.cost` strings say "1 tx". | not in the claim list |

### Claims in the doc that are stale

| Doc claim | Status |
|---|---|
| A cancel of a funded escrow offer takes effect fifteen minutes later (the `UNLOCK_COOLDOWN` table) | Stale. `66c43fa` (2026-08-13) removed the cooldown. `cancel` bites in its own block. The app copy already says so. |
| Getting out of escrow costs three transactions and fifteen minutes | Stale. `withdraw` is one transaction. `park` exists. |
| The authorization is pinned by `auth.nonce == intentHash` | Stale mechanism. `authNonce` (`3960d16`) lets sibling intents share one authorization. The promise holds for app-built offers, which always sign `authNonce: ZERO_HASH`. |
| The Tour's callback step is wrong | Resolved by `b1b0b2a`. |
| `main.tsx` is the whole route table | Stale detail. `Root.tsx` and `surface.ts` are. |

### Claims the fee-sink redesign will break when it lands

| String | Why |
|---|---|
| `landing.control.pause.body`, `landing.control.where.pause` ("Sole owner power", two owner functions) | `registerFeeSink` is a third owner power. It is append-only, but it is a power. |
| `landing.control.fee.body` ("Fee to us needs another contract at another address") | A fee to us needs only a `registerFeeSink` call on this contract. |
| `sign.fee.custom`, `sign.fee.note`, and the `config.ts` comment "a maker… names whatever they like" | An unregistered `feeTo` fails `_termsOk` at any rate above zero. |
| `landing.control.where.fee` ("claim pays it out from there") | `claim(sink)` pays the sink's destination, not the address the intent names. |
| `docs/FEE-MODEL.md` Part 4 and `neutral-protocol.md` (no fee floor) | Each sink has a `minRate`. The maker picks it by picking a sink, so it is not a protocol fee, but the docs must say so. |

Note: on branch `feat/fee-sink-fixed`, the merge `089557e` of `feat/fee-sink-registry` already
adds an owner switch (`setFeeSinkAllowed`, `setSplits`). On that branch,
`landing.control.pause.body` and `landing.control.fee.body` are false today.

> **OPEN QUESTION (owner) — the claim doc itself.** The Live doc now carries stale sections.
> Options: (a) rewrite it in place and keep it Live; (b) mark it Superseded by APP-CLAIM here and
> keep only the claim table in this spec.

---

# Traceability

Each MUST maps to the tests that pin it. "—" means no test pins the rule. Paths are relative to
`sdk/src`, `app/src` or `contracts/test` as marked.

| ID | Test(s) |
|---|---|
| SDK-INT-1 | sdk `intent.test.ts` "the digest matches what the contract computes"; "intentHashOf itself matches the fixture, field for field"; "the field order in TYPES matches the contract typehash" |
| SDK-INT-2 | contracts `Fixture.t.sol` `test_WriteEip712Fixture`, `test_ATypeScriptSignatureRecoversOnChain`; CI step "Fixture is current"; sdk `intent.test.ts` "the pinned signature is the one this package makes today" |
| SDK-INT-3 | sdk `intent.test.ts` "refuses a chain whose settlement is the zero address"; "while reading the same chain still works"; app `lib/signGate.test.ts` "the signing domain" |
| SDK-INT-4 | sdk `intent.test.ts` "a reader of another version drops this post rather than misreading it"; "rubbish decodes to null rather than throwing" |
| SDK-INT-5 | sdk `intent.test.ts` "the gross rounds up on every split…"; "the fee rounds down, and the maker keeps the wei"; contracts `ProveSettlement.t.sol` `test_RoundingFavoursTheMaker` |
| SDK-INT-6 | sdk `intent.test.ts` "the rate curve, against the Solidity fixture" |
| SDK-INT-7 | sdk `intent.test.ts` "where an intent and its authorization overlap" |
| SDK-CUS-1 | — (order not pinned by a test of `strongestRung` on a live chain) |
| SDK-CUS-2 | app `lib/signGate.test.ts` `signAndArm` "refuses on the %s rung" |
| SDK-CUS-3 | app `lib/signGate.test.ts` "the ladder on a chain with no settlement"; sdk `approve.test.ts` "a chain with no settlement is refused" |
| SDK-CUS-4 | sdk `custody.test.ts` "signs the receive variant, never the transfer one" |
| SDK-CUS-5 | — |
| SDK-CUS-6 | sdk `approve.test.ts` "raising an allowance a token will not let you raise" |
| SDK-CUS-7 | — |
| SDK-MKT-1 | sdk `market.test.ts` "a genuine revert on every leg is still no route"; "every leg unreadable is unknown: the key is absent, not null" |
| SDK-MKT-2 | sdk `market.test.ts` "reverts on some legs and unreadable on the rest is unknown, not no route"; "a venue probe that could not be read leaves every key unknown". The `useBoard` consumer: — |
| SDK-MKT-3 | sdk `market.test.ts` "a rate-limited probe is not cached as 'no venue'"; "every caller sharing one probe hears that it failed, not just the first" |
| SDK-DEP-1 | sdk `deployed.test.ts` "943 is refused the renamed accessors"; "a 943 read of the renamed accessor throws, and never asks the chain"; "a build from the day the change landed counts as predating it"; "a chain with no settlement is judged not at all" |
| SDK-DEP-2 | sdk `deployed.test.ts` "the registry names the date the deployment record recorded" |
| SDK-DEP-3 | CI step `npm run check:abi` |
| SDK-MC-1 | sdk `multicall.test.ts` "a rate limit is unreadable"; "an error shape nobody has seen before is unreadable, not an answer"; "a whole chunk rejected with a 429 is unreadable, not reverted" |
| SDK-MC-2 | sdk `multicall.test.ts` "a dropped probe is asked again, not remembered as absent" |
| SDK-MC-3 | sdk `multicall.test.ts` "no eth_call passes the size ceiling, however small the calls are" |
| SDK-KA-1 | sdk `keepalive.test.ts` "the chain is in the storage key, not in a field on the row"; "a payload remembered on one chain is invisible on the other" |
| SDK-KA-2 | sdk `keepalive.test.ts` "they move to the default chain and the old key goes" |
| SDK-KA-3 | sdk `keepalive.test.ts` "it stops when the process moves to another chain mid-pass". One pass at a time: — |
| SDK-KA-4 | — (SHOULD; not built) |
| SDK-TOK-1 | sdk `tokens.test.ts` "the same address can be two different tokens, one per chain"; "each chain persists under a key of its own" |
| SDK-TOK-2 | sdk `tokens.test.ts` "a dropped decimals read is not eighteen decimals"; "zero decimals is a real answer" |
| SDK-CFG-1 | sdk `config.test.ts` resolver override tests; `intent.test.ts` "and answers the resolver, not the registry, once one exists" |
| SDK-CFG-2 | sdk `store.test.ts` "a chain that settles nowhere has its intents refused"; app `hooks/boardOff.test.ts` "it is off where nothing can settle" |
| SDK-CFG-3 | sdk `config.test.ts` "a fresh install starts on a chain that can settle" |
| SDK-CFG-4 | sdk and app `mainnetFlip.test.ts` (all) |
| SDK-CFG-5 | sdk `config.test.ts` "every address is checksummed" |
| SDK-CFG-6 | sdk `fee.test.ts` "refuses a rate that takes the whole fill, and every rate above it" |
| SDK-CFG-7 | — (not built) |
| SDK-CFG-8 | — (not built) |
| SDK-CFG-9 | — (not built in the SDK; contracts tests are on `feat/fee-sink-fixed` once built) |
| SDK-CFG-10 | sdk `fee.test.ts` "the default is resolved at signing into a named sink and its rate", "no answer, or a retired default, is no default to sign"; sdk `sinks.test.ts` "the default resolves to signed terms", "a retired default resolves to no terms"; app `compose.fee.test.ts` "no sink named: the default, resolved at signing" |
| SDK-RFQ-1 | sdk `rfq-crypto.test.ts` "the string the key derives from is this one, and it never changes" |
| SDK-RFQ-2 | sdk `rfq-crypto.test.ts` "the envelope is bound to the address it names" |
| SDK-RFQ-3 | sdk `rfq-crypto.test.ts` (the open/null cases) |
| SDK-RFQ-4 | sdk `rfq.test.ts` "a forged announcement cannot displace a real one" |
| SDK-RFQ-5 | — |
| SDK-RFQ-6 | sdk `store.test.ts` "an exclusive quote never reaches the public book"; app `hooks/boardQuery.test.ts` "the board category and the quote category are different". `MIRROR_TTL` clamp: — |
| SDK-RFQ-7 | — |
| SDK-BRD-1 | sdk `board.test.ts` "matches the board formula at the live factors" |
| SDK-BRD-2 | app `hooks/boardQuery.test.ts` "the board category and the quote category are different" |
| SDK-BRD-3 | sdk `board.test.ts` "advances only to what the messages say, never to the chain head" |
| SDK-BRD-4 | — |
| SDK-BRD-5 | sdk `store.test.ts` "a chain that settles nowhere has its intents refused" |
| SDK-ERR-1 | sdk `revert.test.ts` "prints the selector when nothing decodes…"; "never returns a multi-line message…" |
| SDK-ERR-2 | CI `tools/check-redact.py` (app scripts only). SDK: — |
| APP-BRD-1 | app `hooks/boardQuery.test.ts` "it asks for offers open to everyone, in both scopes"; "it never names an executor of its own" |
| APP-BRD-2 | — |
| APP-BRD-3 | app `hooks/boardOff.test.ts` (the predicate only; the render: —) |
| APP-BRD-4 | app `hooks/boardPresence.test.ts` "before the board answers, presence is unknown — not off"; `lib/answered.test.ts` |
| APP-BRD-5 | app `lib/tokenFilter.test.ts`; `routes.test.ts` "a direction with no token is not written" |
| APP-BRD-6 | — |
| APP-BRD-7 | — |
| APP-SIGN-1 a–b | app `lib/signGate.test.ts` "refuses a chain with no settlement". The `canSign` gate as rendered: — |
| APP-SIGN-1 c | — (only `landing/console/model.test.ts` for the landing copy) |
| APP-SIGN-1 d | app `lib/amount.test.ts` |
| APP-SIGN-1 e | app `components/compose.fee.test.ts` "a rate that will not parse charges nothing" |
| APP-SIGN-1 f | app `components/compose.fee.test.ts` "the ceiling is a rate the form must catch, because deriving past it throws" |
| APP-SIGN-1 g | — |
| APP-SIGN-1 h | app `components/compose.fee.test.ts` "choosing custom and typing nothing does not fall back to the default" and the `asAddress` cases |
| APP-SIGN-1 i | app `components/compose.schedule.test.ts` "an authorization that opens after the offer expires makes a dead offer" |
| APP-SIGN-2 j–l | — (not built) |
| APP-SIGN-3 | app `components/compose.decay.test.ts` "the decay is on"; `compose.fee.test.ts` "the maker is met or beaten at every rate and every size" |
| APP-SIGN-4 | — |
| APP-SIGN-5 | app `components/compose.fee.test.ts` (the ceiling case, indirectly) |
| APP-SIGN-6 | — |
| APP-MINE-1 | app `lib/settlement.test.ts` "a read that throws answers null, so no row the maker can see is deleted". The render in every branch: — |
| APP-MINE-2 | — |
| APP-MINE-3 | app `lib/parked.test.ts`, `lib/cleanup.test.ts` |
| APP-MINE-4 | — |
| APP-MINE-5 | app `lib/nonce-lane.test.ts` "nothing left to retire offers no button"; "the floor is strictly above the one the chain already holds". The two-step confirm: — |
| APP-MINE-6 | — |
| APP-FILL-1 | — |
| APP-FILL-2 | — |
| APP-LAND-1 | app `landing/decay.test.ts`, `landing/console/model.test.ts` (parity only). No bundle check: — |
| APP-RFQ-1 | — |
| APP-RFQ-2 | app `rfq/rfq.test.ts` "no settlement means no venue, whatever address is written down" |
| APP-WAL-1 | app `lib/wallet.test.ts` "an announced wallet is used instead of the contested global"; "several announcements pick the same wallet on every load"; "a stated preference wins over that order" |
| APP-WAL-2 | app `lib/wallet.test.ts` "the account subscription survives, because a descriptor read skips the `get` trap"; "hasWallet answers false rather than throwing…" |
| APP-WAL-3 | — (design choice; no test) |
| APP-WAL-4 | — |
| APP-WAL-5 | app `components/WalletPicker.test.tsx` "the phone half is absent, not disabled"; `lib/walletconnect.test.ts` "an empty variable counts as absent" |
| APP-WAL-6 | app `components/WalletPicker.test.tsx` "the raw handshake string is never printed" |
| APP-WAL-7 | app `lib/walletconnect.test.ts` "asks for both chains, and asks for them as optional"; "a relay that never answers gives up and says so" |
| APP-I18N-1 | app `i18n/parity.test.ts` (all five cases) |
| APP-I18N-2 | app `lib/i18n.test.ts` "a key the translation misses falls back to English, never to the key"; `views.i18n.test.tsx`, `chrome.i18n.test.tsx` |
| APP-I18N-3 | app `lib/i18n-placeholders.test.ts` |
| APP-I18N-4 | app `lib/i18n.test.ts` "Arabic and Hebrew read right to left, and nothing else does"; "the document says which language it is in, and which way it runs"; `lib/bidi.test.ts` |
| APP-I18N-5 | — |
| APP-I18N-6 | app `lib/seo.test.ts` |
| APP-ERR-1 | app `ErrorBoundary.test.tsx` "only the first line of the error reaches the screen" |
| APP-ERR-2 | — (and broken by `App.tsx` `title={error}`) |
| APP-UI-1, 2 | app `ErrorBoundary.test.tsx` "one layer of padding…"; `WalletPicker.test.tsx` (those two components only) |
| APP-UI-3, 4, 5 | app `landing/console/Console.test.tsx` "no CSS border and no rounded panel reaches the edge"; `ErrorBoundary.test.tsx`; `WalletPicker.test.tsx` (three components only) |
| APP-UI-6 | app `landing/console/Console.test.tsx` "no native form control, anywhere" (console only) |
| APP-UI-7 | app `WalletPicker.test.tsx` "the name wraps rather than being cut"; `RpcSettings.test.tsx`. Page-wide: — |
| APP-UI-8 | app `landing/console/Console.test.tsx` "every figure a reader compares is set in the tabular face" (console only) |
| APP-UI-9 | — |
| APP-UI-10 | — |
| APP-UI-11 | — |
| APP-CLAIM-1 | — |
| APP-CLAIM-2 | — |

## Findings: MUSTs with no test

1. SDK-CUS-1: the rung order of `strongestRung` on a live chain.
2. SDK-CUS-5: the relayer as spender, and `permit2Domain` without a version.
3. SDK-CUS-7: the per-chain cache of `supports3009` and `supportsPermit`.
4. SDK-KA-3: one keepalive pass at a time.
5. SDK-RFQ-5: the RFQ key is never stored.
6. SDK-RFQ-6: the `MIRROR_TTL` clamp.
7. SDK-RFQ-7: contract wallets cannot announce.
8. SDK-BRD-4: `grindAndSubmit` believes the board.
9. SDK-ERR-2: no redaction check covers `sdk/src`.
10. SDK-MKT-2: the `useBoard` consumer of the three states.
11. APP-BRD-2, APP-BRD-6, APP-BRD-7, and the rendered half of APP-BRD-3.
12. APP-SIGN-1 c and g, APP-SIGN-4, APP-SIGN-6. No test renders `Compose` and checks that the
    button is disabled.
13. APP-MINE-2, APP-MINE-4, APP-MINE-6, and the render half of APP-MINE-1 and APP-MINE-5.
14. APP-FILL-1 and APP-FILL-2.
15. APP-LAND-1: no check that the landing chunk holds no viem or SDK.
16. APP-RFQ-1.
17. APP-WAL-4: no check that the WalletConnect import stays dynamic.
18. APP-I18N-5.
19. APP-ERR-2, which the code also breaks.
20. APP-UI-9, 10 and 11, and app-wide checks for APP-UI-1 to 8.
21. APP-CLAIM-1 and APP-CLAIM-2: no test ties copy to the claim list.
22. SDK-CFG-7 to 9 and APP-SIGN-2: not built yet.

## Findings: other defects and stale text

- `App.tsx` puts the raw board error into `title={error}` (APP-ERR-2).
- `seo.description`, `tour.cancel.body` and `landing.hero.lede` make false claims (APP-CLAIM).
- `2026-08-12-surfaces-and-claims.md` has five stale sections (APP-CLAIM).
- `rfq.ts` `mirrorFor`'s comment says a zero rate "charges the owner's floor" and pays "the
  protocol's sink". `neutral-protocol.md` deleted both.
- `rfq-crypto.ts` `seal`'s comment says the randomness comes "from the curve library". The nonce
  comes from `crypto.getRandomValues`.
- `lib/wallet.ts` `announcedWallets` says "Nothing draws this yet". `WalletPicker` draws it.
- An RFQ test says an hour is "the settlement's own cap on a wallet-custody window". `a7c5d7f`
  removed that cap.
- `mirrorFor` and `myIntents` read `Date.now()`, against the chain-clock rule (SDK-KA-4).
- `docs/README.md` still lists `neutral-protocol.md` as "Decided, not yet built". It is built.
