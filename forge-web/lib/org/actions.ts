import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { DOC, type RepoRef } from '../repo/contract'
import { descriptionProblem, readTopicDocIds, repoEditChanges, topicChanges, topicDocData, topicsProblem, type RepoDocEdit } from '../repo/settings'
import { contractOf } from '../repo/source'
import { checkRepoInput, firstConfigData, membershipData, normalizeRepoName, planMemberGrant, planMemberRevoke, planRoleChange, refuseMemberChangeWithEnvironments, repoCreateData, type CreateRepoInput } from '../repo/writes'
import { hasMembersKey } from '../repo/members-writes'
import { readNewestManifestOfKind } from '../repo/packs'
import { PACK_KIND } from '../constants'
import { ROLE_LABEL } from '../rules/roles'
import type { Role } from '../rules/v2'
import { queryDocumentsWithProof } from '../sdk'
import type { CreateRequestInput, LaterSpec } from './service'
import { declaredOrgLink, isDeclaredLink } from './gate'
import { DOC_ORG } from './platform'
import { rosterFields, rosterMismatch, type Roster } from './roster'
import { OrgUnavailableError, orgContractOf, type OrgPort } from './transport'
import { MAX_LINKS } from '../rules/profile'
import type { DecodedTransition, WriteSpec } from './transition'

interface StoredDoc {
  readonly revision?: bigint
  toObject(): Record<string, unknown>
}

const documentsOf = (sdk: EvoSDK) => (sdk as unknown as { documents: { get(c: string, t: string, id: string): Promise<StoredDoc | undefined | null> } }).documents

export async function newRepoRequest(sdk: EvoSDK, forge: ForgeIds, orgId: string, orgLabel: string, raw: CreateRepoInput): Promise<CreateRequestInput> {
  const name = normalizeRepoName(raw.name)
  const input: CreateRepoInput = { ...raw, name, visibility: 'public', membersOnly: false }
  checkRepoInput(input)
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: forge.core,
    documentTypeName: DOC.repo,
    where: [
      ['$ownerId', '==', orgId],
      ['name', '==', name],
    ],
    limit: 1,
  })
  if (documents.length > 0) throw new Error(`${orgLabel} already has a repository named ${name}.`)
  const repoFor = (repoId: string): RepoRef => ({ forge, repoId, ownerId: orgId, name, visibility: 'public' })
  const maintainer: LaterSpec = {
    contractId: forge.core,
    after: ([repoId]) => ({ action: 'create', contractId: forge.core, documentType: DOC.maintainer, data: membershipData(repoFor(repoId as string), orgId) }),
  }
  const config: LaterSpec = {
    contractId: forge.core,
    after: ([repoId]) => ({ action: 'create', contractId: forge.core, documentType: DOC.config, data: firstConfigData(decodeIdentifier(repoId as string), 'public', input) }),
  }
  return {
    title: `Create ${orgLabel}/${name}`,
    specs: [{ action: 'create', contractId: forge.core, documentType: DOC.repo, data: repoCreateData(name, input, 'public') }, maintainer, config],
  }
}

/**
 * An organization can't change the members of a repository with members-only content or
 * environments yet: those changes re-share keys and re-save environments, which a request does
 * not carry. Refused before anything is requested.
 */
async function refuseKeyedMemberChange(sdk: EvoSDK, repo: RepoRef): Promise<void> {
  if (repo.visibility !== 'public' || (await hasMembersKey(sdk, repo))) {
    throw new Error(`${repo.name} has members-only content, and an organization can't change its members yet`)
  }
  await refuseMemberChangeWithEnvironments(sdk, repo)
}

const MEMBER_TYPES: ReadonlySet<string> = new Set([DOC.maintainer, DOC.writer])

/**
 * Why a member change in a request can no longer be signed (§11.4): its repository now has
 * members-only content or environments. Null when it is not a member change, its repository is
 * not there yet (made by the same request), or nothing stands in the way.
 */
export async function memberChangeProblem(sdk: EvoSDK, forge: ForgeIds, orgId: string, d: DecodedTransition): Promise<string | null> {
  if (d.contractId !== forge.core || !MEMBER_TYPES.has(d.documentType)) return null
  const docs = documentsOf(sdk)
  const source = d.action === 'delete' ? ((await docs.get(forge.core, d.documentType, d.documentId))?.toObject() ?? null) : d.data
  const repoBytes = source?.['repoId']
  if (!(repoBytes instanceof Uint8Array)) return null
  const repoId = base58Encode(repoBytes)
  const stored = await docs.get(forge.core, DOC.repo, repoId)
  if (!stored) return null
  const data = stored.toObject()
  const name = typeof data['name'] === 'string' ? data['name'] : 'This repository'
  const repo: RepoRef = { forge, repoId, ownerId: orgId, name, visibility: data['visibility'] === 'private' ? 'private' : 'public' }
  const keyed = repo.visibility !== 'public' || (await hasMembersKey(sdk, repo))
  if (!keyed && (await readNewestManifestOfKind(sdk, repo, PACK_KIND.ENV_SNAPSHOT)) === null) return null
  return `${name} now has members-only content or environments, so an organization can't change its members; decline this request`
}

export async function grantRequest(sdk: EvoSDK, repo: RepoRef, memberId: string, role: Role): Promise<CreateRequestInput | null> {
  const plan = await planMemberGrant(sdk, repo, memberId, role)
  if (plan.heldId !== null) return null
  await refuseKeyedMemberChange(sdk, repo)
  return { title: `Give ${ROLE_LABEL[role]} access to ${repo.name}`, specs: [{ action: 'create', contractId: repo.forge.core, documentType: plan.documentType, data: plan.data }] }
}

