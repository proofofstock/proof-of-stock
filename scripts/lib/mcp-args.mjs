// scripts/lib/mcp-args.mjs: tool arguments checked against a tool's inputSchema, for both MCP servers (the HTTP one in
// apps/stocks-mcp-http.mjs and the stdio one in scripts/stocks/passport-mcp.mjs). The spec says a server MUST validate tool
// inputs; the subset here is the one our schemas use. Returns the first problem in words, or null.

// A time an agent may pass as `since`: a date, or a date and time with an optional zone. Nothing after it, so no
// caller text rides on a valid date into a sentence the server says (`Date.parse` accepts "2026-11-09 (anything)").
export const ISO_TIME_PATTERN = '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2})?)?$'
export const isIsoTime = (s) => typeof s === 'string' && new RegExp(ISO_TIME_PATTERN).test(s) && Number.isFinite(Date.parse(s))

export function invalid (schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object'
  const props = schema.properties || {}
  for (const k of schema.required || []) if (args[k] === undefined) return `${k} is required`
  for (const [k, v] of Object.entries(args)) {
    const s = Object.hasOwn(props, k) ? props[k] : undefined
    if (!s) { if (schema.additionalProperties === false) return `unknown argument ${k.slice(0, 40)}`; continue }
    if (s.type === 'string') {
      if (typeof v !== 'string') return `${k} must be a string`
      if (s.minLength != null && v.length < s.minLength) return `${k} is too short`
      if (s.maxLength != null && v.length > s.maxLength) return `${k} is too long`
      if (s.pattern && !new RegExp(s.pattern).test(v)) return `${k} has the wrong form`
    }
    if (s.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) return `${k} must be a number`
    if (s.type === 'integer' && !Number.isInteger(v)) return `${k} must be a whole number`
    if (s.type === 'boolean' && typeof v !== 'boolean') return `${k} must be true or false`
    if (s.type === 'array') {
      if (!Array.isArray(v)) return `${k} must be a list`
      if (s.minItems != null && v.length < s.minItems) return `${k} needs at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}`
      if (s.maxItems != null && v.length > s.maxItems) return `${k} takes at most ${s.maxItems} items`
      const it = s.items || {}
      for (let i = 0; i < v.length; i++) {
        if (it.type === 'string' && typeof v[i] !== 'string') return `${k}[${i}] must be a string`
        if (it.pattern && !new RegExp(it.pattern).test(v[i])) return `${k}[${i}] has the wrong form`
      }
    }
    if (s.enum && !s.enum.includes(v)) return `${k} must be one of ${s.enum.join(', ')}`
    if (s.minimum != null && v < s.minimum) return `${k} must be at least ${s.minimum}`
    if (s.maximum != null && v > s.maximum) return `${k} must be at most ${s.maximum}`
  }
  return null
}
