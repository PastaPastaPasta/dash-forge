'use client'

/**
 * The provenance card on a release's page (epic E5): what the release's tag pointed at when the
 * release was first published, who pushed it, whether the tag or the assets changed since, the
 * tag's signature, and whether tags are protected now. Red when the tag moved, was deleted or
 * races, or the assets changed: the code or files under this name are not what was published.
 * Everything is read from the chain (`lib/rules/releaseProvenance.ts`); the signature is checked
 * in the browser against the keys the repository's owner and members publish.
 */

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { Author } from '@/components/author'
import { Time } from '@/components/repo/byline'
import { SignatureBadge } from '@/components/repo/signature-badge'
import { Oid } from '@/components/ui/oid'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { useAsync } from '@/hooks/use-async'
import { useBrowse } from '@/hooks/use-browse'
import { useSdk } from '@/hooks/use-sdk'
import { useTrustView } from '@/hooks/use-trust-view'
import type { SignatureState } from '@/hooks/use-commit-signatures'
import { repoContractIds, repoKey, type RepoRef } from '@/lib/repo'
import type { ReleaseList } from '@/lib/repo/releases'
import { readReleaseProvenance } from '@/lib/repo/release-provenance'
import { readRepoSigners } from '@/lib/repo/signers'
import { matchesProtected, provenanceAltered, type AssetChanges, type ReleaseProvenance } from '@/lib/rules'
import { splitSignedTag, verifyTagSignature } from '@/lib/rules/signature'
import type { RepoHome } from '@/lib/view'
import { plural } from '@/lib/view'
import { cn } from '@/lib/utils'

/** What the tag's tip says about its signature. */
type TagSignature = { readonly kind: 'lightweight' } | { readonly kind: 'unsigned' } | { readonly kind: 'signed'; readonly state: SignatureState } | { readonly kind: 'unknown' }

