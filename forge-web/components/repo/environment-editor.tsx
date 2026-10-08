'use client'

/**
 * Changing environments in the web (DESIGN §4.5, §10; stream 2C), as `dg env` changes them:
 *
 * - {@link AudiencePicker}: "Who can read production?" with nothing preselected (Maintainers,
 *   Writers and maintainers, All members, Specific people…, "+ Also give access to…"), each
 *   group with how many people it is now, and the 64-reader limit.
 * - {@link EnvChangeDialog}: create an environment (Save stays disabled until an audience is
 *   chosen), edit its values (add, change, remove, import a `.env` file read in this browser
 *   only), change who can read it, save it again, mark old-format values changed, or keep one
 *   version of a conflict. Every change is sealed for the people its audience covers now and
 *   shown with what changes and its cost before anything is signed.
 *
 * Existing values never go into a field: a row left alone keeps its value, a typed one replaces
 * it. Nothing typed or imported is stored outside this page's memory.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Eye, EyeOff, FileUp, Plus, Trash2, X } from 'lucide-react'

import { ACCESS_SENTENCE, MAX_RECIPIENTS, audienceLabel, validEnvName, validVarName, type Audience, type EnvVar, type Group, type VarType } from '@/lib/env'
import { DotenvError, JOINERS_LINE, changeSummary, draftOf, markChangedNames, parseDotenv, planSave, saveNotes, saveNoteText, sentToText, type SavePlan } from '@/lib/env/edit'
import { compareStrings as cmp } from '@/lib/env/format'
import type { EnvBook } from '@/lib/env/loader'
import { resolvePeople, type PeopleView } from '@/lib/env/view'
import { EnvSaveError, prepareSave, storeSave, tooManyText, type EnvSaver, type Prepared } from '@/lib/env/write'
import type { MemberEnvIO } from '@/lib/env/member-change'
import { decodeIdentifier } from '@/lib/auth'
import { base58Encode } from '@/lib/auth/base58'
import { previewCredits } from '@/lib/sdk'
import { errText } from '@/lib/storage/util'
import { onRadioGroupKeyDown, radioTabIndex } from '@/components/ui/radio-group'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { Author } from '@/components/author'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { shortId } from '@/lib/utils'

/** The help line under the picker, after {@link JOINERS_LINE} (DESIGN §10). */
export const REMOVED_LINE = "People removed keep what they could read; you'll get a list of values to change."

const GROUPS: readonly Group[] = ['maintainers', 'writers', 'members']

/** What the picker holds: a group (and people added to it), specific people, or nothing yet. */
export interface AudienceChoice {
  readonly kind: Group | 'people' | null
  /** People added to a group ("+ Also give access to…"). */
  readonly also: readonly string[]
  /** Specific people (the viewer is always added). */
  readonly people: readonly string[]
}

export const NO_CHOICE: AudienceChoice = { kind: null, also: [], people: [] }

/** The picker's state for an existing audience. */
export function choiceOf(a: Audience, viewer: string): AudienceChoice {
  if (a.group === null) return { kind: 'people', also: [], people: a.also.filter((p) => p !== viewer) }
  return { kind: a.group, also: a.also, people: [] }
}

/** The audience `c` picks, or `null` until one is chosen (Specific people needs someone besides the viewer, as `dg --to` does). */
export function audienceOf(c: AudienceChoice, viewer: string): Audience | null {
  if (c.kind === null) return null
  if (c.kind === 'people') return c.people.length === 0 ? null : { group: null, also: [...c.people, viewer] }
  return { group: c.kind, also: [...c.also] }
}

/** How many people `a` is now, the writer included. */
export function audienceSize(a: Audience, people: PeopleView, viewer: string): number {
  const all = resolvePeople(a, people)
  all.add(viewer)
  return all.size
}

/** An identity id typed into a field, or why it isn't one. */
function parseIdentity(text: string): { readonly id: string } | { readonly error: string } {
  const t = text.trim().replace(/^@/, '')
  try {
    // the canonical form: an audience lists ids exactly as the artifact writes them
    return { id: base58Encode(decodeIdentifier(t)) }
  } catch {
    return { error: 'Not an identity id (base58, 32 bytes).' }
  }
}

