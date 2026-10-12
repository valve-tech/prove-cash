# Every address, and what it is

> **Update 2026-10-03.** Every contract address below is from the sink-era design and is
> **ABI-incompatible** with the fee config branch (`feat/fee-config-hash`). Nothing was deployed.
> At the next deploy the table gains `FeeDefaults`, `ProveReader` and `FeeClaimLib` (the library
> address comes from the broadcast file) and loses `FeeSink`. The settlement has no owner; the
> `owner` in `config/<chainid>.json` now owns `FeeDefaults` only, after calling `acceptOwnership`.
> The stray config and the default fee config live in `contracts/config/fee-configs.json`. After
> the deploy, put the `FeeDefaults` address in that file, and the settlement and reader in
> `sdk/src/config.ts`.


Written 2026-08-27, after the testnet redeploy. The per-chain deployment records
in `contracts/deployments/` remain the source of truth for contracts; this page
exists because the rest of it — the keys and the bot wallets — was written down
nowhere. The bot wallets lived only in journals on the bot host and in env files
beside them, so nothing in the repository said which address was posting intents
on mainnet.

Read it two ways: as a checklist before the mainnet redeploy, and as the review
afterwards. The column that changes is marked.

## Contracts

`ProveRelayer` and both call sinks never appear as deploy transactions — a
constructor creates each one, so it binds immutably to the contract that made it.
The settlement makes its own relayer, which is why approving the settlement grants
nothing and every transfer goes through the relayer instead.

**Every call-sink address on this page is a TEMPLATE, and no payout may name one.**
Nothing calls it and nothing sweeps it. Each venue call runs from an EIP-1167 clone
of the template, one clone per caller, and `executor.sinkFor(caller)` answers that
clone. A route that pays the template strands the money there and reverts the fill
with `ProceedsNotHere`. The accessor read `sink()` until 2026-09-15 and reads
`sinkTemplate()` now, so the addresses deployed before that date still answer the
old name and revert on the new one.

**Both columns are the redeploy of 2026-10-06**, the fee-config-hash tree at
`cfd6e85`, read from `contracts/deployments/943.json` and `369.json`, which are the
authority. `verify-bytecode.mjs` called every row identical on both chains the same
night (`contracts/tools/bytecode-pin-<chainid>.json`). The settlement has no owner;
the owner key owns `FeeDefaults` only, and `acceptOwnership` was called on both
chains. The sets they replaced are under "Retired on 943" and "Retired on 369".

