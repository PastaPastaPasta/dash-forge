/**
 * The seed-v2 fixture's summary JSON — what `forge-contracts/scripts/seed-v2-fixture.mjs` prints
 * on stdout, committed at `forge-contracts/deployments/fixtures/devnet-<devnet>.json`. This
 * module has NO `@playwright/test` import: the vitest live tests (`lib/repo/*.live.test.ts`)
 * need the same loader without pulling in Playwright's own test runner, so `e2e/helpers.ts`
 * re-exports it rather than duplicating it.
 *
 * Since forge-v2's issue/PR numbering became dense and shared by both kinds in one sequence per
 * repo (`forge-v2.md` §6.2), the DEMO fixture's PR numbers are no longer the small constants
 * (1, 2, 3) they used to be: they land after its 4 issues. Specs read them from here instead of
 * hard-coding them.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The devnet the build under test (or the live test) reads. Keep in step with playwright.config.ts. */
export const E2E_DEVNET = process.env['E2E_DEVNET'] || 'moutai'

const ROOT = resolve(__dirname, '../..')

/** The DEMO fixture's PR numbers, dense and shared with its issues (seed-v2-fixture.mjs). */
export interface SeedPulls {
  /** The open PR with MAINTAINER's approval. */
  readonly approved: number
  /** The merged PR. */
  readonly merged: number
  /** CONTRIB's review-parity fixture: opened as a draft (a kind-14 `transition`), head moved. */
  readonly reviewParity: number
}

function isSeedPulls(v: unknown): v is SeedPulls {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return typeof p['approved'] === 'number' && typeof p['merged'] === 'number' && typeof p['reviewParity'] === 'number'
}

let cached: SeedPulls | null = null

/**
 * The DEMO fixture's `pulls` numbers. Reads, in order, `$FORGE_SEED_SUMMARY` if set, then
 * `forge-contracts/deployments/fixtures/devnet-<E2E_DEVNET>.json` (repo-root relative); the
 * first one that exists on disk wins. Never reads `~/.cache` (that is the seeder's own
 * resumable-run state, not its committed output).
 *
 * Throws loudly — naming every path tried, and that the seed summary must carry `pulls` — when
 * none exists or none has a valid `pulls` (three numbers). Call this lazily, inside a test or a
 * `beforeAll`: importing this module must never throw merely because the file is absent, so
 * specs that do not touch the DEMO fixture keep working.
 */
export function loadSeedPulls(): SeedPulls {
  if (cached) return cached
  const envPath = process.env['FORGE_SEED_SUMMARY']
  const defaultPath = join(ROOT, `forge-contracts/deployments/fixtures/devnet-${E2E_DEVNET}.json`)
  const tried = envPath ? [envPath, defaultPath] : [defaultPath]
  for (const path of tried) {
    if (!existsSync(path)) continue
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const pulls = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['pulls'] : undefined
    if (!isSeedPulls(pulls)) {
      throw new Error(
        `${path} has no valid \`pulls\` (approved/merged/reviewParity numbers): the seed summary must carry \`pulls\` — re-run forge-contracts/scripts/seed-v2-fixture.mjs`,
      )
    }
    cached = pulls
    return pulls
  }
  throw new Error(
    `no seed summary found — tried ${tried.join(', ')}: the seed summary must carry \`pulls\`. Set $FORGE_SEED_SUMMARY to seed-v2-fixture.mjs's JSON output, or commit forge-contracts/deployments/fixtures/devnet-${E2E_DEVNET}.json`,
  )
}
