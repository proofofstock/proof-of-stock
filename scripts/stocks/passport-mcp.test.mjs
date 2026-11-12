// scripts/stocks/passport-mcp.test.mjs: the MCP server answers initialize, lists its three tools, calls them, keeps
// stdout to JSON-RPC lines only, and answers bad input as the HTTP server does (-32602 for a bad tool or argument); a tool
// that fails while running is a result with isError.
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
  check('initialize names the protocol and offers tools', init.result.protocolVersion === PROTOCOL_VERSION && init.result.capabilities.tools && init.result.serverInfo.name === 'proof-of-stock-stdio')
  check('the initialized notification gets no reply', (await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, opts)) === null)
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, opts)
  check('three tools, each with an input schema', list.result.tools.length === 3 && list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'))
  check('every tool points the model at the one canonical disclaimer', TOOLS.every((t) => /not advice: https:\/\/proofofstock.xyz\/docs\/legal\.md/.test(t.description)))
  const unknown = await handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, opts)
  check('an unknown method is -32601', unknown.error && unknown.error.code === -32601)
  check('a malformed request is -32600', (await handle({ id: 4 }, opts)).error.code === -32600)
  // The same answers as the HTTP server (audit 12.11).
  check('an id of null is -32600', (await handle({ jsonrpc: '2.0', id: null, method: 'ping' }, opts))?.error?.code === -32600)
  check('a client\'s response gets no reply', (await handle({ jsonrpc: '2.0', id: 9, result: {} }, opts)) === null)
  check('a notification never runs a tool and gets no reply', (await handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_stock_tokens', arguments: { chain: 'base' } } }, opts)) === null)
  const v = async (asked) => (await handle({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: 't', version: '0' } } }, opts)).result.protocolVersion
  check('the protocol version is negotiated: a supported one is echoed, another gets ours', (await v('2024-11-05')) === '2024-11-05' && (await v('1999-01-01')) === PROTOCOL_VERSION)
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
  check('a bad chain is -32602, as on the HTTP server', bad.error?.code === -32602 && !bad.result, JSON.stringify(bad))
  const nope = await handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'buy_stock', arguments: { chain: 'base' } } }, opts)
  check('there is no trading tool to call: an unknown tool is -32602', nope.error?.code === -32602 && !nope.result)
  // The schemas it advertises are the ones it holds callers to (audit 12.11: hours 99999 ran).
  const call = (args, name = 'stock_passport') => handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name, arguments: args } }, opts)
  check('hours past the advertised maximum is -32602', (await call({ chain: 'base', address: A, hours: 99999 })).error?.code === -32602)
  check('an argument the schema does not name is -32602', (await call({ chain: 'base', address: A, buy: true })).error?.code === -32602)
  check('a query that is not a string is -32602', (await call({ chain: 'base', query: 123 }, 'find_stock_token')).error?.code === -32602)
  check('arguments that are not an object are -32602', (await handle({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'list_stock_tokens', arguments: ['base'] } }, opts)).error?.code === -32602)
  check('a __proto__ argument is refused, not merged', (await call(JSON.parse('{"chain":"base","__proto__":{"x":1}}'), 'list_stock_tokens')).error?.code === -32602)
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
