// scripts/lib/invoked-directly.mjs — is this module the one `node` was asked to run?
//
// 🔴 WHY THIS EXISTS. Scripts guard their command line with "am I the entry point", and most did it by
// comparing `import.meta.url` with `process.argv[1]`: as URLs (`pathToFileURL(argv[1]).href`, or a
// hand-built `file://` string) or as paths (`path.resolve(argv[1]) === fileURLToPath(import.meta.url)`).
// Node resolves `import.meta.url` through symlinks and junctions; `argv[1]` keeps the path as typed. So a
// script run through a linked directory loaded, matched nothing, and exited 0 having done nothing - found
// in review of scripts/sync-gta-dictionary.mjs (#559), where a --check through a junction printed nothing.
//
// ⚠ ONE HOME. Every entry guard asks this function; scripts/lib/invoked-directly.test.mjs refuses a
// script that compares the two by hand.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @param metaUrl  the caller's `import.meta.url`
 * @param argv1    the script node was asked to run; defaults to process.argv[1]
 * @returns true only when both resolve to the same real file. No argv[1] (a REPL, `node -e`, an import
 *          from a test runner) or a path that cannot be resolved is not a direct run.
 */
export function isEntryPoint (metaUrl, argv1 = process.argv[1]) {
  if (!argv1 || !metaUrl) return false
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(metaUrl))
  } catch (_) {
    return false
  }
}
