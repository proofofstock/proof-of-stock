// apps/x402-discovery.mjs: how the paid pass is described to x402 catalogues (22.11, owner: x402 v2 for x402scan).
//
// Two documents, both about the one paid route, GET /api/pass:
//   - the Bazaar extension (x402 v2, specs/extensions/bazaar.md in coinbase/x402), sent inside its 402: what to call
//     and what comes back, so a catalogue or an agent knows the route without reading our docs;
//   - /openapi.json, the first place x402scan looks (Merit-Systems/x402scan docs/DISCOVERY.md): the route, its price
//     in x-payment-info, and its 402.
// The free routes are not listed: a catalogue of paid routes probes every route it is given and expects a 402, and the
// free ones answer 200. They are documented at /docs/reference/http-api.md and /llms.txt.

/** What GET /api/pass answers once paid, as the example both documents show. */
export function passExample ({ passMinutes, passRate }) {
  return { pass: { active: true, until: '2026-11-22T12:10:00.000Z', minutes: passMinutes, units_per_minute: passRate } }
}

const PASS_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    pass: {
      type: 'object',
      properties: {
        active: { type: 'boolean' },
        until: { type: 'string', format: 'date-time', description: 'when the pass ends (UTC)' },
        minutes: { type: 'integer', description: 'how long a pass lasts' },
        units_per_minute: { type: 'integer', description: 'the rate limit while the pass is live, in units a minute' },
      },
      required: ['active', 'until', 'minutes', 'units_per_minute'],
    },
  },
  required: ['pass'],
})

/** The x402 v2 Bazaar extension for GET /api/pass: no input, a JSON pass back. */
export function passBazaar ({ passMinutes, passRate }) {
  return {
    bazaar: {
      info: {
        input: { type: 'http', method: 'GET' },
        output: { type: 'json', example: passExample({ passMinutes, passRate }) },
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['GET'] } },
            required: ['type', 'method'],
            additionalProperties: false,
          },
          output: { type: 'object', properties: { type: { type: 'string' }, example: PASS_OUTPUT_SCHEMA }, required: ['type'] },
        },
        required: ['input'],
      },
    },
  }
}

/** /openapi.json: the paid route, its price and its 402, for catalogues that read OpenAPI first. */
export function openApiOf ({ origin, priceUsd, passMinutes, passRate, version }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Proof of Stock pass',
      version: String(version || '0'),
      description: `Proof of Stock checks tokenized stocks on Base against the issuer's own list, free within 60 units a minute. A pass lifts that to ${passRate} units a minute for ${passMinutes} minutes, for ${priceUsd} USDC on Base over x402. The free API is at ${origin}/docs/reference/http-api.md.`,
    },
    servers: [{ url: origin }],
    paths: {
      '/api/pass': {
        get: {
          operationId: 'buyPass',
          summary: `Buy a ${passMinutes}-minute pass at ${passRate} units a minute`,
          description: 'Without a live pass this answers 402 with the x402 offer (v2 in the PAYMENT-REQUIRED header and the body; pay with PAYMENT-SIGNATURE, or X-PAYMENT for v1). Paid, the pass is bound to the calling client and the answer says until when it runs.',
          'x-payment-info': { protocols: ['x402'], price: { mode: 'fixed', currency: 'USD', amount: String(priceUsd) } },
          responses: {
            200: { description: 'The pass is live', content: { 'application/json': { schema: PASS_OUTPUT_SCHEMA, example: passExample({ passMinutes, passRate }) } } },
            402: { description: 'Payment required: the x402 offer' },
          },
        },
      },
    },
  }
}
