'use client'

/**
 * The repo's security policy (DESIGN mixed-visibility §4.7, D37): the default branch's
 * `SECURITY.md`, read through the browse reader as the README is. {@link useSecurityPolicy} finds it;
 * the repo header links it ({@link SecurityPolicyLink}), the new-issue form points to it
 * ({@link SecurityHint}), and `/<owner>/<repo>/security` shows it ({@link SecurityPolicyContent}) with
 * the README's Markdown renderer. There is no report form: intake is what the file says.
 *
 * Only a public repo's default branch is read. A repo with no pushed code, no policy, or storage a
 * browser cannot reach shows no link and the "contact a maintainer" hint.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, FileText, ShieldCheck } from 'lucide-react'
import { useAsync } from '@/hooks/use-async'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { useDefaultBranchReader } from '@/components/repo/issue-templates'
import { MarkdownView, type MarkdownRepoContext } from '@/components/markdown-view'
import { CopyLinkButton } from '@/components/ui/copy-link'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoKey } from '@/lib/repo'
import { selectRef, tipOidOf, type RepoHome } from '@/lib/view'
import { trimOldest } from '@/lib/view/pool'
import { sessionCached } from '@/lib/view/session-cache'
import { findSecurityPolicy, readSecurityPolicy, type SecurityPolicyFile } from '@/lib/view/security-policy'
import type { BrowseReader } from '@/lib/browse'

/** What a tip's policy lookup found, kept for the session: a tip's files never change. */
const FOUND_TTL_MS = 10 * 60_000

const foundKey = (home: RepoHome, tip: string): string => `securityPolicy:${repoKey(home.repo)}:${tip}`
/** Lookups that settled this session (a warm page paints with no flash of the old state). */
const settled = new Map<string, SecurityPolicyFile | null>()
const KEEP_SETTLED = 100

/** The lookup already settled under `key` this session, if any. */
function settledLookup(key: string): { readonly file: SecurityPolicyFile | null } | undefined {
  return settled.has(key) ? { file: settled.get(key) ?? null } : undefined
}

/**
 * The policy at `tip`, looked up once per tip and shared by the header, the issue form and the
 * page. A lookup that failed is no policy: the header shows no link, the hint says to contact a
 * maintainer.
 */
function lookUp(home: RepoHome, reader: BrowseReader, tip: string): Promise<{ readonly file: SecurityPolicyFile | null }> {
  const key = foundKey(home, tip)
  return sessionCached(key, FOUND_TTL_MS, () => findSecurityPolicy(reader, tip)).then(
    (file) => {
      settled.set(key, file)
      trimOldest(settled, KEEP_SETTLED)
      return { file }
    },
    () => ({ file: null }),
  )
}

/** Whether `ms` have passed since this mounted (false until then). */
function useAfter(ms: number, enabled: boolean): boolean {
  const [after, setAfter] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const t = setTimeout(() => setAfter(true), ms)
    return () => clearTimeout(t)
  }, [ms, enabled])
  return after
}

/** The header waits this long before reading the policy, so the page's own reads go first. */
const HEADER_DELAY_MS = 1500

/**
 * The security policy on the default branch: the file, or `null` when the repo has none (also for
 * a private repo, an empty one, and a lookup that failed), or `undefined` while it is read.
 * `enabled: false` reads nothing and answers `null`.
 */
export function useSecurityPolicy(home: RepoHome, enabled = true): SecurityPolicyFile | null | undefined {
  // Members-only content is not involved: only a public repo's public files are read.
  const eligible = enabled && home.repo.visibility === 'public'
  const { tip, reader, unavailable } = useDefaultBranchReader(home, eligible)
  const key = tip === null ? '' : foundKey(home, tip)
  const state = useAsync<{ readonly file: SecurityPolicyFile | null }>(
    () => lookUp(home, reader!, tip!),
    [key, reader === null ? 0 : 1],
    { enabled: reader !== null && tip !== null, initial: () => settledLookup(key) },
  )
  // Nothing to find: a private or empty repo, or code no browser can read.
  if (!eligible || tip === null || unavailable) return null
  return state.data === null ? undefined : state.data.file
}

