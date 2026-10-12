import {
  createPublicClient,
  http,
  type Account,
  type Chain,
  type HttpTransport,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem'
import { getChainId, getChainRpc, network, rpcHeadersFor, type ChainId } from './config.js'

/**
 * The two clients this package talks through. Reads go over a public client; writes need a
 * wallet the caller owns — a browser wallet in a tab, a private key in a bot — so this package
 * never creates one. Every write takes the wallet as its first argument instead.
 */

/**
 * A public client for plain `eth_` reads. Defaults to the chain endpoint, not the board.
 *
 * **No transport retries.** viem retries a failed request three times by default, which is right
 * for a read and wrong for everything this gateway does. It fans one request out to several
 * upstreams and surfaces the last error, so a write that landed still reports failure — and the
 * retry then sends it again. Measured: ten board posts became forty `msgboard_addMessage` calls,
 * four per post, all but the first of them pointless traffic against a message the board already
 * held.
 *
 * Recovery belongs where it can tell the difference. `submit.ts` catches the error, asks the
 * board whether the message is there, and only then decides. A blind retry cannot do that.
 */
export function rpcClient(
  url = getChainRpc(),
  id: ChainId = getChainId(),
): PublicClient<HttpTransport, Chain> {
  // The headers a bot registered for this URL, such as the gateway's `X-API-Key`. None in a
  // browser, which registers none. See `setRpcHeaders`.
  const headers = rpcHeadersFor(url)
  return createPublicClient({
    chain: network(id).chain,
    transport: http(url, { retryCount: 0, ...(headers ? { fetchOptions: { headers } } : {}) }),
  })
}

/**
 * The wallet shape every write here accepts: any viem wallet client that knows its chain. A
 * browser wallet over `custom(window.ethereum)` and a bot's `http` client both qualify.
 */
export type ProveWalletClient = WalletClient<Transport, Chain, Account | undefined>
