'use client'

import { ExternalLink } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { repoContractIds, repoKey } from '@/lib/repo'
import { readMirrorSourceCached, type MirrorKind, type MirrorSource } from '@/lib/view/mirror-source'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'

/** The repo's mirror source (`lib/view/mirror-source`), or null while unknown or not a mirror. */
export function useMirrorSource(home: RepoHome, kind: MirrorKind): MirrorSource | null {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { data } = useAsync(() => readMirrorSourceCached(sdk!, home.repo, home.description, kind, network), [ready, repoKey(home.repo), home.description, kind], {
    enabled: ready && sdk !== null,
  })
  return data ?? null
}

/**
 * The line an issue or PR list of a mirror shows: its rows are what the import copied, and
 * the source's own list holds the full history. The import records no upstream total, so no
 * count is claimed.
 */
export function MirrorNote({ home, kind }: { home: RepoHome; kind: MirrorKind }): JSX.Element | null {
  const source = useMirrorSource(home, kind)
  if (source === null) return null
  return (
    <p role="note" className="mb-3 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="mirror-note">
      Mirrored from {source.label} ·{' '}
      <a href={source.listUrl} target="_blank" rel="noopener noreferrer" className="hit-area inline-flex items-center gap-0.5 text-forge-700 hover:underline dark:text-forge-400">
        view the full history on {source.host} <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </p>
  )
}

/** The New issue form's hint on a mirror: numbers here are this repo's own, not the source's. */
export function MirrorComposeHint({ home }: { home: RepoHome }): JSX.Element | null {
  const source = useMirrorSource(home, 'issue')
  if (source === null) return null
  return (
    <p role="note" className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="mirror-compose-hint">
      This repo mirrors {source.label}. Issues opened here are numbered in this repo&apos;s own sequence; mirrored items show their {source.host} number beside it.
    </p>
  )
}