export async function revokeRequest(sdk: EvoSDK, repo: RepoRef, memberId: string, role: Role): Promise<CreateRequestInput | null> {
  const plan = await planMemberRevoke(sdk, repo, memberId, role)
  if (plan === null) return null
  await refuseKeyedMemberChange(sdk, repo)
  return { title: `Remove ${ROLE_LABEL[role]} access to ${repo.name}`, specs: [{ action: 'delete', contractId: repo.forge.core, documentType: plan.documentType, documentId: plan.documentId }] }
}

export async function changeRoleRequest(sdk: EvoSDK, repo: RepoRef, memberId: string, from: Role, to: Role): Promise<CreateRequestInput> {
  await refuseKeyedMemberChange(sdk, repo)
  const { revoke, grant } = await planRoleChange(sdk, repo, memberId, from, to)
  return {
    title: `Change access to ${ROLE_LABEL[to]} on ${repo.name}`,
    specs: [
      { action: 'delete', contractId: repo.forge.core, documentType: revoke.documentType, documentId: revoke.documentId },
      { action: 'create', contractId: repo.forge.core, documentType: grant.documentType, data: grant.data },
    ],
  }
}

export async function listingRequest(sdk: EvoSDK, repo: RepoRef, edit: RepoDocEdit): Promise<CreateRequestInput | null> {
  if (edit.description !== undefined) {
    const p = descriptionProblem(edit.description)
    if (p) throw new Error(p)
  }
  if (edit.topics !== undefined) {
    const p = topicsProblem(edit.topics)
    if (p) throw new Error(p)
  }
  const changes = repoEditChanges(edit)
  if (Object.keys(changes).length === 0) return null
  const stored = (await documentsOf(sdk).get(repo.forge.core, DOC.repo, repo.repoId)) ?? null
  if (stored === null) throw new Error(`${repo.name} was not found`)
  const props: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(stored.toObject())) if (!k.startsWith('$')) props[k] = v
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete props[k]
    else props[k] = v
  }
  const specs: WriteSpec[] = [{ action: 'replace', contractId: repo.forge.core, documentType: DOC.repo, documentId: repo.repoId, revision: stored.revision ?? 1n, data: props }]
  if (edit.topics !== undefined && repo.visibility === 'public') {
    const topicContract = contractOf(repo.forge, DOC.topic)
    const held = await readTopicDocIds(sdk, repo)
    const { added, removed } = topicChanges([...held.keys()], edit.topics)
    for (const name of removed) specs.push({ action: 'delete', contractId: topicContract, documentType: DOC.topic, documentId: held.get(name) as string })
    for (const name of added) specs.push({ action: 'create', contractId: topicContract, documentType: DOC.topic, data: await topicDocData(sdk, repo, name) })
  }
  return { title: `Edit the listing of ${repo.name}`, specs }
}

/** Whether the organization's profile carries exactly the declared link its roster calls for. */
export function declaresRoster(links: readonly unknown[], network: string, roster: Roster): boolean {
  const declared = links.filter(isDeclaredLink)
  return declared.length === 1 && declared[0] === declaredOrgLink(network, roster.threshold, roster.members.length)
}

/**
 * "Publish organization" (§10.5): one request that writes the `org` roster (create, or replace a
 * stale one) and adds the declared link to the organization's profile, keeping its other fields.
 * Null when both are already published.
 */
export async function publishRequest(sdk: EvoSDK, forge: ForgeIds, port: OrgPort, roster: Roster, network: string, label: string): Promise<CreateRequestInput | null> {
  const orgContract = orgContractOf(forge)
  if (orgContract === null) throw new OrgUnavailableError()
  const profileContract = contractOf(forge, DOC.profile)
  const [current, found] = await Promise.all([
    port.orgDoc(roster.orgId),
    queryDocumentsWithProof(sdk, { dataContractId: profileContract, documentTypeName: DOC.profile, where: [['$ownerId', '==', roster.orgId]], limit: 1 }),
  ])
  const specs: WriteSpec[] = []
  const data: Record<string, unknown> = { ...rosterFields(roster) }
  if (current === null) specs.push({ action: 'create', contractId: orgContract, documentType: DOC_ORG, data })
  else if (rosterMismatch(roster, { ...current.fields }) !== null) specs.push({ action: 'replace', contractId: orgContract, documentType: DOC_ORG, documentId: current.id, revision: current.revision, data })
  const link = declaredOrgLink(network, roster.threshold, roster.members.length)
  const profileId = found.documents[0]?.['$id']
  const stored = typeof profileId === 'string' ? await documentsOf(sdk).get(profileContract, DOC.profile, profileId) : null
  if (stored) {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(stored.toObject())) if (!k.startsWith('$')) props[k] = v
    const links = Array.isArray(props['links']) ? (props['links'] as unknown[]) : []
    if (!declaresRoster(links, network, roster)) {
      const kept = links.filter((l) => !isDeclaredLink(l))
      if (kept.length >= MAX_LINKS) throw new Error(`${label}'s profile already has ${MAX_LINKS} links; remove one first, then publish.`)
      specs.push({ action: 'replace', contractId: profileContract, documentType: DOC.profile, documentId: profileId as string, revision: stored.revision ?? 1n, data: { ...props, links: [...kept, link] } })
    }
  } else {
    specs.push({ action: 'create', contractId: profileContract, documentType: DOC.profile, data: { links: [link] } })
  }
  return specs.length === 0 ? null : { title: `Publish ${label} as an organization`, specs }
}
