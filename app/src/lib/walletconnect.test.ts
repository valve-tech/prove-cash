import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { numberToHex, type Address } from 'viem'
import { en } from '../i18n/en.ts'
import {
  DEFAULT_CHAIN,
  memoryKeyValueStore,
  setChainId,
  setKeyValueStore,
  setRpc,
  setRpcLinked,
  type ChainId,
} from '@prove.cash/sdk'
import {
  cancelWalletConnect,
  connectWalletConnect,
  disconnectWalletConnect,
  onSessionEnded,
  projectId,
  setSessionLoader,
  walletConnectOffered,
  type SessionProvider,
} from './walletconnect.ts'
import { browserWallet, ensureChain, onAccountsChanged, onSession, preferWallet } from './wallet.ts'

/**
 * WalletConnect, without a relay and without a phone.
 *
 * The provider is a fake, so nothing here opens a socket. What the fake is for is the boundary:
 * `lib/walletconnect.ts` asks a provider for a session and then hands that provider to
 * `lib/wallet.ts` as if it were an extension. Every question below is about that handover — what
 * the wallet is asked for, in what order, on which chain, and what happens when the answer never
 * comes.
 *
 * Two of these tests exist because the real package surprised us, and both fail without the fix:
 * `eth_chainId` comes back as a number rather than as hex, and `rpcMap` is read under two
 * different key spellings. Neither is written down anywhere outside the package's own source.
 */

const MAKER: Address = '0x1111111111111111111111111111111111111111'
const OTHER: Address = '0x2222222222222222222222222222222222222222'
const LIVE: ChainId = 943
const MAIN: ChainId = 369
const ID = 'a-public-reown-project-id'

type Call = { method: string; params?: unknown }

/**
 * A provider in the shape `@walletconnect/universal-provider` hands back.
 *
 * The details that matter are copied from that package rather than invented. `eth_chainId`
 * answers with a NUMBER, because the real one does `parseInt(this.getDefaultChain())` and
 * returns the result. `wallet_switchEthereumChain` is answered locally when the chain is one the
 * session already carries, because that is what `handleSwitchChain` does — no round trip to the
 * wallet at all. A fake that answered hex, or that always asked the wallet, would let a broken
 * `ensureChain` pass.
 */
function fakeSession(
  opts: {
    /** The chains the wallet approved. A wallet that never heard of 369 approves only 943. */
    approved?: ChainId[]
    accounts?: Address[]
    /** Fail the handshake, the way an unreachable relay does. */
    failConnect?: Error
    /** Never hand back a URI. A relay that accepted the socket and then said nothing. */
    silent?: boolean
    /** Never settle the handshake either. A relay that refuses the socket and retries forever. */
    hang?: boolean
  } = {},
) {
  const approved = opts.approved ?? [LIVE, MAIN]
  const calls: Call[] = []
  const handlers = new Map<string, Set<(v: unknown) => void>>()
  const state = { chain: approved[0] as number, disconnected: false, aborted: 0 }
  let namespaces: unknown

  const fire = (event: string, value: unknown) => {
    for (const h of handlers.get(event) ?? []) h(value)
  }

  const raw = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push({ method, params })
      switch (method) {
        case 'eth_chainId':
          // A number. Not `numberToHex(state.chain)`. This is the trap.
          return state.chain
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return opts.accounts ?? [MAKER]
        case 'wallet_switchEthereumChain': {
          const want = Number((params as [{ chainId: `0x${string}` }])[0].chainId)
          if (!approved.includes(want as ChainId)) throw new Error('chain not approved')
          state.chain = want
          return null
        }
        case 'wallet_addEthereumChain':
          state.chain = Number((params as [{ chainId: `0x${string}` }])[0].chainId)
          return null
        case 'personal_sign':
          return `0x${'ab'.repeat(65)}`
      }
      throw new Error(`asked for ${method}, which this module should never send`)
    },
    on: (event: string, handler: (v: unknown) => void) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
    },
    removeListener: (event: string, handler: (v: unknown) => void) => {
      handlers.get(event)?.delete(handler)
    },
    connect: async (opts2: { optionalNamespaces: unknown }) => {
      namespaces = opts2.optionalNamespaces
      if (opts.failConnect) throw opts.failConnect
      if (!opts.silent) fire('display_uri', 'wc:topic@2?relay-protocol=irn&symKey=deadbeef')
      if (opts.hang) return await new Promise(() => {})
      return {}
    },
    disconnect: async () => {
      state.disconnected = true
    },
    setDefaultChain: (chain: string) => {
      const want = Number(chain.split(':')[1])
      if (!approved.includes(want as ChainId)) throw new Error('no provider for that chain')
      state.chain = want
    },
    abortPairingAttempt: () => {
      state.aborted += 1
    },
  }

  /*
   * Cast once, here, rather than annotating the object above.
   *
   * viem's `EIP1193RequestFn` is generic over the method name, so a plain async function that
   * returns a union of answers cannot satisfy it — no fake can, and `lib/wallet.test.ts` reaches
   * the same wall. The cast is at the boundary and the shape above is the real one.
   */
  const provider = raw as unknown as SessionProvider

  return {
    provider,
    state,
    calls,
    methods: () => calls.map((c) => c.method),
    /** The eip155 namespace the session was asked for. */
    asked: () => (namespaces as Record<string, Record<string, unknown>>).eip155,
    fire,
  }
}

