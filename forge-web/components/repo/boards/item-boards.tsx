'use client'

/**
 * The issue and pull request sidebar's "Boards" (design `docs/design/boards.md` §5.6, GitHub's
 * "Projects"): each board the item is on whose home is its repository or another public one of
 * the same owner (`useItemBoards`), with a link to it and the item's Status and custom fields
 * there, edited in place by that board's members (one card write each, as on the board); and,
 * for the repository's members who place cards, "Add to board" for its other open boards.
 *
 * It reads nothing until it scrolls into view (`useInView`): the page's first render and its
 * request budget are the thread's alone. The board list behind "Add to board" is read only
 * when the menu opens. Auto-archive is not applied here (the sidebar does not read when the
 * item closed); a card's own archive is.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, KanbanSquare, Plus } from 'lucide-react'
import { canPlaceCards, type BoardView, type CardPatch, type RepoRef } from '@/lib/repo'
import type { BoardItem, FieldValue } from '@/lib/rules/boards'
import { priceBoardWrites } from '@/lib/sdk'
import { useBoards, useBoardsDeployed, useItemBoards, type ItemBoardPlacement } from '@/hooks/use-board'
import { useInView } from '@/hooks/use-in-view'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useAuth } from '@/contexts/auth-context'
import type { RepoAddress } from '@/hooks/use-query-param'
import { SidebarSection, useDismiss } from '@/components/repo/target-rail'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Spinner } from '@/components/ui/states'
import { cn, errorMessage } from '@/lib/utils'
import { DotLabel, FieldInput, StatusSelect, boardHref, columnName, fieldValueText } from './board-fields'

/** The address of a board's home: the item's own repository, or another of its owner's. */
function homeAddr(addr: RepoAddress, repo: RepoRef, home: RepoRef): RepoAddress {
  return home.repoId === repo.repoId ? addr : { owner: addr.owner, name: home.name, repoId: home.repoId }
}

export function ItemBoards({ repo, addr, item }: { repo: RepoRef; addr: RepoAddress | undefined; item: BoardItem }): JSX.Element | null {
  // only where the network's forge-meta has boards (`boardsDeployed`: the bundled snapshot, no request)
  if (useBoardsDeployed(repo.forge) !== true) return null
  return <ItemBoardsSection repo={repo} addr={addr} item={item} />
}

function ItemBoardsSection({ repo, addr, item }: { repo: RepoRef; addr: RepoAddress | undefined; item: BoardItem }): JSX.Element {
  const [ref, seen] = useInView<HTMLDivElement>()
  const boards = useItemBoards(repo, seen ? item : null)
  const { role } = useViewerRole(repo)
  const { signer } = useAuth()
  const canAdd = signer !== null && canPlaceCards(role)
  const entries = (boards.data ?? []).filter((e) => e.placement === null || e.placement.on)
  return (
    <SidebarSection title="Boards" icon={KanbanSquare}>
      <div ref={ref} className="space-y-3" data-testid="item-boards">
        {!seen || (boards.loading && boards.data === null) ? (
          <Spinner label="Reading boards" className="text-[12px]" />
        ) : boards.error !== null ? (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            This page couldn&apos;t read the boards.{' '}
            <button type="button" onClick={boards.reload} className="text-forge-700 hover:underline dark:text-forge-400">
              Try again
            </button>
          </p>
        ) : entries.length === 0 ? (
          <p className="text-anvil-500 dark:text-anvil-400">None yet</p>
        ) : (
          entries.map((e) => <ItemBoardEntry key={`${e.home.repoId}:${e.board.key}`} entry={e} repo={repo} addr={addr} closed={item.state !== 'open'} write={boards.write} />)
        )}
        {canAdd && seen ? (
          <AddToBoard
            repo={repo}
            on={new Set((boards.data ?? []).filter((e) => e.home.repoId === repo.repoId && e.placement?.on !== false).map((e) => e.board.key))}
            // a board the signer already has a card on (removed from it) is a replace, not a create
            mine={new Set((boards.data ?? []).filter((e) => e.home.repoId === repo.repoId && signer !== null && e.cards.some((c) => c.ownerId === signer.identityId)).map((e) => e.board.key))}
            addTo={boards.addTo}
          />
        ) : null}
      </div>
    </SidebarSection>
  )
}

