import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hexToString, numberToHex, type Address, type Hex } from 'viem'
import {
  CURVE_LINEAR,
  DEFAULT_CHAIN,
  ZERO,
  ZERO_HASH,
  memoryKeyValueStore,
  network,
  setChainId,
  setKeyValueStore,
  setSettlementOverride,
  type ChainId,
  defaultFees,
  hashFeeConfig,
  rememberFeeConfig,
} from '@prove.cash/sdk'
import {
  announcedWallets,
  browserWallet,
  connect,
  currentAccount,
  ensureChain,
  hasWallet,
  onAccountsChanged,
  preferWallet,
  signExclusive,
  signIntent,
  signMessage,
  watchAccount,
} from './wallet'
import { t } from './i18n'

/**
 * The browser wallet, which is the only module in this app that can make a signature.
 *
 * Nothing here moves money on its own. What it makes is the two things that do: the client every
 * SDK write takes, and the maker's signature over an `Intent`. So the questions below are about
 * what a wallet is asked, on which chain, and when it is not asked at all — a refusal that comes
 * before the prompt costs a person nothing, and one that comes after has already opened a wallet
 * for a transaction that cannot go through.
 *
 * The provider is a fake that records every call, so no test here reaches a wallet or a chain.
 */

const MAKER: Address = '0x1111111111111111111111111111111111111111'
const OTHER: Address = '0x4444444444444444444444444444444444444444'
const TOKEN_A: Address = '0x2222222222222222222222222222222222222222'
const TOKEN_B: Address = '0x3333333333333333333333333333333333333333'
const VENUE: Address = '0x5555555555555555555555555555555555555555'

/** A signature is 65 bytes. Nothing here checks one; the wallet's answer is passed through. */
const SIGNATURE: Hex = `0x${'ab'.repeat(65)}`

/**
 * The two chains, and both settlements are overridden rather than read from the registry.
 *
 * The registry's 943 address moves with every redeploy — it has moved twice since September —
 * so an assertion that reads it tests the registry rather than this file. An override fixes the
 * address the domain must carry, and the refusal on `DEAD` keeps meaning what it means on the
 * day mainnet deploys.
 */
const LIVE: ChainId = 943
const DEAD: ChainId = 369
const SETTLEMENT: Address = '0x00000000000000000000000000000000000f0f0f'
const NONE: Address = '0x0000000000000000000000000000000000000000'

type Call = { method: string; params?: unknown }

/** A refusal in the shape a browser wallet uses. 4001 is the user saying no. */
const rejection = (message: string) => Object.assign(new Error(message), { code: 4001 })

/**
 * A browser wallet that answers the five methods this module sends, and records all of them.
 *
 * `chainId` is state rather than a constant: a switch that the wallet accepts has to be visible
 * to the next read, because that is the whole question `ensureChain` asks.
 */
function fakeWallet(
  opts: {
    chainId?: number
    accounts?: Address[]
    /** Answers that replace the default for one method, to fail or to refuse a switch. */
    answers?: Partial<Record<string, (params: unknown) => unknown>>
    /** Leave the listener methods off, the way a bare EIP-1193 provider may. */
    listeners?: boolean
  } = {},
) {
  const calls: Call[] = []
  const handlers = new Map<string, (v: unknown) => void>()
  const state = { chainId: opts.chainId ?? LIVE }

  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params })
      const answer = opts.answers?.[method]
      if (answer) return answer(params)
      switch (method) {
        case 'eth_chainId':
          return numberToHex(state.chainId)
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return opts.accounts ?? [MAKER]
        case 'wallet_switchEthereumChain':
          state.chainId = Number((params as [{ chainId: Hex }])[0].chainId)
          return null
        case 'wallet_addEthereumChain':
          state.chainId = Number((params as [{ chainId: Hex }])[0].chainId)
          return null
        case 'eth_signTypedData_v4':
        case 'personal_sign':
          return SIGNATURE
      }
      throw new Error(`the wallet was asked for ${method}, which this module should never send`)
    },
    ...(opts.listeners === false
      ? {}
      : {
          on: (event: string, handler: (v: unknown) => void) => handlers.set(event, handler),
          removeListener: (event: string) => handlers.delete(event),
        }),
  }

  return {
    provider,
    calls,
    state,
    /** Every method the wallet was asked for, in order. */
    methods: () => calls.map((c) => c.method),
    /** The parameters of the one call to `method`. */
    paramsOf: (method: string) => calls.find((c) => c.method === method)?.params as unknown[],
    /** Fire what the wallet would fire when the person switches account. */
    emit: (event: string, value: unknown) => handlers.get(event)?.(value),
    listening: (event: string) => handlers.has(event),
  }
}

type Wallet = ReturnType<typeof fakeWallet>

/** Put a wallet in the page. With no call to this, the page has none. */
const install = (w: Wallet) => vi.stubGlobal('window', { ethereum: w.provider })

