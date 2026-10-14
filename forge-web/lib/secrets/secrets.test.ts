/**
 * Behaviour tests, ported from `crates/forge-secrets` (`tests.rs` and the unit tests of `allow.rs`,
 * `glob.rs` and `util.rs`). Fake secrets are assembled at run time so none appears whole in this
 * repository (GitHub push protection reads its bytes).
 */

import { describe, expect, it } from 'vitest'

import {
  AllowList,
  MAX_SCAN_BYTES,
  decide,
  gitBlobId,
  githubChecksumOk,
  gitlabChecksumOk,
  isEnvFileName,
  isFingerprint,
  isTestPath,
  pathMatches,
  scanFile,
  scanUnread,
  verdict,
  type Finding,
  type Rule,
} from './index'
import { base58Decode, crc32, encodeBase, lineAt, lineStarts, shannonEntropy } from './util'

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function githubToken(random: string): string {
  const check = encodeBase(crc32(random), B62, 6)
  return `${'gh'}${'p_'}${random}${check}`
}

function gitlabToken(payload: string): string {
  const prefix = `${'gl'}${'pat-'}`
  const len = encodeBase(payload.length, B36, 2)
  const crc = encodeBase(crc32(`${prefix}${payload}.01.${len}`), B36, 7)
  return `${prefix}${payload}.01.${len}${crc}`
}

function pem(): string {
  const line = 'VGhpcyBpcyBub3QgYSByZWFsIGtleSwgaXQgaXMgYSBGb3JnZSB0ZXN0LiBUaGlz'
  const label = `EC ${'PRIVATE KEY'}`
  return `-----BEGIN ${label}-----\n${line}\n${line}\n-----END ${label}-----\n`
}

function rules(path: string, text: string): Rule[] {
  return scanFile(path, enc(text)).map((f) => f.rule)
}

function first(findings: Finding[]): Finding {
  const f = findings[0]
  if (!f) throw new Error('expected a finding')
  return f
}

function f(path: string, fp: string): Finding {
  return { rule: 'env_file', path, line: null, fingerprint: fp }
}

describe('env files', () => {
  it('names', () => {
    for (const p of ['.env', 'a/.env', '.env.local', '.env.production', 'x/.env.staging']) {
      expect(isEnvFileName(p), p).toBe(true)
    }
    for (const p of ['.env.example', '.env.sample', '.env.template', '.env.local.example', '.envrc', 'env', 'x.env', '.environment']) {
      expect(isEnvFileName(p), p).toBe(false)
    }
  })

  it('a new env refuses and its example passes', () => {
    const found = scanFile('.env', enc('SECRET=x\n'))
    expect(found).toHaveLength(1)
    expect(verdict(first(found), false).severity).toBe('refuse')
    expect(scanFile('.env.example', enc('SECRET=x\n'))).toEqual([])
  })

  it('case, BOM and colons', () => {
    expect(isEnvFileName('APP/.ENV')).toBe(true)
    expect(isEnvFileName('.Env.Production')).toBe(true)
    expect(isEnvFileName('.ENV.EXAMPLE')).toBe(false)
    expect(rules('.env', '﻿A=1\n')).toEqual(['env_file'])
    expect(rules('.env.yaml', 'DB_PASSWORD: not-real\n')).toEqual(['env_file'])
    expect(rules('.env', '# fill in: later\n')).toEqual([])
  })

  it('a tests/.env is still refused', () => {
    const found = first(scanFile('tests/.env', enc('A=1\n')))
    expect(verdict(found, false).severity).toBe('refuse')
    expect(verdict(found, true).reason).toBe('history')
  })

  it('an .envrc warns', () => {
    const found = first(scanFile('.envrc', enc('export A=1\n')))
    expect(found.rule).toBe('envrc')
    expect(verdict(found, false)).toEqual({ severity: 'warn', reason: 'rule' })
  })
})

