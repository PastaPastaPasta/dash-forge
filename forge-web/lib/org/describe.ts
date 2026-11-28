import { base58Encode } from '../auth/base58'
import { ROLE_LABEL, writerRoleOf } from '../rules/roles'
import type { DecodedTransition } from './transition'
import { isAllowed } from './transition'
import { sameValue } from './util'

export interface DescribeNames {
  readonly org: string
  readonly orgId: string
  readonly person: (identityId: string) => string
  readonly repo: (repoId: string) => string | null
  readonly stored?: Record<string, unknown> | null
}

const idOf = (v: unknown): string => (v instanceof Uint8Array && v.length === 32 ? base58Encode(v) : typeof v === 'string' ? v : '')
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const quote = (s: string, max = 80): string => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`

const FIELD_LABELS: Readonly<Record<string, string>> = {
  description: 'description',
  displayName: 'display name',
  topics: 'topics',
  language: 'language',
  renamedTo: 'new location',
  defaultBranch: 'default branch',
}

const plain = (v: unknown): unknown =>
  v instanceof Uint8Array ? (v.length === 32 ? base58Encode(v) : Array.from(v)) : typeof v === 'bigint' || typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map(plain) : v

/** What a replace changes against the stored document: every field, so nothing is left unsaid. */
function changes(next: Record<string, unknown>, stored: Record<string, unknown> | null | undefined, repo: (id: string) => string | null): string {
  if (!stored) return `its current version could not be read; it would ${changes(next, {}, repo)}`
  const keys = [...new Set([...Object.keys(next), ...Object.keys(stored)])].filter((k) => !k.startsWith('$') && !sameValue(next[k], stored[k]))
  if (keys.length === 0) return 'no change'
  return keys
    .map((k) => {
      const label = FIELD_LABELS[k] ?? k
      const v = next[k]
      if (v === undefined) return `remove the ${label}`
      if (Array.isArray(v)) return `set the ${label} to ${v.map((x) => String(plain(x))).join(', ') || 'none'}`
      const shown = plain(v)
      if (k === 'renamedTo' && typeof shown === 'string') return `set the ${label} to ${repo(shown) ?? shown}`
      return `set the ${label} to ${quote(String(shown))}`
    })
    .join(', ')
}

export function describeTransition(d: DecodedTransition, names: DescribeNames): string {
  if (!isAllowed(d.documentType, d.action)) return `Unrecognised action (${d.action || 'unknown'} ${d.documentType || 'document'}): Forge will not sign it`
  const source = d.action === 'delete' ? (names.stored ?? {}) : d.data
  const repoId = idOf(source['repoId'])
  const repoName = repoId ? (names.repo(repoId) ?? 'a repository') : 'a repository'
  const member = idOf(source['memberId'])
  const who = member === names.orgId ? 'the organization' : member ? names.person(member) : 'someone'
  switch (`${d.documentType}:${d.action}`) {
    case 'repo:create':
      return `Create the repository ${names.org}/${text(d.data['name'])}`
    case 'repo:replace': {
      const name = text(d.data['name']) || text(names.stored?.['name'])
      return `Edit the listing of ${names.org}/${name}: ${changes(d.data, names.stored, names.repo)}`
    }
    case 'maintainer:create':
      return member === names.orgId ? `Make the organization the maintainer of ${repoName}` : `Give ${who} Maintain access to ${repoName}`
    case 'writer:create': {
      const role = writerRoleOf(d.data['role']) ?? 'writer'
      return `Give ${who} ${ROLE_LABEL[role]} access to ${repoName}`
    }
    case 'maintainer:delete':
      return `Remove ${who}'s Maintain access to ${repoName}`
    case 'writer:delete': {
      const role = writerRoleOf(source['role']) ?? 'writer'
      return `Remove ${who}'s ${ROLE_LABEL[role]} access to ${repoName}`
    }
    case 'config:create': {
      const branch = text(d.data['defaultBranch']) || 'main'
      const protectedPatterns = Array.isArray(d.data['protectedPatterns']) && d.data['protectedPatterns'].length > 0
      return `Set up ${repoName} with default branch ${branch}${protectedPatterns ? ', protected' : ''}`
    }
    case 'profile:create':
      return `Create the organization's profile: ${changes(d.data, {}, names.repo)}`
    case 'profile:replace': {
      return `Update the organization's profile: ${changes(d.data, names.stored, names.repo)}`
    }
    case 'topic:create':
      return `Add the topic ${quote(text(d.data['name']))} to ${repoName}`
    case 'topic:delete':
      return `Remove the topic ${quote(text(source['name']))} from ${repoName}`
    case 'runner:create':
      return `Let ${who} report CI checks on ${repoName}`
    case 'org:create':
    case 'org:replace': {
      const size = d.data['members'] instanceof Uint8Array ? d.data['members'].length / 32 : 0
      return `Publish the organization's roster: ${String(d.data['threshold'] ?? '?')} of ${size} members must sign`
    }
    case 'runner:delete':
      return `Stop ${who} reporting CI checks on ${repoName}`
    default:
      return `Unrecognised action (${d.action} ${d.documentType}): Forge will not sign it`
  }
}
