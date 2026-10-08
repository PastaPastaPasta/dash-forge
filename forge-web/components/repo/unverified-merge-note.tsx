'use client'

/**
 * "This pull request may already be on <base>": the base moved to a commit that makes this pull
 * request's changes except in files the base changed too (Q5-A01), so no "Record merge" is
 * offered; the note gives the `dg` command instead.
 */

import { CopyRow } from '@/components/ui/copy-row'
import { Oid } from '@/components/ui/oid'
import { plural } from '@/lib/view/format'

/**
 * The base tip makes this PR's changes except in files the base changed too. Whether the tip's
 * version of those files holds the PR's change can't be checked here (an unrelated push to the
 * same file looks the same), so no "Record merge" is offered: a recorded merge is final. When the
 * base changed every file the PR changes (`prPaths`, null when the PR's file list is incomplete),
 * none of it is confirmed, and the note says so. `bypass`: the branch rules are not met, so the
 * command carries `--override-policy`, which records a bypass; the note says that too.
 */
export function UnverifiedMergeNote({
  oid,
  base,
  combined,
  prPaths,
  bypass,
  command,
}: {
  oid: string
  base: string
  combined: readonly string[]
  prPaths: readonly string[] | null
  bypass: boolean
  command: string
}): JSX.Element {
  const more = combined.length > 3 ? ` and ${combined.length - 3} more` : ''
  const files = `${plural(combined.length, 'file')} (${combined.slice(0, 3).join(', ')}${more})`
  const none = prPaths !== null && prPaths.length > 0 && prPaths.every((p) => combined.includes(p))
  return (
    <section aria-label="Possible unrecorded merge" className="rounded-lg border border-anvil-300 px-4 py-3 text-dense dark:border-anvil-700" data-testid="unverified-merge-box">
      <p className="font-medium">This pull request may already be on {base}</p>
      <p className="text-anvil-600 dark:text-anvil-300">
        {base} is at <Oid value={oid} chars={7} copyable={false} />.{' '}
        {none ? (
          <>
            None of this pull request&apos;s files can be checked automatically: {base} also changed {combined.length === 1 ? 'it' : 'each of them'} ({combined.slice(0, 3).join(', ')}
            {more}) after the pull request branched off.
          </>
        ) : (
          <>
            It makes this pull request&apos;s changes, except in {files} that {base} also changed after the pull request branched off. Changes on both sides can&apos;t be checked
            automatically.
          </>
        )}{' '}
        If this commit is the merge, record it with:
      </p>
      <CopyRow text={command} label="Copy the command" className="mt-2" />
      {bypass ? (
        <p className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="unverified-merge-bypass">
          The branch rules are not met, so the command includes --override-policy. It records a bypass of the branch rules on the pull request.
        </p>
      ) : null}
    </section>
  )
}
