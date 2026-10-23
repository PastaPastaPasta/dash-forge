import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('collects the browser suite without the optional write identities', () => {
  const identities = mkdtempSync(join(tmpdir(), 'forge-e2e-no-identities-'))
  const web = resolve(__dirname, '..')
  try {
    // --list imports every spec without starting a browser or running any hooks/writes.
    // A top-level test.skip does not prevent the rest of its module from evaluating.
    const result = spawnSync(process.execPath, [join(web, 'node_modules/@playwright/test/cli.js'), 'test', '--list'], {
      cwd: web,
      env: { ...process.env, E2E_NETWORK: 'devnet', E2E_DEVNET: 'sakura', E2E_WRITE: '', E2E_IDENTITY_DIR: identities },
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/Total: \d+ tests in \d+ files/)
  } finally {
    rmSync(identities, { recursive: true, force: true })
  }
}, 100_000)
