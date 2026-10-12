import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rpcHeadersFor } from '@prove.cash/sdk'
import {
  PRIORITY_FEE,
  assertChainId,
  boardEndpoint,
  feesAt,
  fees,
  redact,
  registerEndpoint,
  rpcEndpoint,
  rpcLabel,
  rpcTransport,
  describe as why,
} from './rpc.ts'

const GWEI = 1_000_000_000n

/** What every bot carried inline before `feesAt` existed. Kept here as the thing that broke. */
const OLD_LITERAL = { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 20_000_000_000n } as const

/** Chain 369, measured on 2026-08-22. Thirty-five thousand times the cap the bots used to send. */
const MAINNET_BASE = 710_836n * GWEI

/** A block header, as much of one as `fees` reads. */
const clientAt = (baseFeePerGas: bigint | null) => ({
  getBlock: async ({ blockTag }: { blockTag: 'latest' }) => {
    expect(blockTag).toBe('latest')
    return { baseFeePerGas }
  },
})

describe('feesAt', () => {
  it('keeps chain 943 on the 20 gwei floor, because a zero base fee sets no floor of its own', () => {
    expect(feesAt(0n)).toEqual({
      maxPriorityFeePerGas: 1n * GWEI,
      maxFeePerGas: 20n * GWEI,
    })
  })

  it('leaves the 7 wei base fee of 943 on that same floor', () => {
    expect(feesAt(7n).maxFeePerGas).toBe(20n * GWEI)
  })

  it('clears the 369 base fee of 710,836 gwei, which the old 20 gwei literal sat under — a node rejects that send outright', () => {
    expect(OLD_LITERAL.maxFeePerGas).toBeLessThan(MAINNET_BASE) // the bug, stated
    expect(feesAt(MAINNET_BASE).maxFeePerGas).toBeGreaterThan(MAINNET_BASE)
  })

  it('leaves four times the base fee of headroom on 369, so six blocks of 12.5% rises still fit', () => {
    expect(feesAt(MAINNET_BASE).maxFeePerGas).toBe(MAINNET_BASE * 4n + 1n * GWEI)
  })

  it('pays a tip of exactly 1 gwei at every base fee, because the tip is ours to set and never read', () => {
    for (const base of [0n, 7n, 1n * GWEI, MAINNET_BASE, 10_000_000n * GWEI]) {
      expect(feesAt(base).maxPriorityFeePerGas).toBe(1n * GWEI)
      expect(feesAt(base).maxPriorityFeePerGas).toBe(PRIORITY_FEE)
    }
  })

  it('never returns a cap below the base fee, at any base fee either chain has shown', () => {
    for (const base of [0n, 7n, 1n * GWEI, MAINNET_BASE, 10_000_000n * GWEI]) {
      expect(feesAt(base).maxFeePerGas).toBeGreaterThan(base)
    }
  })
})

describe('fees', () => {
  it('builds the cap from the latest block of chain 369', async () => {
    await expect(fees(clientAt(MAINNET_BASE))).resolves.toEqual(feesAt(MAINNET_BASE))
  })

  it('reads a pre-1559 block, whose header carries no base fee, as zero rather than throwing', async () => {
    await expect(fees(clientAt(null))).resolves.toEqual({
      maxPriorityFeePerGas: 1n * GWEI,
      maxFeePerGas: 20n * GWEI,
    })
  })
})

/**
 * A live key, in the shape the registry issues. Not a real one — the real one is 35 characters and
 * lives in a password manager, and a test that needs the real secret is a test that leaks it.
 */
const KEY = 'vk_TestOnly_0123456789abcdefghij'

/**
 * viem's error, as far as these functions read it. `HttpRequestError` puts the request URL into
 * `metaMessages` and `BaseError` folds those into `message`, so the credential arrives inside the
 * multi-line string a bot then logs. This is the exact shape that wrote the key into the journal
 * 32 times.
 */
const viemErrorWith = (url: string) => ({
  shortMessage: 'HTTP request failed.',
  message: [
    'HTTP request failed.',
    '',
    `URL: ${url}`,
    'Request body: {"method":"msgboard_addMessage"}',
    '',
    'Details: fetch failed',
  ].join('\n'),
  cause: { shortMessage: 'fetch failed', message: 'fetch failed' },
})

