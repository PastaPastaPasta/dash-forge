import { ExternalLink } from 'lucide-react'
import { mirrorSourceOfRows } from '@/lib/view/mirror-source'

/**
 * The line an issue or PR list shows when its rows were mirrored from another forge: the
 * import copies what it was asked for (often a recent window), so the list is not the
 * source's whole history. The import records no upstream total, so no count is claimed.
 */
export function MirrorNote({ urls, kind }: { urls: readonly (string | null | undefined)[]; kind: 'issue' | 'pull' }): JSX.Element | null {
  const source = mirrorSourceOfRows(urls, kind)
  if (source === null) return null
  const what = kind === 'issue' ? 'issues' : 'pull requests'
  return (
    <p role="note" className="mb-3 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="mirror-note">
      Mirrored from {source.label}: only the {what} its import copied are here, not the whole history.{' '}
      <a href={source.listUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-forge-700 hover:underline dark:text-forge-400">
        View all on {source.label.split('/')[0]} <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </p>
  )
}
