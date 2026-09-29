'use client'

/**
 * NewPullContent — open a PR from the browser (`ux-dx-spec.md` §1d, §5.7). Nothing is pushed
 * here: the head is a branch that already exists, in this repo or in one of the viewer's forks
 * of it (the `forkOf` index). The base defaults to the repo's default branch, the diff renders
 * before submit, the title comes from the head commit's subject, and the `patch` is numbered
 * by the repo's allocation rule, retrying past a number someone claims meanwhile. A signed-out
 * draft is kept in this tab while the sign-in sheet is open (`lib/view/pr-draft.ts`; a private
 * repo's in page memory only).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { GitBranch } from 'lucide-react'

import { createPatch, findForks, readRefs, repoKey, type ResolvedRef, type RepoRef } from '@/lib/repo'
import { branchName, commitSubject, readCommit, tipOidOf, type DiffSides, type RepoHome } from '@/lib/view'
import { preferring } from '@/lib/view/pull-diff'
import { dropPrDraft, loadPrDraft, savePrDraft } from '@/lib/view/pr-draft'
import { BodyCounter, PrivateComposeNote, SealedLimit, composeCost, composeTooLong, privateComposeBlock } from '@/components/repo/private-compose'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { useIntent } from '@/hooks/use-intent'
import { SupersededWriteError } from '@/lib/sdk'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { ComparisonDiff } from '@/components/repo/pull-diff'
import { MarkdownView } from '@/components/markdown-view'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { CopyRow } from '@/components/ui/copy-row'
import { cn } from '@/lib/utils'

/** A branch a PR can come from: this repo's, or one of the viewer's forks'. */
interface HeadOption {
  readonly key: string
  readonly repo: RepoRef
  readonly refName: string
  readonly oid: string
  readonly label: string
}

const short = branchName

