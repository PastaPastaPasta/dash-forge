/**
 * In-page `#fragment` links that keep Back working (QW4-005).
 *
 * A plain `<a href="#x">` (a Markdown heading anchor, a footnote, the skip link) is followed by the
 * browser, which adds a history entry with no state. Next's app router ignores a `popstate` to an
 * entry without its state, so after README → its `#building` anchor → a link to another file,
 * Back put the README's URL in the address bar and left the other file on screen, for good.
 *
 * This follows such links itself: `history.pushState` (which Next patches to copy its own state
 * onto the entry, so Back restores the page that pushed it), then what the browser would have
 * done: scroll the target into view (honouring `scroll-margin`), focus it when it takes focus
 * (the skip link's `<main tabIndex={-1}>`), and fire `hashchange` for listeners such as the file
 * view's line selection. A link a handler already handled (`preventDefault`), a modified or
 * non-primary click, a `target`ed or `download` link, and a fragment on another page are left to
 * the browser.
 */

/** The element a fragment names (an `id`, else an `<a name>`), or null. */
function fragmentTarget(doc: Document, hash: string): HTMLElement | null {
  let id = hash.slice(1)
  try {
    id = decodeURIComponent(id)
  } catch {
    /* keep it as written */
  }
  if (id === '') return null
  const named = doc.getElementsByName(id)[0]
  return doc.getElementById(id) ?? (named instanceof HTMLElement ? named : null)
}

/** What following `hash` shows: its target scrolled to (and focused when focusable), or the top. */
export function revealFragment(doc: Document, hash: string): void {
  const el = fragmentTarget(doc, hash)
  if (el === null) {
    if (hash === '#' || hash === '#top' || hash === '') doc.defaultView?.scrollTo(0, 0)
    return
  }
  // A target inside a closed <details> is shown first, as the browser does.
  for (let at = el.parentElement; at !== null; at = at.parentElement) if (at instanceof HTMLDetailsElement && !at.open) at.open = true
  el.scrollIntoView?.()
  // Focus only what asks for it (the skip link's `<main tabIndex={-1}>`), not a link or heading.
  if (el.hasAttribute('tabindex')) el.focus({ preventScroll: true })
}

/** Follow same-page `#fragment` link clicks through the router's history. Returns the uninstall. */
export function installHashLinkHistory(win: Window & typeof globalThis = window): () => void {
  const onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const start = e.target instanceof win.Element ? e.target : null
    const a = start?.closest('a[href]')
    if (!(a instanceof win.HTMLAnchorElement)) return
    if ((a.target !== '' && a.target !== '_self') || a.hasAttribute('download')) return
    // Only a link written as a fragment of this page (`#x`), not a full URL that happens to match.
    if (!(a.getAttribute('href') ?? '').startsWith('#')) return
    const to = new URL(a.href)
    const here = new URL(win.location.href)
    if (to.origin !== here.origin || to.pathname !== here.pathname || to.search !== here.search) return
    e.preventDefault()
    // The same fragment again: the browser scrolls to it and adds no entry.
    if (to.hash !== here.hash) {
      win.history.pushState(null, '', to.hash || here.pathname + here.search)
      win.dispatchEvent(new win.HashChangeEvent('hashchange', { oldURL: here.href, newURL: win.location.href }))
    }
    revealFragment(win.document, to.hash)
  }
  // A fragment change no click made (typed in the address bar, `location.hash = …`) still leaves an
  // entry with no router state, which Next's Back ignores. Mark it (through Next's patched
  // replaceState, which stores state without the router's marker): Back to it then reloads the
  // page at that URL instead of leaving another page on screen.
  const onHash = (): void => {
    const st: unknown = win.history.state
    if (st === null || typeof st !== 'object' || !('__NA' in st)) win.history.replaceState(null, '', win.location.href)
  }
  win.document.addEventListener('click', onClick)
  win.addEventListener('hashchange', onHash)
  return () => {
    win.document.removeEventListener('click', onClick)
    win.removeEventListener('hashchange', onHash)
  }
}
