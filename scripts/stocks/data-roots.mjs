// scripts/stocks/data-roots.mjs: the two places Proof of Stock reads from, kept apart since 12.11.
//
// 1. OUR DATA ROOT, one per chain, /var/lib/pos/<chain>. Everything POS writes lives in <root>/stock-peg/: the readings,
//    the run rows, the pool book, the impostor and names files and the append-only history/. Read by the site, written by
//    the recorder and the impostor list, backed up by pos-backup (deployment/BACKUP.md). Env: STOCKS_ROOT_BASE,
//    STOCKS_ROOT_ROBINHOOD; a script's --root= wins over both.
//
// 2. THE TOKEN DATASET, one per chain: the collector streams of a separate project on the same host, which POS does not
//    produce and NEVER writes. Default /var/lib/stp/<chain>, read-only links into that project's datasets
//    (deployment/CUTOVER.md). Env: POS_TOKEN_DATASET_BASE, POS_TOKEN_DATASET_ROBINHOOD; a script's --token-dataset= wins.
//    Who reads it: the impostor list (scripts/stocks/impostor-list.mjs, unit stp-impostors), the impostor census, the
//    stdio passport for a token outside the registry (its symbol and name), and stp-health for the age of the newest
//    day file. The public site does not: it reads only what the impostor list derived into our data root.
//    The read contract is TOKEN_DATASET_FIELDS below, and nothing else in those files is used.
//
// Before 12.11 the two were one root (/var/lib/stp/<chain>, our stock-peg/ inside the other project's dataset). A unit
// that still passes the old --root alone keeps working: the token dataset then defaults to the same /var/lib/stp path.

/** Our own data, per chain. */
export const POS_DATA_ROOT = Object.freeze({ base: '/var/lib/pos/base', robinhood: '/var/lib/pos/robinhood' })
export const DATA_ROOT_ENV = Object.freeze({ base: 'STOCKS_ROOT_BASE', robinhood: 'STOCKS_ROOT_ROBINHOOD' })

/** The other project's token streams, per chain: read only. */
export const TOKEN_DATASET = Object.freeze({ base: '/var/lib/stp/base', robinhood: '/var/lib/stp/robinhood' })
export const TOKEN_DATASET_ENV = Object.freeze({ base: 'POS_TOKEN_DATASET_BASE', robinhood: 'POS_TOKEN_DATASET_ROBINHOOD' })

/**
 * Every file and field read from the token dataset. A day file is <dir>/<prefix>YYYY-MM-DD.jsonl, or .jsonl.gz once
 * the collector has compressed it; one JSON object per line.
 */
export const TOKEN_DATASET_FIELDS = Object.freeze({
  'static/token-static-': Object.freeze({
    token_address: 'the token contract, 0x + 40 hex; the key of everything below',
    symbol: 'the token\'s symbol as the chain reports it: resemblance to a listed ticker, and the name shown for a stranger',
    name: 'the token\'s name: resemblance to a listed company, and the name shown for a stranger',
    deployer: 'the address that deployed it: groups look-alikes by deployer (same_deployer_impostors)',
    observed_at: 'when the collector first saw it, ISO 8601: first_seen_at',
  }),
  'deployers/token-deployer-': Object.freeze({
    token_address: 'the token contract',
    deployer: 'its deployer, filled in later than token-static (Robinhood only); only fills a missing deployer',
  }),
})

const pick = (chain, arg, env, envName, fallback) => {
  if (arg) return arg
  const fromEnv = env[envName[chain]]
  if (fromEnv) return fromEnv
  return fallback[chain] || null
}

/** Our data root for a chain: --root=, then the env, then /var/lib/pos/<chain>. Null for an unknown chain. */
export function dataRoot (chain, { arg = null, env = process.env } = {}) {
  return pick(chain, arg, env, DATA_ROOT_ENV, POS_DATA_ROOT)
}

/** The token dataset for a chain: --token-dataset=, then the env, then /var/lib/stp/<chain>. Null for an unknown chain. */
export function tokenDataset (chain, { arg = null, env = process.env } = {}) {
  return pick(chain, arg, env, TOKEN_DATASET_ENV, TOKEN_DATASET)
}
