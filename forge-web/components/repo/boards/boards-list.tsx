'use client'

/**
 * BoardsList — `/repo/boards` (design `docs/design/boards.md` §2.1, §5.1): a repository's boards,
 * Open / Closed, each with its name, description, column count and when it last changed, as
 * GitHub lists a repository's projects. Maintainers and writers create one ("New board"): a name
 * and a template (`board-templates.ts`), priced before signing, then the new board opens.
 *
 * Boards are forge-meta documents (UPDATE-3): on a network whose contracts have no forge-meta
 * the page says boards are not available there. A private repository's boards are encrypted
 * with the repo's key; one this reader cannot open is listed without its name.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CheckCircle2, KanbanSquare, Lock, Plus, Settings2 } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { checkBoardInput, type BoardView } from '@/lib/repo'
import { NAME_MAX } from '@/lib/rules/boards'
import { priceBoardWrites } from '@/lib/sdk'
import { plural, timeAgo } from '@/lib/view/format'
import { useBoards } from '@/hooks/use-board'
import { useParam, type RepoAddress } from '@/hooks/use-query-param'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { StateTab } from '@/components/repo/list-controls'
import { onRadioGroupKeyDown, radioTabIndex } from '@/components/ui/radio-group'
import { cn, inputProblem } from '@/lib/utils'
import { BOARD_TEMPLATES, boardTemplate, type BoardTemplateKey } from './board-templates'
import { boardHref, boardSettingsHref } from './board-fields'

/** Whether `home`'s network has the board types (forge-meta, UPDATE-3). */
export function boardsAvailable(home: Pick<RepoHome, 'repo'>): boolean {
  return home.repo.forge.meta !== undefined
}

/** What boards are, in one sentence (the empty state, the sidebar). */
export const BOARDS_BLURB = 'Boards lay out issues and pull requests in columns, so the team can see and move work through its stages.'

