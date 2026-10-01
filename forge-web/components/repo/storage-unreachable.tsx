'use client'

/**
 * Storage unreachable (`ux-dx-spec.md` §6.3): the refs read fine, but no place this repo
 * stores its packs answered. A card, not a spinner, naming each place tried and why, with
 * Try again and Add a gateway. Members get the reseed command.
 */

import { useState } from 'react'
import Link from 'next/link'
import { CloudOff, RotateCw, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyRow } from '@/components/ui/copy-row'
import { GatewaysField } from '@/components/gateways-field'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { capabilitiesOf } from '@/lib/rules/roles'
import type { RepoAddress } from '@/hooks/use-query-param'
import { repoKey, type RepoRef } from '@/lib/repo'
import {
  describeUnavailable,
  forgetDeadMirrors,
  onlyGatewaysFailed,
  onlyUnfollowed,
  readGatewaysFor,
  type UnavailablePack,
} from '@/lib/view'
import { clearUnreachable } from '@/lib/view/content-checks'

export function StorageUnreachableCard({
  repo,
  addr,
  packs,
  retry,
}: {
  repo: RepoRef
  addr?: RepoAddress
  packs: readonly UnavailablePack[]
  retry: () => void
}): JSX.Element {
  const places = describeUnavailable(packs, readGatewaysFor(repoKey(repo)))
  // Every place that failed is an IPFS gateway: a working gateway is the fix, so the form is
  // open from the start instead of hidden behind a button.
  const gatewaysOnly = onlyGatewaysFailed(places)
  // Every copy is at a private or plain-http address (a push with `--allow-private-uri`):
  // nothing is down, the files are simply not published anywhere a browser may go (QW2-006).
  const privateOnly = onlyUnfollowed(places)
  const [adding, setAdding] = useState(gatewaysOnly)
  const { role } = useViewerRole(repo)
  const slug = addr ? `${addr.owner}/${addr.name}` : repo.name

  return (
    <section
      role="alert"
      aria-labelledby="storage-unreachable-title"
      data-testid="storage-unreachable"
      className="rounded-lg border border-caution/40 bg-caution/5 p-5"
    >
      <div className="flex items-start gap-3">
        <CloudOff className="mt-0.5 h-5 w-5 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="storage-unreachable-title" className="text-prose">
            {privateOnly ? "Code not reachable from a browser" : "Code unavailable right now"}
          </h2>
          <p className="mt-1 text-dense text-anvil-700 dark:text-anvil-200">
            {privateOnly
              ? "This repo stores its files only at addresses a browser can't reach:"
              : "The places this repo stores its files didn't answer:"}
          </p>
          <ul className="mt-1.5 space-y-0.5 font-mono text-[12px] text-anvil-700 dark:text-anvil-200">
            {places.map((p) => (
              <li key={p} className="flex items-center gap-1.5">
                <Server className="h-3 w-3 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
          {privateOnly ? (
            <p data-testid="private-storage-advice" className="mt-2 text-dense text-anvil-700 dark:text-anvil-200">
              This site fetches only public https addresses: a local, private-network or plain-http
              one would have every visitor&apos;s browser call it. The owner can publish the files
              by adding public https or IPFS storage and pushing again.
            </p>
          ) : null}
          {gatewaysOnly ? (
            <p data-testid="gateway-advice" className="mt-2 text-dense text-anvil-700 dark:text-anvil-200">
              This repo is stored on IPFS, and none of the gateways this browser tried could serve it.
              Add a gateway that can reach the owner&apos;s IPFS node below (or in{' '}
              <Link href="/settings/" className="underline underline-offset-2">
                Settings → Your IPFS gateways
              </Link>
              ), then Try again. The owner can fix it for everyone by setting a public gateway on
              their storage profile (<code className="font-mono text-[12px]">--public-gateway</code>).
            </p>
          ) : null}
          <p className="mt-2 text-dense text-anvil-600 dark:text-anvil-300">
            Branches, issues and pull requests are unaffected.
          </p>
          {/* Nothing is fetched from an unfollowed address, so Try again could not change anything. */}
          <div className={privateOnly ? 'hidden' : 'mt-3 flex flex-wrap gap-2'}>
            <Button
              variant="primary"
              onClick={() => {
                forgetDeadMirrors()
                clearUnreachable(repoKey(repo))
                retry()
              }}
            >
              <RotateCw className="h-4 w-4" aria-hidden /> Try again
            </Button>
            {privateOnly ? null : (
              <Button onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
                Add a gateway
              </Button>
            )}
          </div>
          {adding ? (
            <div className="mt-3 max-w-md">
              <GatewaysField />
            </div>
          ) : null}
          {capabilitiesOf(role).canPush ? (
            <div className="mt-4">
              <p className="mb-1 text-dense text-anvil-600 dark:text-anvil-300">Have a clone? This restores it:</p>
              <CopyRow text={`dg reseed ${slug} --from-local`} label="Copy the reseed command" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