type Session = ReturnType<typeof fakeSession>

/** Build sessions from this fake instead of importing the relay client. */
const useFake = (s: Session) => setSessionLoader(async () => s.provider)

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setChainId(LIVE)
  vi.stubEnv('VITE_REOWN_PROJECT_ID', ID)
})

afterEach(async () => {
  // A session lives as long as the module does, which in a test run is as long as the whole
  // file. Every test starts from no session, the way a fresh page does.
  await disconnectWalletConnect()
  setSessionLoader(null)
  setChainId(DEFAULT_CHAIN)
  // A session outlives one test the way it outlives one page, so every test takes its own back.
  preferWallet(null)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the project id', () => {
  test('a build with one offers WalletConnect', () => {
    expect(projectId()).toBe(ID)
    expect(walletConnectOffered()).toBe(true)
  })

  test('a build without one offers nothing, and says so without throwing', () => {
    vi.stubEnv('VITE_REOWN_PROJECT_ID', undefined)
    expect(projectId()).toBeNull()
    expect(walletConnectOffered()).toBe(false)
  })

  test('an empty variable counts as absent', () => {
    // `VITE_REOWN_PROJECT_ID=` in a .env file is the ordinary way to get here, and an empty id
    // does not fail at init — it fails much later, at the relay, with a 403 and no session.
    vi.stubEnv('VITE_REOWN_PROJECT_ID', '   ')
    expect(projectId()).toBeNull()
    expect(walletConnectOffered()).toBe(false)
  })

  test('connecting without one refuses before it reaches a relay', async () => {
    vi.stubEnv('VITE_REOWN_PROJECT_ID', '')
    const seen: string[] = []
    let loaded = false
    setSessionLoader(async () => {
      loaded = true
      return fakeSession().provider
    })
    await expect(connectWalletConnect(LIVE, (u) => seen.push(u))).rejects.toThrow(/project id/i)
    // The refusal comes first, so nothing is fetched and no socket is opened. This is what keeps
    // a build with no id from paying 146 KB to find out it has no id.
    expect(loaded).toBe(false)
    expect(seen).toEqual([])
    expect(onSession()).toBe(false)
  })
})

