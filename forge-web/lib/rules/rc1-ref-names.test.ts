/**
 * The RC1 ref-name pre-checks (`oid.ts`) against the contracts they mirror: the patterns are the
 * JSON's own strings, and every rc1 vector that carries a ref name, a default branch or a tag
 * name is accepted or refused by the pre-check exactly as consensus judges the name (R-01).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  RC1_BRANCH_PATTERN,
  RC1_REF_NAME_PATTERN,
  RC1_TAG_PATTERN,
  isGitRefName,
  isLegalRefName,
  isRc1BranchName,
  isRc1OidHex,
  isRc1RefName,
  isRc1TagName,
} from './oid'

const ROOT = resolve(process.cwd(), '..', 'forge-contracts')

interface Rc1Vector {
  readonly item: string
  readonly name: string
  readonly type: string
  readonly expect: 'ok' | 'refused'
  readonly why?: string
  readonly doc: Record<string, unknown>
}

type Contract = {
  schemaDefs: Record<string, { pattern?: string }>
  documentSchemas: Record<string, { properties: Record<string, { pattern?: string }> }>
}
const contract = (name: string): Contract => JSON.parse(readFileSync(resolve(ROOT, 'contracts', `${name}.json`), 'utf8')) as Contract
const vectors = (name: string): Rc1Vector[] => JSON.parse(readFileSync(resolve(ROOT, 'vectors', 'rc1', `${name}.json`), 'utf8')) as Rc1Vector[]

/** Which field of which type each pre-check guards. */
const CHECKS: readonly { readonly types: readonly string[]; readonly field: string; readonly check: (s: string) => boolean }[] = [
  { types: ['refUpdate', 'protectedRefUpdate'], field: 'refName', check: isRc1RefName },
  { types: ['patch'], field: 'baseRefName', check: isRc1RefName },
  { types: ['patch'], field: 'sourceRefName', check: isRc1RefName },
  { types: ['repo', 'config'], field: 'defaultBranch', check: isRc1BranchName },
  { types: ['release'], field: 'tagName', check: isRc1TagName },
]