function IdentityAdder({ label, onAdd, testId }: { label: string; onAdd: (id: string) => void; testId: string }): JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const add = (): void => {
    const r = parseIdentity(text)
    if ('error' in r) {
      setError(r.error)
      return
    }
    onAdd(r.id)
    setText('')
    setError(null)
  }
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Input
          aria-label={label}
          placeholder="Identity id"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          className="font-mono"
          spellCheck={false}
          data-testid={testId}
        />
        <Button size="sm" variant="outline" onClick={add} disabled={text.trim() === ''}>
          Add
        </Button>
      </div>
      {error !== null ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{error}</p> : null}
    </div>
  )
}

function PersonChip({ id, onRemove }: { id: string; onRemove: () => void }): JSX.Element {
  const name = useDpnsName(id) ?? shortId(id)
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-anvil-200 px-2 py-0.5 text-[12px] dark:border-anvil-700" data-testid="env-person-chip">
      {name}
      <button type="button" aria-label={`Remove ${name}`} onClick={onRemove} className="hit-area rounded-full text-anvil-500 hover:text-anvil-900 dark:hover:text-anvil-50">
        <X className="h-3 w-3" aria-hidden />
      </button>
    </span>
  )
}

/**
 * "Who can read {env}?" (DESIGN §10): nothing preselected for a new environment; each group with
 * how many people it is now (`people`, when read); Specific people lists the repo's members to
 * tick and takes anyone else by id; a group takes people added to it.
 */
export function AudiencePicker({
  env,
  value,
  onChange,
  people,
  viewer,
}: {
  env: string
  value: AudienceChoice
  onChange: (c: AudienceChoice) => void
  people: PeopleView | null
  viewer: string
}): JSX.Element {
  const [showAlso, setShowAlso] = useState(value.also.length > 0)
  const options: { readonly kind: Group | 'people'; readonly label: string }[] = [
    ...GROUPS.map((g) => ({ kind: g, label: audienceLabel({ group: g, also: [] }) })),
    { kind: 'people' as const, label: 'Specific people…' },
  ]
  const anyChecked = value.kind !== null
  const chosen = audienceOf(value, viewer)
  const size = chosen !== null && people !== null ? audienceSize(chosen, people, viewer) : null
  const members = people === null ? [] : [...new Set([people.owner, ...people.members.map((m) => m.identity)])].filter((p) => p !== viewer)
  const others = value.people.filter((p) => !members.includes(p))
  return (
    <fieldset className="space-y-2" data-testid="env-audience-picker">
      <legend className="text-dense font-medium text-anvil-700 dark:text-anvil-200">Who can read {env === '' ? 'this environment' : env}?</legend>
      <div role="radiogroup" aria-label={`Who can read ${env === '' ? 'this environment' : env}`} onKeyDown={onRadioGroupKeyDown} className="space-y-1">
        {options.map((o, i) => {
          const checked = value.kind === o.kind
          const count = o.kind !== 'people' && people !== null ? audienceSize({ group: o.kind, also: [] }, people, viewer) : null
          return (
            <button
              key={o.kind}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={radioTabIndex(checked, i, anyChecked)}
              data-audience={o.kind}
              onClick={() => onChange({ ...value, kind: o.kind })}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-dense hover:bg-anvil-50 coarse:min-h-11 dark:hover:bg-anvil-900"
            >
              <span
                aria-hidden
                className={
                  'inline-block h-3.5 w-3.5 shrink-0 rounded-full border ' +
                  (checked ? 'border-forge-500 bg-forge-500 ring-2 ring-inset ring-white dark:ring-anvil-950' : 'border-anvil-400 dark:border-anvil-500')
                }
              />
              <span>
                {o.label}
                {count !== null ? <span className="text-anvil-500 dark:text-anvil-400"> ({count})</span> : null}
              </span>
            </button>
          )
        })}
      </div>
      {value.kind === 'people' ? (
        <div className="space-y-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-800" data-testid="env-specific-people">
          <p className="text-[12px] text-anvil-600 dark:text-anvil-300">You&apos;re always included.</p>
          {members.map((id) => {
            const on = value.people.includes(id)
            return (
              <label key={id} className="flex items-center gap-2 text-dense">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onChange({ ...value, people: on ? value.people.filter((p) => p !== id) : [...value.people, id] })}
                />
                <Author identityId={id} link={false} />
              </label>
            )
          })}
          {others.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {others.map((id) => (
                <PersonChip key={id} id={id} onRemove={() => onChange({ ...value, people: value.people.filter((p) => p !== id) })} />
              ))}
            </div>
          ) : null}
          <IdentityAdder label="Add someone by identity id" testId="env-people-add" onAdd={(id) => id !== viewer && !value.people.includes(id) && onChange({ ...value, people: [...value.people, id] })} />
        </div>
      ) : null}
      {value.kind !== null && value.kind !== 'people' ? (
        <div className="space-y-2">
          {value.also.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-testid="env-also">
              {value.also.map((id) => (
                <PersonChip key={id} id={id} onRemove={() => onChange({ ...value, also: value.also.filter((p) => p !== id) })} />
              ))}
            </div>
          ) : null}
          {showAlso ? (
            <IdentityAdder label="Also give access to (identity id)" testId="env-also-add" onAdd={(id) => !value.also.includes(id) && onChange({ ...value, also: [...value.also, id] })} />
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setShowAlso(true)} data-testid="env-also-open">
              <Plus className="h-3.5 w-3.5" aria-hidden /> Also give access to…
            </Button>
          )}
        </div>
      ) : null}
      {chosen !== null && size !== null && size > MAX_RECIPIENTS ? (
        <p role="alert" className="text-dense text-danger-700 dark:text-danger-400" data-testid="env-too-many">
          {tooManyText(chosen, size)}
        </p>
      ) : null}
      <div className="space-y-0.5 text-[12px] text-anvil-500 dark:text-anvil-400">
        <p>{JOINERS_LINE}</p>
        <p>{REMOVED_LINE}</p>
        <p>{ACCESS_SENTENCE}</p>
      </div>
    </fieldset>
  )
}