describe('opening a session', () => {
  test('hands the code out before the handshake finishes, and returns the account', async () => {
    const s = fakeSession()
    useFake(s)
    const seen: string[] = []
    const account = await connectWalletConnect(LIVE, (u) => seen.push(u))
    expect(seen).toEqual(['wc:topic@2?relay-protocol=irn&symKey=deadbeef'])
    expect(account).toBe(MAKER)
    expect(onSession()).toBe(true)
  })

  test('asks for both chains, and asks for them as optional', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    const ns = s.asked()
    // Optional is the whole trick. A `requiredNamespaces` entry is a condition of the session, so
    // a wallet that has never heard of 369 must refuse the entire connection — and most do.
    expect(ns.chains).toEqual(['eip155:369', 'eip155:943'])
    expect(ns.events).toEqual(['accountsChanged', 'chainChanged'])
    expect(ns.methods).toContain('eth_signTypedData_v4')
    expect(ns.methods).toContain('wallet_addEthereumChain')
  })

  test('the endpoint map carries both key spellings', async () => {
    // The package reads this map two ways in two places: `rpcMap['eip155:943']` when it builds
    // its HTTP providers from the namespace chains, and `rpcMap['943']` when it falls back for a
    // chain it meets later. Fill one and the other path reaches for rpc.walletconnect.org, which
    // has never carried PulseChain, and every read through the session times out.
    setRpcLinked(false, LIVE)
    setRpc('https://node.example/943', LIVE, 'chain')
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    const map = s.asked().rpcMap as Record<string, string>
    expect(map['943']).toBe('https://node.example/943')
    expect(map['eip155:943']).toBe('https://node.example/943')
    expect(map['369']).toBe(map['eip155:369'])
    // Nothing may fall through to the relay's own node, on any chain we offer.
    for (const url of Object.values(map)) expect(url).not.toContain('walletconnect.org')
  })

  test('points the session at the chain the app is showing', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(MAIN, () => {})
    expect(s.state.chain).toBe(MAIN)
  })

  test('a wallet sitting on another chain is moved before the account comes back', async () => {
    /*
     * The real-world failure, and it is not a refused session. A wallet approves the chains it
     * knows and then stays wherever it already was — Ethereum, nearly always — because nothing
     * in the handshake tells it to move. Without the guard the header shows an address and every
     * signature after it is made under another chain's domain.
     */
    const s = fakeSession({ approved: [MAIN] })
    useFake(s)
    const account = await connectWalletConnect(LIVE, () => {})
    expect(account).toBe(MAKER)
    // The wallet approved 369 and nothing else, so pointing the session at 943 fails and the
    // guard has to climb the ladder: switch refused, then add. Without it the account comes
    // back on 369 and the first signature is bound to the wrong settlement.
    expect(s.methods()).toContain('wallet_addEthereumChain')
    expect(s.state.chain).toBe(LIVE)
  })

  test('a second attempt uses the open session rather than asking for another scan', async () => {
    const s = fakeSession()
    let built = 0
    setSessionLoader(async () => {
      built += 1
      return s.provider
    })
    const seen: string[] = []
    await connectWalletConnect(LIVE, (u) => seen.push(u))
    await connectWalletConnect(LIVE, (u) => seen.push(u))
    // One pairing, one code. A second would leave two live sessions on the relay for one app,
    // and would ask somebody to scan for a wallet they have already connected.
    expect(built).toBe(1)
    expect(seen).toHaveLength(1)
  })

  test('coming back from an extension re-adopts the session rather than losing it', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    preferWallet('io.metamask')
    expect(onSession()).toBe(false)
    await connectWalletConnect(LIVE, () => {})
    expect(onSession()).toBe(true)
  })

  test('a session that carries no account answers null rather than throwing', async () => {
    const s = fakeSession({ accounts: [] })
    useFake(s)
    // Null is "answered, nothing connected" — the same thing a locked extension says, and what
    // the header needs to stop pulsing at "checking".
    await expect(connectWalletConnect(LIVE, () => {})).resolves.toBeNull()
  })
})

