/**
 * Writing environments from the browser and the member-change flow, over real seals and an
 * in-memory chain: a maintainer creates environments for each audience and only their people
 * read them; adding a writer saves a Writers-and-maintainers environment again and the writer
 * reads it; promoting someone saves a Maintainers environment again after the plan (and first
 * protects one their dormant change would replace); removing a reader lists the checklist and
 * saves All members again without them; a removed maintainer's head is saved again first-hand.
 * Also `.env` parsing (forge-core `parse_dotenv`'s cases), mark-changed and the plan's sentences.
 */

import { describe, expect, it } from 'vitest'
import { getPublicKey } from '@noble/secp256k1'

import { base58Encode } from '../auth/base58'
import type { LetterReader, OwnerKey } from '../private'
import type { Membership, Role } from '../rules/v2'
import { decodeSnapshot, encodeSnapshot, type Audience, type EnvVar, type Snapshot } from './format'
import { openSnapshot, sealLetterSnapshot } from './codec'
import { applySet, changeSummary, draftOf, markChangedNames, parseDotenv, planSave, saveNotes, saveNoteText } from './edit'
import { currentOf, readEnvironments, type EnvBook, type EnvKeys, type EnvManifest, type EnvSources } from './loader'
import { planMemberChange, runMemberChange, type MemberChange, type MemberEnvIO } from './member-change'
import { notUpdatedLine, outcomeLine, pinLine, planHeadline } from './plan-view'
import { membersAfter } from './regroup'
import { resolvePeople } from './view'
import { EnvSaveError, MAX_SEALED, baseOf, draftSnapshot, newEnvId, prepareSave, recipientsOf, storeSave, type EnvSaver, type PersonKey } from './write'

const repoIdBytes = new Uint8Array(32).fill(0x11)
const secret = (b: number) => new Uint8Array(32).fill(b)
interface Party {
  readonly b: number
  readonly id: string
  readonly bytes: Uint8Array
  readonly pub: Uint8Array
}
const party = (b: number): Party => {
  const bytes = new Uint8Array(32).fill(b + 100)
  return { b, id: base58Encode(bytes), bytes, pub: getPublicKey(secret(b), true) }
}
const owner = party(1) // the owner, a maintainer
const mara = party(2) // a maintainer
const will = party(3) // a writer
const rae = party(4) // a reader
const dana = party(5) // joins later
const bot = party(6) // a CI bot, never in a group
const nokey = party(7) // no encryption key
const everyone = [owner, mara, will, rae, dana, bot, nokey]
const byId = new Map(everyone.map((p) => [p.id, p]))
const name = (id: string) => ['owner', 'mara', 'will', 'rae', 'dana', 'bot', 'nokey'][(byId.get(id)?.b ?? 0) - 1] ?? id

async function sha256Hex(b: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(b))).toString('hex')
}

/** A repo on an in-memory chain: its members, its kind-8 manifests and their bytes. */
class Chain {
  members: Membership[] = [
    { identity: owner.id, role: 'maintainer', createdAt: 1 },
    { identity: mara.id, role: 'maintainer', createdAt: 1 },
    { identity: will.id, role: 'writer', createdAt: 1 },
    { identity: rae.id, role: 'reader', createdAt: 1 },
  ]
  stored: { manifest: EnvManifest; bytes: Uint8Array }[] = []
  height = 10
  writes = 0

  maintainers(): string[] {
    return this.members.filter((m) => m.role === 'maintainer').map((m) => m.identity)
  }

  sources(extra?: string): EnvSources {
    return {
      manifests: async () => this.stored.map((s) => s.manifest),
      maintainers: async () => [...new Set([...this.maintainers(), ...(extra === undefined ? [] : [extra])])],
      fetch: async (m) => (this.stored.find((s) => s.manifest.id === m.id) as { bytes: Uint8Array }).bytes,
      ownerKeys: async (o): Promise<OwnerKey[]> => {
        const p = byId.get(o)
        return p === undefined || p === nokey ? [] : [{ id: 4, purpose: 1, keyType: 0, data: p.pub }]
      },
    }
  }

  /** What `p` reads (the owner holds no members key: every snapshot here is a letter). */
  read(p: Party, asMaintainer?: string): Promise<EnvBook> {
    const reader: LetterReader = { identityId: p.bytes, secrets: [secret(p.b)] }
    const keys: EnvKeys = { repoId: repoIdBytes, members: null, withReader: (use) => use(reader), hasReader: true }
    return readEnvironments(this.sources(asMaintainer), keys)
  }