export function BoardsList({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  if (!boardsAvailable(home)) {
    return (
      <div className="max-w-4xl" data-testid="boards-page">
        <EmptyState icon={KanbanSquare} title="Boards aren't here yet" body="Boards aren't available on this network yet." />
      </div>
    )
  }
  return <BoardsListContent home={home} addr={addr} />
}

function BoardsListContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const repo = home.repo
  const boards = useBoards(repo)
  const archived = home.config?.archived === true
  const canCreate = boards.can.edit && !archived
  const [state, setState] = useState<'open' | 'closed'>(useParam('state') === 'closed' ? 'closed' : 'open')
  const [creating, setCreating] = useState(false)
  const all = useMemo(() => boards.data ?? [], [boards.data])
  const open = all.filter((b) => b.state === 'open')
  const closed = all.filter((b) => b.state === 'closed')
  const shown = state === 'open' ? open : closed
  const now = Date.now()

  return (
    <div className="max-w-4xl space-y-4" data-testid="boards-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-prose">
          <KanbanSquare className="h-4 w-4 text-fg-muted" aria-hidden /> Boards
        </h2>
        {canCreate ? (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)} data-testid="new-board">
            <Plus className="h-3.5 w-3.5" aria-hidden /> New board
          </Button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        <div className="flex items-center gap-3 border-b border-anvil-200 bg-anvil-50 px-4 py-2 dark:border-anvil-800 dark:bg-anvil-900" role="tablist" aria-label="Board state">
          <StateTab active={state === 'open'} onClick={() => setState('open')}>
            <KanbanSquare className="h-3.5 w-3.5" aria-hidden /> {boards.data === null ? '' : `${open.length} `}Open
          </StateTab>
          <StateTab active={state === 'closed'} onClick={() => setState('closed')}>
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {boards.data === null ? '' : `${closed.length} `}Closed
          </StateTab>
        </div>
        {boards.loading && boards.data === null ? (
          <LoadingBlock label="Reading boards" />
        ) : boards.error ? (
          <div className="p-4">
            <ErrorState message={boards.error} onRetry={boards.reload} />
          </div>
        ) : shown.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={KanbanSquare}
              title={state === 'open' ? (all.length === 0 ? 'No boards yet' : 'No open boards') : 'No closed boards'}
              body={state === 'closed' ? 'A closed board shows here, read-only.' : canCreate ? BOARDS_BLURB : `${BOARDS_BLURB} Maintainers and members with Write create them.`}
              action={
                state === 'open' && canCreate ? (
                  <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden /> New board
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ul aria-label="Boards">
            {shown.map((b) => (
              <BoardRow key={b.key} board={b} addr={addr} now={now} canEdit={boards.can.edit} />
            ))}
          </ul>
        )}
      </div>

      <NewBoardDialog open={creating} onClose={() => setCreating(false)} home={home} addr={addr} create={boards.create} taken={all.map((b) => b.name ?? '')} />
    </div>
  )
}

/** One board in the list. */
function BoardRow({ board, addr, now, canEdit }: { board: BoardView; addr: RepoAddress; now: number; canEdit: boolean }): JSX.Element {
  const spec = board.spec
  const unreadable = board.name === null
  return (
    <li className="flex items-start gap-3 border-b border-anvil-100 px-4 py-3 last:border-b-0 dark:border-anvil-850" data-testid="board-row" data-key={board.key}>
      <KanbanSquare className={cn('mt-0.5 h-4 w-4 shrink-0', board.state === 'open' ? 'text-fg-muted' : 'text-anvil-400 dark:text-anvil-500')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={boardHref(addr, board.key)} className="hit-area min-w-0 break-words text-prose font-semibold text-anvil-900 hover:text-forge-700 hover:underline dark:text-anvil-50 dark:hover:text-forge-400">
            {unreadable ? 'Encrypted board' : board.name}
          </Link>
          {board.sealed ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400" title="Encrypted with the repo's key">
              <Lock className="h-3 w-3" aria-hidden />
              <span className="sr-only">Encrypted</span>
            </span>
          ) : null}
          {board.state === 'closed' ? <span className="rounded-full border border-anvil-300 px-1.5 text-[11px] text-anvil-600 dark:border-anvil-700 dark:text-anvil-300">Closed</span> : null}
        </div>
        {spec?.desc ? <p className="mt-1 line-clamp-2 whitespace-pre-line break-words text-dense text-anvil-700 dark:text-anvil-200">{spec.desc}</p> : null}
        <p className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-anvil-500 dark:text-anvil-400">
          {spec !== null ? <span>{plural(spec.columns.length, 'column')}</span> : unreadable ? <span>You need the repo&apos;s key to read it.</span> : <span>Its settings can&apos;t be read here.</span>}
          <span>Updated {timeAgo(board.newest.updatedAt, now)}</span>
        </p>
      </div>
      {canEdit && spec !== null ? (
        <Link href={boardSettingsHref(addr, board.key)} className="inline-flex items-center gap-1 rounded p-1 text-[12px] text-anvil-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11" aria-label={`Settings of ${board.name ?? 'board'}`}>
          <Settings2 className="h-3.5 w-3.5" aria-hidden />
        </Link>
      ) : null}
    </li>
  )
}

/** The create dialog: a name and a template, priced before signing; the new board opens. */
function NewBoardDialog({
  open,
  onClose,
  home,
  addr,
  create,
  taken,
}: {
  open: boolean
  onClose: () => void
  home: RepoHome
  addr: RepoAddress
  create: ReturnType<typeof useBoards>['create']
  taken: readonly string[]
}): JSX.Element {
  const router = useRouter()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<BoardTemplateKey>('kanban')
  const spec = useMemo(() => boardTemplate(template).spec(home.repo.repoId, Date.now()), [template, home.repo.repoId])
  const trimmed = name.trim()
  const problem = trimmed === '' ? 'Name the board.' : inputProblem(() => checkBoardInput({ name: trimmed, spec }))
  const duplicate = taken.some((t) => t.toLowerCase() === trimmed.toLowerCase())
  const sealed = home.repo.visibility === 'private'
  const close = (): void => {
    onClose()
    setName('')
    setTemplate('kanban')
  }
  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      title="New board"
      description="Anyone who can see this repo can see its boards. Maintainers and members with Write change them."
      cost={priceBoardWrites(1, 0, { type: 'board', sealed })}
      confirmLabel="Sign & create"
      successNote="Board created"
      blocked={problem !== null && trimmed !== '' ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{problem}</p> : trimmed === '' ? <span /> : undefined}
      onConfirm={async (intent) => {
        const out = await create({ name: trimmed, spec, intent })
        router.push(boardHref(addr, out.key))
      }}
    >
      <Field label="Name" htmlFor="new-board-name" hint={duplicate ? 'Another board has this name. Boards keep their own keys, so both work.' : undefined}>
        <Input id="new-board-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} placeholder="Roadmap" autoFocus data-testid="new-board-name" />
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-dense font-medium text-anvil-700 dark:text-anvil-200">Template</legend>
        <div role="radiogroup" aria-label="Template" className="grid gap-2 sm:grid-cols-2" onKeyDown={onRadioGroupKeyDown}>
          {BOARD_TEMPLATES.map((t, i) => {
            const on = t.key === template
            const cols = t.spec(home.repo.repoId, 0).columns
            return (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={radioTabIndex(on, i, true)}
                onClick={() => setTemplate(t.key)}
                data-testid={`template-${t.key}`}
                className={cn(
                  'rounded-md border px-3 py-2 text-left transition-colors coarse:min-h-11',
                  on ? 'border-forge-500 bg-forge-500/5 dark:border-forge-400' : 'border-anvil-200 hover:border-anvil-300 dark:border-anvil-750 dark:hover:border-anvil-600',
                )}
              >
                <span className="block text-dense font-medium text-anvil-900 dark:text-anvil-50">{t.name}</span>
                <span className="mt-0.5 block text-[12px] text-anvil-500 dark:text-anvil-400">{t.blurb}</span>
                <span className="mt-1.5 flex flex-wrap gap-1" aria-hidden>
                  {cols.map((c) => (
                    <span key={c.id} className="rounded bg-anvil-100 px-1.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300">
                      {c.name}
                    </span>
                  ))}
                </span>
              </button>
            )
          })}
        </div>
      </fieldset>
      {sealed ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">This repo is private: the board is encrypted with its key.</p> : null}
    </ConfirmDialog>
  )
}
