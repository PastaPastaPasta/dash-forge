'use client'

/**
 * What a repo page says while the repo is being made public (DESIGN §4.10, §10;
 * `lib/repo/conversion-status.ts`):
 *
 * - to anyone, where its code would be: "This repo is being made public. Its code appears here
 *   when that's done." instead of the empty-repo state ({@link BeingMadePublicState});
 * - to its maintainers and owner, once nothing has happened for ten minutes, a banner where the
 *   repo's other banners render: "Making this repo public stalled 3d ago. Finish it", linking to
 *   Settings → Danger zone, where any maintainer finishes it ({@link ConversionStalledBanner}).
 *
 * Only a repo the page's config read found made public reads anything here.
 */

import Link from 'next/link'
import { Globe, Hourglass } from 'lucide-react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { readMembershipsCached, repoContractIds } from '@/lib/repo'
import { FINISH_IT, beingMadePublicText, conversionProgressCached, isStalled, stalledText, type ConversionProgress } from '@/lib/repo/conversion-status'
import { knownConversion } from '@/lib/repo/converted'
import { REPO_DANGER_ANCHOR } from '@/lib/settings-links'
import type { RepoHome } from '@/lib/view'

/** Whether the page's config read found `home`'s repo made public (no read of its own). */
export function madePublic(home: RepoHome): boolean {
  return home.repo.visibility === 'public' && knownConversion(home.repo.repoId) != null
}

/** Where "Finish it" goes: Settings → Danger zone. */
export function finishHref(addr: RepoAddress): string {
  return `${repoHref('/repo/settings', addr)}#${REPO_DANGER_ANCHOR}`
}

/** {@link ConversionProgress} of `home`'s repo, read when `enabled` and it was made public; null until read. */
export function useConversionProgress(home: RepoHome, enabled = true): { readonly progress: ConversionProgress | null; readonly settled: boolean } {
  const { sdk, ready } = useSdk(repoContractIds(home.repo))
  const on = enabled && madePublic(home)
  const read = useAsync(() => conversionProgressCached(sdk!, home.repo), [ready, home.repo.repoId], { enabled: on && ready && sdk !== null })
  return { progress: read.data, settled: !on || read.settled }
}

/** The stalled banner's body (pure): the sentence and the "Finish it" link. */
export function ConversionStalledNote({ lastStepAt, href, now }: { lastStepAt: number; href: string; now?: number }): JSX.Element {
  return (
    <div role="alert" data-testid="conversion-stalled" className="mb-3 flex items-start gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
      <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
      <p className="min-w-0 flex-1">
        {stalledText(lastStepAt, now)}{' '}
        <Link href={href} className="hit-area font-medium text-forge-700 underline dark:text-forge-400" data-testid="conversion-finish">
          {FINISH_IT}
        </Link>
      </p>
    </div>
  )
}

/**
 * "Making this repo public stalled 3d ago. Finish it", to the repo's owner and maintainers when
 * making it public stopped more than ten minutes ago. Nothing for anyone else, nor for a repo
 * never made public (no read).
 */
export function ConversionStalledBanner({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element | null {
  const { identity } = useAuth()
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const converted = madePublic(home) && identity !== null
  const maintains = useAsync(
    async () => identity === home.repo.ownerId || (await readMembershipsCached(sdk!, home.repo, network)).some((m) => m.identity === identity && m.role === 'maintainer'),
    [ready, home.repo.repoId, identity ?? '', network],
    { enabled: converted && ready && sdk !== null },
  )
  const { progress } = useConversionProgress(home, converted && maintains.data === true)
  if (!converted || maintains.data !== true || progress === null || !isStalled(progress) || progress.lastStepAt === null) return null
  return <ConversionStalledNote lastStepAt={progress.lastStepAt} href={finishHref(addr)} />
}

/** Where the code of a repo being made public will be, for everyone (pure). */
export function BeingMadePublicNote(): JSX.Element {
  return (
    <section aria-label="Being made public" data-testid="being-made-public" className="flex items-start gap-3 rounded-lg border border-anvil-200 bg-white p-5 text-dense dark:border-anvil-750 dark:bg-anvil-900">
      <Globe className="mt-0.5 h-5 w-5 shrink-0 text-fg-muted" aria-hidden />
      <p>{beingMadePublicText}</p>
    </section>
  )
}

/**
 * The Code tab of a repo with no branch yet: "being made public" while making it public is
 * unfinished, else `empty` (the empty-repo state). A repo never made public shows `empty` at
 * once, with no read; one made public waits for its progress (`loading`).
 */
export function BeingMadePublicState({ home, empty, loading }: { home: RepoHome; empty: JSX.Element; loading: JSX.Element }): JSX.Element {
  const { progress, settled } = useConversionProgress(home)
  if (!settled) return loading
  return progress?.unfinished === true ? <BeingMadePublicNote /> : empty
}