/** The signature of the annotated tag `oid`, read from the repo's packs once they are browsable. */
function useTagSignature(repo: RepoRef, oid: string | null): TagSignature | null {
  const browse = useBrowse(repo)
  const view = useTrustView()
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const shared = browse.data?.kind === 'ready' ? browse.data.context.reader : null
  const reader = useMemo(() => shared?.forView(view) ?? null, [shared, view])
  const settled = reader === null && (browse.error !== null || (browse.data !== null && browse.data.kind !== 'ready'))
  const [sig, setSig] = useState<{ readonly oid: string; readonly sig: TagSignature } | null>(null)
  useEffect(() => {
    if (oid === null) return
    if (settled) return setSig({ oid, sig: { kind: 'unknown' } })
    if (reader === null || !ready || sdk === null) return
    let live = true
    const set = (s: TagSignature): void => {
      if (live) setSig({ oid, sig: s })
    }
    void (async () => {
      try {
        const obj = await reader.readObject(oid)
        if (obj.type !== 'tag') return set({ kind: 'lightweight' })
        if (splitSignedTag(obj.bytes) === null) return set({ kind: 'unsigned' })
        set({ kind: 'signed', state: 'checking' })
        const signers = await readRepoSigners(sdk, repo, network)
        const v = await verifyTagSignature(obj.bytes, signers)
        set(v === null ? { kind: 'unsigned' } : { kind: 'signed', state: v })
      } catch {
        set({ kind: 'unknown' })
      }
    })()
    return () => {
      live = false
    }
    // `reader` follows the browse state and the view; the repo and network are in its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oid, reader, settled, ready, sdk])
  // A result read for another tip (the tag moved under a reload) is not this tip's.
  return sig !== null && sig.oid === oid ? sig.sig : null
}

function assetSentence(a: AssetChanges): string | null {
  const parts = [
    a.replaced.length > 0 ? `replaced ${a.replaced.join(', ')}` : null,
    a.added.length > 0 ? `added ${a.added.join(', ')}` : null,
    a.removed.length > 0 ? `removed ${a.removed.join(', ')}` : null,
  ].filter((p): p is string => p !== null)
  return parts.length === 0 ? null : `Assets changed since the first publish: ${parts.join('; ')}.`
}

/** The card's headline: what a person installing from this tag needs to know first. */
function headline(p: ReleaseProvenance, tag: string): string {
  switch (p.tag) {
    case 'unchanged':
      return `${tag} points where it did when this release was published.`
    case 'restored':
      return `${tag} was moved after this release was published, then moved back. It points where it did at publish.`
    case 'moved':
      return p.pinnedBy === 'release'
        ? `${tag} no longer points at the commit this release records.`
        : `${tag} was moved after this release was published. It points at different code now.`
    case 'deleted':
      return `${tag} was deleted after this release was published.`
    case 'diverged':
      return `Two pushes race on ${tag}, so it points at no single commit.`
    case 'missing':
      return `No tag named ${tag} was ever pushed, so this release cannot be checked against one.`
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:gap-3">
      <dt className="w-32 shrink-0 text-anvil-500 dark:text-anvil-400">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1">{children}</dd>
    </div>
  )
}

function SignatureRow({ sig }: { sig: TagSignature | null }): JSX.Element | null {
  if (sig === null) return null
  return (
    <Row label="Signature">
      {sig.kind === 'signed' ? (
        <SignatureBadge state={sig.state} subject="tag" />
      ) : (
        <span className="text-anvil-600 dark:text-anvil-300" data-testid="tag-signature-none">
          {sig.kind === 'lightweight'
            ? 'None: a lightweight tag has no signature.'
            : sig.kind === 'unsigned'
              ? 'None: the tag is not signed.'
              : 'Not checked: the tag object could not be read.'}
        </span>
      )}
    </Row>
  )
}

export function ReleaseProvenanceCard({ home, addr, list, tag }: { home: RepoHome; addr: RepoAddress; list: ReleaseList; tag: string }): JSX.Element | null {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const revisions = [...list.current, ...list.previous].filter((r) => r.tagName === tag).map((r) => r.id).join(',')
  const prov = useAsync(() => readReleaseProvenance(sdk!, home.repo, list, tag), [ready, repoKey(home.repo), network, tag, revisions], {
    enabled: ready && sdk !== null,
  })
  const p = prov.data
  const sig = useTagSignature(home.repo, p?.current?.oid ?? null)
  if (prov.error !== null) {
    return (
      <section aria-label="Provenance" className="rounded-lg border border-anvil-200 p-4 text-dense text-anvil-600 dark:border-anvil-750 dark:text-anvil-300">
        The tag&apos;s history could not be read, so this release&apos;s provenance was not checked.
      </section>
    )
  }
  if (p === null) {
    return (
      <section aria-label="Provenance" aria-busy className="rounded-lg border border-anvil-200 p-4 text-dense text-anvil-500 dark:border-anvil-750 dark:text-anvil-400">
        Checking the tag&apos;s history…
      </section>
    )
  }
  const altered = provenanceAltered(p)
  const caution = !altered && (p.tag === 'restored' || p.lateTag)
  const assets = assetSentence(p.assets)
  const tagsProtected = home.config === null ? null : matchesProtected(`refs/tags/${tag}`, home.config.protectedPatterns)
  const moved = p.current !== null && p.baseline !== null && p.current.oid !== p.baseline.oid
  return (
    <section
      aria-label="Provenance"
      data-testid="release-provenance"
      data-state={altered ? 'altered' : caution ? 'caution' : 'intact'}
      className={cn(
        'rounded-lg border p-4',
        altered
          ? 'border-danger/50 bg-danger/5'
          : caution
            ? 'border-caution/40 bg-caution/5'
            : 'border-anvil-200 bg-white dark:border-anvil-750 dark:bg-anvil-900',
      )}
    >
      <h2 className="flex items-center gap-2 text-dense font-semibold">
        {altered ? (
          <ShieldAlert className="h-4 w-4 text-danger-700 dark:text-danger-400" aria-hidden />
        ) : (
          <ShieldCheck className={cn('h-4 w-4', caution ? 'text-caution-700 dark:text-caution-400' : 'text-verify-700 dark:text-verify-400')} aria-hidden />
        )}
        Provenance
      </h2>
      <p
        className={cn('mt-1 text-dense', altered ? 'font-medium text-danger-700 dark:text-danger-400' : 'text-anvil-700 dark:text-anvil-200')}
        data-testid="provenance-headline"
      >
        {headline(p, tag)}
        {assets !== null ? <> {assets}</> : null}
      </p>
      <dl className="mt-2 divide-y divide-anvil-100 text-[13px] dark:divide-anvil-850">
        {p.published !== null ? (
          <Row label="Published">
            by <Author identityId={p.published.by} /> · <Time ms={p.published.at} withDate />
          </Row>
        ) : null}
        {p.baseline !== null ? (
          <Row label={p.pinnedBy === 'release' ? 'Release records' : p.lateTag ? 'Tag first pushed' : 'Tag at publish'}>
            <Oid value={p.baseline.oid} />
            {p.pinnedBy === 'tag' ? (
              <>
                pushed by <Author identityId={p.baseline.by} /> · <Time ms={p.baseline.at} withDate />
                {p.lateTag ? <span className="text-caution-700 dark:text-caution-400">, after the release was published</span> : null}
              </>
            ) : null}
          </Row>
        ) : null}
        {moved && p.current !== null ? (
          <Row label="Tag now">
            <Oid value={p.current.oid} />
            pushed by <Author identityId={p.current.by} /> · <Time ms={p.current.at} withDate />
          </Row>
        ) : null}
        {p.moves.length > 0 ? (
          <Row label={plural(p.moves.length, 'move')}>
            <ol className="w-full space-y-0.5" data-testid="provenance-moves">
              {p.moves.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-1">
                  <Author identityId={m.by} /> {m.to === null ? 'deleted it' : 'moved it to'}
                  {m.to !== null ? <Oid value={m.to} /> : null} · <Time ms={m.at} withDate />
                </li>
              ))}
            </ol>
          </Row>
        ) : null}
        <SignatureRow sig={sig} />
        {tagsProtected !== null ? (
          <Row label="Protection">
            {tagsProtected ? (
              <span>Only maintainers can move this tag.</span>
            ) : (
              <span className="text-caution-700 dark:text-caution-400" data-testid="provenance-unprotected">
                Tags are not protected: any writer can move this one.{' '}
                <Link href={repoHref('/repo/settings', addr)} className="underline hover:text-forge-800 dark:hover:text-forge-400">
                  Branch settings
                </Link>
              </span>
            )}
          </Row>
        ) : null}
      </dl>
    </section>
  )
}
