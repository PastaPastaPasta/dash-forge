'use client'

/**
 * RepoRail — the 296px right rail (style guide layout): the assay/trust panel, the clone box,
 * and repo metadata (default branch, branches/tags, storage source). The trust panel is the
 * ever-present signature element on every repo view.
 *
 * The panel's states are derived from what this session actually checked: whether the SDK
 * connection proof-verifies reads, the folded state of the attested ref, and the browse
 * plane's content-check ledger for this repo (which updates live as the page reads objects).
 */

import { useSyncExternalStore } from 'react'
import Link from 'next/link'
import { GitBranch, Star, Tag } from 'lucide-react'
import {
  connectionTrust,
  contentChecks,
  deriveTrust,
  isLive,
  NO_CONTENT_CHECKS,
  subscribeContentChecks,
  tipOidOf,
  type RepoHome,
  type SelectedRef,
} from '@/lib/view'
import { useSdk } from '@/hooks/use-sdk'
import { TrustPanel } from '@/components/ui/trust-panel'
import { CloneBox } from '@/components/repo/clone-box'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

export function RepoRail({
  home,
  addr,
  selected,
}: {
  home: RepoHome
  addr: RepoAddress
  /** The ref the page is showing — the assay attests its tip. */
  selected: SelectedRef
}): JSX.Element {
  const { ready, trusted, network } = useSdk()
  const contractId = home.repo.contractId
  const checks = useSyncExternalStore(
    subscribeContentChecks,
    () => contentChecks(contractId),
    () => NO_CONTENT_CHECKS,
  )

  const report = deriveTrust({
    network,
    connection: connectionTrust(ready, trusted),
    tip: selected.ref?.state ?? 'missing',
    checks,
    configuredBackend: home.backend.label,
  })

  return (
    <aside className="space-y-4">
      <TrustPanel report={report} contractId={contractId} tipOid={tipOidOf(selected.ref) ?? undefined} />
      <CloneBox home={home} addr={addr} />

      <div className="rounded-lg border border-anvil-200 bg-white p-3 text-dense dark:border-anvil-750 dark:bg-anvil-900">
        <h3 className="mb-2 text-[12px] uppercase tracking-wide text-anvil-400">About</h3>
        {home.config?.defaultBranch ? (
          <Row icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />} label="Default branch">
            <span className="font-mono">{home.defaultBranch}</span>
          </Row>
        ) : null}
        <Row
          icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />}
          label="Branches"
          href={repoHref('/repo/branches', addr)}
        >
          {home.branches.filter(isLive).length}
        </Row>
        <Row
          icon={<Tag className="h-3.5 w-3.5" aria-hidden />}
          label="Tags"
          href={repoHref('/repo/tags', addr)}
        >
          {home.tags.filter(isLive).length}
        </Row>
        <Row
          icon={<Star className="h-3.5 w-3.5" aria-hidden />}
          label="Stars"
          href={repoHref('/repo/stargazers', addr)}
        >
          {home.starCount ?? <span title="Couldn't read the star count from Platform">–</span>}
        </Row>
      </div>
    </aside>
  )
}

function Row({
  icon,
  label,
  href,
  children,
}: {
  icon: React.ReactNode
  label: string
  href?: string
  children: React.ReactNode
}): JSX.Element {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-anvil-500 dark:text-anvil-400">
        {icon}
        {label}
      </span>
      <span className="font-medium">{children}</span>
    </>
  )
  if (href) {
    return (
      <Link
        href={href}
        className="-mx-1 flex items-center justify-between rounded px-1 py-1 text-anvil-600 transition-colors hover:bg-anvil-50 hover:text-forge-600 dark:text-anvil-300 dark:hover:bg-anvil-850 dark:hover:text-forge-400"
      >
        {body}
      </Link>
    )
  }
  return (
    <div className="flex items-center justify-between py-1 text-anvil-600 dark:text-anvil-300">
      {body}
    </div>
  )
}
