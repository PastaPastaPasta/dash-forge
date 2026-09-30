'use client'

/**
 * RepoRail — the 296px right rail (`ux-dx-spec.md` §5.3): Verification (first), Clone, About,
 * Members, Latest release. On narrow screens it drops under the content, Verification still
 * first.
 *
 * The Verification card's states come from what this session actually checked
 * ({@link useRepoTrust}).
 */

import { Time } from '@/components/repo/byline'
import { useEffect, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { ExternalLink, GitBranch, HardDrive, Rocket, Scale, Star, Tag, Users } from 'lucide-react'
import {
  isLive,
  prefetchDpnsNames,
  refParamFor,
  selectedTip,
  type RepoHome,
  type SelectedRef,
} from '@/lib/view'
import { mirrorSourceOfDescription } from '@/lib/view/mirror-source'
import { readMembershipsCached, repoContractIds, repoKey, type RepoRef } from '@/lib/repo'
import type { Membership } from '@/lib/rules/v2'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useLatestRelease, useViewerRole } from '@/hooks/use-repo-chrome'
import { useInView } from '@/hooks/use-in-view'
import { useRepoTrust } from '@/hooks/use-repo-trust'
import { TrustPanel } from '@/components/ui/trust-panel'
import { BackendBadge } from '@/components/ui/backend-badge'
import { CloneBox } from '@/components/repo/clone-box'
import { LanguageBar, useRepoFacts } from '@/components/repo/repo-facts-card'
import { readAboutTotals, repoFactsLoading, repoSizeOf, subscribeRepoFacts, wantRepoFacts, type AboutTotals } from '@/lib/view/repo-facts'
import { peeledCommitOf } from '@/lib/view/tip'
import { Author } from '@/components/author'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

export function RepoRail({
  home,
  addr,
  selected,
}: {
  home: RepoHome
  addr: RepoAddress
  /** The ref the page is showing: the Verification card attests its tip. */
  selected: SelectedRef
}): JSX.Element {
  // Here, not in the page frame: each content check re-renders the rail, not the whole page.
  const report = useRepoTrust(home, selected)
  const { role } = useViewerRole(home.repo)
  const isPrivate = home.repo.visibility === 'private'

  return (
    <aside className="min-w-0 space-y-4" aria-label="About this repository">
      <TrustPanel report={report} />
      {/* A private repo shows a non-member (or a viewer whose role is still loading) nothing
          past the card: no clone box (it would start reading packs), no members, no releases. */}
      {isPrivate && role === null ? null : (
        <>
          <CloneBox home={home} addr={addr} selected={selected} />
          <About home={home} addr={addr} selected={selected} />
          <Members repo={home.repo} />
          <LatestRelease home={home} addr={addr} />
        </>
      )}
    </aside>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-anvil-200 bg-white p-3 text-dense dark:border-anvil-750 dark:bg-anvil-900"
    >
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-anvil-500 dark:text-anvil-400">{title}</h2>
      {children}
    </section>
  )
}

