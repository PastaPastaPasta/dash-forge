'use client'

/**
 * BoardSettings — `/repo/board/settings?b=` (design `docs/design/boards.md` §2, §4, §5.1, §8):
 * a board's definition, edited as a draft and saved as one priced write (`saveBoard`, which
 * re-reads the newest revision and replaces the signer's own).
 *
 * - **General**: name and description.
 * - **Columns** (1-20): add, rename, colour (the label palette), WIP limit, reorder (drag, or the
 *   up / down buttons), delete (its items go to the default column), and the Default and Done
 *   columns.
 * - **Fields** (up to 12): add, rename, delete; a single select's options with colours; an
 *   iteration's start and length, with the next iterations previewed. A field's type is fixed.
 * - **Sources** (up to 5): a repository (the owner's, or any `owner/name`), issues / PRs / both,
 *   and a filter checked as it is typed (what a source cannot apply is named, `parseSourceQuery`).
 * - **Auto-archive**, **Views** (rename, reorder, delete, layout, default query), and closing,
 *   reopening or deleting the board (each its own priced write).
 *
 * The draft is checked as the rules check it (`checkBoardInput`: names, references, the 4096
 * byte limit, with a size meter); a deleted field takes the views' references to it along, so a
 * save never fails on them. A new column, field or option never takes an id any card still names
 * (the page reads the board's cards, `usedIds`): a deleted entry's items never come back. A save
 * over a revision another member wrote since the page read it is refused before signing, so it
 * never silently undoes theirs. Maintainers and members with Write edit; everyone else reads.
 */

import { useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronRight, GripVertical, KanbanSquare, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import {
  LABEL_COLORS,
  boardWriteGeneration,
  canEditBoards,
  boardTextBytes,
  checkBoardInput,
  ownRevision,
  readBoard,
  readBoardDefinition,
  readRepoById,
  repoContractIds,
  repoKey,
  resolveAnyRepo,
  saveBoard,
  setBoardState,
  subscribeBoardWrites,
  type BoardState,
  type BoardView,
  type RepoRef,
} from '@/lib/repo'
import {
  ARCH_MAX,
  DESC_MAX,
  ITER_DAYS_MAX,
  MAX_COLUMNS,
  MAX_FIELDS,
  MAX_OPTIONS,
  MAX_SOURCES,
  MAX_VIEWS,
  NAME_MAX,
  QUERY_MAX,
  SPEC_MAX_BYTES,
  WIP_MAX,
  dateDays,
  iterationAt,
  iterationRange,
  mondayOf,
  parseBoardQuery,
  parseSourceQuery,
  type BoardColumn,
  type BoardField,
  type BoardSource,
  type BoardSpec,
  type FieldOption,
  type FieldType,
  type IterationRange,
  type SourceKind,
  type ViewLayout,
} from '@/lib/rules/boards'
import { priceBoardWrites } from '@/lib/sdk'
import { listReposByOwner } from '@/lib/view/discovery'
import { useAsync } from '@/hooks/use-async'
import { useBoardsDeployed } from '@/hooks/use-board'
import { useSdk } from '@/hooks/use-sdk'
import { useAuth } from '@/contexts/auth-context'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import type { RepoAddress } from '@/hooks/use-query-param'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { useDismiss } from '@/components/repo/target-rail'
import { cn, inputProblem, shortId } from '@/lib/utils'
import { boardHref, boardsHref, controlClass, ColorDot, dayRangeText, columnName } from './board-fields'
import { BoardsUnavailable } from './boards-list'
import {
  IDS_USED_UP,
  NO_USED_IDS,
  clampedInt,
  cleanView,
  entryProblem,
  hasNameProblems,
  moved,
  nameProblem,
  newEntry,
  sameSpec,
  specBytes,
  trimNames,
  usedIds,
  withCleanViews,
  withoutColumn,
  withoutField,
  type UsedIds,
} from './board-settings-model'

type SpecEdit = (f: (s: BoardSpec) => BoardSpec) => void

const FIELD_TYPE_LABEL: Readonly<Record<FieldType, string>> = { sel: 'Single select', num: 'Number', date: 'Date', iter: 'Iteration', text: 'Text' }
const KIND_LABEL: Readonly<Record<SourceKind, string>> = { a: 'Issues and pull requests', i: 'Issues', p: 'Pull requests' }
const LAYOUT_LABEL: Readonly<Record<ViewLayout, string>> = { board: 'Board', table: 'Table', roadmap: 'Roadmap' }
/** What a save over another member's newer revision says (it is refused before signing). */
export const CHANGED_MEANWHILE = 'Someone changed this board while you were editing. Reload and try again.'

export function BoardSettings({ home, addr, boardKey }: { home: RepoHome; addr: RepoAddress; boardKey: number }): JSX.Element {
  const deployed = useBoardsDeployed(home.repo.forge)
  if (deployed === null) return <LoadingBlock label="Reading the board" />
  if (!deployed) return <BoardsUnavailable />
  if (!Number.isInteger(boardKey) || boardKey < 1 || boardKey > 0xffffffff) return <EmptyState icon={KanbanSquare} title="No board addressed" body="Open a board from the repo's Boards tab." />
  return <BoardSettingsLoaded home={home} addr={addr} boardKey={boardKey} />
}

function BoardSettingsLoaded({ home, addr, boardKey }: { home: RepoHome; addr: RepoAddress; boardKey: number }): JSX.Element {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  const { role } = useViewerRole(repo)
  const generation = useSyncExternalStore(subscribeBoardWrites, () => boardWriteGeneration(repo), () => 0)
  // The cards too: a new entry must not take an id one of them still names.
  const read = useAsync(() => readBoard(sdk!, repo, boardKey), [ready, repoKey(repo), network, boardKey, generation], { enabled: ready && sdk !== null })
  const board = read.data?.board ?? null
  const used = useMemo(() => (read.data === null ? NO_USED_IDS : usedIds(read.data.cards.filter((c) => c.unreadable !== true), read.data.board.spec)), [read.data])
  const allBoards = <Link href={boardsHref(addr)} className="text-forge-700 hover:underline dark:text-forge-400">All boards</Link>
  if (read.loading && read.data === null) return <LoadingBlock label="Reading the board" />
  if (read.error) return <ErrorState message={read.error} onRetry={read.reload} />
  if (board === null) return <EmptyState icon={KanbanSquare} title="Board not found" body="No board with this key in this repo." action={allBoards} />
  if (board.state === 'deleted') return <EmptyState icon={KanbanSquare} title="This board was deleted" action={allBoards} />
  if (board.spec === null || board.name === null) {
    return <EmptyState icon={KanbanSquare} title="Can't read this board" body={board.name === null ? 'It is encrypted with the repo’s key, which this browser doesn’t hold.' : 'Its settings are not in a form this version reads.'} />
  }
  const editor = signer !== null && canEditBoards(role) && home.config?.archived !== true
  return (
    <div className="max-w-3xl space-y-5" data-testid="board-settings">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-dense text-anvil-500 dark:text-anvil-400">
        <Link href={boardsHref(addr)} className="hover:text-forge-700 hover:underline dark:hover:text-forge-400">
          Boards
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <Link href={boardHref(addr, board.key)} className="min-w-0 truncate hover:text-forge-700 hover:underline dark:hover:text-forge-400">
          {board.name}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <span className="text-anvil-900 dark:text-anvil-50" aria-current="page">
          Settings
        </span>
      </nav>
      {!editor ? (
        <p role="note" className="rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-dense text-anvil-600 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-300" data-testid="settings-read-only">
          {home.config?.archived === true ? 'This repo is archived, so its boards are read-only.' : signer === null ? 'Sign in as a maintainer or a member with Write to change this board.' : 'Only maintainers and members with Write change a board’s settings.'}
        </p>
      ) : null}
      {/* A new revision (this page's save, or another member's) starts a fresh draft. */}
      <SettingsEditor key={`${board.newest.id}:${board.newest.updatedAt}`} home={home} addr={addr} board={board as BoardView & { spec: BoardSpec; name: string }} used={used} sdk={sdk} editor={editor} reload={read.reload} />
    </div>
  )
}

function Section({ title, hint, children, id }: { title: string; hint?: ReactNode; children: ReactNode; id: string }): JSX.Element {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="text-prose">
          {title}
        </h2>
        {hint ? <p className="mt-0.5 text-[12px] text-anvil-500 dark:text-anvil-400">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

const card = 'rounded-lg border border-anvil-200 dark:border-anvil-800'
const rowClass = 'flex flex-wrap items-center gap-2 border-b border-anvil-100 px-3 py-2 last:border-b-0 dark:border-anvil-850'
const chip = 'rounded bg-anvil-100 px-1.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300'
const iconButton = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-anvil-500 hover:bg-anvil-100 hover:text-anvil-900 disabled:pointer-events-none disabled:opacity-40 dark:text-anvil-400 dark:hover:bg-anvil-800 dark:hover:text-anvil-50 coarse:h-11 coarse:w-11'

function Problem({ text }: { text: string | null }): JSX.Element | null {
  return text === null ? null : (
    <p role="alert" className="w-full text-[12px] text-danger-700 dark:text-danger-400">
      {text}
    </p>
  )
}

/**
 * A whole-number field: typed freely, and clamped to `min`…`max` (or emptied, when `optional`)
 * only when it is left or Enter is pressed, so typing "21" over "14" is never "121" → 90.
 */
function NumberField({ value, min, max, optional = false, onChange, label, placeholder, className, disabled }: { value: number | undefined; min: number; max: number; optional?: boolean; onChange: (n: number | undefined) => void; label: string; placeholder?: string; className?: string; disabled?: boolean }): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const settle = (): void => {
    if (text === null) return
    const n = clampedInt(text, min, max)
    setText(null)
    if (n === null) {
      if (optional && text.trim() === '') onChange(undefined)
      return
    }
    if (n !== value) onChange(n)
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      value={text ?? (value === undefined ? '' : String(value))}
      onChange={(e) => setText(e.target.value)}
      onBlur={settle}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          settle()
        }
      }}
      className={cn(controlClass, 'font-mono tabular-nums', className)}
    />
  )
}

