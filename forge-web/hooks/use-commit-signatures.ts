'use client'

/**
 * The signed-commit verdicts of the commits a page shows (P1-7): for each commit read with a
 * signature header, `lib/rules/signature.ts` against the repository's candidate signers
 * (`lib/repo/signers.ts`). Unsigned commits get no entry and cost nothing; the signers are read
 * only once a signed commit is on the page. Verdicts are kept per signer set: when the signers are
 * read again (their cache expired, or this browser changed its own keys), every commit is judged
 * again.
 */

import { useEffect, useState } from 'react'
import { readRepoSigners } from '@/lib/repo/signers'
import { repoContractIds, repoKey, type RepoRef } from '@/lib/repo'
import { verifyCommitSignature, type Signer, type SignatureVerdict } from '@/lib/rules/signature'
import { useSdk } from '@/hooks/use-sdk'

/** A row's badge state: its verdict, still checking, or the check could not run. */
export type SignatureState = SignatureVerdict | 'checking' | 'error'

/** What the hook needs of a commit: its id and, when signed, its raw bytes. */
export interface SignableCommit {
  readonly oid: string
  readonly signed?: Uint8Array
}

/** Verdicts per signer set (a set read again is a new array: its verdicts start over). */
const verdicts = new WeakMap<readonly Signer[], Map<string, SignatureVerdict | null>>()

/** `extra`: identities that may have signed besides the repo's owner and members (a PR's author). */
export function useCommitSignatures(repo: RepoRef, commits: readonly SignableCommit[], extra: readonly string[] = []): ReadonlyMap<string, SignatureState> {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const scope = `${network}:${repoKey(repo)}:${extra.join(',')}`
  const signed = commits.filter((c) => c.signed !== undefined)
  const key = signed.map((c) => c.oid).join(',')
  const [states, setStates] = useState<ReadonlyMap<string, SignatureState>>(new Map())

  useEffect(() => {
    if (signed.length === 0) return
    let live = true
    const now = new Map<string, SignatureState>(signed.map((c) => [c.oid, 'checking']))
    setStates(now)
    if (!ready || sdk === null) return
    const publish = (): void => {
      if (live) setStates(new Map(now))
    }
    void (async () => {
      let signers: Signer[]
      try {
        signers = await readRepoSigners(sdk, repo, network, extra)
      } catch {
        for (const c of signed) now.set(c.oid, 'error')
        return publish()
      }
      let known = verdicts.get(signers)
      if (known === undefined) {
        known = new Map()
        verdicts.set(signers, known)
      }
      for (const c of signed) {
        if (!live) return
        let v = known.get(c.oid)
        if (v === undefined) {
          try {
            // A 64-digit id is a SHA-256 repository's: its signature header is `gpgsig-sha256`.
            v = await verifyCommitSignature(c.signed as Uint8Array, signers, c.oid.length === 64)
            known.set(c.oid, v)
          } catch {
            now.set(c.oid, 'error')
            publish()
            continue
          }
        }
        // Only the other hash's signature header: unsigned in this repository, as git reads it.
        if (v === null) now.delete(c.oid)
        else now.set(c.oid, v)
        publish()
      }
    })()
    return () => {
      live = false
    }
    // `signed` is derived from `key`, the repo and `extra` from `scope`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scope, ready, sdk])

  return states
}