/**
 * `window.ethereum` as two extensions leave it: a Proxy whose `get` hands back a fresh bound
 * function where the target holds a frozen one.
 *
 * This is not an invented failure. A non-writable, non-configurable data property must read back
 * as the value the target holds, and a Proxy that returns anything else makes the ENGINE throw at
 * the read — before the wallet's code runs and before ours does. Production threw exactly this on
 * `on`, inside a mount effect, and React unmounted the whole tree.
 *
 * `request` is an ordinary writable property, so the invariant does not cover it and a bound copy
 * of it is legal. That is the real shape of the defect: the page can still send a request and
 * cannot subscribe to an account change.
 */
function contested(w: Wallet) {
  const target: Record<string, unknown> = { request: w.provider.request }
  const listeners = w.provider as unknown as Record<string, unknown>
  for (const name of ['on', 'removeListener']) {
    Object.defineProperty(target, name, {
      value: listeners[name],
      writable: false,
      configurable: false,
    })
  }
  return new Proxy(target, {
    get(t, key, receiver) {
      const own = Reflect.get(t, key, receiver)
      return typeof own === 'function' ? own.bind(t) : own
    },
  })
}

/** An injected object that refuses every read, descriptor included. The worst case. */
const hostile = () =>
  new Proxy(
    {},
    {
      get() {
        throw new TypeError('hostile get')
      },
      getOwnPropertyDescriptor() {
        throw new TypeError('hostile descriptor')
      },
    },
  )

/**
 * A page that can carry events, which is what EIP-6963 discovery needs.
 *
 * `install` stubs the global with a plain object, and a plain object has no `addEventListener`.
 * All three shapes are real: a prerender has no window at all, a plain stub has one that cannot
 * carry an event, and a live tab has both. The module is asked to work on all three.
 */
function page(ethereum?: unknown) {
  const bus = new EventTarget()
  vi.stubGlobal('window', {
    ethereum,
    addEventListener: (type: string, h: EventListener) => bus.addEventListener(type, h),
    removeEventListener: (type: string, h: EventListener) => bus.removeEventListener(type, h),
    dispatchEvent: (e: Event) => bus.dispatchEvent(e),
  })
  const asked: string[] = []
  bus.addEventListener('eip6963:requestProvider', (e) => asked.push(e.constructor.name))
  return {
    /** A wallet extension that answers the page's request the way EIP-6963 says to. */
    extension: (rdns: string, provider: unknown) =>
      bus.addEventListener('eip6963:requestProvider', () =>
        bus.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: { info: { uuid: `uuid:${rdns}`, name: rdns, icon: '', rdns }, provider },
          }),
        ),
      ),
    /** Every time the page asked the wallets to announce themselves, by event class. */
    requests: () => asked,
  }
}

/** The terms a maker signs. The field list is the settlement's `INTENT_TYPEHASH` order. */
const intent = () => ({
  maker: MAKER,
  recipient: MAKER,
  tokenIn: TOKEN_A,
  tokenOut: TOKEN_B,
  amountIn: 1_000n,
  minOutStart: 900n,
  minOutEnd: 900n,
  curve: CURVE_LINEAR,
  startTime: 0n,
  endTime: 1_000_000n,
  executor: ZERO,
  // A wallet cannot sign a zero config (no EIP-712 struct hashes to zero), so a fee-free offer
  // from a wallet names the chain's default config at rate zero.
  feeConfig: hashFeeConfig(defaultFees(LIVE).config),
  feeRateIn: 0n,
  feeRate: 0n,
  feeRateProceeds: 0n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: 0,
  nonce: 1n,
})

/** The binding that makes a quote exclusive. */
const exclusive = () => ({
  intentHash: ZERO_HASH,
  counterparty: OTHER,
  take: 500n,
  expiry: 1_000_000n,
  nonce: 7n,
})

/** The typed data the wallet was shown, parsed back out of the EIP-712 payload. */
function shown(w: Wallet) {
  const params = w.paramsOf('eth_signTypedData_v4')
  return {
    account: params[0] as Address,
    ...(JSON.parse(String(params[1])) as {
      domain: { name: string; chainId: number; verifyingContract: Address }
      primaryType: string
      message: Record<string, string>
    }),
  }
}

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setChainId(LIVE)
  setSettlementOverride(LIVE, SETTLEMENT)
  setSettlementOverride(DEAD, NONE)
})

afterEach(() => {
  setSettlementOverride(LIVE, null)
  setSettlementOverride(DEAD, null)
  setChainId(DEFAULT_CHAIN)
  // A stated wallet preference lives as long as the page does, so a test that states one has to
  // take it back.
  preferWallet(null)
  vi.unstubAllGlobals()
})

describe('whether there is a wallet to ask', () => {
  test('a page with no window has none, and says so rather than throwing', () => {
    // Every prerendered page runs this. `hasWallet` is read while the server builds the HTML.
    expect(hasWallet()).toBe(false)
  })

  test('a browser with no extension has none', () => {
    vi.stubGlobal('window', {})
    expect(hasWallet()).toBe(false)
  })

  test('a browser with one has it', () => {
    install(fakeWallet())
    expect(hasWallet()).toBe(true)
  })
})

