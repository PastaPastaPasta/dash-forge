import type { MemberRow, MessageRow, ShareRow } from './platform'
import type { OrgDocRow, OrgPort } from './transport'
import { hex } from './util'

/** An in-memory `forge-org` for tests: Platform's ordering by `$createdAt`, nothing else. */
export interface FakeOrgPort extends OrgPort {
  readonly members: MemberRow[]
  readonly messages: (MessageRow & { readonly org: string })[]
  readonly shares: ShareRow[]
  readonly orgDocs: Map<string, OrgDocRow>
  readonly writes: { readonly type: string; readonly ownerId: string }[]
}

export function fakeOrgPort(): FakeOrgPort {
  let clock = 1_000
  let ids = 0
  const members: MemberRow[] = []
  const messages: (MessageRow & { org: string })[] = []
  const shares: ShareRow[] = []
  const orgDocs = new Map<string, OrgDocRow>()
  const writes: { type: string; ownerId: string }[] = []
  const nextId = (): string => `doc${(ids++).toString().padStart(6, '0')}`
  return {
    members,
    messages,
    shares,
    orgDocs,
    writes,
    orgDoc: async (orgId) => orgDocs.get(orgId) ?? null,
    membersByKey: async (orgId, authPub) => [...members].sort((a, b) => a.createdAt - b.createdAt).filter((m) => m.org === orgId && hex(m.authPub) === authPub),
    membershipsOf: async (ownerId) => members.filter((m) => m.ownerId === ownerId),
    messagesOf: async (orgId, ownerId, since) => messages.filter((m) => m.org === orgId && m.ownerId === ownerId && m.createdAt >= since),
    shareOf: async (orgId, ownerId, cid) => shares.find((r) => r.org === orgId && r.ownerId === ownerId && hex(r.cid) === cid) ?? null,
    async writeShare(auth, f) {
      if (shares.some((r) => r.org === f.org && r.ownerId === auth.identityId && hex(r.cid) === hex(f.cid))) throw new Error('duplicate unique index byCeremony')
      writes.push({ type: 'orgShare', ownerId: auth.identityId })
      shares.push({ id: nextId(), ownerId: auth.identityId, org: f.org, cid: f.cid, sealed: f.sealed })
    },
    async writeMember(auth, f) {
      if (members.some((m) => m.org === f.org && m.ownerId === auth.identityId && hex(m.authPub) === hex(f.authPub))) throw new Error('duplicate unique index byOrg')
      writes.push({ type: 'orgMember', ownerId: auth.identityId })
      members.push({ id: nextId(), ownerId: auth.identityId, createdAt: clock++, org: f.org, room: f.room, authPub: f.authPub, proof: f.proof })
    },
    async writeMessage(auth, orgId, parts) {
      for (const p of parts) {
        writes.push({ type: 'orgMessage', ownerId: auth.identityId })
        messages.push({ id: nextId(), ownerId: auth.identityId, createdAt: clock++, org: orgId, ...p })
      }
    },
  }
}