/** One row of the values editor. `value` null: keep the saved value (it never goes into a field). */
interface Row {
  readonly key: number
  readonly name: string
  readonly saved: boolean
  readonly value: string | null
  readonly type: VarType
  readonly note: string
}

function rowsOf(vars: ReadonlyMap<string, EnvVar>, focus: readonly string[]): Row[] {
  const names = [...vars.keys()].sort((a, b) => {
    const fa = focus.includes(a) ? 0 : 1
    const fb = focus.includes(b) ? 0 : 1
    return fa - fb || cmp(a, b)
  })
  return names.map((name, i) => {
    const v = vars.get(name) as EnvVar
    return { key: i, name, saved: true, value: null, type: v.type, note: v.note }
  })
}

/** The entries the rows make from `base`, or why they can't be saved. */
function varsOf(rows: readonly Row[], base: ReadonlyMap<string, EnvVar>): { readonly vars: Map<string, EnvVar> } | { readonly error: string } {
  const out = new Map<string, EnvVar>()
  for (const r of rows) {
    const name = r.name.trim()
    if (!validVarName(name)) return { error: `${name === '' ? 'A name is missing' : `${name} is not a variable name`}: letters, digits and _, not starting with a digit.` }
    if (out.has(name)) return { error: `${name} is listed twice.` }
    const value = r.value ?? base.get(r.saved ? r.name : name)?.value
    if (value === undefined) return { error: `${name} needs a value.` }
    out.set(name, { value, type: r.type, note: r.note })
  }
  return { vars: out }
}