describe('redact', () => {
  it('takes the key out of a registry URL', () => {
    expect(redact(`URL: https://one.valve.city/rpc/${KEY}/evm/369`)).toBe(
      'URL: https://one.valve.city/rpc/REDACTED/evm/369',
    )
  })

  it('leaves vk_demo legible, because the website publishes it', () => {
    const url = 'https://one.valve.city/rpc/vk_demo/evm/369'
    expect(redact(`URL: ${url}`)).toBe(`URL: ${url}`)
  })

  it('takes the credential out of URL userinfo, which an RPC override can carry', () => {
    expect(redact('https://someone:hunter2@node.example/evm/369')).toBe(
      'https://REDACTED@node.example/evm/369',
    )
  })

  it('takes the live key out of any text at all, whatever surrounds it', () => {
    const before = process.env.VALVE_RPC_KEY
    process.env.VALVE_RPC_KEY = KEY
    try {
      expect(redact(`the node refused key ${KEY} outright`)).toBe(
        'the node refused key REDACTED outright',
      )
    } finally {
      if (before === undefined) delete process.env.VALVE_RPC_KEY
      else process.env.VALVE_RPC_KEY = before
    }
  })

  it('passes through text that holds no credential', () => {
    expect(redact('msgboard: message block too old')).toBe('msgboard: message block too old')
  })

  it('takes a credential out of a query parameter, whatever the provider calls it', () => {
    // Many providers take the key as a query parameter, and an operator's RPC override can be
    // one of them. viem prints the whole URL, query and all.
    expect(redact('URL: https://node.example/v1?apikey=s3cr3tValue&chain=369')).toBe(
      'URL: https://node.example/v1?apikey=REDACTED&chain=369',
    )
    expect(redact('https://node.example/?key=abc123def&x=1')).toBe('https://node.example/?key=REDACTED&x=1')
    expect(redact('https://node.example/?chain=1&Token=abc123def')).toBe('https://node.example/?chain=1&Token=REDACTED')
    expect(redact('https://node.example/?api_key=abc&access_token=def')).toBe(
      'https://node.example/?api_key=REDACTED&access_token=REDACTED',
    )
  })

  it('leaves a query parameter that only ends in a credential word alone', () => {
    expect(redact('https://node.example/?monkey=1&tokenIn=0xabc')).toBe('https://node.example/?monkey=1&tokenIn=0xabc')
  })
})

describe('describe', () => {
  it('keeps no credential from a viem error, which is why it exists', () => {
    const out = why(viemErrorWith(`https://one.valve.city/rpc/${KEY}/evm/369`))
    expect(out).not.toContain(KEY)
    expect(out).toContain('HTTP request failed.')
  })

  it('names the innermost cause, not just the generic wrapper', () => {
    const out = why({
      shortMessage: 'Invalid parameters were provided to the RPC method.',
      cause: { shortMessage: 'msgboard: message block too old' },
    })
    expect(out).toBe(
      'Invalid parameters were provided to the RPC method. ← msgboard: message block too old',
    )
  })

  it('survives a cause chain that points back at itself', () => {
    const loop: { shortMessage: string; cause?: unknown } = { shortMessage: 'round and round' }
    loop.cause = loop
    expect(why(loop)).toBe('round and round')
  })

  it('falls back to the string form of a thing that is not an error', () => {
    expect(why('plain string')).toBe('plain string')
  })
})

/**
 * The node is asked what chain it is on, and the answer is believed over the caller.
 *
 * Nothing in this tree asked before. viem does not ask either: `sendTransaction` calls
 * `assertCurrentChain` only for a `json-rpc` account, and every script here signs with
 * `privateKeyToAccount`, so the chain id comes off the `chain` object and the node is never
 * consulted. Read-only scripts had nothing at all. Meanwhile `rpcUrl` answers `RPC` whole and
 * drops the chain id it was handed, so the URL and the literal beside it can point at two
 * different chains and every read still comes back looking correct.
 */