describe('with no wallet in the page', () => {
  /**
   * Every entry point that needs a provider names the missing extension. The message is the whole
   * of what a person can do about it, so it must not become "cannot read properties of undefined".
   */
  test('connect says which extensions to install', async () => {
    await expect(connect()).rejects.toThrow(/No browser wallet found/)
  })

  test('the chain guard says it too, rather than reading a chain id off nothing', async () => {
    await expect(ensureChain()).rejects.toThrow(/No browser wallet found/)
  })

  test('so does the client every SDK write takes', async () => {
    await expect(browserWallet()).rejects.toThrow(/No browser wallet found/)
  })

  test('and so does signing', async () => {
    await expect(signIntent(intent())).rejects.toThrow(/No browser wallet found/)
  })

  test('currentAccount answers null instead, because asking is not the point', async () => {
    // The header reads this on mount. A throw would be an error banner on every visit made
    // without an extension, which is most of them.
    expect(await currentAccount()).toBeNull()
  })

  test('a listener subscribes to nothing and still hands back a working unsubscribe', () => {
    const stop = onAccountsChanged(() => {})
    expect(() => stop()).not.toThrow()
  })
})

describe('connecting', () => {
  test('asks for the accounts and answers with the first', async () => {
    const w = fakeWallet({ accounts: [MAKER, OTHER] })
    install(w)
    expect(await connect(LIVE)).toBe(MAKER)
    expect(w.methods()).toContain('eth_requestAccounts')
  })

  test('puts the wallet on the right chain before it answers', async () => {
    // The account is useless on the wrong chain: every read and every write that follows is
    // addressed to a contract on `LIVE`.
    const w = fakeWallet({ chainId: DEAD })
    install(w)
    await connect(LIVE)
    expect(w.methods()).toContain('wallet_switchEthereumChain')
    expect(w.state.chainId).toBe(LIVE)
  })

  test('asks for the accounts first, so the person is not made to switch chains to say no', async () => {
    const w = fakeWallet({ chainId: DEAD })
    install(w)
    await connect(LIVE)
    expect(w.methods()[0]).toBe('eth_requestAccounts')
  })

  test('a refused connection is passed on, in the wallet’s own words', async () => {
    const w = fakeWallet({
      answers: {
        eth_requestAccounts: () => {
          throw rejection('User rejected the request.')
        },
      },
    })
    install(w)
    await expect(connect(LIVE)).rejects.toThrow(/rejected/i)
    // Nothing follows a refusal. A chain switch prompt after "no" is a second prompt nobody asked
    // for.
    expect(w.methods()).toEqual(['eth_requestAccounts'])
  })

  test('a wallet that grants no account answers null, not undefined', async () => {
    // Undefined is the header's word for "the wallet has not answered yet" — `accountAnswered`
    // in `lib/answered.ts` reads it exactly that way — so handing it back from a finished
    // connection leaves the button pulsing at "checking" for ever, on a page that has already
    // asked. `currentAccount` answers null for the same wallet, and null is what the header
    // draws "connect" from. A person who opens a locked wallet and declines to unlock it lands
    // here.
    install(fakeWallet({ accounts: [] }))
    expect(await connect(LIVE)).toBeNull()
  })

  test('connects on the selected chain when it is given none', async () => {
    setChainId(DEAD)
    const w = fakeWallet({ chainId: LIVE })
    install(w)
    await connect()
    expect(w.state.chainId).toBe(DEAD)
  })
})

describe('which account the page is on', () => {
  test('the first of the wallet’s accounts', async () => {
    install(fakeWallet({ accounts: [MAKER, OTHER] }))
    expect(await currentAccount()).toBe(MAKER)
  })

  test('a locked wallet answers null, which is an answer', async () => {
    // `eth_accounts` is the read that prompts nothing, so a locked wallet answers with an empty
    // list rather than an error. Null is what the header draws "connect" from.
    install(fakeWallet({ accounts: [] }))
    expect(await currentAccount()).toBeNull()
  })

  test('it never prompts', async () => {
    const w = fakeWallet()
    install(w)
    await currentAccount()
    expect(w.methods()).toEqual(['eth_accounts'])
  })
})

