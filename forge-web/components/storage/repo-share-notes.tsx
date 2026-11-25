'use client'

/**
 * The repo Settings lines about maintainers using the owner's storage
 * (docs/design/identity-synced-state.md §5): collapsed, and nothing when there is nothing to say.
 */

import { Author } from '@/components/author'
import { DOCS } from '@/lib/docs-links'

export function RepoShareNotes({ waiting, memberNeedsKey }: { waiting: readonly string[]; memberNeedsKey: boolean }): JSX.Element | null {
  if (waiting.length > 0) {
    return (
      <details className="mt-3 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="share-waiting">
        <summary className="cursor-pointer coarse:py-2">
          {waiting.length === 1 ? '1 maintainer gets' : `${waiting.length} maintainers get`} access to your storage after signing in with a wallet once
        </summary>
        <ul className="space-y-1 pt-1">
          {waiting.map((m) => (
            <li key={m}>
              <Author identityId={m} />
            </li>
          ))}
        </ul>
      </details>
    )
  }
  if (memberNeedsKey) {
    return (
      <details className="mt-3 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="share-needs-key">
        <summary className="cursor-pointer coarse:py-2">The owner&apos;s storage reaches you after you sign in with your Dash wallet once</summary>
        <p className="pt-1">Until then, your browser pushes here use your own storage settings.</p>
      </details>
    )
  }
  return null
}

export function RotateCredentialsNote(): JSX.Element {
  return (
    <p className="mt-3 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="rotate-credentials">
      They could use your shared storage until now: <a href={DOCS.rotateStorage} className="text-forge-700 underline dark:text-forge-400" target="_blank" rel="noreferrer">rotate those storage keys</a>.
    </p>
  )
}

/** Said once per repo when the owner's reconcile stopped a share of the default storage. */
export function StoppedShareLine({ line }: { readonly line: 'default' | 'removed' }): JSX.Element {
  return (
    <div className="mb-3 text-dense text-anvil-700 dark:text-anvil-200">
      <p data-testid={line === 'default' ? 'stopped-default-share' : 'stopped-share'}>
        {line === 'default' ? "Stopped sharing your default storage with this repo's maintainers. Set storage for this repo to share it." : "Stopped sharing storage with this repo's maintainers."}
      </p>
      <details className="mt-1" data-testid="stopped-share-rotate">
        <summary className="cursor-pointer">The keys they saw</summary>
        <p className="mt-1">
          Maintainers could read the storage keys shared until now.{' '}
          <a href={DOCS.rotateStorage} className="text-forge-700 underline dark:text-forge-400" target="_blank" rel="noreferrer">
            Rotate them
          </a>{' '}
          if that matters to you.
        </p>
      </details>
    </div>
  )
}

/** The owner's details under "Shared with this repo's maintainers.": who has access, who waits, and what removal does. */
export function RepoShareDetails({ granted, waiting }: { granted: readonly string[]; waiting: readonly string[] }): JSX.Element {
  return (
    <details className="mt-3 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="share-details">
      <summary className="cursor-pointer coarse:py-2">Who can use it</summary>
      <div className="space-y-2 pt-1">
        {granted.length > 0 ? (
          <ul className="space-y-1" aria-label="Maintainers with access">
            {granted.map((m) => (
              <li key={m}>
                <Author identityId={m} />
              </li>
            ))}
          </ul>
        ) : (
          <p>No maintainer has access yet.</p>
        )}
        {waiting.length > 0 ? (
          <div>
            <p>Get access after signing in with a wallet once:</p>
            <ul className="space-y-1" aria-label="Maintainers waiting">
              {waiting.map((m) => (
                <li key={m}>
                  <Author identityId={m} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p>
          Removing a maintainer ends their access to it from then on. They could have copied the keys, so{' '}
          <a href={DOCS.rotateStorage} className="text-forge-700 underline dark:text-forge-400" target="_blank" rel="noreferrer">
            rotate them
          </a>{' '}
          after.
        </p>
      </div>
    </details>
  )
}

/** Master's hint on "Your browser pushes": what every network without settings sync shows. */
export const LOCAL_PUSHES_HINT = 'Only you see this: it stays in this browser.'
export const SHARE_ACTION = 'Use separate storage for this repo to share it with maintainers'

/**
 * The "Your browser pushes" card by case: without sync, master's card as it was; the owner with
 * sync and maintainers but no storage of the repo's own gets one action to set it (maintainers get
 * only that); with it, the card says it is shared, details collapsed.
 */
export function storageCardView(p: {
  readonly syncOn: boolean
  readonly owner: boolean
  readonly hasRepoStorage: boolean
  /** The repo's own storage names a place that is not Platform (something to share). */
  readonly repoStorageShareable: boolean
  readonly maintainers: number
  /** Whether the share lends storage as it stands (a kept one too); null before it was reconciled: the policy says. */
  readonly lends?: boolean | null
}): {
  readonly hint: string
  readonly shareAction?: string
  readonly details: boolean
} {
  if (!p.syncOn) return { hint: LOCAL_PUSHES_HINT, details: false }
  const lends = p.lends ?? (p.hasRepoStorage && p.repoStorageShareable)
  if (p.owner && lends && p.maintainers > 0) return { hint: "Shared with this repo's maintainers.", details: true }
  if (p.owner && !p.hasRepoStorage && p.maintainers > 0) return { hint: 'Only you see this.', shareAction: SHARE_ACTION, details: false }
  return { hint: 'Only you see this.', details: false }
}