describe('when the relay does not answer', () => {
  test('a failed handshake throws and leaves no session behind', async () => {
    const s = fakeSession({ failConnect: new Error('No matching key. relay: 403') })
    useFake(s)
    await expect(connectWalletConnect(LIVE, () => {})).rejects.toThrow(/403/)
    // The app must be exactly where it started. A half-registered session would send every later
    // signature to a provider with no session.
    expect(onSession()).toBe(false)
  })

  test('a loader that cannot even be fetched throws rather than blanking the page', async () => {
    setSessionLoader(async () => {
      throw new Error('Failed to fetch dynamically imported module')
    })
    await expect(connectWalletConnect(LIVE, () => {})).rejects.toThrow(/dynamically imported/)
    expect(onSession()).toBe(false)
  })

  test('a relay that never answers gives up and says so', async () => {
    /*
     * Measured in a browser against a project id the relay rejects: the socket is refused, the
     * client retries it forever, and nothing comes back — no throw, no event, no code. The
     * dialog sat at "opening the connection" indefinitely.
     *
     * The same silence is what an origin missing from the Reown allowlist produces, and that one
     * passes every test and every local run and fails only in production.
     */
    vi.useFakeTimers()
    try {
      const s = fakeSession({ silent: true, hang: true })
      useFake(s)
      const attempt = connectWalletConnect(LIVE, () => {})
      const caught = expect(attempt).rejects.toThrow(en['wallet.wc.unreachable'])
      await vi.advanceTimersByTimeAsync(13_000)
      await caught
    } finally {
      vi.useRealTimers()
    }
  })

  test('a code on screen buys as long as the person needs', async () => {
    // The wait is bounded on the code arriving, never on somebody scanning it. Once a `wc:`
    // string is up, a person may take as long as they like to find their phone.
    vi.useFakeTimers()
    try {
      const s = fakeSession({ hang: true })
      useFake(s)
      const seen: string[] = []
      let settled = false
      void connectWalletConnect(LIVE, (u) => seen.push(u)).then(
        () => (settled = true),
        () => (settled = true),
      )
      await vi.advanceTimersByTimeAsync(60_000)
      expect(seen).toHaveLength(1)
      expect(settled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed attempt does not poison the next one', async () => {
    const bad = fakeSession({ failConnect: new Error('relay down') })
    const good = fakeSession()
    let n = 0
    setSessionLoader(async () => (n++ === 0 ? bad.provider : good.provider))
    await expect(connectWalletConnect(LIVE, () => {})).rejects.toThrow()
    // A provider whose relay never answered must not be reused. It would hang a second time,
    // and without even pairing, so no code would appear at all.
    await expect(connectWalletConnect(LIVE, () => {})).resolves.toBe(MAKER)
    expect(n).toBe(2)
  })

  test('a relay that says nothing hands out no code', async () => {
    const s = fakeSession({ silent: true })
    useFake(s)
    const seen: string[] = []
    await connectWalletConnect(LIVE, (u) => seen.push(u))
    expect(seen).toEqual([])
  })

  test('the code listener comes off once the handshake settles, either way', async () => {
    const s = fakeSession({ failConnect: new Error('relay down') })
    useFake(s)
    const seen: string[] = []
    await expect(connectWalletConnect(LIVE, (u) => seen.push(u))).rejects.toThrow()
    // A URI that arrives after the attempt is over would put a dead code back on a live screen.
    s.fire('display_uri', 'wc:late@2')
    expect(seen).toEqual([])
  })
})

describe('the chain', () => {
  test('943: a session already on it is not asked to switch', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    s.calls.length = 0
    await ensureChain(LIVE)
    // This is the numeric `eth_chainId` trap. The provider answers 943, not "0x3af", and
    // `parseInt(943, 16)` is 2371 — so a reader that assumes hex decides the wallet is on the
    // wrong chain, asks it to switch to the chain it is already on, and then throws at somebody
    // with nothing to switch. Without `chainOf` this line finds a switch in the list.
    expect(s.methods()).toEqual(['eth_chainId'])
  })

  test('369: a wallet that approved both chains switches without asking the phone', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    s.calls.length = 0
    await ensureChain(MAIN)
    expect(s.methods()).toContain('wallet_switchEthereumChain')
    expect(s.state.chain).toBe(MAIN)
    const params = s.calls.find((c) => c.method === 'wallet_switchEthereumChain')?.params
    expect((params as [{ chainId: string }])[0].chainId).toBe(numberToHex(MAIN))
  })

  test('369: a wallet that only knows 943 is asked to add the network', async () => {
    // The common case, and the one the whole optional-namespace design is for. The wallet
    // approved 943 and nothing else, so the switch is refused and the ladder falls through to
    // the add — the same ladder an extension goes through.
    const s = fakeSession({ approved: [LIVE] })
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    s.calls.length = 0
    await ensureChain(MAIN)
    expect(s.methods()).toContain('wallet_addEthereumChain')
    expect(s.state.chain).toBe(MAIN)
  })

  test('a wallet client over the session names the chain it was built for', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    const client = await browserWallet(MAIN)
    expect(client.chain?.id).toBe(MAIN)
  })
})