describe('the chain guard', () => {
  test('a wallet already on the chain is left alone', async () => {
    const w = fakeWallet({ chainId: LIVE })
    install(w)
    await ensureChain(LIVE)
    expect(w.methods()).toEqual(['eth_chainId'])
  })

  test('a wallet on another chain is asked to switch, to this chain', async () => {
    const w = fakeWallet({ chainId: DEAD })
    install(w)
    await ensureChain(LIVE)
    expect(w.paramsOf('wallet_switchEthereumChain')).toEqual([{ chainId: numberToHex(LIVE) }])
  })

  test('a chain the wallet does not know is offered, with the registry’s own details', async () => {
    // A wallet that has never seen PulseChain refuses the switch. The add carries everything it
    // needs to run: the id, the name, the native currency, an endpoint and an explorer.
    const w = fakeWallet({
      chainId: DEAD,
      answers: {
        wallet_switchEthereumChain: () => {
          throw Object.assign(new Error('Unrecognized chain ID.'), { code: 4902 })
        },
      },
    })
    install(w)
    await ensureChain(LIVE)
    const [added] = w.paramsOf('wallet_addEthereumChain') as [Record<string, unknown>]
    expect(added.chainId).toBe(numberToHex(LIVE))
    expect(added.chainName).toBe('PulseChain V4')
    expect(added.nativeCurrency).toEqual({ name: 'V4 Pulse', symbol: 'v4PLS', decimals: 18 })
    expect(added.rpcUrls).toEqual(['https://rpc.v4.testnet.pulsechain.com'])
    expect(added.blockExplorerUrls).toEqual(['https://scan.v4.testnet.pulsechain.com'])
  })

  test('a refused add is passed on, because the chain was not reached', async () => {
    const w = fakeWallet({
      chainId: DEAD,
      answers: {
        wallet_switchEthereumChain: () => {
          throw rejection('User rejected the request.')
        },
        wallet_addEthereumChain: () => {
          throw rejection('User rejected the request.')
        },
      },
    })
    install(w)
    await expect(ensureChain(LIVE)).rejects.toThrow(/rejected/i)
  })

  /**
   * The guard that has to hold, because it is the last one.
   *
   * `wallet_addEthereumChain` resolves for a chain the wallet already knows, and it does not have
   * to switch to it — the person can approve the add and decline the switch, and some wallets
   * never offer the switch at all. Nothing downstream reads the wallet's chain again: the client
   * is built on the chain that was *asked* for, so an unswitched wallet is handed a client that
   * claims a chain it is not on.
   */
  test('a wallet that stays on its old chain is refused, not reported as ready', async () => {
    const w = fakeWallet({
      chainId: DEAD,
      answers: {
        wallet_switchEthereumChain: () => {
          throw Object.assign(new Error('Unrecognized chain ID.'), { code: 4902 })
        },
        // Added, and not switched to. The wallet is still on `DEAD`.
        wallet_addEthereumChain: () => null,
      },
    })
    install(w)
    await expect(ensureChain(LIVE)).rejects.toThrow(/another chain/)
  })

  test('the refusal speaks through the translation table', async () => {
    const w = fakeWallet({
      chainId: DEAD,
      answers: {
        wallet_switchEthereumChain: () => {
          throw Object.assign(new Error('Unrecognized chain ID.'), { code: 4902 })
        },
        wallet_addEthereumChain: () => null,
      },
    })
    install(w)
    const expected = t('wallet.chain.other', { network: network(LIVE).chain.name })
    await expect(ensureChain(LIVE)).rejects.toThrow(expected)
  })

  test('and no client is handed out for a chain the wallet is not on', async () => {
    // The refusal has to reach `browserWallet`, because that is what every SDK write takes. A
    // client on the wrong chain signs the wrong deployment's terms and sends to the wrong one.
    const w = fakeWallet({
      chainId: DEAD,
      answers: {
        wallet_switchEthereumChain: () => null,
      },
    })
    install(w)
    await expect(browserWallet(LIVE)).rejects.toThrow(/another chain/)
  })

  test('it reads the chain id as hex, the way a wallet reports it', async () => {
    // `eth_chainId` answers '0x3af', not 943. Reading it as a decimal makes every chain wrong.
    const w = fakeWallet({ answers: { eth_chainId: () => numberToHex(LIVE) } })
    install(w)
    await ensureChain(LIVE)
    expect(w.methods()).toEqual(['eth_chainId'])
  })

  test('with no argument it guards the selected chain', async () => {
    setChainId(DEAD)
    const w = fakeWallet({ chainId: LIVE })
    install(w)
    await ensureChain()
    expect(w.state.chainId).toBe(DEAD)
  })
})

describe('the client every SDK write takes', () => {
  test('is on the chain that was asked for', async () => {
    install(fakeWallet({ chainId: LIVE }))
    const wallet = await browserWallet(LIVE)
    expect(wallet.chain.id).toBe(LIVE)
  })

  test('speaks through the page’s own wallet and not an endpoint', async () => {
    // The transport is the extension. A write signed here is sent by the person, from their own
    // node, and this app never holds a key.
    install(fakeWallet())
    const wallet = await browserWallet(LIVE)
    expect(wallet.transport.type).toBe('custom')
  })

  test('guards the chain before it is built', async () => {
    const w = fakeWallet({ chainId: DEAD })
    install(w)
    await browserWallet(LIVE)
    expect(w.state.chainId).toBe(LIVE)
  })
})