describe('RC1 ref-name pre-checks', () => {
  it('use the contracts\' own patterns', () => {
    const core = contract('forge-core')
    const collab = contract('forge-collab')
    expect(RC1_REF_NAME_PATTERN).toBe(core.schemaDefs['refName']?.pattern)
    expect(RC1_BRANCH_PATTERN).toBe(core.schemaDefs['branch']?.pattern)
    expect(RC1_TAG_PATTERN).toBe(core.documentSchemas['release']?.properties['tagName']?.pattern)
    expect(RC1_REF_NAME_PATTERN).toBe(collab.schemaDefs['refName']?.pattern)
    expect(RC1_REF_NAME_PATTERN).toBe(collab.documentSchemas['patch']?.properties['sourceRefName']?.pattern)
  })

  // A vector refused for a name is an R-01 one, and the refused name is the field it changed from
  // its type's base vector; every other name a vector carries is legal (a refusal is then some
  // other rule's), so the pre-check must accept it.
  const cases = ['forge-core', 'forge-collab'].flatMap((c) => {
    const all = vectors(c)
    const base = (type: string): Record<string, unknown> => all.find((v) => v.item === 'base' && v.type === type)?.doc ?? {}
    return all.flatMap((v) =>
      CHECKS.filter((k) => k.types.includes(v.type) && typeof v.doc[k.field] === 'string').map((k) => ({
        label: `${c} ${v.item} ${v.name} (${k.field})`,
        value: v.doc[k.field] as string,
        want: !(v.item === 'R-01' && v.expect === 'refused' && v.doc[k.field] !== base(v.type)[k.field]),
        check: k.check,
      })),
    )
  })

  it('cover the R-01 vectors', () => {
    expect(cases.filter((c) => !c.want).length).toBeGreaterThanOrEqual(30)
  })

  it.each(cases)('$label', ({ value, want, check }) => {
    expect(check(value)).toBe(want)
  })

  it('leave a non-final .lock component to the reader, as consensus does', () => {
    expect(isRc1RefName('refs/heads/x.lock/y')).toBe(true)
    expect(isRc1RefName('refs/heads/x.lock')).toBe(false)
    expect(isGitRefName('refs/heads/x.lock/y')).toBe(false)
  })

  // The fold's rule is the contract's (parity: forge-core `is_legal_ref_name`, judged over the
  // same rc1 vectors), so a sealed private ref name or a retarget value outside it is inert.
  it.each(cases.filter((c) => c.check === isRc1RefName))('the fold judges $label as consensus does', ({ value, want }) => {
    expect(isLegalRefName(value)).toBe(want)
  })

  it('refuses the wire-injection shapes forge-core tests', () => {
    expect(isLegalRefName('refs/heads/main')).toBe(true)
    expect(isLegalRefName('refs/tags/v1.0')).toBe(true)
    for (const bad of ['refs/heads/x\n0000 refs/heads/main', 'refs/heads/x\t', 'refs/heads/ x', 'refs/heads/x\0y', '-oops', '', 'heads/main', 'refs/heads/a@{1}']) {
      expect(isLegalRefName(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it("refuse a default branch of '@' alone or leading a path ('@/x', '@.x'), as $defs.branch does", () => {
    for (const bad of ['@', '@/x', '@.x', '@@', '-x']) expect(isRc1BranchName(bad), bad).toBe(false)
    for (const ok of ['@a', 'a@', 'a/@', 'x/@/y', 'main']) expect(isRc1BranchName(ok), ok).toBe(true)
  })

  it('agree with the JSON patterns over a generated corpus (every string of up to 4 of 12 characters)', () => {
    const alphabet = ['a', 'b', '@', '.', '/', '-', '{', '~', ' ', 'é', '\n', 'k']
    const judge = (pattern: string, min: number, max: number) => {
      const re = new RegExp(pattern, 'u')
      return (s: string): boolean => {
        const bytes = new TextEncoder().encode(s).length
        return [...s].length >= min && bytes <= max && re.test(s)
      }
    }
    const branch = judge(RC1_BRANCH_PATTERN, 1, 255)
    const tag = judge(RC1_TAG_PATTERN, 1, 63)
    const ref = judge(RC1_REF_NAME_PATTERN, 6, 255)
    let words = ['']
    let checked = 0
    for (let len = 1; len <= 4; len++) {
      words = words.flatMap((w) => alphabet.map((c) => w + c))
      for (const w of words) {
        expect(isRc1BranchName(w), JSON.stringify(w)).toBe(branch(w))
        expect(isRc1TagName(w), JSON.stringify(w)).toBe(tag(w))
        const full = `refs/${w}`
        expect(isRc1RefName(full), JSON.stringify(full)).toBe(ref(full) && !full.endsWith('.lock'))
        checked += 1
      }
    }
    expect(checked).toBe(12 + 144 + 1728 + 20736)
  })

  it('count characters and UTF-8 bytes', () => {
    expect(isRc1RefName(`refs/${'a'.repeat(250)}`)).toBe(true)
    // 251 characters but 256 bytes.
    expect(isRc1RefName(`refs/${'a'.repeat(245)}ééééé`)).toBe(false)
    expect(isRc1TagName('v'.repeat(63))).toBe(true)
    expect(isRc1TagName('v'.repeat(64))).toBe(false)
    expect(isRc1BranchName('')).toBe(false)
    // A lone surrogate is no UTF-8 at all.
    expect(isRc1RefName('refs/heads/\uD800x')).toBe(false)
  })

  it('accept oids of 20 or 32 bytes only (R-10 `oidWidth`)', () => {
    expect(isRc1OidHex('ab'.repeat(20))).toBe(true)
    expect(isRc1OidHex('AB'.repeat(32))).toBe(true)
    expect(isRc1OidHex('0'.repeat(40))).toBe(true)
    expect(isRc1OidHex('ab'.repeat(25))).toBe(false)
    expect(isRc1OidHex('ab'.repeat(21))).toBe(false)
    expect(isRc1OidHex('')).toBe(false)
    expect(isRc1OidHex('zz'.repeat(20))).toBe(false)
  })
})
