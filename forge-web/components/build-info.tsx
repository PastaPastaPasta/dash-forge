'use client'

/**
 * "About this build", in the footer: the commit, the CID when served from IPFS, and how to check
 * both (lib/build-info.ts). The CID comes from the URL, so it is read after mount: the page was
 * prerendered without one.
 */

import { useEffect, useState } from 'react'

import { BUILD_COMMIT, commitUrl, servedCid, shortCid, verifyGuideUrl } from '@/lib/build-info'

const LINK = 'hit-area underline decoration-dotted underline-offset-2 hover:text-anvil-800 dark:hover:text-anvil-100'

export function BuildInfo(): JSX.Element {
  const [cid, setCid] = useState<string | null>(null)
  useEffect(() => setCid(servedCid(window.location)), [])
  const commit = commitUrl()
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="build-info">
      <span>About this build:</span>
      {commit ? (
        <a href={commit} className={`${LINK} font-mono`} title={BUILD_COMMIT} rel="noreferrer">
          {BUILD_COMMIT.slice(0, 12)}
        </a>
      ) : (
        <span className="font-mono">unknown commit</span>
      )}
      {cid && (
        <>
          <span aria-hidden="true">·</span>
          <span>
            IPFS{' '}
            <span className="font-mono" title={cid} data-testid="build-cid">
              {shortCid(cid)}
            </span>
          </span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <a href={verifyGuideUrl()} className={LINK} rel="noreferrer">
        Verify this build
      </a>
    </p>
  )
}