describe('signing the terms', () => {
  test('the maker signs, under the settlement’s domain, on this chain', async () => {
    const w = fakeWallet()
    install(w)
    expect(await signIntent(intent(), LIVE)).toBe(SIGNATURE)
    const data = shown(w)
    expect(data.account).toBe(MAKER)
    expect(data.primaryType).toBe('Intent')
    expect(data.domain.verifyingContract).toBe(SETTLEMENT)
    expect(data.domain.chainId).toBe(LIVE)
  })

  test('the amount reaches the wallet in wei, to the last unit', async () => {
    // The wallet shows this number to the person, and the settlement spends exactly it. A
    // rounded amount here is a different offer from the one the form drew.
    const w = fakeWallet()
    install(w)
    await signIntent({ ...intent(), amountIn: 123_456_789_012_345_678n }, LIVE)
    expect(shown(w).message.amountIn).toBe('123456789012345678')
  })

  /**
   * The refusal this file exists for.
   *
   * On a chain with no settlement the domain's `verifyingContract` is the zero address, and a
   * signature under it is bound to no contract at all — unspendable the day it is made and
   * unrescuable by any later deploy. Seven such offers reached the mainnet archive.
   */
  test('a chain with no settlement is refused', async () => {
    install(fakeWallet({ chainId: DEAD }))
    await expect(signIntent(intent(), DEAD)).rejects.toThrow(/not deployed/)
  })

  test('and refused before the wallet opens, so nobody is prompted for nothing', async () => {
    const w = fakeWallet({ chainId: DEAD })
    install(w)
    await expect(signIntent(intent(), DEAD)).rejects.toThrow(/not deployed/)
    expect(w.methods()).toEqual([])
  })

  test('the refusal reads the chain, not the caller’s claim about it', async () => {
    // A form that computes "live" wrongly must not be able to talk its way past. The only
    // argument this takes is the chain id.
    setChainId(DEAD)
    install(fakeWallet({ chainId: DEAD }))
    await expect(signIntent(intent())).rejects.toThrow(/not deployed/)
  })

  /**
   * The fee half of the same rule. A rate sent with no config to pay it to, or a rate above one
   * hundred per cent, is `BadTerms_` at every fill for the life of the offer. The form refuses it;
   * this holds whatever else asks, and it holds before the wallet opens.
   */
  test('a rate with no fee config is refused before the wallet opens', async () => {
    const w = fakeWallet()
    install(w)
    await expect(signIntent({ ...intent(), feeConfig: ZERO_HASH, feeRate: 1n }, LIVE)).rejects.toThrow(
      /feeConfig = 0 charges no fee/,
    )
    expect(w.methods()).toEqual([])
  })

  test('a rate above one hundred per cent is refused at each point, before the wallet opens', async () => {
    const w = fakeWallet()
    install(w)
    const over = 10n ** 18n + 1n
    for (const o of [{ feeRateIn: over }, { feeRate: over }, { feeRateProceeds: over }]) {
      await expect(signIntent({ ...intent(), ...o }, LIVE)).rejects.toThrow(/above/i)
    }
    expect(w.methods()).toEqual([])
  })

  test('a config the app does not know the destinations of is refused: a wallet could not show it', async () => {
    const w = fakeWallet()
    install(w)
    await expect(signIntent({ ...intent(), feeConfig: `0x${'ab'.repeat(32)}` }, LIVE)).rejects.toThrow(
      /not one this app ships/,
    )
    expect(w.methods()).toEqual([])
  })

  test('a chain default the build does not ship is refused until its destinations are acknowledged', async () => {
    const stranger = { destinations: ['0x00000000000000000000000000000000000000aa' as Address], weights: [10n ** 18n] }
    const h = hashFeeConfig(stranger)
    const w = fakeWallet()
    install(w)
    // Read from the chain but not acknowledged: not remembered, so the guard refuses it.
    await expect(signIntent({ ...intent(), feeConfig: h }, LIVE)).rejects.toThrow(/not one this app ships/)
    expect(w.methods()).toEqual([])
    rememberFeeConfig(stranger) // what `acknowledgeDefault` does once the maker accepts
    await expect(signIntent({ ...intent(), feeConfig: h }, LIVE)).resolves.toMatch(/^0x/)
  })

  test('a refused signature is passed on and nothing is returned in its place', async () => {
    const w = fakeWallet({
      answers: {
        eth_signTypedData_v4: () => {
          throw rejection('User rejected the request.')
        },
      },
    })
    install(w)
    await expect(signIntent(intent(), LIVE)).rejects.toThrow(/rejected/i)
  })

  test('a refused signature is asked for once, not retried', async () => {
    // A retry is a second wallet prompt for a person who has already said no.
    const w = fakeWallet({
      answers: {
        eth_signTypedData_v4: () => {
          throw rejection('User rejected the request.')
        },
      },
    })
    install(w)
    await signIntent(intent(), LIVE).catch(() => {})
    expect(w.methods().filter((m) => m === 'eth_signTypedData_v4')).toHaveLength(1)
  })
})

