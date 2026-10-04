/**
 * Building `profile.pubkeys` entries (P1-7) from the throwaway fixtures in
 * `forge-contracts/fixtures/signing`: the web reaches the same entries as the vectors (and as
 * `forge_core::signing_keys`, which builds them from the same files).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { keyEntry, openpgpEntry, sshEntry, withKey } from './signing-keys'

const FIX = resolve(__dirname, '../../../forge-contracts/fixtures/signing')
const VEC = resolve(__dirname, '../../../forge-contracts/vectors')
const fixture = (f: string): string => readFileSync(`${FIX}/${f}`, 'utf8')
const vectorEntry = (name: string): string => (JSON.parse(readFileSync(`${VEC}/pubkey_entry__${name}.json`, 'utf8')) as { input: { entry: string } }).input.entry

describe('signing key entries', () => {
  it('an Ed25519 OpenPGP key gives its packet, as the vectors hold it', async () => {
    expect(await openpgpEntry(fixture('gpg-a.asc'))).toBe(vectorEntry('gpg_ed25519_primary'))
  })

  it('a certify-only primary gives its signing subkey', async () => {
    expect(await openpgpEntry(fixture('gpg-b.asc'))).toBe(vectorEntry('gpg_ed25519_subkey'))
  })

  it('an RSA key is refused: it does not fit a profile entry', async () => {
    await expect(openpgpEntry(fixture('gpg-c.asc'))).rejects.toThrow(/over a profile entry/)
  })

  it('an SSH line keeps its comment', async () => {
    expect(await sshEntry(fixture('e.pub'))).toBe(vectorEntry('ssh_ed25519'))
    expect(await keyEntry(`  ${fixture('e.pub')}  `)).toBe(vectorEntry('ssh_ed25519'))
  })

  it('refuses what Forge does not verify, and a key twice', async () => {
    await expect(sshEntry('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ')).rejects.toThrow()
    await expect(keyEntry('not a key')).rejects.toThrow()
    const one = await withKey([], vectorEntry('ssh_ed25519'))
    await expect(withKey(one, vectorEntry('ssh_ed25519'))).rejects.toThrow(/already/)
  })
})
