'use client'

/**
 * RepoRail — the 296px right rail (`ux-dx-spec.md` §5.3): Verification (first), Clone, About,
 * Members, Latest release. On narrow screens it drops under the content, Verification still
 * first.
 *
 * The Verification card's states come from what this session actually checked: the SDK
 * connection's proof mode, the quorum-key cross-check, the folded state of the attested ref,
 * and the browse plane's content-check ledger (which updates live as the page reads objects).
 */

import { Time } from '@/components/repo/byline'
import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { GitBranch, Scale, Star, Tag, Users } from 'lucide-react'
import {
  beginView,
  contentChecks,
  deriveTrust,
  isLive,
  readGatewaysFor,
  NO_CONTENT_CHECKS,
  prefetchDpnsNames,
  refParamFor,
  selectedTip,
  subscribeContentChecks,
  type RepoHome,
  type SelectedRef,
} from '@/lib/view'
import { readMembershipsCached, repoContractIds, repoKey, type RepoRef } from '@/lib/repo'
import type { Membership } from '@/lib/rules/v2'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useQuorumCheck } from '@/hooks/use-quorum-check'
import { useTrustView } from '@/hooks/use-trust-view'
import { useLatestRelease, useViewerRole } from '@/hooks/use-repo-chrome'
import { useInView } from '@/hooks/use-in-view'
import { TrustPanel } from '@/components/ui/trust-panel'
import { BackendBadge } from '@/components/ui/backend-badge'
import { CloneBox } from '@/components/repo/clone-box'
import { LanguageBar, useRepoFacts } from '@/components/repo/repo-facts-card'
import { repoFactsLoading, subscribeRepoFacts, wantRepoFacts } from '@/lib/view/repo-facts'
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
  const { connection, network } = useSdk(repoContractIds(home.repo))
  // Not while Platform is unreachable: a comparison run then only reports that it could not run.
  const quorum = useQuorumCheck(network, connection === 'trusted')
  const { role } = useViewerRole(home.repo)
  const isPrivate = home.repo.visibility === 'private'
  const key = repoKey(home.repo)
  // Each page (a route and its query: another file, ref or tab) is a new view: the summary names
  // the places that served ITS objects (L-18). A layout effect, so it runs before the page's own
  // effects start reading (its reads start the view themselves too, if they come first).
  const view = useTrustView()
  useLayoutEffect(() => beginView(key, view), [key, view])
  const checks = useSyncExternalStore(
    subscribeContentChecks,
    () => contentChecks(key),
    () => NO_CONTENT_CHECKS,
  )

  const report = deriveTrust({
    network,
    connection,
    quorum,
    refName: selected.name,
    tip: selected.pinned ? { pinned: selected.pinned } : selected.ref?.state ?? 'missing',
    checks,
    configuredBackend: home.backend.label,
    configuredUris: home.backend.uris,
    gateways: readGatewaysFor(key),
  })

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
  return (
    <Card title="About">
      {home.description ? <p className="mb-2 text-anvil-700 dark:text-anvil-200">{home.description}</p> : null}
      {home.v2.topics.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Topics" data-testid="repo-topics">
          {home.v2.topics.map((t) => (
            <li key={t} className="rounded-full bg-forge-50 px-2 py-0.5 font-mono text-[11px] text-forge-800 dark:bg-forge-950 dark:text-forge-300">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      <Row icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />} label="Default branch">
        <span className="font-mono">{home.defaultBranch}</span>
      </Row>
      <Row icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />} label="Branches" href={repoHref('/repo/branches', addr)}>
        {home.branches.filter(isLive).length}
      </Row>
      <Row icon={<Tag className="h-3.5 w-3.5" aria-hidden />} label="Tags" href={repoHref('/repo/tags', addr)}>
        {home.tags.filter(isLive).length}
      </Row>
      <Row icon={<Star className="h-3.5 w-3.5" aria-hidden />} label="Stars" href={repoHref('/repo/stargazers', addr)}>
        {home.starCount ?? <span title="Couldn't read the star count from Platform">–</span>}
      </Row>
      <Facts home={home} addr={addr} selected={selected} />
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-anvil-100 pt-2 dark:border-anvil-850">
        <span className="text-anvil-500 dark:text-anvil-400">Storage</span>
        <BackendBadge backend={home.backend} />
      </div>
    </Card>
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

function Members({ repo }: { repo: RepoRef }): JSX.Element {
  const { sdk, ready, network } = useSdk([repo.forge.core, repo.forge.collab])
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
  children,
}: {
  icon: React.ReactNode
  label: string
  href?: string
  testId?: string
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
        className="-mx-1 flex items-center justify-between gap-2 rounded px-1 py-1 text-anvil-600 transition-colors hover:bg-anvil-50 hover:text-forge-800 coarse:min-h-11 dark:text-anvil-300 dark:hover:bg-anvil-850 dark:hover:text-forge-400"
      >
        {body}
      </Link>
    )
  }
  return (
    <div data-testid={testId} className="flex items-center justify-between gap-2 py-1 text-anvil-600 dark:text-anvil-300">
      {body}
    </div>
  )
}