describe('signing the exclusivity binding', () => {
  test('is signed under the venue’s domain, not the settlement’s', async () => {
    // A second domain, so the settlement's `Intent` typehash never moves. The venue's address is
    // the verifying contract here, and the chain id is in it, so a binding made for one venue on
    // one chain verifies nowhere else.
    const w = fakeWallet()
    install(w)
    expect(await signExclusive(MAKER, exclusive(), VENUE, LIVE)).toBe(SIGNATURE)
    const data = shown(w)
    expect(data.primaryType).toBe('Exclusive')
    expect(data.domain.name).toBe('prove.cash rfq')
    expect(data.domain.verifyingContract).toBe(VENUE)
    expect(data.domain.chainId).toBe(LIVE)
  })

  test('the signer is the account it was given, which need not be the counterparty', async () => {
    const w = fakeWallet()
    install(w)
    await signExclusive(MAKER, exclusive(), VENUE, LIVE)
    expect(shown(w).account).toBe(MAKER)
    expect(shown(w).message.counterparty).toBe(OTHER)
  })

  test('the size it releases reaches the wallet unrounded', async () => {
    const w = fakeWallet()
    install(w)
    await signExclusive(MAKER, { ...exclusive(), take: 999_999_999_999_999_999n }, VENUE, LIVE)
    expect(shown(w).message.take).toBe('999999999999999999')
  })

  test('a refused binding is passed on', async () => {
    const w = fakeWallet({
      answers: {
        eth_signTypedData_v4: () => {
          throw rejection('User rejected the request.')
        },
      },
    })
    install(w)
    await expect(signExclusive(MAKER, exclusive(), VENUE, LIVE)).rejects.toThrow(/rejected/i)
  })
})

describe('signing a plain string', () => {
  test('goes out as personal_sign, with the string readable to the person signing it', async () => {
    // The wallet shows these two messages to the person who is attesting to them, so they travel
    // as text rather than as typed data.
    const w = fakeWallet()
    install(w)
    expect(await signMessage(MAKER, 'prove.cash rfq key v1', LIVE)).toBe(SIGNATURE)
    const params = w.paramsOf('personal_sign')
    expect(hexToString(params[0] as Hex)).toBe('prove.cash rfq key v1')
    expect(params[1]).toBe(MAKER)
  })

  test('the same string asks the wallet for the same bytes every time', async () => {
    // One of the two callers derives an encryption key from the signature. A request that varies
    // is a key that varies, and every sealed quote already addressed to the old one is lost.
    const first = fakeWallet()
    install(first)
    await signMessage(MAKER, 'prove.cash rfq key v1', LIVE)
    vi.unstubAllGlobals()
    const second = fakeWallet()
    install(second)
    await signMessage(MAKER, 'prove.cash rfq key v1', LIVE)
    expect(first.paramsOf('personal_sign')).toEqual(second.paramsOf('personal_sign'))
  })

  test('a refused message is passed on', async () => {
    const w = fakeWallet({
      answers: {
        personal_sign: () => {
          throw rejection('User rejected the request.')
        },
      },
    })
    install(w)
    await expect(signMessage(MAKER, 'prove.cash rfq key v1', LIVE)).rejects.toThrow(/rejected/i)
  })
})

describe('when the person switches account', () => {
  test('the new account is reported', () => {
    const w = fakeWallet()
    install(w)
    const seen: (Address | null)[] = []
    onAccountsChanged((a) => seen.push(a))
    w.emit('accountsChanged', [OTHER])
    expect(seen).toEqual([OTHER])
  })

  test('a wallet that disconnects reports null, not an empty list', () => {
    // The page reads null as "no account". An empty array is truthy and would read as connected.
    const w = fakeWallet()
    install(w)
    const seen: (Address | null)[] = []
    onAccountsChanged((a) => seen.push(a))
    w.emit('accountsChanged', [])
    expect(seen).toEqual([null])
  })

  test('the unsubscribe stops the reports', () => {
    const w = fakeWallet()
    install(w)
    const stop = onAccountsChanged(() => {})
    expect(w.listening('accountsChanged')).toBe(true)
    stop()
    expect(w.listening('accountsChanged')).toBe(false)
  })

  test('a provider with no listener support is tolerated, both ways', () => {
    // `on` and `removeListener` are not in EIP-1193. A provider without them must not take the
    // page down on mount, or on unmount.
    const w = fakeWallet({ listeners: false })
    install(w)
    const stop = onAccountsChanged(() => {})
    expect(() => stop()).not.toThrow()
  })
})

/**
 * Two wallet extensions fighting over `window.ethereum`.
 *
 * The defect this section exists for took the whole app down on production. One extension
 * installed the global as a Proxy whose `get` trap returned a fresh bound function where the
 * target held a frozen one, and the engine refused the read:
 *
 *   TypeError: 'get' on proxy: property 'on' is a read-only and non-configurable data property
 *   on the proxy target but the proxy did not return its actual value
 *
 * It threw at `p.on?.(…)` inside the mount effect in `App.tsx`, so React unmounted the tree and
 * the tab went white. Nothing was clickable and nothing said why. Brave is the known cause: it
 * makes `request`, `isConnected`, `enable` and `sendAsync` non-writable to stop another extension
 * overwriting them, and then its own proxy re-wraps those same methods — see brave-core
 * `js_ethereum_provider.cc`. RainbowKit #1081 is the same crash, closed unfixed.
 *
 * So every read of an injected object is a read of code this app did not write, and none of them
 * may throw into a render, an effect or a click.
 */
