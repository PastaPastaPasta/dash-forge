'use client'

/** PR comparison: verify base/head commits, compare their trees, and render bounded text patches. */

import { FileDiff, Files } from 'lucide-react'

import type { PullView, RepoRef } from '@/lib/repo'
import {
  loadPullComparison,
  PULL_DIFF_INLINE_FILE_CAP,
  type FileChange,
  type FilePatch,
  type ObjectReader,
} from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { Oid } from '@/components/ui/oid'
import { LoadingBlock } from '@/components/ui/states'
import { cn } from '@/lib/utils'

const STATUS_META: Record<FileChange['status'], { label: string; klass: string }> = {
  added: { label: 'A', klass: 'text-verify' },
  modified: { label: 'M', klass: 'text-caution' },
  deleted: { label: 'D', klass: 'text-danger' },
}

function DiffUnavailable({ message }: { message: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-anvil-200 px-4 py-5 dark:border-anvil-800">
      <div className="flex items-center gap-2 text-dense font-medium">
        <FileDiff className="h-4 w-4 text-anvil-400" aria-hidden />
        Diff unavailable
      </div>
      <p className="mt-1 text-dense text-anvil-500 dark:text-anvil-400">{message}</p>
    </div>
  )
}

function originalDiffUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
    if (!/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)) return null
    url.pathname = `${url.pathname.replace(/\/$/, '')}/files`
    return url.toString()
  } catch {
    return null
  }
}

export function PullDiff({ pull, baseRepo }: { pull: PullView; baseRepo: RepoRef }): JSX.Element {
  if (pull.headOid === '') {
    return <DiffUnavailable message="This PR does not identify a proposed head." />
  }
  const sourceRepo: RepoRef = {
    contractId: pull.sourceContractId || baseRepo.contractId,
    ownerId: pull.author || baseRepo.ownerId,
  }
  const renderBody = (baseReader: ObjectReader, sourceReader: ObjectReader): JSX.Element => (
    <PullDiffBody sourceReader={sourceReader} baseReader={baseReader} pull={pull} />
  )
  return (
    <div data-source-contract={sourceRepo.contractId}>
      <BrowseBoundary repo={baseRepo}>
        {(baseReader) =>
          sourceRepo.contractId === baseRepo.contractId ? (
            renderBody(baseReader, baseReader)
          ) : (
            <BrowseBoundary repo={sourceRepo}>
              {(sourceReader) => renderBody(baseReader, sourceReader)}
            </BrowseBoundary>
          )
        }
      </BrowseBoundary>
    </div>
  )
}

function PullDiffBody({
  sourceReader,
  baseReader,
  pull,
}: {
  sourceReader: ObjectReader
  baseReader: ObjectReader
  pull: PullView
}): JSX.Element {
  const { data, loading, error, reload } = useAsync(
    () => loadPullComparison(sourceReader, baseReader, pull.baseOid, pull.headOid, pull.imported),
    [sourceReader, baseReader, pull.baseOid, pull.headOid, pull.imported],
  )
  if (loading) return <LoadingBlock label="Comparing pull request" />
  if (error) {
    const original = originalDiffUrl(pull.importedUrl)
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-caution/30 bg-caution/5 px-6 py-8 text-center">
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-caution/10 text-caution">
          <FileDiff className="h-5 w-5" aria-hidden />
        </span>
        <h3 className="text-prose text-anvil-900 dark:text-anvil-50">
          {pull.imported ? 'Native diff unavailable' : 'Diff unavailable'}
        </h3>
        <p className="mt-1.5 max-w-md break-words text-dense text-anvil-600 dark:text-anvil-300">
          {pull.imported
            ? `This imported PR does not include enough retained Git history to reconstruct an exact diff (${error}).`
            : `Dash Forge could not reconstruct this diff from the stored Git objects (${error}).`}
        </p>
        <div className="mt-4 flex items-center gap-2">
          {original ? (
            <a
              href={original}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-forge-500 px-3 py-1.5 text-dense font-medium text-white hover:bg-forge-600"
            >
              View original diff
            </a>
          ) : null}
          <button
            onClick={reload}
            className="rounded-md border border-anvil-300 px-3 py-1.5 text-dense hover:bg-anvil-100 dark:border-anvil-700 dark:hover:bg-anvil-800"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
  if (!data) return <LoadingBlock />

  return (
    <section className="space-y-3" aria-labelledby="files-changed-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Files className="h-4 w-4 text-anvil-400" aria-hidden />
          <h2 id="files-changed-heading" className="text-prose font-semibold">Files changed</h2>
          <span className="text-dense text-anvil-500 dark:text-anvil-400">
            {data.changes.length} file{data.changes.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-anvil-400">
          <Oid value={data.comparedBaseOid} chars={7} copyable={false} />
          <span>…</span>
          <Oid value={pull.headOid} chars={7} copyable={false} />
        </div>
      </div>

      {data.comparisonNote ? (
        <p className="rounded-md border border-caution/30 bg-caution/5 px-3 py-2 text-dense text-anvil-600 dark:text-anvil-300">
          {data.comparisonNote}
        </p>
      ) : null}

      {data.changes.length === 0 ? (
        <div className="rounded-lg border border-anvil-200 px-4 py-6 text-center text-dense text-anvil-500 dark:border-anvil-800 dark:text-anvil-400">
          The proposed head has no file changes from the current target tip.
        </div>
      ) : (
        <>
          {data.patches.map((patch) => <FilePatchView key={patch.change.path} patch={patch} />)}
          {data.changes.length > PULL_DIFF_INLINE_FILE_CAP ? (
            <p className="text-dense text-anvil-500 dark:text-anvil-400">
              Showing the first {PULL_DIFF_INLINE_FILE_CAP} of {data.changes.length} changed files.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

function FilePatchView({ patch }: { patch: FilePatch }): JSX.Element {
  const meta = STATUS_META[patch.change.status]
  return (
    <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
      <div className="flex items-center gap-3 border-b border-anvil-200 bg-anvil-50 px-3 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
        <span className={cn('w-4 shrink-0 text-center font-mono font-semibold', meta.klass)} title={patch.change.status}>
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{patch.change.path}</span>
        <Oid value={patch.change.oid} chars={7} copyable={false} />
      </div>
      {patch.lines === null ? (
        <p className="px-4 py-5 text-dense text-anvil-500 dark:text-anvil-400">{patch.note}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[12px] leading-5">
            <tbody>
              {patch.lines.map((line, index) => {
                if (line.kind === 'gap') {
                  return (
                    <tr key={`gap-${index}`} className="bg-dash/5 text-dash">
                      <td colSpan={3} className="px-3 py-0.5">@@</td>
                    </tr>
                  )
                }
                const marker = line.kind === 'added' ? '+' : line.kind === 'deleted' ? '-' : ' '
                return (
                  <tr
                    key={`${line.kind}-${line.oldLine ?? 'n'}-${line.newLine ?? 'n'}-${index}`}
                    className={cn(
                      line.kind === 'added' && 'bg-verify/10',
                      line.kind === 'deleted' && 'bg-danger/10',
                    )}
                  >
                    <td className="w-12 select-none border-r border-anvil-100 px-2 text-right text-anvil-400 dark:border-anvil-850">
                      {line.oldLine ?? ''}
                    </td>
                    <td className="w-12 select-none border-r border-anvil-100 px-2 text-right text-anvil-400 dark:border-anvil-850">
                      {line.newLine ?? ''}
                    </td>
                    <td className="whitespace-pre px-3 text-anvil-800 dark:text-anvil-200">
                      <span className="select-none text-anvil-400">{marker}</span>{line.text || ' '}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