/** One board the item is on: its name, and the item's Status and fields there. */
function ItemBoardEntry({ entry, repo, addr, closed, write }: { entry: ItemBoardPlacement; repo: RepoRef; addr: RepoAddress | undefined; closed: boolean; write: ReturnType<typeof useItemBoards>['write'] }): JSX.Element {
  const { board, placement } = entry
  const spec = board.spec
  const { role } = useViewerRole(entry.home)
  const { signer } = useAuth()
  const can = signer !== null && canPlaceCards(role) && board.state === 'open' && spec !== null
  // What this page wrote, shown until the re-read (every board write re-reads the list) has it.
  const [shown, setShown] = useState<{ col?: number; fields: Record<string, FieldValue | null> }>({ fields: {} })
  // writes in flight (queued per item by the hook, so each lands over the one before)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const version = `${entry.card?.id ?? ''}:${entry.card?.updatedAt ?? 0}`
  const busyRef = useRef(busy)
  busyRef.current = busy
  // a re-read of the card with every write landed shows what was written
  useEffect(() => {
    if (busyRef.current === 0) setShown({ fields: {} })
  }, [version])
  const href = addr === undefined ? null : boardHref(homeAddr(addr, repo, entry.home), board.key)
  const name = board.name ?? 'Encrypted board'
  const apply = (patch: CardPatch): void => {
    setShown((s) => ({ ...s, ...(patch.col !== undefined ? { col: patch.col } : {}), fields: { ...s.fields, ...patch.fields } }))
    setBusy((n) => n + 1)
    setError(null)
    write(entry, patch)
      .catch((e: unknown) => {
        setShown({ fields: {} })
        setError(errorMessage(e))
      })
      .finally(() => setBusy((n) => n - 1))
  }
  const col = shown.col ?? placement?.col ?? 0
  const valueOf = (id: number): FieldValue | undefined => {
    const k = String(id)
    if (k in shown.fields) return shown.fields[k] ?? undefined
    return placement?.fields[k]
  }
  const fields = spec === null ? [] : spec.fields.filter((f) => can || valueOf(f.id) !== undefined)
  return (
    <div className="space-y-1.5" data-testid="item-board" data-key={board.key}>
      <div className="flex min-w-0 items-center gap-1.5">
        {href !== null ? (
          <Link href={href} className="min-w-0 truncate font-medium text-anvil-900 hover:text-forge-700 hover:underline dark:text-anvil-50 dark:hover:text-forge-400">
            {name}
          </Link>
        ) : (
          <span className="min-w-0 truncate font-medium text-anvil-900 dark:text-anvil-50">{name}</span>
        )}
        {entry.home.repoId !== repo.repoId ? <span className="shrink-0 font-mono text-[11px] text-anvil-500 dark:text-anvil-400">{entry.home.name}</span> : null}
        {board.state === 'closed' ? <span className="shrink-0 rounded-full border border-anvil-300 px-1.5 text-[11px] text-anvil-600 dark:border-anvil-700 dark:text-anvil-300">Closed</span> : null}
        {busy > 0 ? <Spinner label="Saving" className="ml-auto shrink-0 text-[11px]" /> : null}
      </div>
      {spec === null ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">This board can&apos;t be read here.</p>
      ) : (
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-[12px]">
          <dt className="text-anvil-500 dark:text-anvil-400">Status</dt>
          <dd className="min-w-0">
            {can ? (
              <StatusSelect spec={spec} value={col} closed={closed} label={`Status on ${name}`} onChange={(c) => apply({ col: c })} className="h-7 py-0.5 text-[12px]" />
            ) : (
              <DotLabel color={spec.columns.find((c) => c.id === col)?.color} className="text-anvil-800 dark:text-anvil-100">
                {columnName(spec, col)}
              </DotLabel>
            )}
          </dd>
          {fields.map((f) => (
            <FieldRow key={f.id} name={f.name}>
              {can ? (
                <FieldInput field={f} value={valueOf(f.id)} now={Date.now()} label={`${f.name} on ${name}`} onCommit={(v) => apply({ fields: { [f.id]: v } })} className="h-7 py-0.5 text-[12px]" />
              ) : (
                <span className="truncate text-anvil-800 dark:text-anvil-100">{fieldValueText(f, valueOf(f.id))}</span>
              )}
            </FieldRow>
          ))}
        </dl>
      )}
      {placement?.archived != null ? (
        <p className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
          <Archive className="h-3 w-3" aria-hidden /> Archived on this board
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-[12px] text-danger-700 dark:text-danger-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function FieldRow({ name, children }: { name: string; children: React.ReactNode }): JSX.Element {
  return (
    <>
      <dt className="truncate text-anvil-500 dark:text-anvil-400" title={name}>
        {name}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

/** "Add to board": the repository's other open boards (read when the menu opens), one priced card write. */
function AddToBoard({ repo, on, mine, addTo }: { repo: RepoRef; on: ReadonlySet<number>; mine: ReadonlySet<number>; addTo: ReturnType<typeof useItemBoards>['addTo'] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<BoardView | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12px] text-anvil-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11"
        data-testid="add-to-board"
      >
        <Plus className="h-3 w-3" aria-hidden /> Add to board
      </button>
      {open ? <BoardMenu repo={repo} on={on} onChoose={(b) => { setChosen(b); setOpen(false) }} /> : null}
      <ConfirmDialog
        open={chosen !== null}
        onClose={() => setChosen(null)}
        title={`Add to “${chosen?.name ?? ''}”`}
        description="The item joins the board in its default column, or in Done once closed."
        cost={chosen !== null && mine.has(chosen.key) ? priceBoardWrites(0, 1, { sealed: repo.visibility === 'private' }) : priceBoardWrites(1, 0, { sealed: repo.visibility === 'private' })}
        confirmLabel="Sign & add"
        successNote="Added"
        onConfirm={async (intent) => {
          if (chosen !== null) await addTo(chosen, undefined, { intent })
        }}
      />
    </div>
  )
}

function BoardMenu({ repo, on, onChoose }: { repo: RepoRef; on: ReadonlySet<number>; onChoose: (b: BoardView) => void }): JSX.Element {
  const boards = useBoards(repo)
  const choices = (boards.data ?? []).filter((b) => b.state === 'open' && b.spec !== null && b.name !== null && !on.has(b.key))
  return (
    <div role="menu" aria-label="Boards" className="absolute left-0 z-30 mt-1 w-60 overflow-hidden rounded-md border border-anvil-200 bg-white py-1 shadow-lg dark:border-anvil-750 dark:bg-anvil-900">
      {boards.data === null && boards.error === null ? (
        <Spinner label="Reading boards" className="px-3 py-1.5 text-[12px]" />
      ) : boards.error !== null ? (
        <p className="px-3 py-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">This page couldn&apos;t read the boards.</p>
      ) : choices.length === 0 ? (
        <p className="px-3 py-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">No other open boards in this repo.</p>
      ) : (
        choices.map((b) => (
          <button key={b.key} type="button" role="menuitem" onClick={() => onChoose(b)} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-dense text-anvil-800 hover:bg-anvil-100 dark:text-anvil-100 dark:hover:bg-anvil-800 coarse:min-h-11')}>
            <KanbanSquare className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
            <span className="min-w-0 truncate">{b.name}</span>
          </button>
        ))
      )}
    </div>
  )
}
