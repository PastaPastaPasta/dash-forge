'use client'

/**
 * RepoRail — the 296px right rail (style guide layout): the assay/trust panel, the clone box,
 * and repo metadata (default branch, branches/tags, storage source). The trust panel is the
 * ever-present signature element on every repo view.
 */

import { GitBranch, Star, Tag } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import type { Source } from '@/components/ui/verification-chip'
import { TrustPanel, type TrustChain } from '@/components/ui/trust-panel'
import { CloneBox } from '@/components/repo/clone-box'
import type { RepoAddress } from '@/hooks/use-query-param'

function sourceOf(kind: string): Source {
  if (kind === 'ipfs' || kind === 's3' || kind === 'https') return kind
  return 'platform'
}

export function RepoRail({
  home,
  addr,
  chainOverride,
}: {
  home: RepoHome
  addr: RepoAddress
  /** A page (blob/commit) can supply concrete tip/pack serials for the assay. */
  chainOverride?: Partial<TrustChain>
}): JSX.Element {
  const defaultTip = home.branches.find((b) => b.refName === `refs/heads/${home.defaultBranch}`)
  const tipOid = defaultTip?.state.state === 'resolved' ? defaultTip.state.oid : undefined

  const chain: TrustChain = {
    refs: 'verified',
    packs: 'verified',
    source: sourceOf(home.backend.kind),
    contractId: home.repo.contractId,
    tipOid,
    ...chainOverride,
  }

  return (
    <aside className="space-y-4">
      <TrustPanel chain={chain} />
      <CloneBox home={home} addr={addr} />

      <div className="rounded-lg border border-anvil-200 bg-white p-3 text-dense dark:border-anvil-750 dark:bg-anvil-900">
        <h3 className="mb-2 text-[12px] uppercase tracking-wide text-anvil-400">About</h3>
        {home.config?.defaultBranch ? (
          <Row icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />} label="Default branch">
            <span className="font-mono">{home.defaultBranch}</span>
          </Row>
        ) : null}
        <Row icon={<GitBranch className="h-3.5 w-3.5" aria-hidden />} label="Branches">
          {home.branches.length}
        </Row>
        <Row icon={<Tag className="h-3.5 w-3.5" aria-hidden />} label="Tags">
          {home.tags.length}
        </Row>
        <Row icon={<Star className="h-3.5 w-3.5" aria-hidden />} label="Stars">
          {home.starCount}
        </Row>
      </div>
    </aside>
  )
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center justify-between py-1 text-anvil-600 dark:text-anvil-300">
      <span className="flex items-center gap-1.5 text-anvil-500 dark:text-anvil-400">
        {icon}
        {label}
      </span>
      <span className="font-medium">{children}</span>
    </div>
  )
}