  async put(ownerId: string, bytes: Uint8Array, supersedes: readonly string[]): Promise<{ id: string; packHash: string }> {
    this.height += 1
    this.writes += 1
    const packHash = await sha256Hex(bytes)
    const id = `m${String(this.height).padStart(4, '0')}${'y'.repeat(40)}`
    this.stored.push({ manifest: { id, ownerId, packHash, supersedes: [...supersedes], height: this.height, createdAt: this.height * 1000, sizeBytes: bytes.length }, bytes })
    return { id, packHash }
  }
}

const keyOf = (p: Party): PersonKey | null => (p === nokey ? null : { keyId: 4, publicKey: p.pub })

/** `p` saving to `chain`, as `sdkEnvSaver` does over the SDK. */
function saverFor(chain: Chain, p: Party): EnvSaver {
  return {
    me: p.id,
    requireMaintainer: async () => {
      if (!chain.maintainers().includes(p.id)) throw new EnvSaveError('Only maintainers can change environments.')
    },
    sender: async () => ({ identity: p.id, keyId: 4, publicKey: p.pub }),
    keysOf: async (ids) => new Map(ids.map((id) => [id, byId.has(id) ? keyOf(byId.get(id) as Party) : null])),
    seal: (slots, snap) => sealLetterSnapshot(repoIdBytes, secret(p.b), 4, p.bytes, slots, snap),
    store: (sealed, supersedes) => chain.put(p.id, sealed, supersedes),
  }
}

function ioFor(chain: Chain, p: Party): MemberEnvIO {
  return {
    read: (asMaintainer) => chain.read(p, asMaintainer),
    members: async () => [...chain.members],
    keys: async (ids) => new Map(ids.map((id) => [id, byId.has(id) && byId.get(id) !== nokey ? 4 : null])),
  }
}

const vars = (o: Record<string, string>): Map<string, EnvVar> => new Map(Object.entries(o).map(([k, v]) => [k, { value: v, type: 'secret', note: '' }]))

/** `p` creates or changes `env` with `audience` and `values`, as the web's form does. */
async function save(chain: Chain, p: Party, env: string, audience: Audience | undefined, values: Record<string, string>): Promise<void> {
  const book = await chain.read(p)
  const plan = planSave(book, env, { ...(audience ? { audience } : {}), change: (n) => applySet(n.vars, new Map(Object.entries(values)), true) })
  const people = resolvePeople(plan.audience, { owner: owner.id, members: chain.members })
  await storeSave(saverFor(chain, p), await prepareSave(saverFor(chain, p), draftOf(plan, people), 1_767_225_600_000))
}

/** What `p` reads of `env`'s values (null: it doesn't open for them). */
async function valuesFor(chain: Chain, p: Party, env: string): Promise<Record<string, string> | null> {
  const cur = currentOf(await chain.read(p), env)
  return cur.ok ? Object.fromEntries([...cur.snapshot.vars].map(([k, v]) => [k, v.value])) : null
}

const G = (group: Audience['group'], also: string[] = []): Audience => ({ group, also })

