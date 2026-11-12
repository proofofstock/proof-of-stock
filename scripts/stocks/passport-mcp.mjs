// scripts/stocks/passport-mcp.mjs: the stock-token passport as an MCP server on stdio, for an agent to call.
//
// Three read-only tools, no trading, no wallet, no keys:
//   find_stock_token   a ticker or name → the issuer-listed tokens on a chain that match it
//   list_stock_tokens  a chain's issuer registry: symbol, name, address, ISIN, whether the issuer publishes a price
//   stock_passport     a token address → its passport (evm/core/stocks/passport.mjs)
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, as MCP's stdio transport specifies. Logs go to stderr only:
// anything else on stdout would corrupt the stream. No SDK dependency, the three methods a tools-only server needs
// (initialize, tools/list, tools/call) are small enough to state here and test.
//
// Connect from a client on another machine:  ssh <host> "cd <release> && node scripts/stocks/passport-mcp.mjs"
//
// ⚠ EVERY ANSWER IS FACTS WITH THEIR TIME AND SOURCE, never advice. The passport carries not_trading_signal: true, and the
// tool descriptions say so, so a model calling them is told the same thing a person reading them is.

import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { passportFor } from './passport.mjs'
import { CHAINS } from './stock-peg.mjs'
import { invalid } from '../lib/mcp-args.mjs'

export const PROTOCOL_VERSION = '2025-06-18'
// The versions it can speak, newest first: a client asking for one of them gets it (apps/stocks-mcp-http.mjs does the same).
export const SUPPORTED_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05'])
const SERVER_INFO = Object.freeze({ name: 'proof-of-stock-stdio', version: JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version })
const DEFAULT_ROOT = Object.freeze({ base: '/var/lib/stp/base', robinhood: '/var/lib/stp/robinhood' })
const CHAIN_ENUM = Object.keys(CHAINS)
// One canonical disclaimer (docs/legal.md, served at /docs/legal.md); the tools point at it instead of repeating it.
const NOTICE = 'Facts with their time and source, not advice: https://proofofstock.xyz/docs/legal.md'
const CHAIN_HINT = 'Two chains: base (Coinbase\'s tokens, symbols end in "c", e.g. NVDAc) and robinhood (Robinhood\'s, e.g. NVDA). When the user names no chain, call it for both.'
const UNITS = 'Readings are recorded every 15 minutes (latest.cadence_s), so "latest" is a recorded reading, not a live quote: see latest.age_s. premium compares the latest on-chain price with the issuer reference, whose own age is reference.age_s; when the two are far apart in time, latest.premium_at_reference_time gives the premium of one moment. sources names every source and the pool rule.' + ' Every answer opens with one plain sentence; quote it. In the JSON, premium and spread are FRACTIONS (0.01 = 1%; premium > 0 means the on-chain price is above the issuer\'s), *_age_s and age_s are seconds before generated_at, prices are USD per token. A token is worth `multiplier` shares, and the issuer\'s reference is already per token. reference.kind: nav_total_return = Coinbase\'s NAV, token_bid_ask_mid = the mid of Robinhood\'s token bid/ask. notes are codes for every gap (e.g. reading_stale = our last reading is over 30 min old, pools_capped = the pool count is a minimum).'

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
export const TOOLS = Object.freeze([
  {
    name: 'find_stock_token',
    description: 'Find issuer-listed tokenized stocks on a chain by ticker, company name or ISIN. Returns the official contract addresses. An empty result says only that the issuer lists no such token, nothing about impostors. ' + CHAIN_HINT + ' ' + NOTICE,
    inputSchema: { type: 'object', properties: { chain: { type: 'string', enum: CHAIN_ENUM }, query: { type: 'string', minLength: 1 } }, required: ['chain', 'query'], additionalProperties: false },
    annotations: { title: 'Find a stock token', ...READ_ONLY },
  },
  {
    name: 'list_stock_tokens',
    description: 'List every token in a chain\'s issuer registry: symbol, name, contract address, ISIN, multiplier, whether it is minted on the chain and whether the issuer publishes a reference price. The answer opens with the exact count (also the `count` field); quote that number, do not estimate it from the list. On Base many listed tokens are not minted yet and do not trade (`minted`). ' + CHAIN_HINT + ' ' + NOTICE,
    inputSchema: { type: 'object', properties: { chain: { type: 'string', enum: CHAIN_ENUM } }, required: ['chain'], additionalProperties: false },
    annotations: { title: 'List an issuer registry', ...READ_ONLY },
  },
  {
    name: 'stock_passport',
    description: 'Passport of one token address: whether it is in the issuer registry (and, if not, which listed stock its name imitates); the issuer reference price and its age; the latest DEX price and its premium over the reference; the premium series split by US market session; and every gap named. ' + UNITS + ' ' + CHAIN_HINT + ' ' + NOTICE,
    inputSchema: { type: 'object', properties: { chain: { type: 'string', enum: CHAIN_ENUM }, address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, hours: { type: 'number', minimum: 1, maximum: 720 }, include_series: { type: 'boolean', description: 'also return series_points, the raw premium time series (large); the session medians in `series` are always there' } }, required: ['chain', 'address'], additionalProperties: false },
    annotations: { title: 'Stock token passport', ...READ_ONLY },
  },
])