**369 is on.** The mainnet flip (#52) was decided on 2026-10-10: `sdk/src/config.ts`
names the 369 settlement and `deployedOn: '2026-10-06'`, so `settlementLive(369)` is true
for any client built from this tree. The `-369` units still carry `SETTLEMENT=`, held to
the same address by `check:addresses`.

| | testnet 943 | mainnet 369 |
|---|---|---|
| `ProveSettlement` | `0xa8B3f54c1435ea28437fA89A4192064F4bcCDA99` | `0x5EB7cAf15f9Fa7Afad9a45d035f7E0F67140fC7b` |
| `ProveRelayer` | `0xa71FB9889a4F8069CaD38bf0F8449dEF93e59C21` | `0xAc792BBDd72Ce4177Cf1FAD1719d7B68b598268b` |
| `ProveExecutor` | `0x5711E4D1E18CFBaA288a61C59db9d7C923D12267` | `0x2746b99Cd4b8E35539592Be0895B7A5652b04AD7` |
| `ProveCallSink` | `0x2f0C704487FD0161ABA5E590e80D0c14bd7E3efF` | `0x1a3A59699BE7D908e1460cdAD83cfBd6b9Be4375` |
| `FeeClaimLib` (CREATE2, same on both) | `0x0b169aC0Be0a8062b2f839175Fd2431744Eb83f7` | `0x0b169aC0Be0a8062b2f839175Fd2431744Eb83f7` |
| `FeeDefaults` | `0x67e366de6E29289D43894F5587E29FE460405cFf` | `0xE92cB6265497F141125E25a9B5231370632e878E` |
| `ProveReader` | `0x8dCf4A7Fe697ba4705DF86A0D77084700C84cabD` | `0x8c93958085e4823983b2B811F206874C108C5288` |
| `RfqVenue` | `0x48ebDd0770934799288ab826C439aa029B482896` | `0x6E94A88973f7D1cDcd59A5B0ef21C84eBdA09F04` |
| `ProveBatchExecutor` | `0x65019500356831b7FDBbbE76fFB92e08a1a3E862` | `0xE0925126C969E362195efdbF1f57d1DdF243781c` |
| its call sink | `0x03B4417065F263e30f1c401a023D2E6d403F7004` | `0xBC60540D280e34f7De43F71dB6b1a9397CF44d37` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

**#35 is the mainnet redeploy, so the last column speaks for 369.** Every 369
address changes there except Permit2, and `defaultProceeds` moves to a different
kind of address rather than a new copy of the same one. `RfqVenue` and
`ProveBatchExecutor` read `relayer()` from the settlement in their constructors, so
a settlement that moves orphans both, and the two call sinks follow their owners.
That is exactly what happened on 943 on 2026-09-05.

**Permit2 is not ours and does not move.** We deploy nothing there and own nothing
there: it is the canonical deterministic deployment, 9,152 bytes, byte-identical on
both chains, verified on chain 2026-08-27. The settlement takes it as a constructor
argument from `config/<chainid>.json` and hands it to the relayer, which holds it as
an immutable — read it back with `relayer.permit2()`.

That row is the whole point of the permit2 custody rung. A maker on any other wallet
rung approves `ProveRelayer`, which the settlement's constructor makes, so every
redeploy orphans every one of those approvals — that happened on 943 and cost every
maker a re-approval. A maker who approves Permit2 instead keeps that grant through
this redeploy and every one after it, and signs one short-lived transfer per intent.

**`defaultProceeds` is a setting, not a contract of ours.** It is where
`sweepUnowned` sends a token that belongs to no reservation, and anybody may call
that. The settlement takes no fee of its own, so it is not a fee destination.

**943 has already moved and 369 has not.** The 943 setting is that chain's own
PulseX factory `feeTo()`, taken from `contracts/config/943.json` at the
2026-09-05 deploy and read back off the settlement on 2026-09-09. The 369 setting
is still the `FeeSink` this repository used to deploy, and that contract came out
of the source on 2026-09-03 under backlog #117. It still answers, because deleting
source moves nothing on chain. It was never armed and holds nothing. #35 repoints
369 the same way 943 went — see "Fee destinations" below.

### Retired on 943

**Point nothing at them.** Six redeploys are listed. The 2026-10-06 set replaced the
2026-10-01 one for the fee-config-hash model: `FeeSink`, `registerFeeSink` and the
settlement owner are gone, and `INTENT_TYPEHASH` moved. The 2026-10-01 set replaced
the 2026-09-29 one because `315f5b2` stopped every fill reading the default fee
sink (review M-1), which changed the settlement's code. The 2026-09-29 set replaced
the 2026-09-26 one because `d958108` capped the arming frame at `ARM_GAS` (L-1),
which changed the settlement's code. The 2026-09-26 set replaced
the 2026-09-09 one for the fee-sink registry and the default sink. The 2026-09-09 set replaced
the 2026-09-05 one because #120 and #131 both change storage, and that redeploy
happened four days late: `verify-bytecode.mjs` would have said so on any day
anybody ran it, and nothing ran it. The 2026-09-05 set had replaced the
2026-09-01 one. `contracts/deployments/943.json` says the same in its
`_superseded` field.

| what | address | state |
|---|---|---|
| `ProveSettlement` | `0xdb3843eFa19C06cA77e16c082BF33f7D4Dd1b8FC` | deployed 2026-10-01, replaced 2026-10-06. The FeeSink-era settlement; its intents use the old typehash |
| `ProveRelayer` | `0xBe5e6eA4A71f732b5C91Abb312e867293ee80a0e` | holds the approvals the 2026-10-06 redeploy orphaned |
| `ProveExecutor` | `0x697B30A4e85098943f7DE901DE8475444FD573c0` | binds to that settlement |
| `ProveCallSink` | `0x7FF499494C7146F036e80Cd2dA0EDcF47F70a06A` | that executor's sink |
| `FeeSink` | `0x625f6c74E70973254B4C65a2302b3214bf1aeB65` | that settlement's default sink |
| `RfqVenue` | `0x2a4da6f7E5F046448cCa5Bf5691e431DA833dfff` | binds to that settlement |
| `ProveBatchExecutor` | `0x3a887c9631d7EF5Fc37ba08987150761db6DBeaD` | binds to that settlement |
| its call sink | `0xd751fc7d8818B5bE53d837Fe7Cf7C954C2515724` | that batch executor's sink |

And the 2026-09-29 set before it:

| what | address | state |
|---|---|---|
| `ProveSettlement` | `0x5AF7aC9fD1C038247c7FE3979DFA4A632C359767` | deployed 2026-09-29, replaced 2026-10-01. A zero `feeTo` pays the default sink at fill time |
| `ProveRelayer` | `0x5DfA0Cd08a70Ad71841D8049d59c27B9b479bcD9` | holds the approvals the 2026-10-01 redeploy orphaned |
| `ProveExecutor` | `0x122D4404a45914Cd6A75FC4D789A4c9110017Fc1` | binds to that settlement |
| `ProveCallSink` | `0xCc1130825e0E51EDF6795214F408F1dba962cE17` | that executor's sink |
| `FeeSink` | `0xB5c4D164B43B34C16654499E245EadeAb1907FD0` | that settlement's default sink; the new settlement does not register it |
| `RfqVenue` | `0x6B8DDB0b87ABCb7a65A0C8F4529aD093a07Ee14b` | binds to that settlement |
| `ProveBatchExecutor` | `0x196736ab1b4C8EFdCDEf5A5398B537874eaa1146` | binds to that settlement |
| its call sink | `0x3F5326439dE1d4d31eE49Bb1EB74792478282015` | that batch executor's sink |

And the 2026-09-26 set before it:

| what | address | state |
|---|---|---|
| `ProveSettlement` | `0xc172e58B3A60D66d5D8E73a2d6f5b5D9EAE09Da9` | deployed 2026-09-26, replaced 2026-09-29. No `ARM_GAS` cap on the arming frame |
| `ProveRelayer` | `0xcCe90c6f91046e8Cd2bca814731d15c68Ea75c50` | holds the approvals the 2026-09-29 redeploy orphaned |
| `ProveExecutor` | `0xD8580eeF5268bD7ECF7BdcD4C8727e08Fe7A6596` | binds to that settlement |
| `ProveCallSink` | `0xdbA8FE578Dc7D0adC9c067C43b63175D89b87496` | that executor's sink |
| `FeeSink` | `0x24A14cd8b8c9F976472590f96e34E3661b47d4a1` | that settlement's default sink; the new settlement does not register it |
| `RfqVenue` | `0x0cE8dE5e7b2C6Ea0A2eaC1A1CEF3F6de58877207` | binds to that settlement |
| `ProveBatchExecutor` | `0x93a9DD5b2Ad9027bF7eEE9541aEF83EB15D0993f` | binds to that settlement |
| its call sink | `0x5b9bf0c51719287F602C71c661350a6E11785bCe` | that batch executor's sink |

And the 2026-09-09 set before it:

| what | address | state |
|---|---|---|
| `ProveSettlement` | `0xe5f4F27219d56A4C38A480Ff1915f435B6cF5Ca2` | deployed 2026-09-09, replaced 2026-09-26. No fee-sink registry: it charges a fee to any `feeTo` |
| `ProveRelayer` | `0x444AC7407c5e364D03745D9d25C29E8361334951` | holds the approvals the 2026-09-26 redeploy orphaned |
| `ProveExecutor` | `0x8B5bf5b06B4D04632aFB3D602656D48426605608` | binds to that settlement; publishes `sink()`, not `sinkTemplate()` |
| `ProveCallSink` | `0x639D02889Ba8521BF39cB83D5d69232e9DB36fA2` | that executor's sink |
| `RfqVenue` | `0x52d7E9BB2450487CD8397Ddb1598D063AD08816d` | binds to that settlement |
| `ProveBatchExecutor` | `0xac22055E703DEe47c47b0366989361832Abb320c` | binds to that settlement |
| its call sink | `0x54CC6A19c91f8cfcC2B880E061975983aaA0ED2A` | that batch executor's sink |

And the 2026-09-05 set before it:

| what | address | state |
|---|---|---|
| `ProveSettlement` | `0x79B09eDf293f9ee7E1bb6067a29625B3e2a4861C` | deployed 2026-09-05, replaced 2026-09-09. `parked()`, `totalParked()` and `laneFloor()` revert on it |
| `ProveRelayer` | `0xDe25214B5b96C7c0A9646E2b766F4c1c6e51cE48` | holds the approvals the 2026-09-09 redeploy orphaned |
| `ProveExecutor` | `0x168ad2B1F79FEd87925D7c848820c37A54b57e43` | binds to that settlement |
| `ProveCallSink` | `0xDC1c15870EAED1db39E3B0d50ABB8ed42adD1466` | that executor's sink |
| `RfqVenue` | `0x46C68963df1c24Ac0f94e6CdF9295d5f04A850F8` | binds to that settlement |
| `ProveBatchExecutor` | `0x1552246C820C163F088dAF263ff2cC822aCF3372` | binds to that settlement |
| its call sink | `0x3E736E395c85f92C0E38b519Fa93F48fd9E9BAA7` | that batch executor's sink |

And the 2026-09-01 set before it:

| what | address | state |
|---|---|---|
| `ProveSettlement` | `0xB491398057080aC7ff627A1D053dB258b9F730Cf` | deployed 2026-09-01, replaced 2026-09-05 |
| `ProveRelayer` | `0xDd726810E6c5667CA4765654D558c696AdBC68a4` | holds the approvals the redeploy orphaned. It can only pull, and the settlement that drives it is retired |
| `ProveExecutor` | `0xE7d32f506AeC559a573784f1DCbA277e74F49bEe` | binds to the retired settlement |
| `ProveCallSink` | `0xae49D808662c75e5e8f7d0aB817420F0eBFFF147` | that executor's sink |
| `RfqVenue` | `0xd1b81C59D228b844733b7cd82993055926dAF763` | binds to the retired settlement |
| `ProveBatchExecutor` | `0x8E76F3eA17D6028a1000beD8e36d8306e809b996` | binds to the retired settlement |
| its call sink | `0x92fc2f6822161dE820e7106224991B9819a20751` | that batch executor's sink |
| `FeeSink`, the 2026-09-01 one | `0x197DC914C3D9849c6BDb062650DC2198a7D3CBf7` | the old `defaultProceeds`. **Armed, and it still holds money**: 99.170154874581883516 tPLSX at block 25,344,220 on 2026-09-09, which anybody may still burn by calling `buyback` on it |
| `FeeSink`, the first | `0xcf4051362348e248bAd3f92Ec663f847C75811Ab` | superseded the day it was deployed, for the four-argument constructor from before the rename. Unarmed, and it held no tPLSX at the same block. **No deployment record names it.** This page is the only file in the repository that does |

Read the two balances as measurements with a date on them, not as constants. Take
them again with `cast call <token> 'balanceOf(address)(uint256)' <sink>` against a
943 endpoint before you act on either.

### Retired on 369

**Point nothing at them, and never use the old owner key against them**: on that
settlement a `feeTo = 0` intent was spendable by its owner. The 2026-10-06 set
replaced the 2026-08-22 one. `contracts/deployments/369.json` says the same in its
`_superseded` field.

| what | address | state |
|---|---|---|
| `ProveSettlement` | `0x595ec1C409F63b365ad9f21948E8B040EC5d60EE` | deployed 2026-08-22, replaced 2026-10-06. INTENT_TYPEHASH 0x4b3e51b4… |
| `ProveRelayer` | `0x25e12d9514d2e63266C1696CCfA30b11b6b66bB3` | holds the approvals the 2026-10-06 redeploy orphaned |
| `ProveExecutor` | `0x9d31d91453C931e78392934301B6ABD97c468c0A` | binds to that settlement |
| `ProveCallSink` | `0x1a0E21Bd423cd0c2893d34714790a77CfDBE8A0F` | that executor's sink |
| `RfqVenue` | `0x89C3d80b45C586d8Fa87F4762fa89D30847c9A84` | binds to that settlement |
| `ProveBatchExecutor` | `0xA20EF4De61d1304ba4510Eb6d881219ecdDc3B53` | binds to that settlement |
| its call sink | `0xC40f93d1e7b77D7a7073a900b27Ac04fF94EcE79` | that batch executor's sink |
| `defaultProceeds` | `0xC55FBeE1eD714FC3A65fDd56E1c86cD61dB8157D` | the old 369 `FeeSink`; never armed |

## Keys

| what | address | held as | note |
|---|---|---|---|
| owner, 369 | `0x5182574eE268ABD0A48f97DcfcdE65234E8422E2` | `OWNER_369_PK` | owns the 369 settlement and every test token. Owned 943's until 2026-09-26. Deployed mainnet. Holds ~47.4M PLS |
| testnet admin (943) | `0x6fa7d1016789A0C32fe74d5Bdd4393836C366Acc` | `TESTNET_ADMIN_PK` | owns the 943 settlement from its first block (2026-10-01, and the 2026-09-29 and 2026-09-26 ones before it). Testnet only, split from the mainnet key |
| testnet deployer | `0xC3C6C6Cd76B018550EbF4F7Cb856Fd921dE2Ae21` | `TESTNET_DEPLOYER_PK` | signs 943 deploys only |
| mainnet deployer | `0x090e785daDcAF4Acd189305a0b970358e4E0653a` | `MAINNET_DEPLOYER_PK` | Funded 100k PLS, nonce 0, unused |

The mainnet deployer signs and nothing else. `config/369.json` names the owner
separately, so ownership does not move to the signing key — that separation is
the whole reason for a third key.

**Two deployers, and the names are close enough to confuse.** The item titled
"testnet deployer" is not the mainnet one, and reaching for the wrong one has
happened before.

This page claimed a check for a fortnight before one existed. It does now, in
every script that broadcasts. `config/<chainid>.json` names the keys allowed to
sign under `deployers`, forge derives the signer's address from whatever key it
was handed, and a script refuses to continue unless the list names it. It fails
closed: a chain with no list, an empty list, or no config file stops the deploy
rather than skipping the check. `PROVE_DEPLOYER` overrides the list and narrows
it to one address — it never widens it, so a value left in a shell from a lab
session fails a real deploy instead of waving one through.

| chain | `deployers` |
|---|---|
| 369 | `0x090e785daDcAF4Acd189305a0b970358e4E0653a` — the mainnet deployer, and nothing else |
| 943 | `0xC3C6C6Cd76B018550EbF4F7Cb856Fd921dE2Ae21`, and anvil's first account `0xf39Fd6e5…92266` |

The anvil account is on 943 because `app/scripts/lab/up.sh` runs anvil with
`--chain-id 943`, so every config file in the repository loads unchanged, and it
signs the lab's whole deployment with that published key. It costs nothing:
deploying is permissionless, so a stranger holding that key could already deploy
their own settlement to 943, and this list neither grants nor withholds that.
Mainnet lists one address and no anvil account.

**Neither list may name the owner**, and `test/Deploy.t.sol` fails if one does.
That separation is the whole reason a third key exists — "it deployed and I own
it" cannot be evidence that the right key signed when the two are one address.

## Adding a venue or an executor to a live deployment

`DeployRfqVenue` and `DeployBatchExecutor` take `PROVE_SETTLEMENT` from the
environment. Their constructors check that the address has code and answers a
non-zero `relayer()`, **and yesterday's settlement passes both**. Paste an old
address and the venue deploys cleanly, quotes cleanly, signs cleanly, and reverts
at settlement.

So both scripts now hold that address against `deployments/<chainid>.json`. The
record must name it as the current settlement, and the relayer it names must be
the one the settlement itself answers — a record whose settlement line was
updated and whose relayer line was not is refused. That forces the record to be
written before the periphery is deployed, rather than from memory afterwards.

A fork dry run deploys a settlement no record can know about. Set
`PROVE_SETTLEMENT_OFF_RECORD` to the same address to say so. It takes the
address rather than a boolean on purpose: typing it into a second variable is a
deliberate act, and a flag left in a shell cannot wave through tomorrow's
different address.

## Checking what is on chain against what we build

`contracts/tools/verify-bytecode.mjs` repeats the comparison both records below
claim. It reads the deployment record, fetches `eth_getCode` for every address,
and holds each one against the artifact `forge build` produced.

    cd contracts && node tools/verify-bytecode.mjs 943

Immutables are written into the runtime code, so a plain comparison differs on
every contract. The tool reads the compiler's own `immutableReferences` rather
than masking a guess, checks the artifact really carries zeros there, requires
every difference to fall inside a declared span, extracts each immutable's value
and prints it, and names the ones the record also names. One byte differing
outside a span is a failure with its offset.

It has three verdicts, not two, and the middle one is the interesting one:

- **identical** — every byte matches, metadata trailer included. Exit 0.
- **same program, different build** — the only bytes differing outside the spans
  are inside the metadata trailer, which solc appends and never executes. Every
  instruction matches. Exit 3.
- **different code** — bytes differ outside the spans and outside the trailer.
  Exit 1.

### What 943 actually runs, measured 2026-10-01

The command, run from the repository root right after the 2026-10-01 redeploy:

    cd contracts && node tools/verify-bytecode.mjs 943

It exited **0**, and its own summary reads `8 identical, 0 same program from a
different build, 0 different code, 0 not verifiable`. That covers the settlement,
the relayer, both executors, both call sinks, the venue and the `FeeSink`. Every
named immutable resolved to an address in the record. On chain the settlement is
24,345 bytes, the executor 5,209, the batch executor 9,255 and the fee sink 320.

**CI will read same-program, not identical.** CI builds from another checkout
path, and solc hashes the remappings that forge derives from that path.
`contracts/tools/bytecode-pin-943.json` therefore pins `same-program` for all
eight, and the nightly gate holds the chain to that.

The 2026-09-16 measurement of the retired set read `0 identical, 4 same program
from a different build, 3 different code`: `4f67e4d`, `4ba9a66` and `c28c5aa` had
changed the settlement and both executors after that deploy. The redeploy closed it.

Chain 943 was measured this way on 2026-09-04, from a worktree at 9ff9265, the
commit whose record makes the claim. All eight contracts matched instruction for
instruction; every byte count and nibble count in that record reproduced exactly;
and all eight metadata hashes differed. The cause is `settings.remappings`, the
only metadata field that moved between two builds of the same tree. Forge
auto-detects it from whether `lib/openzeppelin-contracts` has its own submodules
checked out, and from the absolute path of the checkout — one remapping arrives
context-prefixed with it. **The metadata hash is therefore reproducible only
from an equivalent checkout at the same path; the instruction bytes are
reproducible anywhere.**

What a clean run does not prove: anything in storage — `owner`,
`defaultProceeds`, balances are not in the runtime code; anything about the
constructor, whose code is not part of the runtime; that an unnamed immutable
holds the right value, only that it is consistent and what it is; anything about
an address the record does not list.

## Bots

On the bot host. Keys live in env files on that host and nowhere else.

| | 943 | 369 |
|---|---|---|
| heartbeat maker | `0xFC9d26Dd5FEc77fb057E32939456e53cF488728f` | `0xAeC3308B5D3753D31f20975793F3261705454112` |
| executor | `0xF5eD57bb129A2c7210EA206cd04dDf87E2fB4e0A` | `0x2d5AE354e1E14831ce6FC4131Afeb8a19d02d6b1` |
| solver | `0x202D14Ab7Bee6fBae4D2491A77735D30d2C887aC` | `0x255c38DB8C7AFE6c5279FF39C4FDaC54B882601F` |

The four 369 units are **stopped** as of 2026-08-27, and the gap has widened
twice since. `minFill` and `authNonce` took `Intent` from fourteen fields to
sixteen, and the `curve` field took it to **seventeen** on 2026-09-05. Each move
changes the tuple, and so every selector that takes one: `hashIntent` went
`0x1d6bd64f` to `0xec38b9f7` to `0x6820d6d4`. Read the current one back with
`forge inspect ProveSettlement abi`. The current build cannot call the mainnet
settlement at all. They restart after #35, and their unit files name the
settlement explicitly, so those need the new address first.

## Tokens

Testnet tokens are ours, from `contracts/script/DeployTestTokens.s.sol`. Anyone
may `claim()` once per cooldown per address; only the owner may `mint`. Their
decimals differ on purpose — the quote rounds at 18, 8 and 6, and only a mixed
set exercises all three.

| 943 | | | 369 | | |
|---|---|---|---|---|---|
| WPLS | `0x70499adEBB11Efd915E3b69E700c331778628707` | 18 | WPLS | `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` | 18 |
| PLSX | `0x8a810ea8B121d08342E9e7696f4a9915cBE494B7` | 18 | PLSX | `0x95B303987A60C71504D99Aa1b13B4DA07b0790ab` | 18 |
| HEX | `0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39` | 8 | HEX | `0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39` | 8 |
| tPLSX | `0xabeF58363E0fc60250D16778848eAED831eA26F9` | 18 | DAI | `0xefD766cCb38EaF1dfd701853BFCe31359239F305` | 18 |
| tHEX | `0xA54e1565AB28360B66809803306Ec5b1229808a0` | 8 | x402PLSX | `0x1EABe4a39B404ae7Cd386194f1b10A011f430135` | 18 |
| tUSDC | `0x86390129a2079fb7f0FC889473160a3a449117Ab` | 6 | x402USDC | `0x33D3BBF903D3E85973aF93d55CDeA7C1523e607B` | 6 |
| tUSDT | `0x7d32f9Ebb6C5813435f4bDF4e9beaF99C805D529` | 6 | x402HEX | `0x7464eC8E2de5fEE14653Ce685058C1904A293eee` | 8 |
| tWBTC | `0x70c421a8baC4aDAa10285A20EfF09997A5e09565` | 8 | | | |
| tWETH | `0xCb5C3ED9cD727f142d1b9eFc60790550683aA655` | 18 | | | |

`tUSDC` and `tUSDT` sit one apart and are easy to swap by eye. Every end-to-end
run on 2026-08-27 used `0x7d32f9…D529`, which is **tUSDT**.

## Venues

| chain | label | router | factory |
|---|---|---|---|
| 943 | v1 | `0xDaE9dd3d1A52CfCe9d5F2fAC7fDe164D500E50f7` | `0xFf0538782D122d3112F75dc7121F61562261c0f7` |
| 369 | v1 | `0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02` | `0x1715a3E4A142d8b698131108995174F37aEBA10D` |
| 369 | v2 | `0x165C3410fC91EF562C50559f7d2289fEbed552d9` | `0x29eA7545DEf87022BAdc76323F373EA1e707C523` |

Neither mainnet router has code on 943, which is why the testnet router is its
own address and not a copy.

## Fee destinations

**A fee goes to a registered fee sink, and to nothing else.** Since 2026-09-23 an
intent with `feeRate > 0` must name, in `feeTo`, a `FeeSink` that the settlement
has registered. `_termsOk` refuses any other address. A `FeeSink` is an immutable
record of one destination and one `minRate`. It has no owner and no setter, and
it never holds a token: `claim` pays the destination directly. Registration is
permanent. See `docs/FEE-MODEL.md` and
`docs/specs/2026-09-23-fee-sink-fixed-destination.md`.

**No sink is deployed on either chain yet.** The settlements on 943 and 369
predate the registry, so they have no `registerFeeSink`. The next redeploy of
each chain deploys one sink and registers it in the same run. `Deploy.s.sol`
reads the list from `feeSinks` in `contracts/config/<chainid>.json`:

| chain | sink destination | `minRate` in the config |
|---|---|---|
| 943 | `0x7cD43983A963c62Add34694E83E896c5AfC3333f` | 0 |
| 369 | `0xd6cA7ee047a6F45d20d2962E4394E070cF27724F` | 0 |

Each destination is that chain's PulseX factory `feeTo()`, the buy-and-burn.
**The 369 floor of 0 is a placeholder, not a decision.** The owner has not named
the buy-and-burn sink's `minRate` (the internal open-questions list T1-13). Confirm it before
the mainnet deploy, because a registered sink cannot be changed. Add the sink
address to this page when a deploy prints it.

**`defaultProceeds` becomes those same two addresses at the redeploy.**
`contracts/config/369.json` and `contracts/config/943.json` name them, and
`Deploy.s.sol` refuses to deploy without one. It is not a fee destination: it is
where `sweepUnowned` sends a token belonging to no intent, and anybody may call
that. Both were read off their own factory on 2026-09-03 and both carry 708
bytes of proxy code.

**943 arrived there on 2026-09-05 and 369 has not.** The 369 `defaultProceeds`
still points at the old `FeeSink`, `0xC55FBeE1eD714FC3A65fDd56E1c86cD61dB8157D`
in the 369 column above, until #35 lands. That old contract is a burner with an
owner, not the immutable record of 2026-09-23. What forwarding to a buy-and-burn
costs is measured in `contracts/test/ForkBuyAndBurn.t.sol` and accepted in
`docs/AUDIT-SCOPE.md` section 6.4: 14.29% of the PLSX goes to that contract's
own `devAddr`, and a token with no PulseX pool is stranded there.
