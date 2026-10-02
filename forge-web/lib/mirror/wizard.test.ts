/**
 * The `/mirror` wizard's pure parts: reading a GitHub repository name, the anonymous public
 * check, the Forge name and description, the `dfk1:` runner key, the storage → Action mapping,
 * and the workflow file, which must pass the Action's own input validation (`action/validate.sh`).
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { StorageProfile } from '../storage/profiles'
import {
  GithubCheckError,
  PLATFORM_STORAGE,
  checkGithubRepo,
  costCapProblem,
  ACTION_COST_CAP,
  defaultCostCap,
  mirrorRepoInput,
  suggestedRunnerBudget,
  dfk1,
  latestCommit,
  mirrorDescription,
  mirrorStorageOf,
  newSecretUrl,
  newWorkflowUrl,
  parseGithubRepo,
  suggestForgeName,
  workflowSecrets,
  workflowYaml,
  type UsableMirrorStorage,
  type WorkflowOptions,
} from './wizard'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const SHA = 'a'.repeat(40)

describe('parseGithubRepo', () => {
  it('reads owner/name, URLs and clone addresses', () => {
    for (const input of [
      'dashpay/dash',
      ' dashpay/dash ',
      'github.com/dashpay/dash',
      'https://github.com/dashpay/dash',
      'https://www.github.com/dashpay/dash/',
      'https://github.com/dashpay/dash.git',
      'https://github.com/dashpay/dash/tree/master/src',
      'https://github.com/dashpay/dash?tab=readme',
      'git@github.com:dashpay/dash.git',
    ]) {
      expect(parseGithubRepo(input), input).toEqual({ owner: 'dashpay', name: 'dash' })
    }
    expect(parseGithubRepo('Some-Org/My.Repo_2')).toEqual({ owner: 'Some-Org', name: 'My.Repo_2' })
  })

  it('refuses what is not a GitHub repository', () => {
    for (const bad of ['', 'dashpay', '/dash', 'dashpay/', 'https://gitlab.com/a/b', '-bad/x', 'a/b c', 'a/..', 'a/.', `a/${'x'.repeat(101)}`]) {
      expect(() => parseGithubRepo(bad), bad).toThrow(/owner\/name/)
    }
  })
})

/** A fake `fetch` answering one request. */
function answer(status: number, body: unknown, headers: Record<string, string> = {}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const f = (async (url: string) => {
    urls.push(url)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
  }) as unknown as typeof fetch
  return { fetch: f, urls }
}