describe('two wallet extensions fighting over the page', () => {
  test('the engine throws on the property read itself, which is the defect', () => {
    // The reproduction. Nothing of ours runs here: this is the read, and the engine refusing it.
    const w = fakeWallet()
    vi.stubGlobal('window', { ethereum: contested(w) })
    const injected = window.ethereum as unknown as Record<string, unknown>
    expect(() => injected.on).toThrow(TypeError)
    expect(() => injected.on).toThrow(/read-only and non-configurable/)
  })

  test('the page still knows there is a wallet, and asking never throws', () => {
    // `hasWallet` is read during render. A throw here is a white screen with no effect involved.
    const w = fakeWallet()
    vi.stubGlobal('window', { ethereum: contested(w) })
    expect(() => hasWallet()).not.toThrow()
    expect(hasWallet()).toBe(true)
  })

  test('the account subscription survives, because a descriptor read skips the `get` trap', () => {
    // `Object.getOwnPropertyDescriptor` does not go through the trap, so the frozen function is
    // still reachable. The subscription works rather than merely failing quietly.
    const w = fakeWallet()
    vi.stubGlobal('window', { ethereum: contested(w) })
    const seen: (Address | null)[] = []
    let stop: () => void = () => {}
    expect(() => (stop = onAccountsChanged((a) => seen.push(a)))).not.toThrow()
    w.emit('accountsChanged', [OTHER])
    expect(seen).toEqual([OTHER])
    expect(() => stop()).not.toThrow()
  })

  test('and a request still goes through', async () => {
    const w = fakeWallet()
    vi.stubGlobal('window', { ethereum: contested(w) })
    expect(await currentAccount()).toBe(MAKER)
  })

  test('an object that refuses every read still leaves an unsubscribe to call', () => {
    vi.stubGlobal('window', { ethereum: hostile() })
    let stop: () => void = () => {}
    expect(() => (stop = onAccountsChanged(() => {}))).not.toThrow()
    expect(() => stop()).not.toThrow()
  })

  test('it is named as a conflict the person can act on, not as a proxy invariant', async () => {
    // What a person can do about this is turn an extension off. "'get' on proxy: property 'on'
    // is a read-only and non-configurable data property" is not that sentence.
    vi.stubGlobal('window', { ethereum: hostile() })
    const failure = await connect().catch((e: unknown) => e as Error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/in conflict/)
    expect((failure as Error).message).not.toMatch(/proxy/)
  })

  test('hasWallet answers false rather than throwing when the global itself refuses', () => {
    // Some extensions install `ethereum` as a getter. Reading it can throw on its own.
    vi.stubGlobal('window', {
      get ethereum() {
        throw new TypeError('cannot redefine property: ethereum')
      },
    })
    expect(() => hasWallet()).not.toThrow()
    expect(hasWallet()).toBe(false)
  })
})

/**
 * EIP-6963: the wallets that announce themselves.
 *
 * The standard written for several wallets on one page. The app dispatches
 * `eip6963:requestProvider`, each extension answers with `eip6963:announceProvider` carrying its
 * own provider object, and the app talks to that object instead of the contested global. It is
 * the fix rather than a workaround: Brave announces `window.braveEthereum`, the raw object behind
 * the proxy that throws.
 *
 * The global stays as the fallback, because plenty of wallets still do not announce.
 */
