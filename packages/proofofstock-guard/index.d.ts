// Types for @proofofstock/guard (written by hand; the package has no build step).

export type Chain = 'base' | 'robinhood'

export interface ListProof {
  issuer: 'coinbase' | 'robinhood'
  source: string | null
  addresses: number
  /** SHA-256 hex of the list's addresses, lowercase, sorted, one per line */
  addresses_sha256: string
  /** "sha256:<hex>", the canonical list hash the archive uses */
  registry_hash: string
  reproduce: string | null
  reproduce_unavailable: string | null
  read_at: string | null
  stale: boolean
  ledger: string
  list_url?: string | null
  addresses_url?: string | null
  note: string
}

export interface VerifyBody {
  listed: boolean
  registries_checked: string[]
  chain: Chain
  address: string
  issuer: string | null
  symbol: string | null
  name: string | null
  isin: string | null
  minted: boolean | null
  listed_on_other_chain: { chain: Chain, symbol: string } | null
  impostor: { kinds: string[], imitates_symbol: string | null, listed_address: string | null } | null
  delisted_at: string | null
  registry_age_s: number
  checked_at: string
  passport: string
  list_proof?: ListProof | null
  [key: string]: unknown
}

export interface VerifyResult { status: 'ok' | 'unavailable' | 'error', body: VerifyBody | { error: string } | null }
export interface VerifyManyResult { status: 'ok' | 'unavailable' | 'error', body: { results: VerifyBody[], list_proofs: (ListProof | null)[] } | { error: string } | null }

export interface CrossCheck {
  status: 'match' | 'list_changed' | 'issuer_unavailable' | 'no_recipe'
  address_in_issuer_list: boolean | null
  issuer_sha256: string | null
}

export interface Decision {
  allow: boolean
  decision: 'listed' | 'impostor' | 'not_listed' | 'wrong_stock' | 'unknown' | 'invalid_input'
  reason: string
  /** the issuer-listed contract to use instead, when the token imitates one */
  use_instead: string | null
  verify: VerifyBody | { error: string } | null
  cross_check?: CrossCheck
}

export interface GuardOptions {
  /** default https://proofofstock.xyz */
  endpoint?: string
  fetchImpl?: typeof fetch
  /** per request, default 8000 */
  timeoutMs?: number
  /** allow a buy when the registry cannot be read; default false */
  failOpen?: boolean
  /** a listed answer from a list read longer ago is unknown; default 900 */
  maxRegistryAgeS?: number
  /** also read the issuer's own list and require the address on it; default false */
  crossCheck?: boolean
  retryDelayMs?: number
}

export interface BuyRequest { chain: Chain, tokenAddress: string, claimedSymbol?: string }

export interface Guard {
  verify (chain: Chain, address: string): Promise<VerifyResult>
  verifyMany (chain: Chain, addresses: string[]): Promise<VerifyManyResult>
  beforeBuy (p: BuyRequest): Promise<Decision>
  beforeBuyMany (chain: Chain, tokens: { tokenAddress: string, claimedSymbol?: string }[]): Promise<Decision[]>
}

export const VERSION: string
export const DEFAULT_ENDPOINT: string
export const MAX_BATCH: number
export function createGuard (options?: GuardOptions): Guard
export function addressesSha256 (addresses: string[]): Promise<string>
export function checkListProof (proof: ListProof | null | undefined, options?: { address?: string | null, fetchImpl?: typeof fetch, timeoutMs?: number }): Promise<CrossCheck>