describe('verdicts', () => {
  it('test folders and history warn', () => {
    expect(isTestPath('test/key.pem')).toBe(true)
    expect(isTestPath('a/testdata/b/key.pem')).toBe(true)
    expect(isTestPath('test')).toBe(false)
    expect(isTestPath('latest/key.pem')).toBe(false)
    const inTest = first(scanFile('test/key.pem', enc(pem())))
    expect(inTest.rule).toBe('private_key')
    expect(verdict(inTest, false).reason).toBe('test_path')
    const plain = first(scanFile('key.pem', enc(pem())))
    expect(verdict(plain, false).severity).toBe('refuse')
    expect(verdict(plain, true).reason).toBe('history')
  })

  it('a path glob warns and a fingerprint silences', () => {
    const found = first(scanFile('deploy/k.pem', enc(pem())))
    const byPath = decide(found, false, AllowList.parse('deploy/*.pem\n'))
    expect(byPath).toEqual({ severity: 'warn', reason: 'allowed_path' })
    expect(decide(found, false, AllowList.parse(`${found.fingerprint}\n`))).toBeNull()
    // A bare name is anchored at the root.
    expect(decide(found, false, AllowList.parse('k.pem\n'))?.severity).toBe('refuse')
  })
})

describe('token rules', () => {
  it('github checksums', () => {
    const token = githubToken('FakeTokenForForgeSecretsScan01')
    expect(githubChecksumOk(token)).toBe(true)
    const bad = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
    expect(githubChecksumOk(bad)).toBe(false)
    expect(rules('a.sh', `T=${token}\n`)).toEqual(['github_token'])
    expect(rules('a.sh', `T=${bad}\n`)).toEqual(['unverified_token'])
    // Inside a longer word it is not a token.
    expect(rules('a.sh', `T=x${token}\n`)).toEqual([])
  })

  it('gitlab checksums', () => {
    const token = gitlabToken('FakeGitLabPayloadForForgeScanTests01')
    expect(gitlabChecksumOk(token)).toBe(true)
    expect(gitlabChecksumOk(token.replace('.01.', '.02.'))).toBe(false)
    expect(rules('ci.yml', `token: ${token}.\n`)).toEqual(['gitlab_token'])
  })

  it('aws needs the secret', () => {
    const id = `${'AK'}${'IAFAKEFAKEFAKEFAKE'}`
    const secret = `${'Fake'}${'SecretKeyForForgeScanTest/NotReal000'}`
    expect(rules('a.ini', `id = ${id}\n`)).toEqual([])
    expect(rules('a.ini', `id = ${id}\nsecret = ${secret}\n`)).toEqual(['aws_key_pair'])
    // Written NAME=value, as shells, Dockerfiles and compose files do.
    expect(rules('deploy.sh', `export AWS_ACCESS_KEY_ID=${id}\nexport AWS_SECRET_ACCESS_KEY=${secret}\n`)).toEqual(['aws_key_pair'])
    // A git object id is not an AWS secret.
    expect(rules('a.ini', `id = ${id}\ncommit ${'ab12'.repeat(10)}\n`)).toEqual([])
  })

  it('private key markers need a body', () => {
    expect(rules('k.pem', pem())).toEqual(['private_key'])
    const marker = `-----BEGIN ${'RSA PRIVATE KEY'}-----`
    expect(rules('pem.rs', `const M: &str = "${marker}";\n`)).toEqual([])
    // Encrypted keys carry header lines; they are skipped, the body still counts.
    const encrypted = pem().replace('KEY-----\n', 'KEY-----\nProc-Type: 4,ENCRYPTED\n\n')
    expect(rules('k.pem', encrypted)).toEqual(['private_key'])
  })

  it('a stray BEGIN does not hide a later key', () => {
    const marker = `-----BEGIN ${'RSA PRIVATE KEY'}-----`
    expect(rules('notes.md', `${marker} is how a key starts\n${pem()}`)).toEqual(['private_key'])
    // Thousands of markers stay cheap and find nothing.
    expect(rules('many.txt', `${marker}\n`.repeat(10_000))).toEqual([])
  })

  it('wifs warn and need their checksum', () => {
    // Dash Core src/test/data/key_io_valid.json (public test vectors).
    const w = 'XK9kG3y8JeDgSNrXdomWiCiBMs7D2eNJSrux1rx7GuGLWpMxEH3w'
    const found = scanFile('contrib/k.py', enc(`K = '${w}'\n`))
    expect(found).toHaveLength(1)
    expect(first(found).rule).toBe('wif')
    expect(verdict(first(found), false).reason).toBe('rule')
    const bad = `${w.slice(0, -1)}v`
    expect(rules('k.py', `K = '${bad}'\n`)).toEqual([])
  })

  it('assignments warn once per line', () => {
    expect(rules('s.py', 'API_TOKEN = "q8Zr2LxP0vNw7TkB4mYcHs9D"\n')).toEqual(['secret_assignment'])
    // A token on the line is reported as the token, not also as an assignment.
    const token = githubToken('FakeTokenForForgeSecretsScan01')
    expect(rules('s.py', `GITHUB_TOKEN = "${token}"\n`)).toEqual(['github_token'])
    expect(rules('s.py', 'token_url = "https://example.org/oauth/token"\n')).toEqual([])
  })
})