export function NewPullContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const repo = home.repo
  const { sdk, ready } = useSdk()
  const { identity, signer, locked } = useAuth()
  const guard = useWriteGuard()
  const router = useRouter()
  const draftIntent = useIntent()

  const baseParam = useParam('base')
  const headParam = useParam('head')
  const saved = useMemo(() => (typeof window === 'undefined' ? null : loadPrDraft(repo)), [repo])
  const [title, setTitle] = useState(saved?.title ?? '')
  const [titleTouched, setTitleTouched] = useState((saved?.title ?? '') !== '')
  const [body, setBody] = useState(saved?.body ?? '')
  const [preview, setPreview] = useState(false)
  const [base, setBase] = useState(saved?.base || baseParam || `refs/heads/${home.defaultBranch}`)
  const [headKey, setHeadKey] = useState(saved?.head || headParam)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // "Create draft pull request" (review-parity P6): the PR opens as a draft, marked ready later.
  const [asDraft, setAsDraft] = useState(false)

  // Keep the draft for this tab (a sign-in in between must not lose it). Only a title the author
  // typed is kept: one filled in from a head commit belongs to that head, and a draft restored
  // later (another branch, a new push) must take its own head's subject (L-16).
  useEffect(
    () => savePrDraft(repo, { title: titleTouched ? title : '', body, head: headKey, base }),
    [repo, title, titleTouched, body, headKey, base],
  )

  const branches = useMemo(() => home.branches.filter((b) => tipOidOf(b) !== null), [home.branches])
  const forks = useAsync(
    async () => {
      const mine = await findForks(sdk!, repo.forge, repo.repoId, identity!)
      return Promise.all(mine.map(async (f) => ({ fork: f, refs: (await readRefs(sdk!, f)).filter((r) => r.refName.startsWith('refs/heads/')) })))
    },
    [ready, repo.repoId, identity ?? ''],
    // A private repo has no forks (only public repos fork).
    { enabled: ready && sdk !== null && identity !== null && repo.visibility === 'public' },
  )

  const options = useMemo<HeadOption[]>(() => {
    const opt = (r: RepoRef, b: ResolvedRef, label: string): HeadOption | null => {
      const oid = tipOidOf(b)
      return oid === null ? null : { key: `${r.repoId}:${b.refName}`, repo: r, refName: b.refName, oid, label }
    }
    const own = branches.map((b) => opt(repo, b, short(b.refName)))
    const fromForks = (forks.data ?? []).flatMap(({ fork, refs }) => refs.map((b) => opt(fork, b, `${fork.name}: ${short(b.refName)}`)))
    return [...own, ...fromForks].filter((o): o is HeadOption => o !== null)
  }, [branches, forks.data, repo])

  // Default head: the first branch that is not the base.
  const head = options.find((o) => o.key === headKey) ?? options.find((o) => !(o.repo.repoId === repo.repoId && o.refName === base)) ?? null
  const baseRef = branches.find((b) => b.refName === base)
  const baseTip = tipOidOf(baseRef) ?? ''
  // The base must be a branch of this repo now (D-501): a `?base=` link or a kept draft can
  // name one that was never pushed or has been deleted, and a merge into a branch created
  // after the PR never counts.
  const noBase = baseRef === undefined
  const sameBranch = head !== null && head.repo.repoId === repo.repoId && head.refName === base
  const nothing = head !== null && head.oid === baseTip

  // The head commit's subject becomes the title until the author types one (L-16). It is read
  // for the head picked now, through the readers the diff below uses, and again whenever those
  // are replaced (the source repo loaded, or a push reached it). A title filled in for another
  // head is cleared as soon as the head changes, never left behind.
  const [sides, setSides] = useState<{ readonly sides: DiffSides; readonly key: string } | null>(null)
  const onSides = useCallback((s: DiffSides | null, key: string) => setSides(s === null ? null : { sides: s, key }), [])
  const subject = useAsync(
    async () => commitSubject((await readCommit(preferring(sides!.sides.head, sides!.sides.base), head!.oid)).message),
    [head?.key ?? '', head?.oid ?? '', sides?.key ?? ''],
    { enabled: sides !== null && head !== null },
  )
  // Cleared when the head changes; filled once its subject is read. Readers replaced under the
  // same head re-read the subject but never blank the field meanwhile.
  const headId = head === null ? '' : `${head.key}@${head.oid}`
  useEffect(() => {
    if (!titleTouched) setTitle('')
  }, [headId, titleTouched])
  useEffect(() => {
    if (!titleTouched && subject.data) setTitle(subject.data)
  }, [subject.data, titleTouched])

  const input =
    head === null
      ? null
      : { title: title.trim(), body, baseRefName: base, sourceRepoId: head.repo.repoId, sourceRefName: head.refName, headOid: head.oid }
  const cost = composeCost(repo, 'patch', input ?? { title: title.trim(), body })
  const composeBlock = privateComposeBlock(home)
  const tooLong = composeTooLong(repo, 'patch', input ?? { title: title.trim(), body })
  const blocked = input === null || title.trim() === '' || noBase || sameBranch || nothing || composeBlock !== null || tooLong

  const submit = async (): Promise<void> => {
    if (pending || blocked || input === null) return
    if (!guard.check(cost, 'collab')) return
    if (!sdk || !signer) return
    setPending(true)
    setError(null)
    setNote(null)
    try {
      const created = await createPatch(sdk, signer, repo, { ...input, ...(asDraft ? { draft: true } : {}), intent: draftIntent.intent }, (taken, next) =>
        setNote(`Someone claimed #${taken} a moment ago; retrying as #${next}.`),
      )
      dropPrDraft(repo)
      router.push(repoHref('/repo/pull', addr, { number: String(created.number), created: '1' }))
    } catch (e) {
      if (e instanceof SupersededWriteError) {
        // The earlier version of this PR was posted: this draft is done (never post it twice).
        dropPrDraft(repo)
        draftIntent.renew()
        router.push(repoHref('/repo/pulls', addr))
        return
      }
      setError(guard.failed(e))
      setPending(false)
    }
  }

  const you = identity ?? 'you'
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-xl">Open a pull request</h1>
        <p className="mt-1 text-dense text-anvil-600 dark:text-anvil-300">
          Propose merging a branch into {repo.name}. Anyone can open one; maintainers and writers merge.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-anvil-200 p-3 dark:border-anvil-800">
        <Field label="Base" htmlFor="pr-base">
          <select
            id="pr-base"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            className="h-9 min-w-0 max-w-full rounded-md border border-anvil-300 bg-white px-2 font-mono text-dense coarse:h-11 coarse:text-base text-anvil-900 dark:border-anvil-700 dark:bg-anvil-950 dark:text-anvil-100"
          >
            {noBase ? <option value={base}>{short(base)} (not a branch)</option> : null}
            {branches.map((b) => (
              <option key={b.refName} value={b.refName}>
                {short(b.refName)}
              </option>
            ))}
          </select>
        </Field>
        <span className="pb-2 text-anvil-500 dark:text-anvil-400" aria-hidden>
          ←
        </span>
        <Field label="Compare (your branch)" htmlFor="pr-head">
          <select
            id="pr-head"
            value={head?.key ?? ''}
            onChange={(e) => setHeadKey(e.target.value)}
            className="h-9 min-w-0 max-w-full rounded-md border border-anvil-300 bg-white px-2 font-mono text-dense coarse:h-11 coarse:text-base sm:min-w-[14rem] text-anvil-900 dark:border-anvil-700 dark:bg-anvil-950 dark:text-anvil-100"
          >
            {options.length === 0 ? <option value="">No branches yet</option> : null}
            <optgroup label={`${repo.name} (this repo)`}>
              {options
                .filter((o) => o.repo.repoId === repo.repoId)
                .map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
            {(forks.data ?? []).length > 0 ? (
              <optgroup label="Your forks">
                {options
                  .filter((o) => o.repo.repoId !== repo.repoId)
                  .map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </select>
        </Field>
        {forks.loading && identity !== null ? <span className="pb-2 text-[12px] text-anvil-600 dark:text-anvil-400">Looking for your forks…</span> : null}
      </div>

      <div className="text-dense text-anvil-600 dark:text-anvil-300">
        <p className="mb-1.5">
          <GitBranch className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          Need to push a branch first?
        </p>
        <CopyRow text={`git push dash://${you}/${repo.name} HEAD:my-fix`} />
      </div>

      {noBase ? (
        <p role="alert" className="text-dense text-caution-700 dark:text-caution-400">
          {branches.length === 0
            ? `${repo.name} has no branches yet. Push a base branch before opening a pull request.`
            : `${short(base)} is not a branch of ${repo.name}. Pick an existing base branch: a merge into a branch created later never counts.`}
        </p>
      ) : null}
      {sameBranch ? <p className="text-dense text-caution-700 dark:text-caution-400">Pick a branch other than the base to compare.</p> : null}
      {nothing && !sameBranch ? <p className="text-dense text-caution-700 dark:text-caution-400">{short(base)} already points at this commit; there is nothing to merge.</p> : null}

      <div className="space-y-3 rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <Field label="Title" htmlFor="pr-title">
          <Input
            id="pr-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setTitleTouched(true)
            }}
            placeholder="What does this change?"
          />
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="pr-body" className="text-dense font-medium text-anvil-700 dark:text-anvil-200">
              Description
            </label>
            <button
              type="button"
              aria-pressed={preview}
              onClick={() => setPreview((p) => !p)}
              className={cn(
                'rounded-md border border-anvil-200 px-2 py-0.5 text-[12px] font-medium coarse:min-h-11 coarse:px-3 dark:border-anvil-750',
                preview ? 'bg-anvil-200 text-anvil-900 dark:bg-anvil-750 dark:text-anvil-50' : 'text-anvil-600 dark:text-anvil-400',
              )}
            >
              Preview
            </button>
          </div>
          <Textarea id="pr-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Markdown supported." className={cn('min-h-[140px]', preview && 'hidden')} />
          {preview ? (
            <div className="min-h-[140px] rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-800" aria-label="Description preview">
              {body.trim() ? <MarkdownView source={body} /> : <p className="italic text-anvil-600 dark:text-anvil-400">Nothing to preview.</p>}
            </div>
          ) : null}
          <BodyCounter repo={home.repo} text={body} field="description" />
          <SealedLimit repo={home.repo} kind="patch" text={title.trim() + body + (input?.baseRefName ?? '') + (input?.sourceRefName ?? '')} />
        </div>
        {composeBlock !== null ? <PrivateComposeNote reason={composeBlock} /> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CostPreview cost={cost} />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-dense text-anvil-700 dark:text-anvil-200">
              <input type="checkbox" className="h-4 w-4 accent-forge-700" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} />
              Open as a draft
            </label>
            <Button
              variant="primary"
              onClick={submit}
              loading={pending}
              disabled={blocked || guard.disabledReason !== null}
              title={guard.disabledReason ?? undefined}
            >
              {identity ? (asDraft ? 'Create draft pull request' : 'Create pull request') : locked ? 'Unlock to create' : 'Sign in to create'}
            </Button>
          </div>
        </div>
        {note ? <p className="text-dense text-caution-700 dark:text-caution-400">{note}</p> : null}
        {error ? (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400 break-words">
            {error}
          </p>
        ) : null}
      </div>

      {head !== null && !sameBranch && !noBase ? (
        <ComparisonDiff
          key={`${repoKey(repo)}:${base}:${head.key}`}
          baseRepo={repo}
          sourceId={head.repo.repoId}
          spec={{ baseTipOid: baseTip, baseOidAtOpen: baseTip, headOid: head.oid, merged: false, imported: false, importedUrl: '', sourceBaseOid: '' }}
          noHead="Pick a branch to compare."
          onSides={onSides}
        />
      ) : null}
    </div>
  )
}
