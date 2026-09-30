/**
 * Before a Playwright run: a spec's own identities (`E2E_IDENTITY_DIR`) start with fresh
 * browser keys. Their saved vaults from earlier runs are moved aside (never deleted: a key
 * that might still be needed stays recoverable), so the first `signedIn` of each identity
 * imports the identity file again and registers a new key with a full budget (0.05 DASH; the
 * import flow offers no larger one). A live write spec spends a few thousandths of a DASH per
 * write, and keys reused across runs ran out mid-run.
 *
 * Only identities of `E2E_IDENTITY_DIR` are refreshed: the shared fixture identities' vaults
 * are kept (renewing them every run would pile up keys on shared identities), and so are the
 * read-only runs (no identity dir). `E2E_KEEP_KEYS=1` keeps every vault.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export function refreshSpecKeys(authDir: string, identityDir: string, devnet: string, now = Date.now()): string[] {
  if (identityDir === '' || !existsSync(authDir) || !existsSync(identityDir)) return []
  // The saved vault of identity X is `devnet-<devnet>-<NAME>-<first 8 of its id>.json`.
  const prefixes = new Set<string>()
  for (const f of readdirSync(identityDir)) {
    const m = /^([A-Z0-9_]+)\.identity\.json$/.exec(f)
    if (m === null) continue
    try {
      const id = String((JSON.parse(readFileSync(join(identityDir, f), 'utf8')) as { identityId?: string }).identityId ?? '')
      if (id !== '') prefixes.add(`devnet-${devnet}-${m[1]}-${id.slice(0, 8)}.json`)
    } catch {
      /* not an identity file */
    }
  }
  const moved: string[] = []
  const aside = join(authDir, 'retired', String(now))
  for (const f of readdirSync(authDir)) {
    if (!prefixes.has(f)) continue
    mkdirSync(aside, { recursive: true, mode: 0o700 })
    renameSync(join(authDir, f), join(aside, f))
    moved.push(f)
  }
  return moved
}

export default function globalSetup(): void {
  if (process.env['E2E_KEEP_KEYS'] === '1') return
  const moved = refreshSpecKeys(join(__dirname, '.playwright', 'auth'), process.env['E2E_IDENTITY_DIR'] || '', process.env['E2E_DEVNET'] || 'bonsia')
  // eslint-disable-next-line no-console -- the run log says which keys were renewed
  if (moved.length > 0) console.log(`[e2e] fresh browser keys this run: moved ${moved.length} saved vault(s) aside (${moved.join(', ')})`)
}