/** "Security policy" in the repo header, when the default branch has one. */
export function SecurityPolicyLink({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element | null {
  // On every repo page, so it waits for the page's own reads instead of competing with them.
  const later = useAfter(HEADER_DELAY_MS, home.repo.visibility === 'public')
  const policy = useSecurityPolicy(home, later)
  if (!policy) return null
  return (
    <Link
      href={repoHref('/repo/security', addr)}
      className="hit-area inline-flex items-center gap-1 rounded bg-anvil-100 px-1.5 py-0.5 text-[11px] text-anvil-600 hover:text-forge-800 dark:bg-anvil-800 dark:text-anvil-300 dark:hover:text-forge-400"
      data-testid="security-policy-link"
    >
      <ShieldCheck className="h-3 w-3" aria-hidden />
      Security policy
    </Link>
  )
}

/**
 * The new-issue form's reminder (DESIGN §10, always shown): issues are public and permanent, so a
 * vulnerability goes by the policy, or to a maintainer privately when the repo has none.
 */
export function SecurityHint({ home, addr, enabled }: { home: RepoHome; addr: RepoAddress; enabled: boolean }): JSX.Element {
  const policy = useSecurityPolicy(home, enabled)
  return (
    <p className="text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="security-hint">
      Issues are public and permanent.
      {policy === undefined ? null : policy === null ? (
        ' Reporting a vulnerability? Contact a maintainer privately.'
      ) : (
        <>
          {' '}
          Reporting a vulnerability?{' '}
          <Link href={repoHref('/repo/security', addr)} className="font-medium text-forge-700 underline underline-offset-2 dark:text-forge-400" data-testid="security-hint-link">
            Read the security policy.
          </Link>
        </>
      )}
    </p>
  )
}

/** The page at `/<owner>/<repo>/security`. */
export function SecurityPolicyContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const selected = selectRef(home.branches, home.tags, home.defaultBranch, '')
  const tipOid = tipOidOf(selected.ref) || null
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-xl">
          <ShieldCheck className="h-5 w-5 text-anvil-500 dark:text-anvil-400" aria-hidden /> Security policy
        </h1>
        <CopyLinkButton repo={addr} target={{ kind: 'security' }} className="ml-auto" />
      </div>
      {home.repo.visibility !== 'public' ? (
        <NoPolicy isPrivate />
      ) : tipOid === null ? (
        <NoPolicy />
      ) : (
        <BrowseBoundary repo={home.repo} addr={addr}>
          {(reader) => <PolicyBody home={home} reader={reader} tipOid={tipOid} branch={selected.name} addr={addr} />}
        </BrowseBoundary>
      )}
    </div>
  )
}

function NoPolicy({ isPrivate = false }: { isPrivate?: boolean }): JSX.Element {
  const title = isPrivate ? 'Security policies are shown for public repos.' : 'This repo has no security policy.'
  return <EmptyState icon={ShieldCheck} title={title} body="To report a vulnerability, contact a maintainer privately." />
}

function PolicyBody({ home, reader, tipOid, branch, addr }: { home: RepoHome; reader: BrowseReader; tipOid: string; branch: string; addr: RepoAddress }): JSX.Element {
  const found = useAsync(() => lookUp(home, reader, tipOid), [tipOid], { initial: () => settledLookup(foundKey(home, tipOid)) })
  const file = found.data?.file ?? null
  const text = useAsync(() => readSecurityPolicy(reader, file!), [file?.oid ?? ''], { enabled: file !== null })
  const slash = file === null ? -1 : file.path.lastIndexOf('/')
  const dir = file === null || slash < 0 ? '' : file.path.slice(0, slash)
  const markdownRepo = useMemo<MarkdownRepoContext>(() => ({ addr, refParam: '', dir, reader, tipOid }), [addr, dir, reader, tipOid])
  if (found.error) return <ErrorState message={found.error} onRetry={found.reload} />
  if (!found.settled) return <LoadingBlock label="Reading the security policy" />
  if (file === null) return <NoPolicy />
  const blobHref = repoHref('/repo/blob', addr, { path: file.path })
  return (
    <section aria-label="Security policy" className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="security-policy">
      <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense font-medium dark:border-anvil-800 dark:bg-anvil-900">
        <FileText className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <span data-testid="security-policy-source">
          From <span className="font-mono">{file.path}</span> on <span className="font-mono">{branch}</span>
        </span>
      </div>
      <div className="px-5 py-4">
        {text.error ? (
          <ErrorState message={text.error} onRetry={text.reload} />
        ) : text.data === null ? (
          <LoadingBlock label="Reading the security policy" />
        ) : text.data.kind === 'text' ? (
          <MarkdownView source={text.data.text} images="auto" repo={markdownRepo} />
        ) : (
          <p className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="security-policy-unshown">
            {text.data.kind === 'tooLarge' ? 'This file is too large to show here.' : 'This file is not text, so it cannot be shown here.'}{' '}
            <Link href={blobHref} className="inline-flex items-center gap-1 font-medium text-forge-700 underline dark:text-forge-400">
              Open it in the code browser <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          </p>
        )}
      </div>
    </section>
  )
}
