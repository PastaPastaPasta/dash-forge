'use client'

/**
 * The Markdown field of every issue, pull request, comment and review: Write / Preview tabs (the
 * preview renders exactly what will be shown), Cmd/Ctrl+Enter for the composer's main action,
 * Cmd/Ctrl+B, I, E and K to format, Cmd/Ctrl+Shift+P to switch tabs, and Escape to cancel an
 * edit. When the main action is a paid write, the line under the field says so, with its cost,
 * so a keyboard submit is never a surprise.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { MarkdownView, type MarkdownLinks, type SuggestionContext } from '@/components/markdown-view'
import { Textarea } from '@/components/ui/input'
import type { CostPreview } from '@/lib/sdk'
import { formatDash } from '@/lib/view/format'
import { applyFormat, formatForKey } from '@/lib/view/markdown-format'
import { cn } from '@/lib/utils'
import { useMacKeys } from '@/hooks/use-mac-keys'

const EDITOR_HINT = 'Markdown supported. #12 links an issue, @name a profile.'

type Tab = 'write' | 'preview'

/** The key ends or belongs to an input method's composition (Safari reports keyCode 229 for it). */
function composing(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229
}

/** Cmd+Enter or Ctrl+Enter (not while an input method is composing) runs `submit`. */
export function submitShortcut(e: KeyboardEvent<HTMLElement>, submit: () => void): boolean {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || composing(e)) return false
  e.preventDefault()
  submit()
  return true
}

/**
 * The platform's shortcut modifier is held: ⌘ on a Mac, where Ctrl+B, E and K are the text
 * field's own caret and delete commands; Ctrl elsewhere.
 */
function modHeld(e: KeyboardEvent<HTMLElement>, mac: boolean): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/** Cmd/Ctrl+Shift+P: the other tab, as on GitHub. */
function isTabToggle(e: KeyboardEvent<HTMLElement>, mac: boolean): boolean {
  return modHeld(e, mac) && e.shiftKey && e.key.toLowerCase() === 'p'
}

/**
 * Replace `before` with `after` in `el` through the browser's editing (`insertText`), so the
 * change is one step of the field's own undo; false where that is not available.
 */
function insertAsEdit(el: HTMLTextAreaElement, before: string, after: string): boolean {
  if (typeof document.execCommand !== 'function') return false
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  el.focus()
  el.setSelectionRange(head, before.length - tail)
  try {
    return document.execCommand('insertText', false, after.slice(head, after.length - tail))
  } catch {
    return false
  }
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as { current: T | null }).current = value
}

const kbd = 'rounded border border-anvil-300 bg-anvil-50 px-1 font-sans text-[11px] dark:border-anvil-700 dark:bg-anvil-850'