describe('fingerprints', () => {
  it('are short, stable and per path', () => {
    const a = first(scanFile('.env', enc('A=1\n')))
    const b = first(scanFile('.env', enc('A=1\n')))
    const c = first(scanFile('x/.env', enc('A=1\n')))
    expect(a.fingerprint).toHaveLength(12)
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).not.toBe(c.fingerprint)
    const allow = new AllowList()
    expect(allow.addFingerprint(a.fingerprint)).toBe(true)
    expect(allow.allowsFingerprint(a) && !allow.allowsFingerprint(c)).toBe(true)
    // The name-only fingerprint of an unread file is the read one's: both use the blob id.
    expect(first(scanUnread('.env', gitBlobId(enc('A=1\n')))).fingerprint).toBe(a.fingerprint)
    expect(first(scanUnread('.env', '0'.repeat(40))).fingerprint).not.toBe(a.fingerprint)
  })

  it('blob ids match git', () => {
    // `printf 'A=1\n' | git hash-object --stdin`
    expect(gitBlobId(enc('A=1\n'))).toBe('bd2c89c15cf5290bc8b5e0d71f071132864134c3')
    expect(gitBlobId(enc(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })
})

describe('files matched by name only', () => {
  it('binary and oversized', () => {
    const token = githubToken('FakeTokenForForgeSecretsScan01')
    expect(rules('a.bin', `\0${token}`)).toEqual([])
    expect(rules('big.txt', `${token}\n${'a'.repeat(MAX_SCAN_BYTES)}`)).toEqual([])
    expect(scanUnread('.env', 'a'.repeat(40)).map((x) => x.rule)).toEqual(['env_file'])
    // A big .env is matched by name, whatever it holds.
    expect(rules('.env', `A=1\n${'a'.repeat(MAX_SCAN_BYTES)}`)).toEqual(['env_file'])
  })
})

describe('allow list', () => {
  it('fingerprints, globs and comments', () => {
    const list = AllowList.parse('# header\n\n  3F9A1C2D4E5F   # staging\nsrc/test/data/key_io_valid.json\nnot#acomment\n')
    expect(list.allowsFingerprint(f('.env', '3f9a1c2d4e5f'))).toBe(true)
    expect(list.allowsPath(f('.env', '3f9a1c2d4e5f'))).toBe(false)
    const vectors = f('src/test/data/key_io_valid.json', '000000000000')
    expect(list.allowsPath(vectors) && !list.allowsFingerprint(vectors)).toBe(true)
    expect(list.allowsPath(f('other', '000000000000'))).toBe(false)
    expect(list.allowsPath(f('not#acomment', '000000000000'))).toBe(true)
    expect(list.fingerprintsOnly().allowsFingerprint(f('.env', '3f9a1c2d4e5f'))).toBe(true)
    expect(list.fingerprintsOnly().allowsPath(vectors)).toBe(false)
    expect(AllowList.parse('# only\n').isEmpty()).toBe(true)
  })

  it('only exact-length hex is a fingerprint', () => {
    const l = new AllowList()
    expect(l.addFingerprint('3f9a')).toBe(false)
    expect(l.addFingerprint('3f9a1c2d4e5g')).toBe(false)
    expect(l.addFingerprint('3f9a1c2d4e5f')).toBe(true)
    expect(isFingerprint('3F9A1C2D4E5F')).toBe(true)
  })

  it('extend merges both kinds of entry', () => {
    const l = AllowList.parse('docs/\n')
    l.extend(AllowList.parse('3f9a1c2d4e5f\ndocs/\nother\n'))
    expect(l.allowsFingerprint(f('x', '3f9a1c2d4e5f'))).toBe(true)
    expect(l.allowsPath(f('other', '0'.repeat(12)))).toBe(true)
  })
})

describe('path globs', () => {
  it('names are anchored at the root', () => {
    expect(pathMatches('.env', '.env')).toBe(true)
    expect(pathMatches('.env', 'app/.env')).toBe(false)
    expect(pathMatches('**/.env', 'app/.env')).toBe(true)
    expect(pathMatches('**/.env', '.env')).toBe(true)
    expect(pathMatches('*.pem', 'certs/dev.pem')).toBe(false)
    expect(pathMatches('**/*.pem', 'certs/dev.pem')).toBe(true)
    expect(pathMatches('fixtures/', 'fixtures/key.pem')).toBe(true)
    expect(pathMatches('fixtures/', 'src/fixtures/key.pem')).toBe(false)
    expect(pathMatches('key.pem/', 'key.pem')).toBe(false)
  })

  it('a path matches from the root', () => {
    expect(pathMatches('config/dev.env', 'config/dev.env')).toBe(true)
    expect(pathMatches('config/dev.env', 'app/config/dev.env')).toBe(false)
    expect(pathMatches('/config/*.env', 'config/dev.env')).toBe(true)
    expect(pathMatches('config/*.env', 'config/sub/dev.env')).toBe(false)
    expect(pathMatches('config/**/*.env', 'config/sub/dev.env')).toBe(true)
    expect(pathMatches('config/**/*.env', 'config/dev.env')).toBe(true)
    expect(pathMatches('docs/examples', 'docs/examples/a/b.pem')).toBe(true)
    expect(pathMatches('**/keys/*', 'a/b/keys/k.pem')).toBe(true)
    expect(pathMatches('', 'a')).toBe(false)
    expect(pathMatches('a?c', 'abc')).toBe(true)
    expect(pathMatches('a?c', 'a/c')).toBe(false)
  })

  it('many stars stay fast', () => {
    const pattern = `${'**/'.repeat(30)}${'*a'.repeat(30)}b`
    const path = `${'x/'.repeat(60)}${'a'.repeat(200)}`
    expect(pathMatches(pattern, path)).toBe(false)
  })
})

describe('encodings', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(enc('123456789'))).toBe(0xcbf43926)
    expect(crc32(enc(''))).toBe(0)
  })

  it('base58 keeps leading zeros', () => {
    expect(base58Decode('1')).toEqual(Uint8Array.of(0))
    expect(base58Decode('11')).toEqual(Uint8Array.of(0, 0))
    expect(base58Decode('2')).toEqual(Uint8Array.of(1))
    expect(base58Decode('21')).toEqual(Uint8Array.of(58))
    expect(base58Decode('0')).toBeNull()
  })

  it('encodeBase pads to width', () => {
    expect(encodeBase(0, '0123456789', 3)).toBe('000')
    expect(encodeBase(255, '0123456789abcdef', 1)).toBe('ff')
  })

  it('entropy of uniform strings', () => {
    expect(shannonEntropy('aaaa')).toBeCloseTo(0, 12)
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 12)
  })

  it('lines count from one', () => {
    const starts = lineStarts('a\nb\nc')
    expect(lineAt(starts, 0)).toBe(1)
    expect(lineAt(starts, 1)).toBe(1)
    expect(lineAt(starts, 2)).toBe(2)
    expect(lineAt(starts, 4)).toBe(3)
  })
})
