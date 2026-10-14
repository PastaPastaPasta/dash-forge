'use client'

/**
 * PublishDialog — "Publish to everyone?" (mixed-visibility DESIGN §10 "The publish dialog"): the
 * last step before a members-only branch's work lands on a public branch. It says what becomes
 * public (the exact list), the secret scan of it, what each method publishes, the co-author
 * opt-in (their emails become public), a warning when the commit message names the members-only
 * branch, and for Publish with history the typed word `publish`. Nothing is signed here: Publish
 * hands the publisher's choices back to the merge box, which runs the merge steps.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Lock } from 'lucide-react'

import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { branchName } from '@/lib/view'
import { peopleText, publishListText, scanLine, type PublishMethod, type PublishScan } from '@/lib/view/publish'

/** The word Publish with history asks for. */
export const PUBLISH_WORD = 'publish'

/** What the dialog shows. */
export interface PublishFacts {
  readonly method: PublishMethod
  /** The public branch it lands on (`refs/heads/main`). */
  readonly base: string
  /** The members-only branch it comes from (`refs/heads/sec/fix`). */
  readonly source: string
  /** How many commits the branch adds, and their authors' names (null while unread). */
  readonly commits: number | null
  /** More commits are published than were counted (a long branch). */
  readonly commitsPartial?: boolean
  /** Publish with history writes a merge commit too (the base moved since the branch began). */
  readonly mergeCommit?: boolean
  readonly authors: readonly string[]
  /** Files the public gains (null while unread); `filesPartial`: more than were counted. */
  readonly files: number | null
  readonly filesPartial?: boolean
  /** The secret scan: null while it runs, a string when it could not run. */
  readonly scan: PublishScan | string | null
  /** Squash: the co-authors (`Name <email>`) the publisher may credit (their emails become public). */
  readonly coAuthors: readonly string[]
  /** The commit message as it would be written: checked for the members-only branch's name. */
  readonly messageNamesBranch: boolean
}

export function PublishDialog({
  open,
  facts,
  onCancel,
  onPublish,
}: {
  open: boolean
  facts: PublishFacts
  onCancel: () => void
  /** Publish, with the co-author lines or without them. */
  onPublish: (choice: { readonly coAuthors: boolean }) => void
}): JSX.Element {
  const [coAuthors, setCoAuthors] = useState(false)
  const [typed, setTyped] = useState('')
  const [anyway, setAnyway] = useState(false)
  // Every opening starts over: nothing is carried from an earlier one.
  useEffect(() => {
    if (!open) return
    setCoAuthors(false)
    setTyped('')
    setAnyway(false)
  }, [open])
  const history = facts.method === 'history'
  const scan = facts.scan
  const scanned = scan !== null && typeof scan !== 'string'
  // A finding the helper would refuse, or a scan that could not run: published only once confirmed.
  const refuses = (scanned && scan.findings.some((f) => f.severity === 'refuse')) || typeof scan === 'string'
  const base = branchName(facts.base)
  const source = branchName(facts.source)
  const list = publishListText(facts.commits, facts.authors, facts.files, facts.filesPartial === true, facts.commitsPartial === true)
  const wordTyped = typed.trim().toLowerCase() === PUBLISH_WORD
  const ready = scan !== null && (!refuses || anyway) && (!history || wordTyped)
  const blockedWhy = scan === null ? 'Checking for secrets…' : refuses && !anyway ? 'Confirm the possible secret first' : history && !wordTyped ? `Type ${PUBLISH_WORD} to continue` : undefined
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Publish to everyone?"
      description="This can't be undone. Anything published stays public forever, even if you delete it later."
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!ready} title={blockedWhy} onClick={() => onPublish({ coAuthors: !history && coAuthors })} data-testid="publish-confirm">
            Publish
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-dense text-anvil-700 dark:text-anvil-200" data-testid="publish-dialog" data-method={facts.method}>
        <p data-testid="publish-list">
          {list === '' ? 'Reading what this publishes…' : list}
          <span className="text-anvil-500 dark:text-anvil-400">
            {' '}
            from <Lock className="inline h-3 w-3 align-[-1px]" aria-label="members-only" /> <span className="font-mono">{source}</span> onto{' '}
            <span className="font-mono">{base}</span>
          </span>
        </p>
        <p
          data-testid="publish-scan"
          className={refuses ? 'rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-caution-800 dark:text-caution-300' : 'text-anvil-600 dark:text-anvil-300'}
        >
          {scan === null ? 'Checking for secrets…' : typeof scan === 'string' ? `Couldn't check for secrets: ${scan}` : scanLine(scan)}
        </p>
        {refuses ? (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-forge-700" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} data-testid="publish-anyway" />
            <span>Publish anyway</span>
          </label>
        ) : null}
        <p data-testid="publish-method">
          {history
            ? `Publish with history: the ${facts.commits === null || facts.commitsPartial === true ? '' : `${facts.commits} `}commits are published as they are${facts.mergeCommit === true ? `, joined to ${base} by a merge commit` : ''}. The last one will be visibly linked to this branch's members-only activity.`
            : `Squash into one commit: one new commit on ${base}; the members-only history stays members-only.`}
        </p>
        {facts.messageNamesBranch ? (
          <p className="flex items-start gap-1.5 text-caution-800 dark:text-caution-300" data-testid="publish-branch-name">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            The commit message names the members-only branch {source}. Everyone will be able to read the name.
          </p>
        ) : null}
        {!history && facts.coAuthors.length > 0 ? (
          <label className="flex items-start gap-2" data-testid="publish-coauthors">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-forge-700" checked={coAuthors} onChange={(e) => setCoAuthors(e.target.checked)} />
            <span>
              Add co-author lines for {peopleText(facts.coAuthors)} (these emails become public)
            </span>
          </label>
        ) : null}
        {history ? (
          <div className="space-y-1">
            <label htmlFor="publish-word" className="block font-medium text-anvil-800 dark:text-anvil-100">
              Type <span className="font-mono">{PUBLISH_WORD}</span> to continue
            </label>
            <Input id="publish-word" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} data-testid="publish-word" />
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
