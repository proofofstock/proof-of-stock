// scripts/stocks/passport-mcp.test.mjs — the MCP server answers initialize, lists its three tools, calls them, keeps
// stdout to JSON-RPC lines only, and reports a failing tool as a result with isError rather than a protocol error.
//
// Run: node scripts/stocks/passport-mcp.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { handle, serve, TOOLS, PROTOCOL_VERSION } from './passport-mcp.mjs'
import { COINBASE_URL } from '../../evm/core/stocks/registries.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const A = '0x' + 'aa'.repeat(20)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-mcp-'))
const fetchImpl = async (url) => {
  if (String(url).startsWith(COINBASE_URL)) return { ok: true, status: 200, json: async () => ({ tokens: [{ contract_address: A, symbol: 'NVDAc', name: 'NVIDIA', isin: 'US67066G1040', multiplier: '1', nav_price: '180', nav_price_updated_at: '2026-11-06T21:00:00Z', total_supply: '5' }] }) }
  return { ok: false, status: 404, json: async () => ({}) }
}
const opts = { roots: { base: tmp, robinhood: tmp }, fetchImpl, now: () => Date.parse('2026-11-08T14:00:00Z') }
const body = (r) => JSON.parse(r.result.content[0].text)

console.log('protocol')
{
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } } }, opts)
  check('initialize names the protocol and offers tools', init.result.protocolVersion === PROTOCOL_VERSION && init.result.capabilities.tools && init.result.serverInfo.name === 'stock-token-passport-stdio')
  check('the initialized notification gets no reply', (await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, opts)) === null)
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, opts)
  check('three tools, each with an input schema', list.result.tools.length === 3 && list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'))
  check('every tool points the model at the one canonical disclaimer', TOOLS.every((t) => /not advice: https:\/\/proofofstock.xyz\/docs\/legal\.md/.test(t.description)))
  const unknown = await handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, opts)
  check('an unknown method is -32601', unknown.error && unknown.error.code === -32601)
  check('a malformed request is -32600', (await handle({ id: 4 }, opts)).error.code === -32600)
}

console.log('tools')
{
  const find = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'find_stock_token', arguments: { chain: 'base', query: 'nvda' } } }, opts)
  check('find by bare ticker returns the official address', body(find).matches.length === 1 && body(find).matches[0].address === A)
  const byName = body(await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'find_stock_token', arguments: { chain: 'base', query: 'nvidia' } } }, opts))
  check('find by company name works too', byName.matches.length === 1)
  const list = body(await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_stock_tokens', arguments: { chain: 'base' } } }, opts))
  check('the registry list says whether a price is published', list.count === 1 && list.tokens[0].has_reference_price === true)
  const pass = body(await handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'stock_passport', arguments: { chain: 'base', address: A } } }, opts))
  check('the passport tool returns a passport', pass.in_registry === true && pass.not_trading_signal === true)
  const bad = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'stock_passport', arguments: { chain: 'solana', address: A } } }, opts)
  check('a bad chain is a tool error, not a protocol error', bad.result.isError === true && !bad.error)
  const nope = await handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'buy_stock', arguments: { chain: 'base' } } }, opts)
  check('there is no trading tool to call', nope.result.isError === true)
}

console.log('stdio')
{
  const input = new PassThrough(), output = new PassThrough()
  const lines = []
  output.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)))
  serve({ input, output, opts })
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')
  input.write('not json\n')
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  await new Promise((r) => setTimeout(r, 200))
  check('stdout carries one JSON-RPC line per request, nothing for a notification', lines.length === 2 && lines.every((l) => JSON.parse(l).jsonrpc === '2.0'), String(lines.length))
  check('a line that is not JSON gets a parse error', lines.some((l) => JSON.parse(l).error?.code === -32700))
  input.end()
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
