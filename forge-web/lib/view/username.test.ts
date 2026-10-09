/**
 * #452: a typed username is checked against Platform's rules before anything is read. Vectors from
 * platform v5.0.0-beta.3 `dash-platform-queries/src/dpns_usernames.rs` (its own tests: `alice`,
 * `Alice123`, `dash-p2p`, `a-b-c` valid; the contested rule on the homograph-safe label).
 */

import { describe, expect, it } from 'vitest'

import { checkUsername, isContestedUsername, nameRegisterCommand, uncontestedVariants, usernameLabel, usernameProblem } from './username'
import { NETWORKS } from '../constants'

describe('usernameProblem (is_valid_username)', () => {
  it('accepts Platform’s own valid examples', () => {
    for (const ok of ['abc', 'alice', 'Alice123', 'dash-p2p', 'test-name-123', 'a-b-c', 'a'.repeat(63)]) expect(usernameProblem(ok)).toBeNull()
  })

  it('says why a name cannot be one', () => {
    expect(usernameProblem('ab')).toMatch(/at least 3/i)
    expect(usernameProblem('a'.repeat(64))).toMatch(/at most 63/i)
    expect(usernameProblem('has space')).toMatch(/only letters/i)
    expect(usernameProblem('under_score')).toMatch(/only letters/i)
    expect(usernameProblem('alice.dev')).toMatch(/no dots/i)
    expect(usernameProblem('-alice')).toMatch(/starts and ends/i)
    expect(usernameProblem('alice-')).toMatch(/starts and ends/i)
    expect(usernameProblem('al--ice')).toMatch(/two “-”/)
    expect(usernameProblem('ålice')).toMatch(/only letters/i)
  })
})

describe('isContestedUsername (is_contested_username)', () => {
  it('is contested at 3-19 homograph-safe characters of a-z, 0, 1 and -', () => {
    expect(isContestedUsername('alice')).toBe(true)
    expect(isContestedUsername('Bob-Smith')).toBe(true)
    // o/i/l normalize to 0/1, still inside the contested alphabet.
    expect(isContestedUsername('l1lo0')).toBe(true)
    expect(isContestedUsername('a'.repeat(19))).toBe(true)
  })

  it('is not contested with a digit 2-9 or at 20+ characters', () => {
    expect(isContestedUsername('alice2')).toBe(false)
    expect(isContestedUsername('qa5c-newbie-7x9')).toBe(false)
    expect(isContestedUsername('a'.repeat(20))).toBe(false)
  })
})

describe('checkUsername', () => {
  it('strips @ and .dash, keeps the case', () => {
    expect(usernameLabel('  @Alice2.DASH ')).toBe('Alice2')
    expect(checkUsername('@Alice2.dash')).toEqual({ kind: 'ok', label: 'Alice2' })
  })

  it('tells empty, invalid, contested and ok apart', () => {
    expect(checkUsername('  ')).toEqual({ kind: 'empty' })
    expect(checkUsername('a!')).toMatchObject({ kind: 'invalid' })
    expect(checkUsername('alice')).toEqual({ kind: 'contested', label: 'alice' })
    expect(checkUsername('alice-forge-7')).toEqual({ kind: 'ok', label: 'alice-forge-7' })
  })
})

describe('uncontestedVariants', () => {
  it('offers valid names that are not contested', () => {
    const v = uncontestedVariants('alice')
    expect(v.length).toBeGreaterThan(0)
    for (const name of v) {
      expect(checkUsername(name).kind).toBe('ok')
      expect(name.startsWith('alice')).toBe(true)
    }
    // The longest contested name still fits.
    for (const name of uncontestedVariants('a'.repeat(19))) expect(checkUsername(name).kind).toBe('ok')
  })
})

describe('nameRegisterCommand', () => {
  it('is the real dg subcommand, with the identity file and the network flags', () => {
    const sakura = { ...NETWORKS.devnet, devnetName: 'sakura' }
    expect(nameRegisterCommand('Alice-7', sakura)).toBe('dg auth name register Alice-7 --master <identity file> --network devnet --devnet-name sakura')
    expect(nameRegisterCommand('alice7', { ...NETWORKS.testnet, devnetName: null })).toBe('dg auth name register alice7 --master <identity file> --network testnet')
    expect(nameRegisterCommand('', { ...NETWORKS.testnet, devnetName: null })).toContain('register <name> --master')
  })

  it('quotes anything a shell would read specially', () => {
    expect(nameRegisterCommand('a;rm -rf', { ...NETWORKS.testnet, devnetName: null })).toContain("'a;rm -rf'")
  })
})
