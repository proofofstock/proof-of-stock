// base/dataset-v2/schema-validator.mjs — validate a row against a stock-peg schema (ajv, draft-07).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const SCHEMA_DIR = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'schemas', 'v2')
function compile (file) {
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'))
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false })
  addFormats(ajv)
  const copy = { ...schema }
  delete copy.$schema
  return ajv.compile(copy)
}
const VALIDATORS = { 'stock-peg': compile('stock-peg.schema.json'), 'stock-peg-run': compile('stock-peg-run.schema.json'),
  'stock-case': compile('stock-case.schema.json'), 'stock-registry-snapshot': compile('stock-registry-snapshot.schema.json') }
export const V2_SCHEMA_KINDS = Object.keys(VALIDATORS)
/** @returns {{ valid: boolean, errors: Array }} */
export function validateV2 (kind, row) {
  const v = VALIDATORS[kind]
  if (!v) return { valid: false, errors: [{ message: `unknown schema kind: ${kind}` }] }
  const valid = v(row)
  return { valid, errors: valid ? [] : v.errors }
}