function ValueField({ row, onChange, focused }: { row: Row; onChange: (value: string | null) => void; focused: boolean }): JSX.Element {
  const [shown, setShown] = useState(false)
  if (row.value !== null && row.value.includes('\n')) {
    return (
      <span className="flex items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-300">
        Multi-line value ({row.value.split('\n').length} lines)
        <Button size="sm" variant="ghost" onClick={() => onChange(row.saved ? null : '')}>
          Clear
        </Button>
      </span>
    )
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      {/* Not a password field: a password manager would offer to keep the value, or fill a saved
          password in. Masked with CSS instead. */}
      <Input
        aria-label={`Value of ${row.name === '' ? 'the new entry' : row.name}`}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore=""
        data-form-type="other"
        style={shown ? undefined : ({ WebkitTextSecurity: 'disc' } as CSSProperties)}
        spellCheck={false}
        placeholder={row.saved ? (focused ? 'Enter the new value' : 'Unchanged') : 'Value'}
        value={row.value ?? ''}
        onChange={(e) => onChange(e.target.value === '' && row.saved ? null : e.target.value)}
        className={'font-mono ' + (focused ? 'border-caution-500' : '')}
        data-testid="env-value-input"
      />
      <Button variant="ghost" size="icon" aria-label={shown ? 'Hide the value' : 'Show the value'} aria-pressed={shown} onClick={() => setShown((s) => !s)}>
        {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </Button>
    </span>
  )
}

/** The values editor: one row per entry, a new row, remove, and a `.env` file read here. */
function EntriesEditor({ rows, setRows, focus }: { rows: readonly Row[]; setRows: (f: (rows: Row[]) => Row[]) => void; focus: readonly string[] }): JSX.Element {
  const file = useRef<HTMLInputElement>(null)
  const [secret, setSecret] = useState(true)
  const [imported, setImported] = useState<string | null>(null)
  const nextKey = (rs: readonly Row[]): number => rs.reduce((m, r) => Math.max(m, r.key), -1) + 1
  const update = (key: number, patch: Partial<Row>): void => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const importFile = async (f: File): Promise<void> => {
    let values: Map<string, string>
    try {
      values = parseDotenv(await f.text())
    } catch (e) {
      setImported(e instanceof DotenvError ? `${f.name} is not a .env file this can read: ${e.message}.` : `${f.name} could not be read.`)
      return
    }
    if (values.size === 0) {
      setImported(`${f.name} holds no entries.`)
      return
    }
    setRows((rs) => {
      const out = [...rs]
      let k = nextKey(out)
      for (const [name, value] of values) {
        const at = out.findIndex((r) => r.name === name)
        const type = secret ? 'secret' : at >= 0 ? (out[at] as Row).type : 'variable'
        if (at >= 0) out[at] = { ...(out[at] as Row), value, type }
        else out.push({ key: k++, name, saved: false, value, type, note: '' })
      }
      return out
    })
    setImported(`Read ${values.size === 1 ? '1 entry' : `${values.size} entries`} from ${f.name}. Nothing is saved until you save.`)
  }
  return (
    <div className="space-y-2" data-testid="env-entries-editor">
      <p className="text-dense font-medium text-anvil-700 dark:text-anvil-200">Values</p>
      {rows.length === 0 ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">No entries yet.</p> : null}
      <ul className="space-y-2">
        {rows.map((r) => {
          const focused = focus.includes(r.name)
          return (
            <li key={r.key} className="flex flex-wrap items-center gap-2 rounded-md border border-anvil-100 p-2 dark:border-anvil-850" data-testid="env-row">
              {r.saved ? (
                <span className="min-w-0 break-all font-mono text-[12px] font-semibold">{r.name}</span>
              ) : (
                <Input aria-label="Name" placeholder="NAME" value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} className="w-40 font-mono" spellCheck={false} data-testid="env-name-input" />
              )}
              <ValueField row={r} focused={focused} onChange={(value) => update(r.key, { value })} />
              <select
                aria-label={`Type of ${r.name === '' ? 'the new entry' : r.name}`}
                value={r.type}
                onChange={(e) => update(r.key, { type: e.target.value as VarType })}
                className="rounded-md border border-anvil-300 bg-white px-2 py-1.5 text-[12px] dark:border-anvil-700 dark:bg-anvil-950"
              >
                <option value="secret">secret</option>
                <option value="variable">variable</option>
              </select>
              <Button variant="ghost" size="icon" aria-label={`Remove ${r.name === '' ? 'the new entry' : r.name}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setRows((rs) => [...rs, { key: nextKey(rs), name: '', saved: false, value: '', type: 'secret', note: '' }])} data-testid="env-add-row">
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add a value
        </Button>
        <Button size="sm" variant="outline" onClick={() => file.current?.click()} data-testid="env-import">
          <FileUp className="h-3.5 w-3.5" aria-hidden /> Import a .env file
        </Button>
        <label className="flex items-center gap-1.5 text-[12px] text-anvil-600 dark:text-anvil-300">
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> Import as secrets
        </label>
        <input
          ref={file}
          type="file"
          accept=".env,text/plain"
          className="hidden"
          data-testid="env-import-file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f !== undefined) void importFile(f)
          }}
        />
      </div>
      {imported !== null ? (
        <p className="text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="env-import-note">
          {imported}
        </p>
      ) : null}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">The file is read in this browser only. Saved values are encrypted for the people who can read this environment.</p>
    </div>
  )
}

/** What an {@link EnvChangeDialog} does. */
export type EnvChangeMode =
  | { readonly kind: 'create' }
  | { readonly kind: 'values'; readonly env: string; readonly focus?: readonly string[] }
  | { readonly kind: 'audience'; readonly env: string }
  | { readonly kind: 'again'; readonly env: string }
  | { readonly kind: 'mark'; readonly env: string }
  | { readonly kind: 'keep'; readonly env: string; readonly head: string }

/** What the dialog writes with: the book it starts from, the repo's people, and this tab's saver and reads. */
export interface EnvChangeContext {
  readonly book: EnvBook
  readonly people: PeopleView | null
  /** The repository owner (in every group). */
  readonly owner: string
  readonly viewer: string
  readonly saver: EnvSaver
  readonly io: MemberEnvIO
}

/**
 * One change to an environment: a form when it needs input (create, values, audience), then the
 * confirmation with what changes, who it is sealed for and its cost. `onSaved` re-reads the page.
 */
export function EnvChangeDialog({ mode, ctx, onClose, onSaved }: { mode: EnvChangeMode | null; ctx: EnvChangeContext; onClose: () => void; onSaved: () => void }): JSX.Element | null {
  const [plan, setPlan] = useState<SavePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  // a change that needs no input goes straight to its confirmation
  useEffect(() => {
    setPlan(null)
    setError(null)
    if (mode === null || mode.kind === 'create' || mode.kind === 'values' || mode.kind === 'audience') return
    try {
      if (mode.kind === 'again') setPlan(planSave(ctx.book, mode.env, { again: true }))
      else if (mode.kind === 'keep') setPlan(planSave(ctx.book, mode.env, { keep: mode.head }))
      else {
        const picked = markChangedNames(ctx.book, mode.env)
        if (!picked.ok) throw new EnvSaveError(picked.reason)
        setPlan(planSave(ctx.book, mode.env, { change: (n) => void n.markedChanged.push(...picked.names) }))
      }
    } catch (e) {
      setError(errText(e))
    }
    // only a new change resets it: a re-read of the page must not throw away a form or a confirmation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])
  if (mode === null) return null
  const close = (): void => {
    setPlan(null)
    setError(null)
    onClose()
  }
  if (plan !== null) return <SaveConfirm plan={plan} ctx={ctx} onClose={close} onSaved={onSaved} />
  if (mode.kind === 'create' || mode.kind === 'values' || mode.kind === 'audience') {
    return <EnvForm mode={mode} ctx={ctx} onClose={close} onPlan={setPlan} />
  }
  return (
    <Dialog open onClose={close} title="Can't save this change" footer={<Button onClick={close}>Close</Button>}>
      <p role="alert" className="text-dense text-danger-700 dark:text-danger-400" data-testid="env-change-refused">
        {error ?? 'Reading…'}
      </p>
    </Dialog>
  )
}

function EnvForm({
  mode,
  ctx,
  onClose,
  onPlan,
}: {
  mode: Extract<EnvChangeMode, { kind: 'create' | 'values' | 'audience' }>
  ctx: EnvChangeContext
  onClose: () => void
  onPlan: (p: SavePlan) => void
}): JSX.Element {
  const env0 = mode.kind === 'create' ? '' : mode.env
  const current = useMemo(() => {
    if (mode.kind === 'create') return null
    try {
      return planSave(ctx.book, mode.env, { again: true })
    } catch {
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])
  const [name, setName] = useState(env0)
  const [choice, setChoice] = useState<AudienceChoice>(current === null ? NO_CHOICE : choiceOf(current.audience, ctx.viewer))
  const [rows, setRows] = useState<Row[]>(() => (current === null ? [] : rowsOf(current.vars, mode.kind === 'values' ? (mode.focus ?? []) : [])))
  const [error, setError] = useState<string | null>(null)
  const env = name.trim()
  const audience = audienceOf(choice, ctx.viewer)
  const size = audience !== null && ctx.people !== null ? audienceSize(audience, ctx.people, ctx.viewer) : null
  const tooMany = size !== null && size > MAX_RECIPIENTS
  const editsValues = mode.kind !== 'audience'
  const editsAudience = mode.kind !== 'values'
  const nameTaken = mode.kind === 'create' && ctx.book.resolution.environments.some((e) => e.env === env)
  // Save waits for an audience (DESIGN §10: nothing is preselected), a valid new name, and an entry
  const ready =
    audience !== null && !tooMany && (mode.kind !== 'create' || (validEnvName(env) && !nameTaken && rows.length > 0))
  const title = mode.kind === 'create' ? 'New environment' : mode.kind === 'values' ? `Edit ${env0}` : `Change who can read ${env0}`
  const submit = (): void => {
    setError(null)
    try {
      const base = current?.vars ?? new Map<string, EnvVar>()
      const vars = editsValues ? varsOf(rows, base) : { vars: new Map(base) }
      if ('error' in vars) {
        setError(vars.error)
        return
      }
      onPlan(
        planSave(ctx.book, env, {
          ...(audience !== null && editsAudience ? { audience } : {}),
          change: (n) => {
            n.vars = vars.vars
          },
        }),
      )
    } catch (e) {
      setError(errText(e))
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!ready} data-testid="env-save">
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="env-form">
        {mode.kind === 'create' ? (
          <Field label="Name" htmlFor="env-name" hint="Letters, digits, dots, dashes and underscores, such as production.">
            <Input id="env-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="production" className="font-mono" spellCheck={false} autoFocus data-testid="env-new-name" />
          </Field>
        ) : null}
        {mode.kind === 'create' && env !== '' && !validEnvName(env) ? <p className="text-[12px] text-danger-700 dark:text-danger-400">That isn&apos;t an environment name.</p> : null}
        {nameTaken ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{env} exists already: edit it instead.</p> : null}
        {editsAudience ? <AudiencePicker env={env} value={choice} onChange={setChoice} people={ctx.people} viewer={ctx.viewer} /> : null}
        {mode.kind === 'audience' ? <p className="text-[12px] text-anvil-600 dark:text-anvil-300">It&apos;s saved again for the people you choose. Earlier versions stay readable by whoever could read them.</p> : null}
        {editsValues ? <EntriesEditor rows={rows} setRows={setRows} focus={mode.kind === 'values' ? (mode.focus ?? []) : []} /> : null}
        {mode.kind === 'create' && audience === null ? (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="env-choose-audience">
            Choose who can read it to save.
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

function NoteText({ env, note }: { env: string; note: ReturnType<typeof saveNotes>[number] }): JSX.Element {
  const name = useDpnsName(note.kind === 'skipped' ? note.who : '') ?? (note.kind === 'skipped' ? shortId(note.who) : '')
  return <li>{saveNoteText(env, note, () => name)}</li>
}

/** The confirmation of one change: sealed first (nothing signed), then stored on Confirm. */
function SaveConfirm({ plan, ctx, onClose, onSaved }: { plan: SavePlan; ctx: EnvChangeContext; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setPrepared(null)
    setProblem(null)
    if (plan.unchanged) return
    void (async () => {
      try {
        // the people its audience covers now, read fresh (a cached list never decides who reads it)
        const members = await ctx.io.members()
        const people = resolvePeople(plan.audience, { owner: ctx.owner, members })
        const p = await prepareSave(ctx.saver, draftOf(plan, people))
        if (live) setPrepared(p)
      } catch (e) {
        if (live) setProblem(errText(e))
      }
    })()
    return () => {
      live = false
    }
    // the plan and who saves it decide the seal; a re-read book or people list does not
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, ctx.saver, ctx.io, ctx.owner])
  const notes = prepared === null ? [] : saveNotes(ctx.book, plan, prepared.skipped)
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={plan.unchanged ? `${plan.env} is unchanged` : `Save ${plan.env}`}
      cost={plan.unchanged ? null : prepared === null ? 'pending' : previewCredits(prepared.credits)}
      confirmLabel="Sign & save"
      blocked={
        plan.unchanged ? (
          <p className="text-dense text-anvil-600 dark:text-anvil-300">{plan.env} already holds that. Nothing to save.</p>
        ) : problem !== null ? (
          <p role="alert" className="text-dense text-danger-700 dark:text-danger-400" data-testid="env-save-problem">
            {problem}
          </p>
        ) : undefined
      }
      onConfirm={async () => {
        if (prepared === null) throw new Error('not ready')
        await storeSave(ctx.saver, prepared)
        onSaved()
      }}
      successNote={`Saved ${plan.env}`}
    >
      {prepared !== null ? (
        <div className="space-y-2 text-dense text-anvil-700 dark:text-anvil-200" data-testid="env-save-summary">
          <p>
            Save {plan.env} for {sentToText(plan.audience, prepared.to.length)} ({changeSummary(plan.changes)})?
          </p>
          {notes.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-[12px] text-anvil-600 dark:text-anvil-300">
              {notes.map((n, i) => (
                <NoteText key={i} env={plan.env} note={n} />
              ))}
            </ul>
          ) : null}
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">One chunk and one record. Values are not shown.</p>
        </div>
      ) : problem === null && !plan.unchanged ? (
        <p className="text-dense text-anvil-500 dark:text-anvil-400">Encrypting it for its readers…</p>
      ) : null}
    </ConfirmDialog>
  )
}