function About({ home, addr, selected }: { home: RepoHome; addr: RepoAddress; selected: SelectedRef }): JSX.Element {
  const [countsRef, countsInView] = useInView<HTMLDivElement>()
  const totals = useAboutTotals(home.repo, countsInView)
  return (
    <Card title="About">
      {home.description ? <p className="mb-2 text-anvil-700 dark:text-anvil-200">{home.description}</p> : null}
      <MirrorProvenance home={home} />
      {home.v2.topics.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Topics" data-testid="repo-topics">
          {home.v2.topics.map((t) => (
            <li key={t} className="rounded-full bg-forge-50 px-2 py-0.5 font-mono text-[11px] text-forge-800 dark:bg-forge-950 dark:text-forge-300">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      <div ref={countsRef}>
        <Row icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />} label="Default branch">
          <span className="font-mono">{home.defaultBranch}</span>
        </Row>
        <Row icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />} label="Branches" href={repoHref('/repo/branches', addr)}>
          {home.branches.filter(isLive).length}
        </Row>
        <Row icon={<Tag className="h-3.5 w-3.5" aria-hidden />} label="Tags" href={repoHref('/repo/tags', addr)}>
          {home.tags.filter(isLive).length}
        </Row>
        {/* A private repo's count is the member's decrypted list's, never the proved sum
            (readAboutTotals); a reader without keys never gets this far. */}
        <Row
          icon={<Rocket className="h-3.5 w-3.5" aria-hidden />}
          label="Releases"
          href={repoHref('/repo/releases', addr)}
          testId="repo-releases"
          busy={totals === null}
        >
          {totals === null ? <ValuePending label="Reading the release count" /> : (totals.releases ?? <ValueUnavailable what="release count" />)}
        </Row>
        <Row icon={<Star className="h-3.5 w-3.5" aria-hidden />} label="Stars" href={repoHref('/repo/stargazers', addr)}>
          {home.starCount ?? <ValueUnavailable what="star count" />}
        </Row>
        <RepoSize totals={totals} />
      </div>
      <Facts home={home} addr={addr} selected={selected} />
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-anvil-100 pt-2 dark:border-anvil-850">
        <span className="text-anvil-500 dark:text-anvil-400">Storage</span>
        <BackendBadge backend={home.backend} />
      </div>
    </Card>
  )
}

/**
 * The About card's release count and repo size ({@link readAboutTotals}: two proved sums), read
 * once the card's rows are in view (S-1) and each kept for a minute, as the releases list is. Null
 * while reading; a failed read shows as a failed row, never as a zero, and is not kept.
 */
function useAboutTotals(repo: RepoRef, wanted: boolean): AboutTotals | null {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  return useAsync<AboutTotals>(
    () => readAboutTotals(sdk!, repo, network),
    [ready, repoKey(repo), network],
    { enabled: wanted && ready && sdk !== null },
  ).data
}

/** The About card's Size row ({@link repoSizeOf}); none for a repo with no packs. */
function RepoSize({ totals }: { totals: AboutTotals | null }): JSX.Element | null {
  let value: JSX.Element
  if (totals === null) value = <ValuePending label="Reading the repo size" />
  else if (totals.gitPacks === null) value = <ValueUnavailable what="repo size" />
  else {
    const size = repoSizeOf(totals.gitPacks)
    if (size === null) return null
    value = (
      <span title={size.tooltip}>
        {size.text}
        <span className="sr-only"> ({size.tooltip})</span>
      </span>
    )
  }
  return (
    <Row icon={<HardDrive className="h-3.5 w-3.5" aria-hidden />} label="Size" testId="repo-size" busy={totals === null}>
      {value}
    </Row>
  )
}

/** A row value Platform couldn't give: a dash, with why in its tooltip. */
function ValueUnavailable({ what }: { what: string }): JSX.Element {
  return <span title={`Couldn't read the ${what} from Platform`}>–</span>
}

/**
 * A row value still being read: a short pulsing bar, with its label as text a screen reader reads
 * in the row (the row is `aria-busy` meanwhile). No live region: inside a link it would only
 * lengthen the link's name, and it is replaced, not updated, when the value comes.
 */
function ValuePending({ label }: { label: string }): JSX.Element {
  return (
    <span className="inline-block h-3 w-8 animate-pulse rounded bg-anvil-100 align-middle dark:bg-anvil-800">
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * The About card's LICENSE row and language bar: worked out once the slot is in view (S-1), with
 * a skeleton for whichever is not known yet.
 */
function Facts({ home, addr, selected }: { home: RepoHome; addr: RepoAddress; selected: SelectedRef }): JSX.Element {
  const key = repoKey(home.repo)
  const tip = selectedTip(selected)
  const { license, languages } = useRepoFacts(key, tip)
  // A placeholder only while the home has a load of these facts registered: a route that works
  // none out (tree, blob, commits), an empty repo or a failed load shows nothing, as before.
  // Keyed by the commit, as the home keys it: a tag's tip is its tag object (L-01).
  const loading = useSyncExternalStore(subscribeRepoFacts, () => repoFactsLoading(key, peeledCommitOf(tip, key)), () => false)
  const [ref, inView] = useInView<HTMLDivElement>()
  useEffect(() => {
    if (inView) wantRepoFacts(key)
  }, [inView, key])
  // The license file at the ref the page shows (a pinned commit stays pinned).
  const refParam = selected.pinned ?? refParamFor(selected.name, selected.isTag, home.defaultBranch)
  const licenseHref = license ? repoHref('/repo/blob', addr, { path: license.file, ...(refParam ? { ref: refParam } : {}) }) : undefined
  return (
    <div ref={ref}>
      {license ? (
        <Row icon={<Scale className="h-3.5 w-3.5" aria-hidden />} label="License" href={licenseHref} testId="repo-license">
          {license.ids.length > 0 ? license.ids.join(' or ') : 'Other'}
        </Row>
      ) : null}
      {languages ? <LanguageBar stats={languages} /> : null}
      {loading && (license === undefined || languages === undefined) ? (
        <Skeleton
          label="Reading the license and languages"
          testId="facts-skeleton"
          bars={[...(license === undefined ? ['h-3.5 w-full'] : []), ...(languages === undefined ? ['h-2 w-full'] : [])]}
        />
      ) : null}
    </div>
  )
}

/**
 * A mirror's source as a link, and when a ref last moved (L-84). The source is what the owner
 * wrote in the repo description when forge-import created it (`mirrorSourceOfDescription`): no
 * read beyond the home's. The time is the newest signed ref update: when the mirror last
 * changed, not when a sync last ran (a sync that found nothing new writes nothing).
 */
function MirrorProvenance({ home }: { home: RepoHome }): JSX.Element | null {
  const source = mirrorSourceOfDescription(home.description, 'issue')
  if (source === null) return null
  const updated = [...home.branches, ...home.tags].reduce((newest, r) => {
    const at = r.state.state === 'resolved' ? r.state.createdAt : r.state.state === 'diverged' ? Math.max(...r.state.heads.map((h) => h.createdAt)) : 0
    return Math.max(newest, at)
  }, 0)
  return (
    <p className="mb-2 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="mirror-provenance">
      Mirror of{' '}
      <a href={`https://${source.label}`} target="_blank" rel="noopener noreferrer" className="hit-area inline-flex items-center gap-0.5 font-medium text-forge-700 hover:underline dark:text-forge-400">
        {source.label} <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
      {updated > 0 ? <> · <Time ms={updated} prefix="last updated " /></> : null}
    </p>
  )
}

function Members({ repo }: { repo: RepoRef }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const members = useAsync<Membership[]>(
    async () => {
      const list = await readMembershipsCached(sdk!, repo, network)
      // Every member's name in one read, before the pills ask one at a time.
      await prefetchDpnsNames(sdk!, list.map((m) => m.identity), network)
      return list
    },
    [ready, repo.repoId, network],
    { enabled: ready && sdk !== null },
  )
  return (
    <Card title="Members">
      {members.error ? (
        <p className="text-anvil-500 dark:text-anvil-400">Couldn&apos;t read the members.</p>
      ) : members.data === null ? (
        <p className="text-anvil-500 dark:text-anvil-400">Reading…</p>
      ) : members.data.length === 0 ? (
        <p className="text-anvil-500 dark:text-anvil-400">No maintainers or writers.</p>
      ) : (
        <ul className="space-y-1.5" data-testid="rail-members">
          {members.data.map((m) => (
            <li key={`${m.role}:${m.identity}`} className="flex items-center justify-between gap-2">
              <Author identityId={m.identity} />
              <span className="text-[11px] uppercase tracking-wide text-anvil-500 dark:text-anvil-400">{m.role}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 flex items-center gap-1 text-[11px] text-anvil-500 dark:text-anvil-400">
        <Users className="h-3 w-3" aria-hidden /> From the repo&apos;s membership documents.
      </p>
    </Card>
  )
}

function LatestRelease({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  // Below the fold on most screens: read once the card is in view (S-1), a skeleton until then.
  const [ref, inView] = useInView<HTMLDivElement>()
  const latest = useLatestRelease(home.repo, inView)
  return (
    <Card title="Latest release">
      <div ref={ref}>
        {latest.error ? (
          <p className="text-anvil-500 dark:text-anvil-400">Couldn&apos;t read the releases.</p>
        ) : !latest.settled ? (
          <Skeleton label="Reading the latest release" testId="latest-release-skeleton" bars={['h-3.5 w-28', 'h-3 w-16']} />
        ) : latest.data === null ? (
          <p className="text-anvil-500 dark:text-anvil-400">No releases yet.</p>
        ) : (
          <Link
            href={repoHref('/repo/release', addr, { tag: latest.data.tagName })}
            className="-mx-1 block rounded px-1 py-1 hover:bg-anvil-50 dark:hover:bg-anvil-850"
          >
            <span className="flex items-center gap-1.5 font-medium text-anvil-800 dark:text-anvil-100">
              <Tag className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
              <span className="font-mono">{latest.data.tagName}</span>
              {latest.data.name ? <span className="truncate font-normal">{latest.data.name}</span> : null}
            </span>
            <span className="text-[12px] text-anvil-500 dark:text-anvil-400">
              {latest.data.published ? <Time ms={latest.data.published.at} dateOnly /> : <Time ms={latest.data.createdAt} />}
            </span>
          </Link>
        )}
      </div>
    </Card>
  )
}

/** A card's placeholder while its data is read: pulsing bars (Tailwind size classes), announced once. */
function Skeleton({ label, testId, bars }: { label: string; testId: string; bars: readonly string[] }): JSX.Element {
  return (
    <div className="space-y-1.5 py-1" role="status" data-testid={testId}>
      <span className="sr-only">{label}</span>
      {bars.map((size, i) => (
        <div key={i} className={`${size} animate-pulse rounded bg-anvil-100 dark:bg-anvil-800`} />
      ))}
    </div>
  )
}

function Row({
  icon,
  label,
  href,
  testId,
  busy,
  children,
}: {
  icon: React.ReactNode
  label: string
  href?: string
  testId?: string
  /** The value is still being read (`aria-busy`). */
  busy?: boolean
  children: React.ReactNode
}): JSX.Element {
  const body = (
    <>
      <span className="flex shrink-0 items-center gap-1.5 text-anvil-500 dark:text-anvil-400">
        {icon}
        {label}
      </span>
      <span className="truncate font-medium">{children}</span>
    </>
  )
  if (href) {
    return (
      <Link
        href={href}
        data-testid={testId}
        aria-busy={busy || undefined}
        className="-mx-1 flex items-center justify-between gap-2 rounded px-1 py-1 text-anvil-600 transition-colors hover:bg-anvil-50 hover:text-forge-800 coarse:min-h-11 dark:text-anvil-300 dark:hover:bg-anvil-850 dark:hover:text-forge-400"
      >
        {body}
      </Link>
    )
  }
  return (
    <div data-testid={testId} aria-busy={busy || undefined} className="flex items-center justify-between gap-2 py-1 text-anvil-600 dark:text-anvil-300">
      {body}
    </div>
  )
}
