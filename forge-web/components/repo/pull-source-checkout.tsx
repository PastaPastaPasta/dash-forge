'use client'

import type { MergeContent } from '@/lib/rules/merge-content'
import { shellWord } from '@/lib/view/repo-commands'
import { readCommit, type ObjectReader } from '@/lib/view/tree-nav'
import { useAsync } from '@/hooks/use-async'
import { CopyRow } from '@/components/ui/copy-row'
import { Oid } from '@/components/ui/oid'

interface PullSourceCheckoutProps {
  readonly deleted: boolean
  readonly sourceMissing: boolean
  readonly checkout: string
  readonly headOid: string
  readonly merge: {
    readonly oid: string
    readonly headOid: string
    readonly baseBranch: string
    readonly onBase: boolean | null | undefined
    readonly content: MergeContent | null
  } | null
  readonly source: {
    readonly ownerId: string
    readonly name: string
    readonly reader: ObjectReader | null
    readonly readerKey: string
  } | null
}

/** Only a verified containing merge puts the original head in the base's history. */
export function PullSourceCheckout({ deleted, sourceMissing, checkout, headOid, merge, source }: PullSourceCheckoutProps): JSX.Element {
  const unavailable = deleted || sourceMissing
  const originalHead = merge?.headOid || headOid
  const verifiedMerge = merge?.onBase === true && merge.oid !== '' ? merge : null
  const contains = verifiedMerge?.content?.verdict === 'contains' && verifiedMerge.headOid !== ''
  const baseOid = verifiedMerge === null ? null : contains ? verifiedMerge.headOid : verifiedMerge.oid
  const fetchOriginal = unavailable && merge !== null && !contains && source?.reader != null && originalHead !== ''
  // Read the source's own reader, never the comparison's fallback to the base. A repo that
  // exists need not still hold the original head; a deleted branch may leave its packs intact.
  const original = useAsync(
    async () => {
      await readCommit(source!.reader!, originalHead)
      return true
    },
    [fetchOriginal, source?.ownerId, source?.name, source?.readerKey, originalHead],
    { enabled: fetchOriginal },
  )
  if (!unavailable) return <CopyRow text={checkout} label="Copy the checkout command" className="mt-2" />
  const verdict = merge?.content?.verdict
  const resultLabel = verdict === 'squash' ? 'The squash commit is ' : verdict === 'rebase' ? 'The rebase commit is ' : 'The recorded merge commit is '
  return (
    <>
      <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="source-branch-deleted-note">
        {deleted ? 'The branch was deleted. ' : 'The source repo is unavailable. '}
        {baseOid !== null ? (
          <>
            {contains ? "The PR's head is " : resultLabel}<Oid value={baseOid} chars={7} copyable={false} />
            {`, in ${verifiedMerge!.baseBranch}'s history:`}
          </>
        ) : (
          <>The PR&apos;s head is <Oid value={originalHead} chars={7} copyable={false} />.</>
        )}
      </p>
      {baseOid !== null ? <CopyRow text={`git switch --detach ${shellWord(baseOid)}`} label="Copy the checkout command" className="mt-2" /> : null}
      {fetchOriginal && source !== null && original.data === true ? (
        <>
          <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">For the PR&apos;s original commits, fetch its head from the source repo:</p>
          <CopyRow
            text={`git fetch ${shellWord(`dash://${source.ownerId}/${source.name}`)} ${shellWord(originalHead)} && git switch --detach ${shellWord(originalHead)}`}
            label="Copy the original commits checkout command"
            className="mt-2"
          />
        </>
      ) : null}
    </>
  )
}
