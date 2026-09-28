/**
 * Focus helpers for modal surfaces (dialogs, sheets): what can take focus inside a container,
 * where focus should land when one opens, and Tab / Shift+Tab wrapping so it never leaves.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Whether a key press is typing into a field (where `/` or `y` must stay a character). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

/**
 * Whether `e` is the single-key page shortcut `key` (`/` to search, `y` for a permalink): no
 * modifier, not typed into a field, not already handled, and no modal open (it keeps the keyboard).
 */
export function isPageShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented' | 'target'>, key: string): boolean {
  if (e.key !== key || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return false
  return document.querySelector('[aria-modal="true"]') === null
}

/** The tabbable elements of `root`, in DOM order (hidden ones — `display: none`, `inert` — excluded). */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length > 0,
  )
}

/**
 * Where focus belongs when `root` opens. React's `autoFocus` prop focuses its field during the
 * commit but is never written to the DOM, so it cannot be queried: when focus is already inside
 * `root` (an `autoFocus` field took it), it stays there; otherwise the panel itself.
 */
export function initialFocus(root: HTMLElement): HTMLElement {
  const active = document.activeElement
  return active instanceof HTMLElement && root.contains(active) ? active : root
}

/**
 * Keep Tab inside `root`: Tab moves to the next tabbable and wraps from the last to the first,
 * Shift+Tab to the previous and wraps from the first (or the panel itself) to the last. Focus
 * is always moved here, never left to the browser: Safari (and WebKit) by default tabs only
 * between text fields, so its own Tab from a button would leave the panel for the page behind.
 * Returns true when it handled the key.
 */
export function trapTab(
  root: HTMLElement,
  e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault' | 'defaultPrevented'>,
): boolean {
  // A widget inside that already used the Tab (an editor indenting) keeps it.
  if (e.key !== 'Tab' || e.defaultPrevented) return false
  e.preventDefault()
  const items = tabbables(root)
  const active = document.activeElement
  const at = active instanceof HTMLElement ? items.indexOf(active) : -1
  const step = e.shiftKey ? -1 : 1
  // Not on a tabbable (the panel itself, or outside): Tab starts at the first, Shift+Tab at the last.
  let next = at === -1 ? (e.shiftKey ? items.length - 1 : 0) : at + step
  // Skip any candidate that will not take focus (visibility: hidden has client rects).
  for (let tried = 0; tried < items.length; tried++, next += step) {
    const el = items[((next % items.length) + items.length) % items.length] as HTMLElement
    el.focus()
    if (document.activeElement === el) return true
  }
  root.focus()
  return true
}
