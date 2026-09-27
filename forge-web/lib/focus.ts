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
 * Keep Tab inside `root`: from the last tabbable Tab wraps to the first, from the first (or the
 * panel itself) Shift+Tab wraps to the last. Returns true when it moved focus.
 */
export function trapTab(root: HTMLElement, e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>): boolean {
  if (e.key !== 'Tab') return false
  const items = tabbables(root)
  const active = document.activeElement
  if (items.length === 0) {
    e.preventDefault()
    root.focus()
    return true
  }
  const first = items[0] as HTMLElement
  const last = items[items.length - 1] as HTMLElement
  const inside = active instanceof Node && root.contains(active)
  if (e.shiftKey && (!inside || active === first || active === root)) {
    e.preventDefault()
    last.focus()
    return true
  }
  if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault()
    first.focus()
    return true
  }
  return false
}