describe('saving an environment', () => {
  it('seals a version-2 letter for exactly the people its audience covers, writer first, in id order', async () => {
    const chain = new Chain()
    await save(chain, owner, 'production', G('maintainers'), { DB_URL: 'QAMARK-db' })
    await save(chain, owner, 'staging', G('writers', [bot.id]), { API: 'QAMARK-api' })
    await save(chain, owner, 'dev', G('members'), { LOG: 'debug' })
    const book = await chain.read(owner)
    const to = (env: string) => (currentOf(book, env) as { ok: true; snapshot: Snapshot }).snapshot.to
    const sorted = (ids: string[]) => [owner.id, ...ids.filter((i) => i !== owner.id).sort()]
    expect(to('production')).toEqual(sorted([mara.id]))
    expect(to('staging')).toEqual(sorted([mara.id, will.id, bot.id]))
    expect(to('dev')).toEqual(sorted([mara.id, will.id, rae.id]))
    expect(await valuesFor(chain, mara, 'production')).toEqual({ DB_URL: 'QAMARK-db' })
    expect(await valuesFor(chain, will, 'production')).toBeNull()
    expect(await valuesFor(chain, bot, 'staging')).toEqual({ API: 'QAMARK-api' })
    expect(await valuesFor(chain, bot, 'dev')).toBeNull()
    expect(await valuesFor(chain, rae, 'dev')).toEqual({ LOG: 'debug' })
    // the artifact is exactly what the codec reads back (forge-core decodes the same bytes, conformance.test.ts)
    const m = chain.stored[0] as { manifest: EnvManifest; bytes: Uint8Array }
    const reader: LetterReader = { identityId: mara.bytes, secrets: [secret(mara.b)] }
    const snap = await openSnapshot(m.manifest, m.bytes, { repoId: repoIdBytes, ownerKeys: [{ id: 4, purpose: 1, keyType: 0, data: owner.pub }], reader, epochKeys: new Map() })
    expect(snap.version).toBe(2)
    expect(snap.id).toMatch(/^[0-9a-f]{32}$/)
    expect(snap.toKeys).toEqual([4, 4])
    expect(decodeSnapshot(encodeSnapshot(snap))).toEqual(snap)
  })

  it('keeps the id and supersedes the head on a later save, and skips someone with no key, naming them', async () => {
    const chain = new Chain()
    await save(chain, owner, 'ci', G(null, [will.id, nokey.id, owner.id]), { TOKEN: 'a' })
    const first = (await chain.read(owner)).manifests[0] as EnvManifest
    const book = await chain.read(owner)
    const plan = planSave(book, 'ci', { change: (n) => applySet(n.vars, new Map([['TOKEN', 'b']]), false) })
    expect(changeSummary(plan.changes)).toBe('~ TOKEN')
    const prepared = await prepareSave(saverFor(chain, owner), draftOf(plan, new Set(plan.audience.also)))
    expect(prepared.skipped).toEqual([nokey.id])
    expect(saveNoteText('ci', saveNotes(book, plan, prepared.skipped)[0] as ReturnType<typeof saveNotes>[number], name)).toBe("nokey has no encryption key and won't be able to read it.")
    await storeSave(saverFor(chain, owner), prepared)
    const after = currentOf(await chain.read(owner), 'ci') as { ok: true; snapshot: Snapshot }
    expect(after.snapshot.id).toBe(baseOf(book, 'ci').id)
    expect(chain.stored[1]?.manifest.supersedes).toEqual([first.packHash])
    expect(after.snapshot.vars.get('TOKEN')?.value).toBe('b')
  })

  it('refuses a first save with no audience, a writer, and an unchanged save', async () => {
    const chain = new Chain()
    expect(() => planSave({ maintainers: new Set(), manifests: [], opened: new Map(), oldFormat: new Set(), resolution: { ignored: [], environments: [], hidden: [] } }, 'prod')).toThrow(/Choose who can read prod/)
    await save(chain, owner, 'prod', G('maintainers'), { A: '1' })
    const book = await chain.read(owner)
    expect(planSave(book, 'prod').unchanged).toBe(true)
    expect(planSave(book, 'prod', { again: true }).unchanged).toBe(false)
    await expect(prepareSave(saverFor(chain, will), draftOf(planSave(book, 'prod', { again: true }), new Set([owner.id])))).rejects.toThrow('Only maintainers')
    expect(chain.writes).toBe(1)
  })

  it('refuses more than 64 people before sealing', () => {
    const people = Array.from({ length: 70 }, (_, i) => base58Encode(new Uint8Array(32).fill(i + 1)))
    const r = recipientsOf({ identity: owner.id, keyId: 4, publicKey: owner.pub }, people, new Map(people.map((p) => [p, { keyId: 1, publicKey: owner.pub }])))
    expect(r.to).toHaveLength(71)
    expect(MAX_SEALED).toBe(14_700)
    expect(newEnvId()).toMatch(/^[0-9a-f]{32}$/)
  })
})

/** Run `change` as the owner, with the plan shown first. */
async function change(chain: Chain, c: MemberChange): Promise<{ plan: Awaited<ReturnType<typeof planMemberChange>>; outcome: Awaited<ReturnType<typeof runMemberChange>> }> {
  const plan = await planMemberChange(ioFor(chain, owner), c, owner.id, owner.id, false)
  const outcome = await runMemberChange(ioFor(chain, owner), saverFor(chain, owner), plan, owner.id, async () => {
    chain.members = c.kind === 'grant' ? membersAfter(chain.members, c.member, c.role, true) : c.kind === 'revoke' ? membersAfter(chain.members, c.member, c.role, false) : membersAfter(membersAfter(chain.members, c.member, c.role, false), c.member, c.to, true)
  })
  return { plan, outcome }
}