describe('the account subscription', () => {
  test('a session pushes an account change through the same call an extension does', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    const seen: (Address | null)[] = []
    const off = onAccountsChanged((a) => seen.push(a))
    s.fire('accountsChanged', [OTHER])
    expect(seen).toEqual([OTHER])
    off()
    s.fire('accountsChanged', [MAKER])
    // The unsubscribe has to reach the session's own emitter, not a no-op. A header that keeps
    // listening after unmount writes state into a tree that is gone.
    expect(seen).toEqual([OTHER])
  })

  test('an empty account list reads as null, not as undefined', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    const seen: (Address | null)[] = []
    onAccountsChanged((a) => seen.push(a))
    s.fire('accountsChanged', [])
    expect(seen).toEqual([null])
  })
})

describe('leaving', () => {
  test('disconnecting tells the wallet and forgets the session here', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    await disconnectWalletConnect()
    expect(s.state.disconnected).toBe(true)
    expect(onSession()).toBe(false)
  })

  test('a disconnect the relay refuses still disconnects this app', async () => {
    const s = fakeSession()
    useFake(s)
    s.provider.disconnect = async () => {
      throw new Error('relay unreachable')
    }
    await connectWalletConnect(LIVE, () => {})
    // Otherwise the button stops working and the address stays on screen for a session that is
    // already gone on the other side.
    await expect(disconnectWalletConnect()).resolves.toBeUndefined()
    expect(onSession()).toBe(false)
  })

  test('the wallet hanging up reaches whoever asked to hear it', async () => {
    const s = fakeSession()
    useFake(s)
    const heard: number[] = []
    const off = onSessionEnded(() => heard.push(1))
    await connectWalletConnect(LIVE, () => {})
    s.fire('session_delete', {})
    expect(heard).toEqual([1])
    expect(onSession()).toBe(false)
    off()
  })

  test('one subscriber that throws does not silence the others', async () => {
    const s = fakeSession()
    useFake(s)
    const heard: string[] = []
    const offA = onSessionEnded(() => {
      throw new Error('a bad subscriber')
    })
    const offB = onSessionEnded(() => heard.push('b'))
    await connectWalletConnect(LIVE, () => {})
    s.fire('disconnect', {})
    expect(heard).toEqual(['b'])
    offA()
    offB()
  })

  test('closing the dialog aborts a pairing nobody is looking at', async () => {
    const s = fakeSession({ silent: true })
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    cancelWalletConnect()
    expect(s.state.aborted).toBe(1)
  })

  test('choosing an extension drops the session', async () => {
    const s = fakeSession()
    useFake(s)
    await connectWalletConnect(LIVE, () => {})
    expect(onSession()).toBe(true)
    // A person connects one wallet, not two. Without this the picker could leave a session
    // behind and every later signature would go to the phone the reader just walked away from.
    preferWallet('io.metamask')
    expect(onSession()).toBe(false)
  })
})