const summary = (r) => ({ symbol: r.symbol, name: r.name ?? null, address: r.address, isin: r.isin, multiplier: r.multiplier, has_reference_price: r.reference?.price_usd > 0, supplied: r.supplied })

/** One tool call → MCP content. Errors in the tool are results with isError, not protocol errors. */
export async function callTool (name, args = {}, { roots = DEFAULT_ROOT, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const C = CHAINS[args.chain]
  const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] })
  const fail = (m) => ({ content: [{ type: 'text', text: m }], isError: true })
  // The name and the arguments are checked by handle() against the schemas, as a protocol error; this is the last guard.
  if (!TOOLS.some((t) => t.name === name) || !C) return fail('invalid arguments')
  try {
    if (name === 'stock_passport') {
      return text(await passportFor({ chain: args.chain, address: args.address, root: path.resolve(roots[args.chain]), hours: args.hours || undefined, now: now(), fetchImpl }))
    }
    const reg = await C.read(fetchImpl, { chainId: C.chainId })
    if (name === 'list_stock_tokens') return text({ chain: args.chain, issuer: C.issuer, count: reg.length, tokens: reg.map(summary), notice: NOTICE })
    const q = String(args.query || '').trim().toLowerCase()
    const hits = reg.filter((r) => [r.symbol, r.name, r.isin, r.symbol && r.issuer === 'coinbase' ? r.symbol.replace(/c$/, '') : null].some((v) => typeof v === 'string' && v.toLowerCase().includes(q)))
    return text({ chain: args.chain, issuer: C.issuer, query: args.query, matches: hits.slice(0, 20).map(summary), more: Math.max(0, hits.length - 20), notice: NOTICE })
  } catch (e) {
    return fail(String(e && e.message || e).slice(0, 300))
  }
}

/** One JSON-RPC message → the response object, or null for a notification. */
export async function handle (msg, opts) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result })
  const okId = (id) => typeof id === 'string' || Number.isInteger(id)
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg && okId(msg.id) ? msg.id : null, error: { code, message } })
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return error(-32600, 'invalid request')
  // A client's answer to a request of ours: we send none, so there is nothing to say back.
  if (msg.method === undefined && okId(msg.id) && ('result' in msg || 'error' in msg)) return null
  if (typeof msg.method !== 'string' || (msg.id !== undefined && !okId(msg.id))) return error(-32600, 'invalid request')
  const isNotification = msg.id === undefined
  if (isNotification) return null // a notification is never answered, and never runs a tool
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      return reply({ protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: NOTICE })
    }
    case 'ping': return reply({})
    case 'tools/list': return reply({ tools: TOOLS })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name)
      if (!tool) return error(-32602, `unknown tool: ${String(msg.params?.name).slice(0, 40)}`)
      const args = msg.params?.arguments ?? {}
      const bad = invalid(tool.inputSchema, args)
      if (bad) return error(-32602, bad)
      return reply(await callTool(tool.name, args, opts))
    }
    default: return error(-32601, `method not found: ${String(msg.method).slice(0, 40)}`)
  }
}

export function serve ({ input = process.stdin, output = process.stdout, opts } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  rl.on('line', async (line) => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return }
    const res = await handle(msg, opts)
    if (res) output.write(JSON.stringify(res) + '\n')
  })
  return rl
}

if (isEntryPoint(import.meta.url)) {
  process.stderr.write('[passport-mcp] ready on stdio\n')
  serve()
}
