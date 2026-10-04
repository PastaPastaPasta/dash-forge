/**
 * The `/mirror` setup wizard's logic (`ux-dx-spec.md` §1(b), §8): everything that is not a
 * React component, so it can be unit-tested.
 *
 * - The GitHub repository is named, never signed in to: we host nothing, so there is no OAuth
 *   app. The browser asks GitHub's public REST API (unauthenticated, CORS-enabled) whether the
 *   repository exists and is public.
 * - The runner key is a `dfk1:<network>:<identityId>:<keyId>:<wif>` value (forge-core
 *   `keystore::dfk1`), the one-value `DASH_FORGE_KEY` the Mirror Action reads (`action/mirror.sh`).
 * - The workflow is the one `docs/guides/mirror-a-github-repo.md` documents, prefilled. Every
 *   input is checked here against the same patterns `action/validate.sh` applies, so the file
 *   the wizard hands out never fails the Action's own validation.
 */

import { normalizeRepoName as normalizeV2RepoName } from '../rules/v2'
import type { StorageProfile } from '../storage/profiles'

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/** A GitHub repository's owner and name. */
export interface GithubName {
  readonly owner: string
  readonly name: string
}

/** What GitHub's REST API says about a public repository (the fields the wizard uses). */
export interface GithubRepo extends GithubName {
  readonly description: string
  readonly defaultBranch: string
  /** GitHub's `size`, in KiB. */
  readonly sizeKib: number
  readonly archived: boolean
  readonly fork: boolean
  readonly htmlUrl: string
}

/** `action/validate.sh` `github-repo`: owner (GitHub's rules) and repository name. */
const GH_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const GH_NAME = /^[A-Za-z0-9._-]{1,100}$/

/**
 * Parse what a person pastes for a GitHub repository: `owner/name`, `github.com/owner/name`,
 * a browser URL (`https://github.com/owner/name/tree/main/src`, with or without `.git`), or an
 * SSH clone address (`git@github.com:owner/name.git`).
 */
