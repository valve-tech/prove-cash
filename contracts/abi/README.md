# ABIs

For anything outside this repo. **Nothing in this repo reads them.** The app and the SDK use `sdk/src/abi.ts`, which the
compiler writes and which `npm run check:abi` holds to the contracts on every CI run. These files have no such guard, and they drifted: `ProveSettlement.json` sat with
four deleted functions and three missing ones until a review noticed.

So treat them as a published artefact, not a source of truth, and regenerate after any contract
change:

```sh
cd contracts && forge build && npm_config_yes=1 ./abi/export.sh
```

Eight contracts ship: `ProveSettlement`, `ProveRelayer`, `ProveExecutor`, `ProveCallSink`,
`ProveBatchExecutor`, `RfqVenue`, `FeeDefaults` and `ProveReader`. `FeeDefaults` is the advisory
fee-defaults contract (the settlement never reads it) and `ProveReader` holds the read views that
used to cost settlement bytecode, including `available`. The fee-sink registry (`FeeSink`,
`registerFeeSink`) is gone: an intent signs a fee config hash and `claim` takes the preimage.
`FeeClaimLib`, the linked library behind `claim` and `announceFeeConfig`, has no ABI of its own
here: its two events and two errors are redeclared on the settlement, which is what a consumer
reads. The settlement deploys the relayer and each executor deploys its own call sink, so a
consumer reads those addresses back off their parents rather than from a config file.
