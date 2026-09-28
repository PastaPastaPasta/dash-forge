/**
 * Clicks before hydration (the static page shows its buttons a second or more before React
 * attaches their handlers, longer on a slow phone). Without this a tap on "Sign in" in that
 * window does nothing, and the site looks broken.
 *
 * {@link prehydrationScript} runs inline in <head>, before the body is parsed. It catches a
 * click on a button (not one inside a link: a link navigates on its own), keeps the newest as
 * the pending intent, and marks that button busy (`aria-busy`, `data-prehydrate-pending`: a
 * progress cursor and a dimmed look). Once the app has hydrated, {@link replayPrehydrationClick}
 * stops catching and clicks the pending button again, now with its handler, if it is still on
 * the page. Everything is plain DOM: the nodes React hydrates are the same ones.
 *
 * CSP: it runs under `script-src 'unsafe-inline'`, which the layout's meta CSP grants for Next's
 * own inline bootstrap scripts (`self.__next_f.push(…)`). A `'sha256-…'` source for this script
 * alone cannot be added: a hash in `script-src` makes browsers ignore `'unsafe-inline'`, which
 * refuses Next's scripts and stops the app hydrating (checked in Chromium and WebKit on the
 * static export). A strict CSP needs every inline script hashed per page at export time.
 */

/** The window property the inline script keeps its state on. */
export const PREHYDRATION_KEY = '__forgePrehydration'

interface PrehydrationState {
  pending: Element | null
  stop: () => void
}

/** The inline <head> script (a string: it runs before any bundle loads). */
export function prehydrationScript(): string {
  return `(function(){
  var KEY=${JSON.stringify(PREHYDRATION_KEY)};
  if (window[KEY]) return;
  var state = { pending: null, stop: function(){} };
  function onClick(e){
    var t = e.target;
    var b = t && t.closest ? t.closest('button') : null;
    if (!b || b.disabled || b.closest('a')) return;
    e.preventDefault();
    e.stopPropagation();
    if (state.pending && state.pending !== b) { state.pending.removeAttribute('aria-busy'); state.pending.removeAttribute('data-prehydrate-pending'); }
    state.pending = b;
    b.setAttribute('aria-busy','true');
    b.setAttribute('data-prehydrate-pending','');
  }
  document.addEventListener('click', onClick, true);
  state.stop = function(){ document.removeEventListener('click', onClick, true); };
  window[KEY] = state;
})();`
}

/**
 * Called once the app has hydrated: stop catching clicks, and replay the pending one (if its
 * button is still on the page and enabled). Returns the button it clicked, or null.
 */
export function replayPrehydrationClick(win: Window & { [PREHYDRATION_KEY]?: PrehydrationState } = window as never): Element | null {
  const state = win[PREHYDRATION_KEY]
  if (state === undefined) return null
  state.stop()
  const b = state.pending
  state.pending = null
  if (b === null) return null
  b.removeAttribute('aria-busy')
  b.removeAttribute('data-prehydrate-pending')
  if (!b.isConnected || (b as HTMLButtonElement).disabled) return null
  ;(b as HTMLElement).click()
  return b
}