/** Up / down / delete buttons of a list entry. */
function EntryButtons({ index, count, what, onMove, onDelete }: { index: number; count: number; what: string; onMove: (to: number) => void; onDelete?: () => void }): JSX.Element {
  return (
    <span className="ml-auto flex items-center">
      <button type="button" className={iconButton} disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={`Move ${what} up`}>
        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button type="button" className={iconButton} disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label={`Move ${what} down`}>
        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {onDelete !== undefined ? (
        <button type="button" className={cn(iconButton, 'hover:text-danger-700 dark:hover:text-danger-400')} onClick={onDelete} aria-label={`Delete ${what}`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </span>
  )
}

/** A colour from the label palette, or none, in a small popover. */
function ColorPicker({ color, onChange, what }: { color: string | undefined; onChange: (c: string | undefined) => void; what: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  const pick = (c: string | undefined): void => {
    onChange(c)
    setOpen(false)
  }
  return (
    <span ref={ref} className="relative">
      <button type="button" className={cn(iconButton, 'border border-anvil-200 dark:border-anvil-750')} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Colour of ${what}`}>
        <ColorDot color={color} className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <span role="group" aria-label={`Colour of ${what}`} className="absolute left-0 top-8 z-30 grid w-max grid-cols-8 gap-1 rounded-md border border-anvil-200 bg-white p-2 shadow-lg dark:border-anvil-750 dark:bg-anvil-900">
          {LABEL_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} aria-pressed={c === color} onClick={() => pick(c)} className={cn('h-5 w-5 rounded-full ring-offset-1 coarse:h-9 coarse:w-9', c === color && 'ring-2 ring-anvil-900 dark:ring-anvil-50')} style={{ backgroundColor: c }} />
          ))}
          <button type="button" onClick={() => pick(undefined)} aria-pressed={color === undefined} className="col-span-8 mt-1 rounded px-1 py-0.5 text-left text-[12px] text-anvil-600 hover:bg-anvil-100 dark:text-anvil-300 dark:hover:bg-anvil-800">
            No colour
          </button>
        </span>
      ) : null}
    </span>
  )
}

/** Each confirm's words. */
const CONFIRM: Readonly<Record<'save' | BoardState, (name: string) => { title: string; description: string; label: string }>> = {
  save: (name) => ({ title: `Save “${name}”`, description: 'Everyone who opens the board sees the new settings.', label: 'Sign & save' }),
  closed: (name) => ({ title: `Close “${name}”`, description: 'A closed board is read-only and listed under Closed. You can reopen it.', label: 'Sign & close' }),
  open: (name) => ({ title: `Reopen “${name}”`, description: 'Members can move its items and edit it again.', label: 'Sign & reopen' }),
  deleted: (name) => ({ title: `Delete “${name}”`, description: 'The board leaves the list for everyone. Its issues and pull requests are not touched.', label: 'Sign & delete' }),
}

/** The draft editor; `board` is the revision it started from, `used` the ids its cards name. */
function SettingsEditor({ home, addr, board, used, sdk, editor, reload }: { home: RepoHome; addr: RepoAddress; board: BoardView & { spec: BoardSpec; name: string }; used: UsedIds; sdk: EvoSDK | null; editor: boolean; reload: () => void }): JSX.Element {
  const repo = home.repo
  const router = useRouter()
  const { signer } = useAuth()
  const [name, setName] = useState(board.name)
  const [spec, setSpec] = useState<BoardSpec>(board.spec)
  const [action, setAction] = useState<'save' | BoardState | null>(null)
  const [stale, setStale] = useState(false)
  const edit: SpecEdit = setSpec
  const open = board.state === 'open'
  const readOnly = !editor || !open
  // What a save writes: names trimmed, as the board name is.
  const clean = useMemo(() => trimNames(spec), [spec])
  const changed = name.trim() !== board.name || !sameSpec(clean, board.spec)
  // A name's problem shows on its row; the bar names what no row shows.
  const problem = hasNameProblems(clean) ? 'Fix the names marked above to save.' : inputProblem(() => checkBoardInput({ name, spec: clean }))
  const bytes = specBytes(clean)
  const own = signer !== null && ownRevision(board, signer.identityId) !== null
  const cost = priceBoardWrites(own ? 0 : 1, own ? 1 : 0, { type: 'board', sealed: board.sealed, bytes: boardTextBytes({ name, spec: clean }) })

  const run = async (intent: string): Promise<void> => {
    if (sdk === null || signer === null || action === null) throw new Error('Sign in to change this board.')
    // Never save over a revision this draft did not start from: it would undo the other member's change.
    if (action === 'save') {
      const fresh = await readBoardDefinition(sdk, repo, board.key)
      if (fresh === null || fresh.newest.id !== board.newest.id || fresh.newest.updatedAt !== board.newest.updatedAt) {
        setStale(true)
        throw new Error(CHANGED_MEANWHILE)
      }
    }
    if (action === 'save') await saveBoard(sdk, signer, repo, board.key, { name: name.trim(), spec: clean }, { intent })
    else await setBoardState(sdk, signer, repo, board.key, action, { intent })
    if (action === 'deleted') router.push(boardsHref(addr))
    else reload()
  }
  const confirm = CONFIRM[action ?? 'save'](action === 'save' ? name.trim() : board.name)

  return (
    <div className="space-y-6">
      {stale ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400" data-testid="settings-stale">
          <span>{CHANGED_MEANWHILE}</span>
          <Button size="sm" variant="outline" onClick={reload}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reload
          </Button>
        </div>
      ) : null}
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
          <span className="text-anvil-700 dark:text-anvil-200">This board is closed. Reopen it to change it.</span>
          {editor ? (
            <Button size="sm" variant="outline" onClick={() => setAction('open')}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reopen
            </Button>
          ) : null}
        </div>
      ) : null}

      <fieldset disabled={readOnly} className="min-w-0 space-y-8">
        <Section id="board-general" title="General">
          <div className="space-y-3">
            <Field label="Name" htmlFor="board-name">
              <Input id="board-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} />
            </Field>
            <Field label="Description (optional)" htmlFor="board-desc">
              <Textarea
                id="board-desc"
                value={spec.desc ?? ''}
                maxLength={DESC_MAX}
                className="min-h-[72px]"
                onChange={(e) => {
                  const desc = e.target.value
                  edit((s) => ({ ...s, desc: desc === '' ? undefined : desc }))
                }}
              />
            </Field>
          </div>
        </Section>

        <ColumnsSection spec={spec} edit={edit} used={used} />
        <FieldsSection spec={spec} edit={edit} used={used} />
        <SourcesSection spec={spec} edit={edit} repo={repo} sdk={sdk} />

        <Section id="board-archive" title="Auto-archive" hint="Closed and merged items leave the board once they have been closed this long. Show them with is:archived.">
          <label className="flex flex-wrap items-center gap-2 text-dense text-anvil-700 dark:text-anvil-200">
            <input type="checkbox" checked={spec.arch > 0} onChange={(e) => edit((s) => ({ ...s, arch: e.target.checked ? 14 : 0 }))} className="h-4 w-4 accent-forge-700" />
            Archive closed items after
            <NumberField value={spec.arch > 0 ? spec.arch : undefined} min={1} max={ARCH_MAX} label="Days before archiving" disabled={readOnly || spec.arch === 0} onChange={(n) => n !== undefined && edit((s) => ({ ...s, arch: n }))} className="w-20" />
            days
          </label>
        </Section>

        <ViewsSection spec={spec} edit={edit} />
      </fieldset>

      {editor && open ? (
        <div className="sticky bottom-0 z-20 -mx-1 flex flex-wrap items-center gap-3 rounded-lg border border-anvil-200 bg-white/95 px-3 py-2 shadow-sm backdrop-blur dark:border-anvil-800 dark:bg-anvil-950/95" data-testid="settings-save-bar">
          <SizeMeter bytes={bytes} />
          <span className="min-w-0 flex-1 text-[12px]">
            {problem !== null ? (
              <span role="alert" className="text-danger-700 dark:text-danger-400" data-testid="settings-problem">
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                {problem}
              </span>
            ) : changed ? (
              <span className="text-anvil-600 dark:text-anvil-300">Unsaved changes</span>
            ) : null}
          </span>
          {changed ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(board.name)
                setSpec(board.spec)
              }}
            >
              Discard
            </Button>
          ) : null}
          <Button size="sm" variant="primary" disabled={!changed || problem !== null} onClick={() => setAction('save')} data-testid="settings-save">
            Save changes
          </Button>
        </div>
      ) : null}

      {editor ? (
        <Section id="board-danger" title="Close or delete">
          <div className={cn(card, 'divide-y divide-anvil-100 dark:divide-anvil-850')}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <p className="text-dense text-anvil-700 dark:text-anvil-200">{open ? 'A closed board is read-only and moves to Closed.' : 'Reopen the board so members can change it again.'}</p>
              <Button size="sm" variant="outline" onClick={() => setAction(open ? 'closed' : 'open')}>
                {open ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />} {open ? 'Close board' : 'Reopen board'}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <p className="text-dense text-anvil-700 dark:text-anvil-200">Delete the board for everyone. Its issues and pull requests stay.</p>
              <Button size="sm" variant="danger" onClick={() => setAction('deleted')} data-testid="delete-board">
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete board
              </Button>
            </div>
          </div>
        </Section>
      ) : null}

      <ConfirmDialog open={action !== null} onClose={() => setAction(null)} title={confirm.title} description={confirm.description} cost={cost} confirmLabel={confirm.label} successNote={action === 'deleted' ? 'Board deleted' : 'Saved'} onConfirm={run} />
    </div>
  )
}

/** The definition's size against its 4096 bytes. */
function SizeMeter({ bytes }: { bytes: number | null }): JSX.Element | null {
  if (bytes === null) return null
  const pct = Math.min(100, Math.round((bytes / SPEC_MAX_BYTES) * 100))
  const over = bytes > SPEC_MAX_BYTES
  const near = !over && pct >= 90
  return (
    <span className="flex items-center gap-2 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="size-meter">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-anvil-200 dark:bg-anvil-800" role="meter" aria-valuemin={0} aria-valuemax={SPEC_MAX_BYTES} aria-valuenow={Math.min(bytes, SPEC_MAX_BYTES)} aria-label="Board settings size">
        <span className={cn('block h-full rounded-full', over ? 'bg-danger' : near ? 'bg-caution' : 'bg-anvil-500 dark:bg-anvil-400')} style={{ width: `${pct}%` }} />
      </span>
      <span className={cn('font-mono tabular-nums', over && 'text-danger-700 dark:text-danger-400', near && 'text-caution-700 dark:text-caution-400')}>
        {bytes.toLocaleString('en-US')} / {SPEC_MAX_BYTES.toLocaleString('en-US')} bytes
      </span>
    </span>
  )
}

/** `o` without its undefined values (a spec never holds an explicit undefined). */
function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** An "Add …" button, and the note when no id is left for it. */
function AddButton({ label, disabled, onAdd }: { label: string; disabled: boolean; onAdd: () => boolean }): JSX.Element {
  const [usedUp, setUsedUp] = useState(false)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setUsedUp(!onAdd())}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> {label}
      </Button>
      <Problem text={usedUp ? IDS_USED_UP : null} />
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------------

function ColumnsSection({ spec, edit, used }: { spec: BoardSpec; edit: SpecEdit; used: UsedIds }): JSX.Element {
  const [dragging, setDragging] = useState<number | null>(null)
  const setColumn = (id: number, change: Partial<BoardColumn>): void => edit((s) => ({ ...s, columns: s.columns.map((c) => (c.id === id ? dropUndefined({ ...c, ...change }) : c)) }))
  const move = (from: number, to: number): void => edit((s) => ({ ...s, columns: moved(s.columns, from, to) }))
  const add = (): boolean => {
    const entry = newEntry(spec.columns, 'Column', used.columns)
    if (entry !== null) edit((s) => ({ ...s, columns: [...s.columns, entry] }))
    return entry !== null
  }
  return (
    <Section id="board-columns" title="Columns" hint="The stages work moves through, left to right. Drag to reorder.">
      <ol className={card} aria-label="Columns">
        {spec.columns.map((c, i) => {
          const onDrop = (e: DragEvent): void => {
            e.preventDefault()
            if (dragging !== null) move(dragging, i)
            setDragging(null)
          }
          return (
            <li
              key={c.id}
              className={cn(rowClass, dragging === i && 'opacity-50')}
              onDragOver={(e) => {
                if (dragging !== null) e.preventDefault()
              }}
              onDrop={onDrop}
              data-testid="column-row"
            >
              <span
                draggable
                onDragStart={(e) => {
                  // Firefox starts a drag only with data set
                  e.dataTransfer.setData('text/plain', c.name)
                  e.dataTransfer.effectAllowed = 'move'
                  setDragging(i)
                }}
                onDragEnd={() => setDragging(null)}
                className="cursor-grab text-anvil-400 dark:text-anvil-500"
                aria-hidden
                title="Drag to reorder"
              >
                <GripVertical className="h-4 w-4" />
              </span>
              <ColorPicker color={c.color} what={c.name} onChange={(color) => setColumn(c.id, { color })} />
              <input aria-label={`Name of column ${i + 1}`} value={c.name} maxLength={NAME_MAX} onChange={(e) => setColumn(c.id, { name: e.target.value })} className={cn(controlClass, 'min-w-0 flex-1')} />
              <label className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
                WIP
                <NumberField value={c.wip} min={1} max={WIP_MAX} optional placeholder="None" label={`WIP limit of ${c.name}`} onChange={(wip) => setColumn(c.id, { wip })} className="w-20" />
              </label>
              {spec.def === c.id ? <span className={chip}>Default</span> : null}
              {spec.done === c.id ? <span className={chip}>Done</span> : null}
              <EntryButtons index={i} count={spec.columns.length} what={`column ${c.name}`} onMove={(to) => move(i, to)} {...(spec.columns.length > 1 ? { onDelete: () => edit((s) => withoutColumn(s, c.id)) } : {})} />
              <Problem text={entryProblem(spec.columns, c, 'column')} />
            </li>
          )
        })}
      </ol>
      <div className="flex flex-wrap items-end gap-4">
        <AddButton label="Add column" disabled={spec.columns.length >= MAX_COLUMNS} onAdd={add} />
        <label className="flex items-center gap-2 text-dense text-anvil-700 dark:text-anvil-200">
          Default column
          <select value={spec.def} onChange={(e) => edit((s) => ({ ...s, def: Number(e.target.value) }))} className={controlClass} aria-describedby="board-def-hint">
            <option value={0}>No status</option>
            {spec.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-dense text-anvil-700 dark:text-anvil-200">
          Done column
          <select value={spec.done} onChange={(e) => edit((s) => ({ ...s, done: Number(e.target.value) }))} className={controlClass}>
            <option value={0}>None</option>
            {spec.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p id="board-def-hint" className="text-[12px] text-anvil-500 dark:text-anvil-400">
        New items start in the default column ({columnName(spec, spec.def)}), and so do a deleted column&apos;s. Closed and merged items go to Done.
      </p>
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

function FieldsSection({ spec, edit, used }: { spec: BoardSpec; edit: SpecEdit; used: UsedIds }): JSX.Element {
  const [adding, setAdding] = useState<{ name: string; type: FieldType } | null>(null)
  const [usedUp, setUsedUp] = useState(false)
  const setField = (id: number, change: Partial<BoardField>): void => edit((s) => withCleanViews({ ...s, fields: s.fields.map((f) => (f.id === id ? dropUndefined({ ...f, ...change }) : f)) }))
  const move = (from: number, to: number): void => edit((s) => ({ ...s, fields: moved(s.fields, from, to) }))
  const addProblem = adding === null ? null : nameProblem(adding.name.trim(), spec.fields.map((f) => f.name.trim()), 'field')
  const add = (): void => {
    if (adding === null || addProblem !== null) return
    const entry = newEntry(spec.fields, 'Field', used.fields)
    setUsedUp(entry === null)
    if (entry === null) return
    const base = { id: entry.id, name: adding.name.trim(), type: adding.type }
    const field: BoardField = adding.type === 'sel' ? { ...base, options: [] } : adding.type === 'iter' ? { ...base, start: mondayOf(Date.now()), days: 14 } : base
    edit((s) => ({ ...s, fields: [...s.fields, field] }))
    setAdding(null)
  }
  return (
    <Section id="board-fields" title="Fields" hint="What each item carries besides its status, such as priority, estimate, dates and iterations. A field's type is fixed once added.">
      {spec.fields.length > 0 ? (
        <ol className={card} aria-label="Fields">
          {spec.fields.map((f, i) => (
            <li key={f.id} className={cn(rowClass, 'items-start')} data-testid="field-row">
              <div className="flex w-full flex-wrap items-center gap-2">
                <input aria-label={`Name of field ${i + 1}`} value={f.name} maxLength={NAME_MAX} onChange={(e) => setField(f.id, { name: e.target.value })} className={cn(controlClass, 'min-w-0 flex-1')} />
                <span className={cn(chip, 'py-0.5')}>{FIELD_TYPE_LABEL[f.type]}</span>
                <EntryButtons index={i} count={spec.fields.length} what={`field ${f.name}`} onMove={(to) => move(i, to)} onDelete={() => edit((s) => withoutField(s, f.id))} />
              </div>
              <Problem text={entryProblem(spec.fields, f, 'field')} />
              {f.type === 'sel' ? <OptionsEditor field={f} taken={used.options.get(f.id) ?? new Set()} onChange={(options) => setField(f.id, { options })} /> : null}
              {f.type === 'iter' ? <IterationEditor field={f} onChange={(change) => setField(f.id, change)} /> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {adding !== null ? (
        <div className={cn(card, 'flex flex-wrap items-center gap-2 p-3')} data-testid="add-field-form">
          <input aria-label="New field name" placeholder="Priority" value={adding.name} maxLength={NAME_MAX} autoFocus onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} className={cn(controlClass, 'min-w-0 flex-1')} />
          <select aria-label="New field type" value={adding.type} onChange={(e) => setAdding({ ...adding, type: e.target.value as FieldType })} className={controlClass}>
            {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <Button size="sm" variant="primary" onClick={add} disabled={addProblem !== null}>
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>
            Cancel
          </Button>
          {adding.name !== '' ? <Problem text={addProblem} /> : null}
          <Problem text={usedUp ? IDS_USED_UP : null} />
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAdding({ name: '', type: 'sel' })} disabled={spec.fields.length >= MAX_FIELDS}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add field
        </Button>
      )}
    </Section>
  )
}

function OptionsEditor({ field, taken, onChange }: { field: BoardField; taken: ReadonlySet<number>; onChange: (options: FieldOption[]) => void }): JSX.Element {
  const options = field.options ?? []
  const [usedUp, setUsedUp] = useState(false)
  const set = (id: number, change: Partial<FieldOption>): void => onChange(options.map((o) => (o.id === id ? dropUndefined({ ...o, ...change }) : o)))
  return (
    <div className="w-full space-y-1.5 pl-2">
      <ol aria-label={`Options of ${field.name}`} className="space-y-1">
        {options.map((o, i) => (
          <li key={o.id} className="flex flex-wrap items-center gap-2">
            <ColorPicker color={o.color} what={o.name} onChange={(color) => set(o.id, { color })} />
            <input aria-label={`Option ${i + 1} of ${field.name}`} value={o.name} maxLength={NAME_MAX} onChange={(e) => set(o.id, { name: e.target.value })} className={cn(controlClass, 'min-w-0 flex-1')} />
            <EntryButtons index={i} count={options.length} what={`option ${o.name}`} onMove={(to) => onChange(moved(options, i, to))} onDelete={() => onChange(options.filter((x) => x.id !== o.id))} />
            <Problem text={entryProblem(options, o, 'option')} />
          </li>
        ))}
      </ol>
      <button
        type="button"
        disabled={options.length >= MAX_OPTIONS}
        onClick={() => {
          const entry = newEntry(options, 'Option', taken)
          setUsedUp(entry === null)
          if (entry !== null) onChange([...options, { ...entry, color: LABEL_COLORS[(entry.id - 1) % LABEL_COLORS.length] as string }])
        }}
        className="inline-flex items-center gap-1 text-[12px] text-forge-700 hover:underline disabled:opacity-50 dark:text-forge-400 coarse:min-h-11"
      >
        <Plus className="h-3 w-3" aria-hidden /> Add option
      </button>
      <Problem text={usedUp ? IDS_USED_UP : null} />
    </div>
  )
}

function IterationEditor({ field, onChange }: { field: BoardField; onChange: (change: Partial<BoardField>) => void }): JSX.Element {
  const cur = iterationAt(field, Date.now())
  const first = cur ?? 0
  const preview = [first, first + 1, first + 2].map((k) => iterationRange(field, k)).filter((r): r is IterationRange => r !== null)
  return (
    <div className="w-full space-y-1.5 pl-2">
      <div className="flex flex-wrap items-center gap-3 text-dense text-anvil-700 dark:text-anvil-200">
        <label className="flex items-center gap-2">
          Starts
          <input type="date" value={field.start ?? ''} aria-label={`First day of ${field.name}`} onChange={(e) => dateDays(e.target.value) !== null && onChange({ start: e.target.value })} className={controlClass} />
        </label>
        <label className="flex items-center gap-2">
          Each lasts
          <NumberField value={field.days ?? 14} min={1} max={ITER_DAYS_MAX} label={`Days in each ${field.name}`} onChange={(days) => days !== undefined && onChange({ days })} className="w-16" />
          days
        </label>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-anvil-500 dark:text-anvil-400" aria-label={`Next ${field.name}s`} data-testid="iteration-preview">
        {preview.map((r) => (
          <li key={r.index} className={cn(r.index === cur && 'font-medium text-anvil-800 dark:text-anvil-100')}>
            {`${r.name}: ${dayRangeText(r.start, r.end)}${r.index === cur ? ' (current)' : ''}`}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

let sourceKeys = 0

function SourcesSection({ spec, edit, repo, sdk }: { spec: BoardSpec; edit: SpecEdit; repo: RepoRef; sdk: EvoSDK | null }): JSX.Element {
  const { ready, network } = useSdk()
  const owned = useAsync(async () => (await listReposByOwner(sdk!, repo.ownerId, { limit: 100 })).owned, [ready, repo.ownerId, network], { enabled: ready && sdk !== null })
  const known = useMemo(() => new Map([[repo.repoId, repo.name], ...(owned.data ?? []).map((r): [string, string] => [r.key, r.slug])]), [owned.data, repo])
  const strangers = spec.sources.map((s) => s.r ?? repo.repoId).filter((r) => !known.has(r))
  const others = useAsync(
    async () => new Map(await Promise.all([...new Set(strangers)].map(async (id): Promise<[string, string]> => [id, (await readRepoById(sdk!, repo.forge, id).catch(() => null))?.name ?? shortId(id)]))),
    [ready, strangers.join(',')],
    { enabled: ready && sdk !== null && strangers.length > 0 },
  )
  const nameOf = (id: string): string => known.get(id) ?? others.data?.get(id) ?? shortId(id)
  // Sources have no ids: each row keeps a key of its own, so deleting one never moves another's state.
  const [keys, setKeys] = useState<number[]>(() => spec.sources.map(() => ++sourceKeys))
  const rowKeys = spec.sources.map((_, i) => keys[i] ?? -1 - i)
  const setSource = (i: number, change: Partial<BoardSource>): void => edit((s) => ({ ...s, sources: s.sources.map((x, j) => (j === i ? { ...x, ...change } : x)) }))
  const remove = (i: number): void => {
    setKeys(rowKeys.filter((_, j) => j !== i))
    edit((x) => ({ ...x, sources: x.sources.filter((_, j) => j !== i) }))
  }
  return (
    <Section id="board-sources" title="Sources" hint="Every issue or pull request a source matches is on the board without anyone adding it. With no source, the board holds only what members add.">
      {spec.sources.length > 0 ? (
        <ol className={card} aria-label="Sources">
          {spec.sources.map((s, i) => (
            <SourceRow key={rowKeys[i]} index={i} source={s} spec={spec} repo={repo} sdk={sdk} choices={[...known]} nameOf={nameOf} onChange={(change) => setSource(i, change)} onDelete={() => remove(i)} />
          ))}
        </ol>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={spec.sources.length >= MAX_SOURCES}
        onClick={() => {
          setKeys([...rowKeys, ++sourceKeys])
          edit((s) => ({ ...s, sources: [...s.sources, { r: repo.repoId, k: 'a', q: '' }] }))
        }}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden /> Add source
      </Button>
    </Section>
  )
}

function SourceRow({
  index,
  source,
  spec,
  repo,
  sdk,
  choices,
  nameOf,
  onChange,
  onDelete,
}: {
  index: number
  source: BoardSource
  spec: BoardSpec
  repo: RepoRef
  sdk: EvoSDK | null
  choices: readonly (readonly [string, string])[]
  nameOf: (id: string) => string
  onChange: (change: Partial<BoardSource>) => void
  onDelete: () => void
}): JSX.Element {
  const r = source.r ?? repo.repoId
  const [other, setOther] = useState<string | null>(null)
  const [otherError, setOtherError] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)
  const unresolved = useMemo(() => parseSourceQuery(source.q, spec).unresolved, [source.q, spec])
  const listed = choices.some(([id]) => id === r)
  const lookUp = async (): Promise<void> => {
    const m = /^@?([^/\s]+)\/([^/\s]+)$/.exec((other ?? '').trim())
    if (m === null || sdk === null) {
      setOtherError('Write it as owner/name.')
      return
    }
    setLooking(true)
    try {
      const found = await resolveAnyRepo(sdk, { owner: m[1] as string, name: m[2] as string })
      if (found === null) setOtherError('No repo by that name.')
      else {
        onChange({ r: found.repo.repoId })
        setOther(null)
        setOtherError(null)
      }
    } catch {
      setOtherError('This page couldn’t read that repo. Try again.')
    } finally {
      setLooking(false)
    }
  }
  return (
    <li className={cn(rowClass, 'items-start')} data-testid="source-row">
      <div className="flex w-full flex-wrap items-center gap-2">
        <select
          aria-label={`Repo of source ${index + 1}`}
          value={other !== null ? '__other' : r}
          onChange={(e) => {
            if (e.target.value === '__other') setOther('')
            else {
              setOther(null)
              onChange({ r: e.target.value })
            }
          }}
          className={cn(controlClass, 'max-w-[16rem]')}
        >
          {choices.map(([id, name]) => (
            <option key={id} value={id}>
              {id === repo.repoId ? `${name} (this repo)` : name}
            </option>
          ))}
          {!listed ? <option value={r}>{nameOf(r)}</option> : null}
          <option value="__other">Another repo…</option>
        </select>
        <select aria-label={`Kind of source ${index + 1}`} value={source.k} onChange={(e) => onChange({ k: e.target.value as SourceKind })} className={controlClass}>
          {(Object.keys(KIND_LABEL) as SourceKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <button type="button" className={cn(iconButton, 'ml-auto hover:text-danger-700 dark:hover:text-danger-400')} onClick={onDelete} aria-label={`Delete source ${index + 1}`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {other !== null ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          <input aria-label="Another repo, as owner/name" placeholder="owner/name" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void lookUp())} className={cn(controlClass, 'min-w-0 flex-1 font-mono')} />
          <Button size="sm" variant="outline" onClick={() => void lookUp()} loading={looking}>
            Use repo
          </Button>
          <button type="button" className={iconButton} onClick={() => setOther(null)} aria-label="Cancel">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
          <Problem text={otherError} />
        </div>
      ) : null}
      <input aria-label={`Filter of source ${index + 1}`} placeholder="Filter, e.g. label:bug -is:pr (optional)" value={source.q} maxLength={QUERY_MAX} onChange={(e) => onChange({ q: e.target.value })} className={cn(controlClass, 'w-full font-mono')} />
      {unresolved.length > 0 ? (
        <p className="w-full text-[12px] text-caution-700 dark:text-caution-400" data-testid="source-unresolved">
          {`Not applied: ${unresolved.join(' ')}`}. A source reads only the item, so status, fields, archived and @me don&apos;t apply here.
        </p>
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

function ViewsSection({ spec, edit }: { spec: BoardSpec; edit: SpecEdit }): JSX.Element {
  const setView = (id: number, change: Partial<BoardSpec['views'][number]>): void => edit((s) => ({ ...s, views: s.views.map((v) => (v.id === id ? cleanView({ ...v, ...change }, s.fields) : v)) }))
  const move = (from: number, to: number): void => edit((s) => ({ ...s, views: moved(s.views, from, to) }))
  const add = (): boolean => {
    const entry = newEntry(spec.views, 'View')
    if (entry !== null) edit((s) => ({ ...s, views: [...s.views, { ...entry, layout: 'board', q: '' }] }))
    return entry !== null
  }
  return (
    <Section id="board-views" title="Views" hint="Saved cuts of the board, which opens on the first one. Members save new ones from the board.">
      {spec.views.length > 0 ? (
        <ol className={card} aria-label="Views">
          {spec.views.map((v, i) => {
            const unresolved = parseBoardQuery(v.q, spec).unresolved
            return (
              <li key={v.id} className={cn(rowClass, 'items-start')} data-testid="view-row">
                <div className="flex w-full flex-wrap items-center gap-2">
                  <input aria-label={`Name of view ${i + 1}`} value={v.name} maxLength={NAME_MAX} onChange={(e) => setView(v.id, { name: e.target.value })} className={cn(controlClass, 'min-w-0 flex-1')} />
                  <select aria-label={`Layout of ${v.name}`} value={v.layout} onChange={(e) => setView(v.id, { layout: e.target.value as ViewLayout })} className={controlClass}>
                    {(Object.keys(LAYOUT_LABEL) as ViewLayout[]).map((l) => (
                      <option key={l} value={l}>
                        {LAYOUT_LABEL[l]}
                      </option>
                    ))}
                  </select>
                  <EntryButtons index={i} count={spec.views.length} what={`view ${v.name}`} onMove={(to) => move(i, to)} onDelete={() => edit((s) => ({ ...s, views: s.views.filter((x) => x.id !== v.id) }))} />
                </div>
                <Problem text={entryProblem(spec.views, v, 'view')} />
                <input aria-label={`Filter of ${v.name}`} placeholder="Filter, e.g. is:open assignee:@me (optional)" value={v.q} maxLength={QUERY_MAX} onChange={(e) => setView(v.id, { q: e.target.value })} className={cn(controlClass, 'w-full font-mono')} />
                {unresolved.length > 0 ? (
                  <p className="w-full text-[12px] text-caution-700 dark:text-caution-400" data-testid="view-unresolved">
                    {`Not on this board: ${unresolved.join(' ')}`}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">No saved views yet. The board opens on its columns.</p>
      )}
      <AddButton label="Add view" disabled={spec.views.length >= MAX_VIEWS} onAdd={add} />
    </Section>
  )
}
