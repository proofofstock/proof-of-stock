// @stockofproof/guard/agentkit — the guard as an action an AgentKit agent can call before a swap.
//
// This file does not import AgentKit: it exports the action's name, description, a JSON schema of its input and the
// function, so it drops into `customActionProvider` with whatever schema library the agent uses (AgentKit's examples
// use zod; see README). Keeping AgentKit out of the dependencies keeps the guard installable anywhere.

import { createGuard } from './index.mjs'

export const ACTION_NAME = 'check_stock_token_before_buy'
export const ACTION_DESCRIPTION = 'Call this BEFORE buying any token that claims to be a tokenized stock (NVDA, TSLA, AAPL, ...) on Base or Robinhood Chain. ' +
  'It checks the exact contract against the issuer\'s own registry (Coinbase on Base, Robinhood on Robinhood Chain). ' +
  'Only buy when it returns allow=true. If it returns use_instead, that is the issuer-listed contract: use it instead of the one you were given. ' +
  'It never trades; facts, not investment advice.'
export const ACTION_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    chain: { type: 'string', enum: ['base', 'robinhood'], description: 'base = Coinbase tokens (symbols end in c, e.g. NVDAc); robinhood = Robinhood Chain' },
    tokenAddress: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'the contract about to be bought' },
    claimedSymbol: { type: 'string', description: 'the stock the user asked for, e.g. NVDA' },
  },
  required: ['chain', 'tokenAddress'],
  additionalProperties: false,
})

/** The action: input → a short text the model reads, starting with ALLOW or REFUSE. */
export function guardAction (guardOptions) {
  const guard = createGuard(guardOptions)
  return {
    name: ACTION_NAME,
    description: ACTION_DESCRIPTION,
    inputSchema: ACTION_INPUT_SCHEMA,
    async invoke (args) {
      const d = await guard.beforeBuy(args || {})
      return `${d.allow ? 'ALLOW' : 'REFUSE'} (${d.decision}): ${d.reason}${d.use_instead ? ` Use instead: ${d.use_instead}.` : ''}`
    },
  }
}
