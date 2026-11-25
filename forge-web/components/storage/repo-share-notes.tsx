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