export function parseGithubRepo(input: string): GithubName {
  let s = input.trim()
  s = s.replace(/^git@github\.com:/i, '')
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
  const [owner = '', rawName = ''] = s.split(/[/?#]/)
  const name = rawName.replace(/\.git$/i, '')
  if (!GH_OWNER.test(owner) || !GH_NAME.test(name) || name === '.' || name === '..') {
    throw new Error('Enter a GitHub repository as owner/name, for example dashpay/dash, or paste its URL.')
  }
  return { owner, name }
}

/** The repository's page on github.com. */
function githubUrl(repo: GithubName): string {
  return `https://github.com/${repo.owner}/${repo.name}`
}

/** GitHub's REST API root. */
export const GITHUB_API = 'https://api.github.com'

/** The answer was not usable: `kind` says why, `message` is the sentence to show. */
export class GithubCheckError extends Error {
  constructor(
    readonly kind: 'not-found' | 'private' | 'rate-limited' | 'unreachable' | 'unexpected',
    message: string,
  ) {
    super(message)
    this.name = 'GithubCheckError'
  }
}

/**
 * Ask GitHub, unauthenticated, whether `repo` exists and is public. A private repository answers
 * 404 to an anonymous caller, the same as a missing one, so the error says both. GitHub allows
 * 60 anonymous requests an hour per address; a spent allowance says when it resets.
 */
export async function checkGithubRepo(repo: GithubName, fetchImpl: typeof fetch = fetch): Promise<GithubRepo> {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  let res: Response
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit' })
  } catch (e) {
    throw new GithubCheckError('unreachable', `Could not reach GitHub (${e instanceof Error ? e.message : String(e)}). Check your connection and try again.`)
  }
  if (res.status === 404) {
    throw new GithubCheckError(
      'not-found',
      `github.com/${repo.owner}/${repo.name} was not found, or it is private. The wizard mirrors public repositories: GitHub answers a private one only with a token, and Forge runs no server to hold one.`,
    )
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    const at = Number.isFinite(reset) && reset > 0 ? ` after ${new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' in a while'
    throw new GithubCheckError('rate-limited', `GitHub allows 60 anonymous lookups an hour from one address, and this one has used them. Try again${at}.`)
  }
  if (!res.ok) throw new GithubCheckError('unexpected', `GitHub answered ${res.status} for ${repo.owner}/${repo.name}. Try again in a moment.`)
  const body = (await res.json()) as Record<string, unknown>
  if (body['private'] === true || (typeof body['visibility'] === 'string' && body['visibility'] !== 'public')) {
    throw new GithubCheckError('private', `github.com/${repo.owner}/${repo.name} is not public. The wizard mirrors public repositories only.`)
  }
  const fullName = typeof body['full_name'] === 'string' ? body['full_name'] : `${repo.owner}/${repo.name}`
  // A renamed or transferred repository redirects: GitHub's full name is the current one.
  const [owner = repo.owner, name = repo.name] = fullName.split('/')
  return {
    owner,
    name,
    description: typeof body['description'] === 'string' ? body['description'] : '',
    defaultBranch: typeof body['default_branch'] === 'string' && body['default_branch'] !== '' ? body['default_branch'] : 'main',
    sizeKib: typeof body['size'] === 'number' ? body['size'] : 0,
    archived: body['archived'] === true,
    fork: body['fork'] === true,
    htmlUrl: typeof body['html_url'] === 'string' ? body['html_url'] : githubUrl({ owner, name }),
  }
}

/** The latest commit id of `ref` in a public repository (the Dash Forge pin, when the build has none). */
export async function latestCommit(repo: GithubName, ref: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${GITHUB_API}/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}`, {
    headers: { Accept: 'application/vnd.github.sha' },
    credentials: 'omit',
  })
  const sha = res.ok ? (await res.text()).trim() : ''
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GitHub did not return a commit for ${repo.owner}/${repo.name}@${ref} (${res.status})`)
  return sha
}

// ---------------------------------------------------------------------------
// The Forge repository
// ---------------------------------------------------------------------------

/** The Forge name a GitHub name suggests (lowercased, cut to 63), or '' when none is valid. */
export function suggestForgeName(githubName: string): string {
  const lowered = githubName.toLowerCase().slice(0, 63)
  return normalizeV2RepoName(lowered) ?? ''
}

/** The description limit of a forge-v2 `repo` document, in UTF-8 bytes (`REPO_LIMITS`). */
const DESCRIPTION_BYTES = 1000

/**
 * The description forge-import gives a mirror it creates (`importer.rs`): `Mirror of
 * github.com/o/r`, or `<GitHub description> (mirror of github.com/o/r)`. The web reads the
 * source back from it (`lib/view/mirror-source.ts`), so the wizard writes the same. A long
 * GitHub description is shortened to fit the contract's limit.
 */
export function mirrorDescription(repo: Pick<GithubRepo, 'owner' | 'name' | 'description'>): string {
  const src = `github.com/${repo.owner}/${repo.name}`
  const own = repo.description.replace(/\s+/g, ' ').trim()
  if (own === '') return `Mirror of ${src}`
  const suffix = ` (mirror of ${src})`
  const enc = new TextEncoder()
  const room = DESCRIPTION_BYTES - enc.encode(suffix).length
  let head = own
  if (enc.encode(head).length > room) {
    // Cut by code point, never inside a character, and mark the cut.
    const chars = [...own]
    while (chars.length > 0 && enc.encode(`${chars.join('')}…`).length > room) chars.pop()
    head = `${chars.join('').trimEnd()}…`
  }
  return `${head}${suffix}`
}

/** The `createRepo` input of a mirror named `name`: the mirror description and GitHub's default branch. */
export function mirrorRepoInput(github: GithubRepo, name: string): { name: string; description: string; defaultBranch?: string } {
  return { name, description: mirrorDescription(github), ...(github.defaultBranch !== 'main' ? { defaultBranch: github.defaultBranch } : {}) }
}

// ---------------------------------------------------------------------------
// The runner key
// ---------------------------------------------------------------------------

/** Runner key defaults (`ux-dx-spec.md` §1(b) step 4): 0.5 DASH for 365 days. */
export const RUNNER_KEY_DEFAULTS = { budgetDash: 0.5, days: 365 } as const

/** The `dfk1:` value of a key (forge-core `keystore::dfk1`): the whole `DASH_FORGE_KEY` secret. */
export function dfk1(networkKey: string, identityId: string, keyId: number, wif: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(networkKey)) throw new Error(`not a network name: ${networkKey}`)
  if (!Number.isInteger(keyId) || keyId < 0) throw new Error(`not a key id: ${keyId}`)
  return `dfk1:${networkKey}:${identityId}:${keyId}:${wif}`
}

// ---------------------------------------------------------------------------
// Storage → the Action's inputs
// ---------------------------------------------------------------------------

/** A GitHub secret the workflow reads, and where its value comes from. */
export interface SecretSpec {
  readonly name: string
  readonly what: string
}

/** One `with:` (or `env:`) line: a name and its value. */
type Line = readonly [string, string]

/** `[[name, value]]` when `value` is not empty, else nothing. */
const lineIf = (name: string, value: string): Line[] => (value === '' ? [] : [[name, value]])

/** How a storage profile maps onto the Action: its `with:` lines and the secrets it needs. */
export type MirrorStorage =
  | { readonly ok: true; readonly kind: 'platform' | 's3'; readonly inputs: readonly Line[]; readonly secrets: readonly SecretSpec[] }
  | { readonly ok: false; readonly reason: string }

/** A storage the Action can use. */
export type UsableMirrorStorage = Extract<MirrorStorage, { ok: true }>

/** The Platform choice: no profile, no extra secret. */
export const PLATFORM_STORAGE: UsableMirrorStorage = { ok: true, kind: 'platform', inputs: [['storage-kind', 'platform']], secrets: [] }

/** `action/validate.sh` patterns. */
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,62}$/
const REGION = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/
const PREFIX = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/

/**
 * What the Action needs to push to `profile`. S3 profiles (R2, B2, AWS, Garage/RustFS/MinIO)
 * map field for field (`action/mirror.sh` passes them to `dg storage add`); a value the Action
 * would refuse is reported here instead. IPFS profiles are not offered: the Action pins through
 * a kubo node the job itself would have to run.
 */
export function mirrorStorageOf(profile: StorageProfile): MirrorStorage {
  const s = profile.settings
  if (s.kind === 'platform') return PLATFORM_STORAGE
  if (s.kind !== 's3') {
    return { ok: false, reason: 'IPFS storage needs a kubo node inside the GitHub job; the wizard sets up S3-compatible storage or Platform. See the Action’s README for ipfs-pinning.' }
  }
  const endpoint = s.endpoint.replace(/\/+$/, '')
  const publicUrl = s.publicUrl.replace(/\/+$/, '')
  const prefix = s.prefix.replace(/^\/+|\/+$/g, '')
  const problems: string[] = []
  if (!HTTPS_URL.test(endpoint)) problems.push(`the endpoint (${endpoint}) must be a public https:// address a GitHub runner can reach`)
  if (!BUCKET.test(s.bucket)) problems.push(`the bucket name ${JSON.stringify(s.bucket)} is not one the Action accepts (lowercase letters, digits, . and -)`)
  if (s.region !== '' && !REGION.test(s.region)) problems.push(`the region ${JSON.stringify(s.region)} is not a region name`)
  if (publicUrl !== '' && !HTTPS_URL.test(publicUrl)) problems.push(`the public URL (${publicUrl}) must be an https:// address`)
  if (prefix !== '' && !PREFIX.test(prefix)) problems.push(`the key prefix ${JSON.stringify(prefix)} may hold letters, digits and . _ / - only`)
  if (problems.length > 0) return { ok: false, reason: `This profile cannot be used from GitHub Actions: ${problems.join('; ')}.` }
  const inputs: Line[] = [
    ['storage-kind', 's3'],
    ['s3-endpoint', endpoint],
    ...lineIf('s3-region', s.region),
    ['s3-bucket', s.bucket],
    ...lineIf('s3-public-url', publicUrl),
    ...lineIf('s3-prefix', prefix),
    ...lineIf('s3-virtual-hosted', s.pathStyle ? '' : 'true'),
  ]
  return {
    ok: true,
    kind: 's3',
    inputs,
    secrets: [
      { name: 'S3_ACCESS_KEY_ID', what: `the access key id of ${profile.name}` },
      { name: 'S3_SECRET_ACCESS_KEY', what: `the secret access key of ${profile.name}` },
    ],
  }
}

// ---------------------------------------------------------------------------
// The workflow file
// ---------------------------------------------------------------------------

/** Where the Action and the binaries it runs come from. */
export const DASH_FORGE_REPO: GithubName = { owner: 'PastaPastaPasta', name: 'dash-forge' }
/** The workflow's path in the GitHub repository. */
export const WORKFLOW_PATH = '.github/workflows/forge-mirror.yml'

export interface WorkflowOptions {
  readonly github: GithubName
  /** `dash://<owner identity id>/<name>`. */
  readonly forgeRepo: string
  /** `mainnet`, `testnet` or `devnet`. */
  readonly network: string
  /** The devnet's name, or null. */
  readonly devnetName: string | null
  readonly storage: UsableMirrorStorage
  /** Also mirror issues and pull requests (and their comments and reviews). */
  readonly collab: boolean
  /** The per-run cap in DASH, as typed. */
  readonly costCap: string
  /** The Dash Forge commit the Action, and so the binaries it builds, are pinned to (40 hex). */
  readonly commit: string
}

const COST_CAP = /^[0-9]{1,6}(\.[0-9]{1,8})?$/

/** Why `costCap` would fail the Action's validation, or null. */
export function costCapProblem(costCap: string): string | null {
  if (!COST_CAP.test(costCap.trim())) return 'Enter an amount in DASH, like 0.1'
  if (Number(costCap) <= 0) return 'The cap must be more than 0'
  return null
}

/** A YAML single-quoted scalar. */
function q(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

/**
 * The `.github/workflows/forge-mirror.yml` of `docs/guides/mirror-a-github-repo.md`, prefilled.
 * The network is always written out, never left to the Action's default, so the workflow keeps
 * targeting the network this site reads when that default changes. The Action is pinned to one
 * commit, and `install: 'source'` builds `dg`, `git-remote-dash` and `forge-import` from that
 * same commit (no Dash Forge release is published yet; the Action caches the build).
 */
export function workflowYaml(o: WorkflowOptions): string {
  if (!/^[0-9a-f]{40}$/.test(o.commit)) throw new Error('pin a full 40-character Dash Forge commit id')
  const capProblem = costCapProblem(o.costCap)
  if (capProblem !== null) throw new Error(capProblem)
  if (o.network === 'devnet' && (o.devnetName === null || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.devnetName))) throw new Error('a devnet needs its name')
  const sync = o.collab ? 'code,releases,labels,issues,prs' : 'code,releases'
  const withLines: Line[] = [
    ['repo', o.forgeRepo],
    ['network', o.network],
    ...lineIf('devnet-name', o.network === 'devnet' ? (o.devnetName ?? '') : ''),
    ['sync', sync],
    ...o.storage.inputs,
    ['cost-cap', o.costCap.trim()],
    ['install', 'source'],
  ]
  const envLines: Line[] = [
    ['DASH_FORGE_KEY', '${{ secrets.DASH_FORGE_KEY }}'],
    ...o.storage.secrets.map((s): Line => [s.name, `\${{ secrets.${s.name} }}`]),
    ['GITHUB_TOKEN', '${{ secrets.GITHUB_TOKEN }}'],
  ]
  const src = `${DASH_FORGE_REPO.owner}/${DASH_FORGE_REPO.name}`
  const triggers = [
    "  push: { branches: ['**'], tags: ['**'] }",
    ...(o.collab
      ? [
          '  issues: { types: [opened, edited, closed, reopened, labeled, unlabeled] }',
          '  issue_comment: { types: [created] }',
          '  pull_request_target: { types: [opened, edited, closed, reopened, synchronize] }',
        ]
      : []),
    '  release: { types: [published, edited] }',
    "  schedule: [{ cron: '17 3 * * *' }]     # daily reconcile",
    '  workflow_dispatch:',
  ]
  return [
    `# Mirrors github.com/${o.github.owner}/${o.github.name} into Dash Forge (${o.forgeRepo}).`,
    // copy-lint-ignore: a comment in the generated workflow file, read in the user's repo
    '# Made by the Forge mirror wizard; see docs/guides/mirror-a-github-repo.md in',
    `# ${src}. The job never checks out or runs this repository's code.`,
    'name: Forge mirror',
    'on:',
    ...triggers,
    'concurrency: { group: forge-mirror, cancel-in-progress: false }',
    'jobs:',
    '  mirror:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 60',
    '    permissions: { contents: read, issues: read, pull-requests: read }',
    '    steps:',
    '      # No Dash Forge release is published yet: the Action builds dg, git-remote-dash and',
    "      # forge-import from this same pinned commit (install: 'source'). The first run compiles",
    "      # for several minutes; later runs reuse the Action's build cache.",
    `      - uses: ${src}/action@${o.commit}`,
    '        with:',
    ...withLines.map(([k, v]) => `          ${k}: ${q(v)}`),
    '        env:',
    ...envLines.map(([k, v]) => `          ${k}: ${v}`),
    '',
  ].join('\n')
}

/** The secrets the workflow reads, in the order to add them. `DASH_FORGE_KEY` first. */
export function workflowSecrets(storage: UsableMirrorStorage): readonly SecretSpec[] {
  return [{ name: 'DASH_FORGE_KEY', what: 'the runner key from step 4 (starts with dfk1:)' }, ...storage.secrets]
}

/** GitHub's "new file" page with the workflow filled in. */
export function newWorkflowUrl(github: GithubName, branch: string, yaml: string): string {
  const q = new URLSearchParams({ filename: WORKFLOW_PATH, value: yaml })
  return `${githubUrl(github)}/new/${branch.split('/').map(encodeURIComponent).join('/')}?${q.toString()}`
}

/** GitHub's "New repository secret" page. */
export function newSecretUrl(github: GithubName): string {
  return `${githubUrl(github)}/settings/secrets/actions/new`
}

/** The workflow's runs on GitHub. */
export function workflowRunsUrl(github: GithubName): string {
  return `${githubUrl(github)}/actions/workflows/forge-mirror.yml`
}

/** The Action's own `cost-cap` default (action/action.yml, the README's sample), in DASH. */
export const ACTION_COST_CAP = 0.05

/**
 * A per-run cap that lets the first run through, which is why it is above the Action's own
 * default ({@link ACTION_COST_CAP}, a later run's budget; the step says so, QW4-045): the first
 * run writes every branch, tag and release, about 0.0008 DASH a ref update and 0.0007 a release.
 * With your own storage a push pays only its manifest and ref updates, so 0.1 DASH leaves room
 * for that; on Platform the pack bytes are paid too, so the cap grows with GitHub's size of the
 * repository (a third over the estimate, as the estimate is an upper bound anyway).
 */
export function defaultCostCap(kind: 'platform' | 's3', sizeKib: number, perMibDash: number): string {
  if (kind === 's3') return '0.1'
  const estimate = (sizeKib / 1024) * perMibDash * 1.35 + 0.05
  return String(Math.max(0.1, Math.ceil(estimate * 100) / 100))
}

/**
 * The runner key budget to suggest: the default 0.5 DASH, or on Platform enough for the first
 * run's cap twice over (the first run and the pushes after it), at most 10 DASH (the most one
 * key update adds, `TOP_UP_MAX_DASH`).
 */
export function suggestedRunnerBudget(kind: 'platform' | 's3', sizeKib: number, perMibDash: number): string {
  const twice = Number(defaultCostCap(kind, sizeKib, perMibDash)) * 2
  return String(Math.min(10, Math.max(RUNNER_KEY_DEFAULTS.budgetDash, Math.ceil(twice * 10) / 10)))
}