export function MarkdownEditor({
  id,
  label,
  value,
  onChange,
  placeholder,
  links,
  className,
  autoFocus,
  textareaRef,
  tools,
  suggestion = null,
  hint = EDITOR_HINT,
  onSubmit,
  submitLabel = 'submit',
  cost,
  onCancel,
  changed = false,
  initialTab = 'write',
  onTabChange,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  links?: MarkdownLinks
  className?: string
  autoFocus?: boolean
  textareaRef?: Ref<HTMLTextAreaElement>
  /** Buttons beside the tabs (a review comment's "Insert a suggestion"). */
  tools?: ReactNode
  /** How the preview shows ```suggestion blocks (a review comment on lines); keep it stable. */
  suggestion?: SuggestionContext | null
  /** The line under the field; null: none. */
  hint?: string | null
  /** Cmd+Enter (Ctrl+Enter) in the field: the composer's main action, as on GitHub. */
  onSubmit?: (() => void) | undefined
  /** What that action is called in the shortcut cue ("comment", "save"). */
  submitLabel?: string
  /** The action's price, when it is a paid write: named in the shortcut cue. */
  cost?: CostPreview | undefined
  /** Escape in the field (an edit's Cancel). */
  onCancel?: (() => void) | undefined
  /** The text differs from what was there: Escape asks before it discards it. */
  changed?: boolean
  /** The tab the field opens on (a composer that remounts restores it). */
  initialTab?: Tab
  /** Told when the viewer switches tab. */
  onTabChange?: (tab: Tab) => void
}): JSX.Element {
  const [tab, setTabState] = useState<Tab>(initialTab)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  // Where focus goes after a keyboard tab switch: the field it left, or the preview it opened.
  const focusAfter = useRef<Tab | null>(null)
  // The selection to restore once a formatting shortcut's new value is rendered.
  const selection = useRef<{ start: number; end: number } | null>(null)
  const mac = useMacKeys()
  const setFieldRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      field.current = el
      assignRef(textareaRef, el)
    },
    [textareaRef],
  )
  const setTab = (next: Tab): void => {
    setTabState(next)
    onTabChange?.(next)
  }
  useEffect(() => {
    if (focusAfter.current === 'write') field.current?.focus()
    if (focusAfter.current === 'preview') panel.current?.focus()
    focusAfter.current = null
  }, [tab])
  useLayoutEffect(() => {
    const sel = selection.current
    if (sel === null || field.current === null) return
    selection.current = null
    field.current.setSelectionRange(sel.start, sel.end)
  }, [value])

  const toggleTab = (e: KeyboardEvent<HTMLElement>, to: Tab): void => {
    e.preventDefault()
    focusAfter.current = to
    setTab(to)
  }

  const onFieldKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (onSubmit && submitShortcut(e, onSubmit)) return
    if (isTabToggle(e, mac)) return toggleTab(e, 'preview')
    if (e.key === 'Escape' && onCancel && !composing(e)) {
      e.preventDefault()
      if (!changed || window.confirm('Discard your changes?')) onCancel()
      return
    }
    if (!modHeld(e, mac) || e.shiftKey || e.altKey) return
    const format = formatForKey(e.key)
    if (format === null) return
    e.preventDefault()
    const el = e.currentTarget
    const edited = applyFormat(value, el.selectionStart, el.selectionEnd, format)
    selection.current = { start: edited.start, end: edited.end }
    if (!insertAsEdit(el, value, edited.value)) onChange(edited.value)
  }

  const onPreviewKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (onSubmit && submitShortcut(e, onSubmit)) return
    if (isTabToggle(e, mac)) toggleTab(e, 'write')
  }

  const tabClass = (on: boolean) =>
    cn(
      'rounded-t px-3 py-1.5 text-dense font-medium coarse:min-h-11',
      on ? 'border border-b-0 border-anvil-200 bg-white text-anvil-900 dark:border-anvil-750 dark:bg-anvil-950 dark:text-anvil-50' : 'text-anvil-500 dark:text-anvil-400 hover:text-anvil-800 dark:text-anvil-400',
    )
  const mod = mac ? '⌘' : 'Ctrl'
  const cueId = `${id}-cue`
  return (
    <div className={className}>
      <div className="flex flex-wrap items-end gap-1">
        <div role="tablist" aria-label="Write or preview" className="flex gap-1">
          <button type="button" role="tab" aria-selected={tab === 'write'} className={tabClass(tab === 'write')} onClick={() => setTab('write')} title={`Write (${mod}+Shift+P)`}>
            Write
          </button>
          <button type="button" role="tab" aria-selected={tab === 'preview'} className={tabClass(tab === 'preview')} onClick={() => setTab('preview')} title={`Preview (${mod}+Shift+P)`}>
            Preview
          </button>
        </div>
        {tools ? <div className="ml-auto flex items-center gap-1 pb-1">{tools}</div> : null}
      </div>
      {tab === 'write' ? (
        <>
          <label htmlFor={id} className="sr-only">{label}</label>
          <Textarea
            ref={setFieldRef}
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onFieldKey}
            aria-keyshortcuts={onSubmit ? 'Meta+Enter Control+Enter' : undefined}
            aria-describedby={onSubmit ? cueId : undefined}
            placeholder={placeholder}
            className="min-h-[120px] rounded-tl-none"
            autoFocus={autoFocus}
          />
        </>
      ) : (
        <div
          ref={panel}
          role="tabpanel"
          tabIndex={0}
          onKeyDown={onPreviewKey}
          aria-label="Rendered preview"
          className="min-h-[120px] rounded-md rounded-tl-none border border-anvil-300 px-3 py-2 dark:border-anvil-700"
          data-testid="markdown-preview"
        >
          {value.trim() === '' ? <p className="italic text-anvil-500 dark:text-anvil-400">Nothing to preview.</p> : <MarkdownView source={value} links={links} suggestion={suggestion} />}
        </div>
      )}
      {hint !== null || onSubmit ? (
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[12px] text-anvil-500 dark:text-anvil-400">
          {hint !== null ? <p>{hint}</p> : <span />}
          {onSubmit ? (
            <p id={cueId} data-testid="submit-cue">
              <kbd className={kbd}>{mod}</kbd>+<kbd className={kbd}>Enter</kbd> to {submitLabel}
              {cost !== undefined && cost.credits > 0 ? <span className="text-dash-600 dark:text-dash-400"> · costs ~{formatDash(cost.dash)} DASH</span> : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
