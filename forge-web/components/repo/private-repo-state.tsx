'use client'

import { Lock } from 'lucide-react'
import { readPublicRepoFacts, repoContractIds, type RepoRef } from '@/lib/repo'
import { formatBytes, timeAgo } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { Author } from '@/components/author'
import { SignInButton } from '@/components/sign-in-button'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/hooks/use-ui-store'
import Link from 'next/link'
import { PRIVATE_REPOS_SETTINGS } from '@/lib/settings-links'
import { UnlockMore } from '@/components/auth/unlock-more'
import { useAuth } from '@/contexts/auth-context'
import type { RepoAddress } from '@/hooks/use-query-param'
import { BuildIntegrityNotice } from '@/components/build-integrity-notice'

/**
 * A private repo seen by a non-member (`ux-dx-spec.md` §6.3): only what is public by design
 * (name, owner, member count, size, last activity). Nothing is decrypted or rendered from
 * encrypted fields, titles included.
 */
export function PrivateRepoState({
  repo,
  addr,
  access,
}: {
  repo: RepoRef
  addr: RepoAddress
  /**
   * Why the contents stay sealed (`usePrivateHome`): not signed in, not a member, no key here,
   * or a member whose tab resumed a signing-only session (`locked`: unlock inline).
   */
  access: 'signed-out' | 'outsider' | 'no-key' | 'locked'
}): JSX.Element {
  const { sdk, ready } = useSdk(repoContractIds(repo))
  const facts = useAsync(() => readPublicRepoFacts(sdk!, repo), [ready, repo.repoId], { enabled: ready && sdk !== null })
  return (
    <section
      aria-label="Private repository"
      data-testid="private-repo"
      className="rounded-lg border border-anvil-200 bg-white p-5 dark:border-anvil-750 dark:bg-anvil-900"
    >
      <div className="mb-3 flex items-center gap-2">
        <Lock className="h-5 w-5 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <h2 className="text-prose font-mono">{repo.name || addr.name}</h2>
      </div>
      {access === 'locked' || access === 'no-key' ? <BuildIntegrityNotice className="mb-3" /> : null}
      {access === 'signed-out' ? (
        <SignedOutNote />
      ) : access === 'locked' ? (
        <UnlockMore title="Unlock to view this private repo" testId="private-unlock" />
      ) : (
        <p className="text-dense text-anvil-700 dark:text-anvil-200">
          {access === 'no-key' ? (
            <>
              Private: contents are encrypted for members. Add your encryption key to this browser in{' '}
              <Link href={PRIVATE_REPOS_SETTINGS} className="text-forge-700 underline dark:text-forge-400">
                Settings → Private repos
              </Link>{' '}
              to read them.
            </>
          ) : (
            "Private: contents are encrypted for members. You're not one."
          )}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-dense">
        <dt className="text-anvil-500 dark:text-anvil-400">Owner</dt>
        <dd>
          <Author identityId={repo.ownerId} />
        </dd>
        <dt className="text-anvil-500 dark:text-anvil-400">Members</dt>
        <dd>{facts.data ? facts.data.members : facts.error ? '–' : '…'}</dd>
        <dt className="text-anvil-500 dark:text-anvil-400">Size</dt>
        <dd>{facts.data ? formatBytes(facts.data.storedBytes) : facts.error ? '–' : '…'}</dd>
        <dt className="text-anvil-500 dark:text-anvil-400">Last activity</dt>
        <dd>{facts.data ? (facts.data.lastActivity ? timeAgo(facts.data.lastActivity) : 'none yet') : facts.error ? '–' : '…'}</dd>
      </dl>
    </section>
  )
}

/**
 * Signed out or locked: membership is not known yet, so nothing is said about it. A member (the
 * owner included) unlocks or signs in to read.
 */
function SignedOutNote(): JSX.Element {
  const { locked, resuming, vaultsLoaded } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  return (
    <div className="space-y-3" data-testid="private-signed-out">
      <p className="text-dense text-anvil-700 dark:text-anvil-200">
        {locked
          ? 'Private: contents are encrypted for members. Your session is locked: unlock to read it if you are one.'
          : 'Private: contents are encrypted for members. Sign in to read it if you are one.'}
      </p>
      {locked || resuming || !vaultsLoaded ? (
        <SignInButton size="sm" />
      ) : (
        // Says why the sheet opened, and has Import keep the encryption key (QW2-016).
        <Button size="sm" variant="primary" data-testid="private-sign-in" onClick={() => openLogin(undefined, undefined, { action: 'read this private repo', privateRepo: true })}>
          Sign in to read it
        </Button>
      )}
    </div>
  )
}