describe('checkGithubRepo', () => {
  it('reads a public repository, following a rename to its current name', async () => {
    const { fetch, urls } = answer(200, {
      full_name: 'NewOwner/renamed',
      private: false,
      visibility: 'public',
      description: 'A thing',
      default_branch: 'master',
      size: 1234,
      archived: false,
      fork: true,
      html_url: 'https://github.com/NewOwner/renamed',
    })
    const repo = await checkGithubRepo({ owner: 'old', name: 'name' }, fetch)
    expect(urls).toEqual(['https://api.github.com/repos/old/name'])
    expect(repo).toEqual({
      owner: 'NewOwner',
      name: 'renamed',
      description: 'A thing',
      defaultBranch: 'master',
      sizeKib: 1234,
      archived: false,
      fork: true,
      htmlUrl: 'https://github.com/NewOwner/renamed',
    })
  })

  it('treats null fields as empty', async () => {
    const { fetch } = answer(200, { full_name: 'a/b', private: false, description: null, default_branch: null })
    const repo = await checkGithubRepo({ owner: 'a', name: 'b' }, fetch)
    expect(repo.description).toBe('')
    expect(repo.defaultBranch).toBe('main')
  })

  it('says a 404 may be private, and refuses a repository marked private', async () => {
    await expect(checkGithubRepo({ owner: 'a', name: 'b' }, answer(404, { message: 'Not Found' }).fetch)).rejects.toMatchObject({ kind: 'not-found', message: /not found, or it is private/ })
    await expect(checkGithubRepo({ owner: 'a', name: 'b' }, answer(200, { full_name: 'a/b', private: true }).fetch)).rejects.toMatchObject({ kind: 'private' })
    await expect(checkGithubRepo({ owner: 'a', name: 'b' }, answer(200, { full_name: 'a/b', private: false, visibility: 'internal' }).fetch)).rejects.toMatchObject({ kind: 'private' })
  })

  it('names GitHub’s anonymous rate limit, and other failures', async () => {
    const limited = answer(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' })
    await expect(checkGithubRepo({ owner: 'a', name: 'b' }, limited.fetch)).rejects.toMatchObject({ kind: 'rate-limited', message: /60 anonymous lookups an hour/ })
    await expect(checkGithubRepo({ owner: 'a', name: 'b' }, answer(500, 'oops').fetch)).rejects.toMatchObject({ kind: 'unexpected' })
    const offline = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const e = await checkGithubRepo({ owner: 'a', name: 'b' }, offline).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(GithubCheckError)
    expect(e).toMatchObject({ kind: 'unreachable', message: /Failed to fetch/ })
  })
})

describe('latestCommit', () => {
  it('returns the 40-hex id GitHub sends, and refuses anything else', async () => {
    expect(await latestCommit({ owner: 'o', name: 'r' }, 'master', answer(200, `${SHA}\n`).fetch)).toBe(SHA)
    await expect(latestCommit({ owner: 'o', name: 'r' }, 'master', answer(404, 'no').fetch)).rejects.toThrow(/did not return a commit/)
  })
})

describe('suggestForgeName and mirrorDescription', () => {
  it('lowercases a GitHub name into a Forge name, and gives up on one Forge cannot take', () => {
    expect(suggestForgeName('My.Repo_2')).toBe('my.repo_2')
    expect(suggestForgeName('x'.repeat(80))).toBe('x'.repeat(63))
    expect(suggestForgeName('.github')).toBe('')
  })

  it('writes the description forge-import writes, so the web finds the source', () => {
    expect(mirrorDescription({ owner: 'dashpay', name: 'dash', description: '' })).toBe('Mirror of github.com/dashpay/dash')
    expect(mirrorDescription({ owner: 'dashpay', name: 'dash', description: '  Dash -\n Reinventing  ' })).toBe('Dash - Reinventing (mirror of github.com/dashpay/dash)')
  })

  it('shortens a description that would not fit, never inside a character', () => {
    const d = mirrorDescription({ owner: 'o', name: 'r', description: 'é'.repeat(600) })
    expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(1000)
    expect(d.endsWith('… (mirror of github.com/o/r)')).toBe(true)
    expect(d).not.toContain('�')
  })
})

describe('dfk1', () => {
  it('is the value forge-core parses', () => {
    expect(dfk1('devnet-sakura', ID, 7, 'cWIF')).toBe(`dfk1:devnet-sakura:${ID}:7:cWIF`)
    expect(() => dfk1('devnet/x', ID, 7, 'cWIF')).toThrow()
    expect(() => dfk1('testnet', ID, -1, 'cWIF')).toThrow()
  })
})

const s3 = (over: Partial<Extract<StorageProfile['settings'], { kind: 's3' }>> = {}): StorageProfile => ({
  name: 'r2-main',
  settings: {
    kind: 's3',
    provider: 'r2',
    endpoint: 'https://abc123.r2.cloudflarestorage.com/',
    region: 'auto',
    bucket: 'forge',
    pathStyle: true,
    publicUrl: 'https://packs.example.org/',
    prefix: '/mirrors/',
    ...over,
  },
  secrets: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
})

describe('mirrorStorageOf', () => {
  it('maps an S3 profile field for field, with its two secrets', () => {
    const m = mirrorStorageOf(s3())
    expect(m).toEqual({
      ok: true,
      kind: 's3',
      inputs: [
        ['storage-kind', 's3'],
        ['s3-endpoint', 'https://abc123.r2.cloudflarestorage.com'],
        ['s3-region', 'auto'],
        ['s3-bucket', 'forge'],
        ['s3-public-url', 'https://packs.example.org'],
        ['s3-prefix', 'mirrors'],
      ],
      secrets: [
        { name: 'S3_ACCESS_KEY_ID', what: 'the access key id of r2-main' },
        { name: 'S3_SECRET_ACCESS_KEY', what: 'the secret access key of r2-main' },
      ],
    })
    // Never the secret values themselves.
    expect(JSON.stringify(m)).not.toMatch(/AKID|SECRET"/)
  })

  it('asks for virtual-hosted addressing when the profile does not use path style', () => {
    const m = mirrorStorageOf(s3({ provider: 'aws', pathStyle: false, publicUrl: '', prefix: '' }))
    expect(m.ok && m.inputs).toEqual([
      ['storage-kind', 's3'],
      ['s3-endpoint', 'https://abc123.r2.cloudflarestorage.com'],
      ['s3-region', 'auto'],
      ['s3-bucket', 'forge'],
      ['s3-virtual-hosted', 'true'],
    ])
  })

  it('refuses what a GitHub runner cannot use, saying why', () => {
    const local = mirrorStorageOf(s3({ endpoint: 'http://127.0.0.1:9000', bucket: 'Forge_Byo' }))
    expect(local.ok).toBe(false)
    expect(!local.ok && local.reason).toMatch(/endpoint .* https:\/\/.*; the bucket name "Forge_Byo"/)
    const ipfs = mirrorStorageOf({ name: 'kubo', settings: { kind: 'ipfs-kubo', provider: 'kubo', api: 'http://127.0.0.1:5001', gateway: '', publicGateway: '', pinningEndpoint: '' }, secrets: {} })
    expect(ipfs.ok).toBe(false)
  })

  it('maps the Platform profile to storage-kind platform with no secret', () => {
    expect(mirrorStorageOf({ name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} })).toBe(PLATFORM_STORAGE)
  })
})

const OPTIONS: WorkflowOptions = {
  github: { owner: 'alice', name: 'project' },
  forgeRepo: `dash://${ID}/project`,
  network: 'devnet',
  devnetName: 'sakura',
  storage: mirrorStorageOf(s3()) as UsableMirrorStorage,
  collab: true,
  costCap: '0.1',
  commit: SHA,
}

describe('workflowYaml', () => {
  it('pins the Action, and the build it makes, to one commit and fills in every input', () => {
    const y = workflowYaml(OPTIONS)
    expect(y).toContain(`uses: PastaPastaPasta/dash-forge/action@${SHA}`)
    // The Action builds the binaries from that same commit: no release is published yet.
    expect(y).toContain("install: 'source'")
    expect(y).toContain(`repo: 'dash://${ID}/project'`)
    // Written out though it is the Action's default today, so a later default cannot move it.
    expect(y).toContain("network: 'devnet'")
    expect(y).toContain("devnet-name: 'sakura'")
    expect(y).toContain("sync: 'code,releases,labels,issues,prs'")
    expect(y).toContain("s3-endpoint: 'https://abc123.r2.cloudflarestorage.com'")
    expect(y).toContain("cost-cap: '0.1'")
    expect(y).toContain('DASH_FORGE_KEY: ${{ secrets.DASH_FORGE_KEY }}')
    expect(y).toContain('S3_SECRET_ACCESS_KEY: ${{ secrets.S3_SECRET_ACCESS_KEY }}')
    expect(y).toContain('pull_request_target:')
    // The job never checks out the mirrored repository (pull_request_target stays safe).
    expect(y).not.toContain('actions/checkout')
    // Nothing the job runs can move: its one action is pinned by commit.
    const uses = [...y.matchAll(/uses: (\S+)/g)].map((m) => m[1])
    expect(uses).toEqual([`PastaPastaPasta/dash-forge/action@${SHA}`])
  })

  it('drops the issue and PR triggers when only code is mirrored, and devnet-name off a devnet', () => {
    const y = workflowYaml({ ...OPTIONS, collab: false, network: 'mainnet', devnetName: null, storage: PLATFORM_STORAGE })
    expect(y).toContain("sync: 'code,releases'")
    expect(y).not.toContain('pull_request_target')
    expect(y).not.toContain('issue_comment')
    expect(y).not.toContain('devnet-name')
    expect(y).not.toContain('S3_')
    expect(y).toContain("storage-kind: 'platform'")
  })

  it('refuses a short commit, a bad cap and a nameless devnet', () => {
    expect(() => workflowYaml({ ...OPTIONS, commit: 'abc123' })).toThrow(/40-character/)
    expect(() => workflowYaml({ ...OPTIONS, costCap: '0' })).toThrow(/more than 0/)
    expect(() => workflowYaml({ ...OPTIONS, devnetName: null })).toThrow(/devnet/)
    expect(costCapProblem('1e3')).not.toBeNull()
    expect(costCapProblem('0.05')).toBeNull()
  })

  it('passes the Action’s own input validation', () => {
    // Every `with:` value, fed to action/validate.sh as the Action would.
    const env: Record<string, string> = {
      INPUT_GITHUB_REPO: 'alice/project',
      INPUT_REPLICAS: '1',
      INPUT_DRY_RUN: 'false',
      INPUT_STATE_CACHE: 'true',
      INPUT_VERSION: '0.1.0',
      INPUT_INSTALL: 'true',
    }
    for (const line of workflowYaml(OPTIONS).split('\n')) {
      const m = /^ {10}([a-z0-9-]+): '(.*)'$/.exec(line)
      if (m) env[`INPUT_${m[1]!.toUpperCase().replace(/-/g, '_')}`] = m[2]!
    }
    expect(env['INPUT_REPO']).toBe(`dash://${ID}/project`)
    expect(env['INPUT_INSTALL']).toBe('source')
    const script = resolve(__dirname, '../../../action/validate.sh')
    expect(() => execFileSync('bash', [script], { env: { ...process.env, ...env }, stdio: 'pipe' })).not.toThrow()
  })
})

describe('GitHub links', () => {
  it('opens the new-file page with the workflow filled in, and the secrets page', () => {
    const url = new URL(newWorkflowUrl({ owner: 'alice', name: 'project' }, 'main', 'name: x\n'))
    expect(url.origin + url.pathname).toBe('https://github.com/alice/project/new/main')
    expect(url.searchParams.get('filename')).toBe('.github/workflows/forge-mirror.yml')
    expect(url.searchParams.get('value')).toBe('name: x\n')
    expect(newSecretUrl({ owner: 'alice', name: 'project' })).toBe('https://github.com/alice/project/settings/secrets/actions/new')
  })

  it('lists DASH_FORGE_KEY first, then the storage secrets', () => {
    expect(workflowSecrets(OPTIONS.storage).map((s) => s.name)).toEqual(['DASH_FORGE_KEY', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])
    expect(workflowSecrets(PLATFORM_STORAGE).map((s) => s.name)).toEqual(['DASH_FORGE_KEY'])
  })
})

describe('suggestedRunnerBudget, mirrorRepoInput and branch links', () => {
  it('suggests the default budget, more for Platform storage, at most 10 DASH', () => {
    expect(suggestedRunnerBudget('s3', 500_000, 0.39)).toBe('0.5')
    expect(suggestedRunnerBudget('platform', 20, 0.39)).toBe('0.5')
    expect(suggestedRunnerBudget('platform', 10 * 1024, 0.39)).toBe('10')
    expect(suggestedRunnerBudget('platform', 2 * 1024, 0.39)).toBe('2.3')
  })

  it("gives the mirror GitHub's default branch, and no branch when it is main", () => {
    const repo = { owner: 'o', name: 'r', description: '', defaultBranch: 'master', sizeKib: 1, archived: false, fork: false, htmlUrl: '' }
    expect(mirrorRepoInput(repo, 'r')).toEqual({ name: 'r', description: 'Mirror of github.com/o/r', defaultBranch: 'master' })
    expect(mirrorRepoInput({ ...repo, defaultBranch: 'main' }, 'r')).toEqual({ name: 'r', description: 'Mirror of github.com/o/r' })
  })

  it('keeps the slashes of a branch name in the new-file link', () => {
    expect(new URL(newWorkflowUrl({ owner: 'o', name: 'r' }, 'release/v1', 'x')).pathname).toBe('/o/r/new/release/v1')
  })
})

describe('defaultCostCap', () => {
  it("is 0.1 with your own storage, and grows with the repository on Platform: above the Action's 0.05, for the first run", () => {
    expect(defaultCostCap('s3', 500_000, 0.39)).toBe('0.1')
    expect(defaultCostCap('platform', 20, 0.39)).toBe('0.1')
    // 10 MiB at 0.39 DASH/MiB: 3.9, a third over, plus the documents.
    expect(defaultCostCap('platform', 10 * 1024, 0.39)).toBe('5.32')
    expect(Number(defaultCostCap('s3', 0, 0.39))).toBeGreaterThan(ACTION_COST_CAP)
  })
})
