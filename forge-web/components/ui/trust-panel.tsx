'use client'

/**
 * The Verification card (`ux-dx-spec.md` §6) — the signature element on every repo view.
 *
 * Collapsed, one line: `Verified · refs by proof · 214 objects checked this session · from r2.dev`.
 * Expanded, four plain sentences, each with its state (icon + word + color, never color
 * alone): chain data, branch tip, file contents, where the bytes came from. Every state comes
 * from {@link deriveTrust} over checks that actually ran this session (roadmap invariant 4),
 * never from what the app intends to check. The footer always states how far to trust the
 * app itself.
 */

import { useEffect, useId, useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { shortOid, timeAgo, type TrustLink, type TrustReport } from '@/lib/view'
import { Author } from '@/components/author'
import { TRUST_META } from './verification-chip'

/** Inline `code` spans for the backticked parts of a sentence (ref names, oids). */
function Sentence({ text }: { text: string }): JSX.Element {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-anvil-800 dark:text-anvil-100">
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

function StateWord({ link }: { link: TrustLink }): JSX.Element {
  const meta = TRUST_META[link.state]
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] font-medium', meta.klass)}>
      {link.checking ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <meta.Icon className="h-3 w-3" aria-hidden />}
      {link.checking ? 'Checking…' : meta.label}
    </span>
  )
}

function Row({ title, link, children }: { title: string; link: TrustLink; children?: React.ReactNode }): JSX.Element {
  return (
    <li className="border-b border-anvil-200 py-2.5 first:pt-0 last:border-b-0 last:pb-0 dark:border-anvil-750">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-dense font-medium text-anvil-800 dark:text-anvil-100">{title}</span>
        <StateWord link={link} />
      </div>
      <p className="mt-0.5 text-[12px] leading-snug text-anvil-600 dark:text-anvil-300">
        {children ?? <Sentence text={link.detail} />}
      </p>
      {link.note ? (
        <p className="mt-1 text-[11px] leading-snug text-anvil-500 dark:text-anvil-400">{link.note}</p>
      ) : null}
    </li>
  )
}

/** The branch-tip sentence, with the signer as an identity pill (DPNS name when known). */
function TipSentence({ report }: { report: TrustReport }): JSX.Element {
  const { tip } = report
  if (tip.heads.length === 0) return <Sentence text={tip.detail} />
  const heads = [...tip.heads].sort((a, b) => b.createdAt - a.createdAt)
  const name = tip.name === '' ? 'This ref' : tip.name
  if (heads.length === 1) {
    const h = heads[0]!
    return (
      <>
        <code className="font-mono text-anvil-800 dark:text-anvil-100">{name}</code> ={' '}
        <code className="font-mono text-anvil-800 dark:text-anvil-100">{shortOid(h.oid)}</code>, the latest signed update by{' '}
        <Author identityId={h.author} link={false} className="align-middle" />, {timeAgo(h.createdAt)}.
      </>
    )
  }
  return (
    <>
      <Sentence text={tip.detail} />
      <span className="mt-1 block space-y-1">
        {heads.map((h) => (
          <span key={`${h.id}${h.oid}`} className="flex flex-wrap items-center gap-1">
            <code className="font-mono text-anvil-800 dark:text-anvil-100">{shortOid(h.oid)}</code> by{' '}
            <Author identityId={h.author} link={false} /> {timeAgo(h.createdAt)}
          </span>
        ))}
      </span>
    </>
  )
}

export function TrustPanel({ report }: { report: TrustReport }): JSX.Element {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const meta = TRUST_META[report.overall]
  const checking = report.chain.checking === true

  return (
    <section
      aria-label="Verification"
      data-testid="verification-card"
      data-state={report.overall}
      className="rounded-lg border border-anvil-200 bg-anvil-50 dark:border-anvil-750 dark:bg-anvil-850"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-anvil-100 dark:hover:bg-anvil-800"
      >
        {checking ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-anvil-500 dark:text-anvil-400" aria-hidden />
        ) : (
          <meta.Icon className={cn('mt-0.5 h-4 w-4 shrink-0', meta.klass)} aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-dense font-medium text-anvil-800 dark:text-anvil-100">Verification</span>
          <span data-testid="verification-summary" className={cn('block text-[12px]', checking ? 'text-anvil-500 dark:text-anvil-400' : meta.klass)}>
            {report.summary}
          </span>
        </span>
        <ChevronRight
          className={cn('mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
      </button>

      {open ? (
        <div id={bodyId} className="animate-fade-in border-t border-anvil-200 px-3 py-3 dark:border-anvil-750">
          <ol className="mb-3">
            <Row title="Chain data" link={report.chain} />
            <Row title="Branch tip" link={report.tip}>
              <TipSentence report={report} />
            </Row>
            <Row title="File contents" link={report.content} />
            <Row title="Where the bytes came from" link={report.source} />
          </ol>
          <p className="rounded border border-anvil-200 bg-white px-2.5 py-2 text-[11px] leading-snug text-anvil-500 dark:border-anvil-750 dark:bg-anvil-900 dark:text-anvil-400">
            <HostingNote />
          </p>
        </div>
      ) : null}
    </section>
  )
}

/**
 * Who served this app's code (L-81): the checks above cover the data, not the code doing the
 * checking. forge.dashhq.org is GitHub Pages behind Cloudflare, which can rewrite the HTML.
 */
function HostingNote(): JSX.Element {
  const [host, setHost] = useState<string | null>(null)
  useEffect(() => setHost(window.location.host), [])
  const who =
    host === 'forge.dashhq.org' ? 'forge.dashhq.org (GitHub Pages, behind Cloudflare)' : host === null ? 'the site you opened' : host
  return (
    <>
      This app&apos;s code comes from {who}, and you trust that host for the code itself. If you don&apos;t, pin the IPFS build or
      use the CLI, which needs no website.
    </>
  )
}