describe('EIP-6963: the wallets that announce themselves', () => {
  test('the page asks, with the plain event the standard names', async () => {
    const good = fakeWallet()
    const p = page(undefined)
    p.extension('io.metamask', good.provider)
    await currentAccount()
    // `eip6963:requestProvider` carries no detail, so it is an `Event`. Only the announcement is
    // a `CustomEvent`. A wallet that checks the class must find the right one.
    expect(p.requests()).toEqual(['Event'])
  })

  test('an announced wallet is used instead of the contested global', async () => {
    const good = fakeWallet()
    const broken = fakeWallet()
    const p = page(contested(broken))
    p.extension('io.metamask', good.provider)
    expect(await currentAccount()).toBe(MAKER)
    expect(good.methods()).toEqual(['eth_accounts'])
    expect(broken.methods()).toEqual([])
  })

  test('and it takes the account subscription too', () => {
    const good = fakeWallet()
    const broken = fakeWallet()
    const p = page(contested(broken))
    p.extension('io.metamask', good.provider)
    const seen: (Address | null)[] = []
    onAccountsChanged((a) => seen.push(a))
    expect(good.listening('accountsChanged')).toBe(true)
    expect(broken.listening('accountsChanged')).toBe(false)
    good.emit('accountsChanged', [OTHER])
    expect(seen).toEqual([OTHER])
  })

  test('several announcements pick the same wallet on every load', async () => {
    // Announcement order is arbitrary and it changes between loads — mipd and wagmi keep it, and
    // the standard promises nothing about it. A person must not get one wallet this morning and
    // another this afternoon, so the choice is made by a stable name instead.
    const mask = fakeWallet()
    const rabby = fakeWallet()
    const p = page(undefined)
    p.extension('io.metamask', mask.provider)
    p.extension('io.rabby', rabby.provider)
    expect(await currentAccount()).toBe(MAKER)
    expect(mask.methods()).toEqual(['eth_accounts'])
    expect(rabby.methods()).toEqual([])
  })

  test('a picker would list every one of them, in that same order', () => {
    const p = page(undefined)
    p.extension('io.rabby', fakeWallet().provider)
    p.extension('io.metamask', fakeWallet().provider)
    expect(announcedWallets().map((i) => i.rdns)).toEqual(['io.metamask', 'io.rabby'])
    expect(announcedWallets()[0].name).toBe('io.metamask')
  })

  test('and a stated preference wins over that order', async () => {
    // The seam a picker goes in. Nothing draws one yet.
    const mask = fakeWallet()
    const rabby = fakeWallet()
    const p = page(undefined)
    p.extension('io.metamask', mask.provider)
    p.extension('io.rabby', rabby.provider)
    preferWallet('io.rabby')
    expect(await currentAccount()).toBe(MAKER)
    expect(rabby.methods()).toEqual(['eth_accounts'])
    expect(mask.methods()).toEqual([])
  })

  test('a preference for a wallet that is not here falls back to the rule', async () => {
    const mask = fakeWallet()
    const p = page(undefined)
    p.extension('io.metamask', mask.provider)
    preferWallet('com.nowhere')
    expect(await currentAccount()).toBe(MAKER)
    expect(mask.methods()).toEqual(['eth_accounts'])
  })

  test('an announcement with no reverse-DNS name is ignored', async () => {
    // `rdns` is the only field this app keys on, and it is what the standard makes stable between
    // sessions. An announcement without one cannot be told from the next one.
    const nameless = fakeWallet()
    const global = fakeWallet()
    const p = page(global.provider)
    p.extension('', nameless.provider)
    expect(await currentAccount()).toBe(MAKER)
    expect(global.methods()).toEqual(['eth_accounts'])
    expect(nameless.methods()).toEqual([])
  })

  test('the global is the fallback when nothing announces', async () => {
    const w = fakeWallet()
    const p = page(w.provider)
    expect(p.requests()).toEqual([])
    expect(await currentAccount()).toBe(MAKER)
    expect(p.requests()).toEqual(['Event'])
  })

  test('a page that cannot carry events still finds the global', async () => {
    // A plain `window` with no `addEventListener` — a prerender, an old browser, or this stub.
    // Discovery must give up quietly rather than throw on the way past.
    const w = fakeWallet()
    install(w)
    expect(() => hasWallet()).not.toThrow()
    expect(await currentAccount()).toBe(MAKER)
  })

  test('a page with no window at all discovers nothing and says so', () => {
    // Every prerendered page runs this.
    expect(announcedWallets()).toEqual([])
    expect(hasWallet()).toBe(false)
  })
})

/**
 * The account at load, read once and then followed.
 *
 * The first read is a promise, and the wallet's `accountsChanged` event can land before it
 * settles. A late first answer must not overwrite a newer one, and a failed first read is
 * "no account", not an unhandled rejection.
 */
describe('watching the account', () => {
  test('the first read answers', async () => {
    install(fakeWallet({ accounts: [MAKER] }))
    const seen: (Address | null)[] = []
    const stop = watchAccount((a) => seen.push(a))
    await vi.waitFor(() => expect(seen).toEqual([MAKER]))
    stop()
  })

  test('a failed first read answers null', async () => {
    install(
      fakeWallet({
        answers: {
          eth_accounts: () => {
            throw new Error('locked')
          },
        },
      }),
    )
    const seen: (Address | null)[] = []
    const stop = watchAccount((a) => seen.push(a))
    await vi.waitFor(() => expect(seen).toEqual([null]))
    stop()
  })

  test('an event before the first read settles wins over the late read', async () => {
    let release: (v: Address[]) => void = () => {}
    const w = fakeWallet({
      answers: { eth_accounts: () => new Promise<Address[]>((r) => (release = r)) },
    })
    install(w)
    const seen: (Address | null)[] = []
    const stop = watchAccount((a) => seen.push(a))
    w.emit('accountsChanged', [OTHER])
    release([MAKER])
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([OTHER])
    stop()
  })

  test('a read that settles after unsubscribe reports nothing', async () => {
    let release: (v: Address[]) => void = () => {}
    install(fakeWallet({ answers: { eth_accounts: () => new Promise<Address[]>((r) => (release = r)) } }))
    const seen: (Address | null)[] = []
    const stop = watchAccount((a) => seen.push(a))
    stop()
    release([MAKER])
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([])
  })
})