describe('assertChainId', () => {
  const nodeOn = (id: number) => ({ getChainId: async () => id })

  it('is quiet when the node agrees', async () => {
    await expect(assertChainId(nodeOn(943), 943)).resolves.toBeUndefined()
  })

  it('refuses when the node is on another chain, and names both', async () => {
    await expect(assertChainId(nodeOn(943), 369)).rejects.toThrow(/is on chain 943.*for 369/s)
  })

  it('refuses a node that will not answer at all, rather than assuming', async () => {
    const mute = {
      getChainId: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8545')
      },
    }
    await expect(assertChainId(mute, 943)).rejects.toThrow(/would not answer eth_chainId/)
  })

  it('keeps the registry key out of the refusal it prints', async () => {
    // The whole reason `rpcLabel` exists. A guard that leaks the key while complaining about the
    // chain has traded one production problem for a worse one.
    const key = 'vk_liveKey1234567890'
    process.env.VALVE_RPC_KEY = key
    try {
      const said = await assertChainId(nodeOn(943), 369).then(
        () => '',
        (e: unknown) => String(e),
      )
      expect(said).toContain('is on chain 943')
      expect(said).not.toContain(key)
    } finally {
      delete process.env.VALVE_RPC_KEY
    }
  })
})

/**
 * C1 in the solver spec: the bots put the gateway key in the URL path, which reaches the gateway's
 * access logs and every upstream hop. They now use the keyless URL and an `X-API-Key` header.
 */
describe('the bots send the gateway key in a header, never in the URL', () => {
  const KEY = 'vk_liveKey1234567890'
  const saved = { key: process.env.VALVE_RPC_KEY, rpc: process.env.RPC, board: process.env.BOARD_RPC }
  const restore = (name: string, v: string | undefined) => {
    if (v === undefined) delete process.env[name]
    else process.env[name] = v
  }
  afterEach(() => {
    restore('VALVE_RPC_KEY', saved.key)
    restore('RPC', saved.rpc)
    restore('BOARD_RPC', saved.board)
    vi.unstubAllGlobals()
  })
  const live = () => {
    process.env.VALVE_RPC_KEY = KEY
    delete process.env.RPC
    delete process.env.BOARD_RPC
  }

  it('builds the keyless gateway URL and puts the key in X-API-Key', () => {
    live()
    const e = rpcEndpoint(943)
    expect(e.url).toBe('https://one.valve.city/rpc/evm/943')
    expect(e.url).not.toContain(KEY)
    expect(e.headers).toEqual({ 'X-API-Key': KEY })
  })

  it('sends the key to nobody else: an RPC or BOARD_RPC override gets no header', () => {
    live()
    process.env.RPC = 'http://127.0.0.1:8545'
    expect(rpcEndpoint(943)).toEqual({ url: 'http://127.0.0.1:8545', headers: {} })
    delete process.env.RPC
    process.env.BOARD_RPC = 'https://my-board.example/rpc'
    expect(boardEndpoint(rpcEndpoint(943))).toEqual({ url: 'https://my-board.example/rpc', headers: {} })
    delete process.env.BOARD_RPC
    const chain = rpcEndpoint(943)
    expect(boardEndpoint(chain)).toBe(chain)
  })

  it('puts the header on the wire, and the key nowhere in the URL', async () => {
    live()
    const sent: { url: string; headers: Headers }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        sent.push({ url: String(url), headers: new Headers(init?.headers) })
        const { id } = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x3af' }), {
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    await rpcTransport(rpcEndpoint(943))({}).request({ method: 'eth_chainId' })
    expect(sent[0].url).toBe('https://one.valve.city/rpc/evm/943')
    expect(sent[0].headers.get('x-api-key')).toBe(KEY)
  })

  it('registers the header with the SDK, so the board and the quotes send it too', () => {
    live()
    const e = rpcEndpoint(369)
    registerEndpoint(e)
    expect(rpcHeadersFor(e.url)).toEqual({ 'X-API-Key': KEY })
  })

  it('labels the endpoint without the key', () => {
    live()
    expect(rpcLabel(943)).not.toContain(KEY)
    expect(rpcLabel(943)).toContain('vk_liv')
  })

  it('leaves no bot on the path form', () => {
    // The five units that run unattended. The workstation scripts still use `rpcUrl`.
    for (const bot of ['heartbeat', 'watchdog', 'market-mover', 'executor', 'solver']) {
      const source = readFileSync(new URL(`./${bot}.ts`, import.meta.url), 'utf8')
      expect(source, bot).not.toMatch(/\brpcUrl\(/)
      expect(source, bot).not.toMatch(/transport: http\(/)
      expect(source, bot).toMatch(/registerEndpoint\(/)
    }
  })
})
