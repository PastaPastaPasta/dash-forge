'use client'

/**
 * A mirror's claim to its source, in the repo rail (TS-01, CJ-3). The repo description's
 * `Mirror of github.com/o/r` is the owner's own word, so it reads "Says it mirrors" until the
 * viewer checks it with GitHub (`lib/view/mirror-check.ts`): the source's `.dash-forge.json`
 * lists this repo, and the source's default branch points where this mirror's does. The check is
 * optional and runs only when asked; until then nothing here is green. A maintainer of a mirror
 * the source does not list yet sees how to add the file.
 */

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react'
import { Time } from '@/components/repo/byline'
import { Button } from '@/components/ui/button'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { BACKLINK_FILE, backlinkFile } from '@/lib/rules/mirror-backlink'
import { backlinkPageUrl, checkedClaim, checkMirrorClaim, githubRepoOf, newBacklinkUrl, type BacklinkCheck, type HeadCheck, type MirrorCheck } from '@/lib/view/mirror-check'
import { mirrorSourceOfRepo } from '@/lib/view/mirror-source'
import type { RepoHome } from '@/lib/view'
import { cn } from '@/lib/utils'

/** The default branch's commit, when it resolved to one. */
function defaultHead(home: RepoHome): { branch: string; oid: string } | null {
  const branch = home.defaultBranch.replace(/^refs\/heads\//, '')
  const ref = home.branches.find((b) => b.refName === `refs/heads/${branch}`)
  return ref?.state.state === 'resolved' ? { branch, oid: ref.state.oid } : null
}

/** When a ref last moved: the newest signed ref update. */
function lastUpdated(home: RepoHome): number {
  return [...home.branches, ...home.tags].reduce((newest, r) => {
    const at = r.state.state === 'resolved' ? r.state.createdAt : r.state.state === 'diverged' ? Math.max(...r.state.heads.map((h) => h.createdAt)) : 0
    return Math.max(newest, at)
  }, 0)
}

function backlinkLine(c: BacklinkCheck, label: string): { ok: boolean | null; text: string } {
  switch (c.kind) {
    case 'listed':
      return { ok: true, text: `${label} lists this repository as its mirror.` }
    case 'not-listed':
      return { ok: false, text: `${label} lists other mirrors, not this one.` }
    case 'none':
      return { ok: null, text: `${label} lists no Forge mirrors.` }
    case 'failed':
      return { ok: null, text: `Couldn't check the mirror list. ${c.reason}` }
  }
}

function headLine(c: HeadCheck, branch: string): { ok: boolean | null; text: string } {
  switch (c.kind) {
    case 'match':
      return { ok: true, text: `${branch} matches GitHub's default branch at ${c.oid.slice(0, 7)}.` }
    case 'differs':
      return { ok: false, text: `${branch} differs from GitHub's default branch, which is at ${c.upstream.slice(0, 7)}.` }
    case 'empty':
      return { ok: null, text: 'The GitHub repository has no commits.' }
    case 'failed':
      return { ok: null, text: `Couldn't compare ${branch}. ${c.reason}` }
  }
}

function Result({ ok, text, testId }: { ok: boolean | null; text: string; testId: string }): JSX.Element {
  return (
    <li className="flex items-start gap-1.5" data-testid={testId} data-ok={ok === null ? 'unknown' : String(ok)}>
      {ok === true ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verify-700 dark:text-verify-400" aria-hidden />
      ) : ok === false ? (
        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
      ) : (
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-anvil-400" aria-hidden />
      )}
      <span className={cn(ok === true && 'text-verify-700 dark:text-verify-400', ok === false && 'text-caution-700 dark:text-caution-400')}>{text}</span>
    </li>
  )
}

export function MirrorClaim({ home }: { home: RepoHome }): JSX.Element | null {
  // A fork of a mirror carries the mirror's description, not its provenance (QW3-011).
  const source = mirrorSourceOfRepo(home.v2, 'issue')
  const github = source === null ? null : githubRepoOf(source)
  const head = defaultHead(home)
  const repoId = home.repo.repoId
  const { role } = useViewerRole(home.repo)
  const [check, setCheck] = useState<MirrorCheck | null>(null)
  const [pending, setPending] = useState(false)
  // The claim on screen: an answer for another one (the viewer moved on) is dropped.
  const claim = `${source?.label ?? ''}:${repoId}:${head?.branch ?? ''}:${head?.oid ?? ''}`
  const current = useRef(claim)
  current.current = claim

  // A claim already checked this session shows its answer without asking GitHub again.
  useEffect(() => {
    setCheck(null)
    setPending(false)
    if (source === null) return
    let live = true
    void checkedClaim(source, repoId, head)?.then((c) => live && setCheck(c))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `claim` names everything it reads
  }, [claim])

  if (source === null) return null
  const run = (): void => {
    const p = checkMirrorClaim(source, repoId, head)
    if (p === null) return
    const asked = claim
    setPending(true)
    void p.then(
      (c) => {
        if (current.current !== asked) return
        setCheck(c)
        setPending(false)
      },
      () => current.current === asked && setPending(false),
    )
  }
  const vouched = check?.backlink.kind === 'listed'
  const updated = lastUpdated(home)
  const lines = check === null ? [] : [{ ...backlinkLine(check.backlink, source.label), testId: 'mirror-check-backlink' }, ...(check.head !== null && head !== null ? [{ ...headLine(check.head, head.branch), testId: 'mirror-check-head' }] : [])]

  return (
    <div className="mb-2 space-y-1.5 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="mirror-provenance">
      <p>
        {vouched ? 'Mirror of' : 'Says it mirrors'}{' '}
        <a href={`https://${source.label}`} target="_blank" rel="noopener noreferrer" className="hit-area inline-flex items-center gap-0.5 font-medium text-forge-700 hover:underline dark:text-forge-400">
          {source.label} <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
        {updated > 0 ? <> · <Time ms={updated} prefix="last updated " /></> : null}
      </p>
      {github === null ? null : check === null ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button variant="outline" size="sm" onClick={run} loading={pending} data-testid="mirror-check">
            Check with GitHub
          </Button>
          <span className="text-anvil-500 dark:text-anvil-400">Optional. Your browser asks github.com.</span>
        </div>
      ) : (
        <ul className="space-y-1" aria-live="polite" data-testid="mirror-check-result">
          {lines.map((l) => (
            <Result key={l.testId} {...l} />
          ))}
          <li className="text-anvil-500 dark:text-anvil-400">
            Checked with GitHub <Time ms={check.checkedAt} />.
          </li>
        </ul>
      )}
      {github !== null && role === 'maintainer' && !vouched ? (
        <p className="text-anvil-500 dark:text-anvil-400" data-testid="mirror-prove">
          Is this your mirror?{' '}
          {check?.backlink.kind === 'not-listed' ? (
            <>
              <a href={backlinkPageUrl(github)} target="_blank" rel="noopener noreferrer" className="font-medium text-forge-700 underline dark:text-forge-400">
                Add this repository to {BACKLINK_FILE}
              </a>{' '}
              in {source.label}: its id is <code className="break-all font-mono">{repoId}</code>.
            </>
          ) : (
            <>
              <a
                href={newBacklinkUrl(github, home.defaultBranch, backlinkFile([repoId]))}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-forge-700 underline dark:text-forge-400"
              >
                Add {BACKLINK_FILE} to {source.label}
              </a>{' '}
              on its default branch so readers can confirm it.
            </>
          )}
        </p>
      ) : null}
    </div>
  )
}