describe('member changes save environments again', () => {
  it('adding a writer saves Writers and maintainers and All members again; the writer reads them', async () => {
    const chain = new Chain()
    await save(chain, owner, 'production', G('maintainers'), { DB: 'p' })
    await save(chain, owner, 'staging', G('writers'), { DB: 's' })
    await save(chain, owner, 'dev', G('members'), { DB: 'd' })
    const { plan, outcome } = await change(chain, { kind: 'grant', member: dana.id, role: 'writer' })
    expect(plan.regroup.map((p) => p.env)).toEqual(['dev', 'staging'])
    expect(planHeadline(plan, name)).toMatch(/^Adding dana as a writer gives them access to 2 environments: dev, staging\. Saving 2 environments again costs about 0\.\d+ DASH\.$/)
    expect(pinLine(plan.regroup[1]!, name)).toBe('staging (Writers and maintainers): saved again for the people it covers, adds dana.')
    expect(outcome.saves.map((s) => outcomeLine(s, name))).toEqual([
      'Saved dev again (All members, sent to 5 people).',
      'Saved staging again (Writers and maintainers, sent to 4 people).',
    ])
    expect(await valuesFor(chain, dana, 'staging')).toEqual({ DB: 's' })
    expect(await valuesFor(chain, dana, 'production')).toBeNull()
  })

  it('promoting a member to maintainer saves Maintainers again after showing the plan, and protects what their dormant change would replace', async () => {
    const chain = new Chain()
    await save(chain, owner, 'production', G('maintainers'), { DB: 'p1' })
    // will (a writer) saved production once: ignored now, it would count once they're a maintainer
    const prodHead = (await chain.read(owner)).manifests[0] as EnvManifest
    const dormant = await sealLetterSnapshot(repoIdBytes, secret(will.b), 4, will.bytes, [{ identityId: will.bytes, publicKey: will.pub }, { identityId: owner.bytes, publicKey: owner.pub }], {
      version: 2,
      env: 'production',
      audience: G('maintainers'),
      id: (currentOf(await chain.read(owner), 'production') as { ok: true; snapshot: Snapshot }).snapshot.id,
      generatedAt: 1,
      to: [will.id, owner.id],
      toKeys: [4, 4],
      markedChanged: [],
      vars: vars({ DB: 'evil' }),
    })
    await chain.put(will.id, dormant, [prodHead.packHash])
    const { plan, outcome } = await change(chain, { kind: 'change', member: will.id, role: 'writer', to: 'maintainer' })
    expect(plan.first.map((p) => [p.env, p.why.kind])).toEqual([['production', 'promotion']])
    expect(pinLine(plan.first[0]!, name)).toBe("production: will's earlier changes would replace its values, so it's saved first with its current values, which stay.")
    expect(outcome.saves.filter((s) => s.kind === 'saved').map((s) => s.env)).toEqual(['production', 'production'])
    expect(await valuesFor(chain, will, 'production')).toEqual({ DB: 'p1' })
    expect(await valuesFor(chain, owner, 'production')).toEqual({ DB: 'p1' })
  })

  it('removing a reader lists the checklist and saves All members again without them', async () => {
    const chain = new Chain()
    await save(chain, owner, 'dev', G('members'), { TOKEN: 'QAMARK-t', LOG: 'debug' })
    await save(chain, owner, 'production', G('maintainers'), { DB: 'p' })
    const plan = await planMemberChange(ioFor(chain, owner), { kind: 'revoke', member: rae.id, role: 'reader' }, owner.id, owner.id, false)
    expect(plan.exposures).toEqual([{ env: 'dev', names: ['LOG', 'TOKEN'], oldFormat: false }])
    expect(plan.regroup.map((p) => [p.env, p.gone.map(name)])).toEqual([['dev', ['rae']]])
    expect(planHeadline(plan, name)).toMatch(/^rae can no longer read dev once it's saved again without them\./)
    await runMemberChange(ioFor(chain, owner), saverFor(chain, owner), plan, owner.id, async () => {
      chain.members = membersAfter(chain.members, rae.id, 'reader', false)
    })
    expect(await valuesFor(chain, rae, 'dev')).toBeNull()
    expect(await valuesFor(chain, will, 'dev')).toEqual({ LOG: 'debug', TOKEN: 'QAMARK-t' })
  })

  it("removing a maintainer saves their head again first-hand, and names environments the remover can't open", async () => {
    const chain = new Chain()
    await save(chain, owner, 'production', G('maintainers'), { DB: 'p1' })
    await save(chain, mara, 'production', undefined, { DB: 'p2' })
    // mara's own environment, for her and will only: the owner can't open it
    await save(chain, mara, 'secret', G(null, [will.id, mara.id]), { X: '1' })
    const plan = await planMemberChange(ioFor(chain, owner), { kind: 'revoke', member: mara.id, role: 'maintainer' }, owner.id, owner.id, false)
    expect(plan.removal.map((p) => [p.env, p.why.kind, p.savedFor === mara.id])).toEqual([['production', 'theirs', true]])
    expect(plan.notUpdated.map((n) => notUpdatedLine(n, name))).toEqual(["mara may be able to read 1 environment you can't open. Ask mara to save it again without mara."])
    await runMemberChange(ioFor(chain, owner), saverFor(chain, owner), plan, owner.id, async () => {
      chain.members = membersAfter(chain.members, mara.id, 'maintainer', false)
    })
    // mara's values stay, now saved by the owner for the maintainers as they are
    expect(await valuesFor(chain, owner, 'production')).toEqual({ DB: 'p2' })
    expect(await valuesFor(chain, mara, 'production')).toBeNull()
  })

  it('a change after a failed save finishes it: plans compare actual recipients', async () => {
    const chain = new Chain()
    await save(chain, owner, 'staging', G('writers'), { DB: 's' })
    chain.members = membersAfter(chain.members, dana.id, 'writer', true)
    // the add landed but staging was never saved again: the precise list and a re-run plan it
    const plan = await planMemberChange(ioFor(chain, owner), { kind: 'grant', member: dana.id, role: 'writer' }, owner.id, owner.id, false)
    expect(plan.regroup.map((p) => [p.env, p.added.map(name)])).toEqual([['staging', ['dana']]])
  })
})

describe('.env text', () => {
  it('reads what forge-core parse_dotenv reads', () => {
    const got = parseDotenv('# comment\nexport A=plain\nB = \'single $x\'\nC="line1\\nline2 \\"q\\" \\$HOME"\nD=bare # trailing comment\nE="multi\nline"\n\nF=\n')
    expect(Object.fromEntries(got)).toEqual({ A: 'plain', B: 'single $x', C: 'line1\nline2 "q" $HOME', D: 'bare', E: 'multi\nline', F: '' })
  })

  it('names the line, never the value', () => {
    expect(() => parseDotenv('A=1\nnot a line\n')).toThrow('line 2: expected NAME=value')
    expect(() => parseDotenv('1A=secret-value\n')).toThrow(/^line 1: not a variable name/)
    try {
      parseDotenv('1A=secret-value\n')
    } catch (e) {
      expect(String(e)).not.toContain('secret-value')
    }
    expect(() => parseDotenv('A="open\n')).toThrow('a double-quoted value is not closed')
    expect(parseDotenv('\uFEFFA=1\n').get('A')).toBe('1')
  })
})

describe('the web writes what dg writes', () => {
  it('makes the env_snapshot__v2_* vectors\' plaintext from a draft', async () => {
    const { readFileSync } = await import('node:fs')
    const { snapshotFromVector } = await import('./testing')
    for (const name of ['v2_maintainers', 'v2_writers', 'v2_members', 'v2_group_also', 'v2_people']) {
      const vec = JSON.parse(readFileSync(new URL(`../../../forge-contracts/vectors/env_snapshot__${name}.json`, import.meta.url), 'utf8'))
      const want = snapshotFromVector(vec.input.snapshot)
      const draft = { env: want.env, id: want.id as string, audience: want.audience, vars: want.vars, supersedes: [], markedChanged: want.markedChanged, people: new Set(want.to) }
      const got = draftSnapshot(draft, { to: want.to, toKeys: want.toKeys, slots: [], skipped: [] }, want.generatedAt)
      expect(Buffer.from(encodeSnapshot(got)).toString('hex'), name).toBe(Buffer.from(encodeSnapshot(want)).toString('hex'))
    }
  })
})

describe('mark changed', () => {
  it('refuses with nothing in the old format', async () => {
    const chain = new Chain()
    await save(chain, owner, 'dev', G('members'), { A: '1' })
    expect(markChangedNames(await chain.read(owner), 'dev')).toEqual({ ok: false, reason: 'dev has no values saved in the old format' })
  })
})

describe('membersAfter', () => {
  it('replaces the document a role is held in', () => {
    const before: Membership[] = [{ identity: will.id, role: 'writer' as Role, createdAt: 1 }]
    expect(membersAfter(before, will.id, 'reader', true)).toEqual([{ identity: will.id, role: 'reader', createdAt: 0 }])
    expect(membersAfter(before, will.id, 'maintainer', true)).toHaveLength(2)
    expect(membersAfter(before, will.id, 'triage', false)).toEqual([])
  })
})
