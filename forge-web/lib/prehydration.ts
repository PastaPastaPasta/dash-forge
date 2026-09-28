/**
 * Taps before hydration. The static page shows its buttons a second or more before React
 * attaches their handlers (longer on a slow phone); without this, a tap on "Sign in" in that
 * window does nothing and the site looks broken.
 *
 * {@link prehydrationScript} runs inline in <head>, before the body is parsed. It catches a
 * click on a button that names an intent (`data-replay="sign-in"`) and keeps the newest intent,
 * marking that button busy (`aria-busy`, a progress cursor). The component that owns the button
 * consumes the intent in its own mount effect ({@link consumePrehydrationIntent}) and acts on it
 * (the header opens the sign-in sheet). The intent is a name, not a node: it does not depend on
 * which DOM node React keeps. Stopping the catcher (Providers, whichever effect runs first) never
 * drops a recorded intent; an intent older than {@link INTENT_TTL_MS} is ignored instead, so a
 * header that mounts much later (behind a slow boundary, or after a navigation) cannot act on a
 * stale tap. Keep the header out of any Suspense boundary all the same (`QueryPage`).
 *
 * - Only buttons with `data-replay` are caught; any other tap before hydration does what it did
 *   before (nothing for a button, navigation for a link). An intent is only for a button whose
 *   action is safe to do a moment later: it opens something, it never writes.
 * - After {@link STOP_AFTER_MS}, or when a script fails to load, the catcher stops and the busy
 *   state clears, so a page that never hydrates does not keep a spinner forever.
 * - The replayed action runs in an effect, without the user's click: browser APIs that need a
 *   fresh user activation (a popup, the clipboard, a passkey prompt) may refuse it. The sign-in
 *   sheet needs none; it asks for any of those on the user's next click inside it.
 * - A capture-phase click handler added later (`onClickCapture`) on an ancestor of a replay
 *   button would never see a caught tap: this listener stops it first, on the document.
 *
 * CSP: it runs under `script-src 'unsafe-inline'`, which the layout's meta CSP grants for Next's
 * own inline bootstrap scripts (`self.__next_f.push(…)`). A `'sha256-…'` source for this script
 * alone cannot be added: a hash in `script-src` makes browsers ignore `'unsafe-inline'`, which
 * refuses Next's scripts and stops the app hydrating (checked in Chromium and WebKit on the
 * static export). A strict CSP needs every inline script hashed per page at export time.
 */

/** The window property the inline script keeps its state on. */
export const PREHYDRATION_KEY = '__forgePrehydration'

/** How long the catcher waits for the app before giving up (and clearing the busy look). */
export const STOP_AFTER_MS = 12_000

/** How long a caught tap stays actionable. */
export const INTENT_TTL_MS = 15_000

/** The intents a button can carry (`data-replay`). */
export type PrehydrationIntent = 'sign-in'

interface PrehydrationState {
  intent: string | null
  at: number
  stop: () => void
}

/** The inline <head> script (a string: it runs before any bundle loads). */
export function prehydrationScript(): string {
  return `(function(){
  var KEY=${JSON.stringify(PREHYDRATION_KEY)};
  if (window[KEY]) return;
  var busy = null, prior = null;
  function clearBusy(){
    if (!busy) return;
    if (prior === null) busy.removeAttribute('aria-busy'); else busy.setAttribute('aria-busy', prior);
    busy.removeAttribute('data-prehydrate-pending');
    busy = null; prior = null;
  }
  var state = { intent: null, at: 0, stop: function(){} };
  function onClick(e){
    var t = e.target;
    var b = t && t.closest ? t.closest('button[data-replay]') : null;
    if (!b || b.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    clearBusy();
    state.intent = b.getAttribute('data-replay');
    state.at = Date.now();
    busy = b; prior = b.getAttribute('aria-busy');
    b.setAttribute('aria-busy','true');
    b.setAttribute('data-prehydrate-pending','');
  }
  function onError(e){ if (e.target && e.target.tagName === 'SCRIPT') state.stop(); }
  var timer = setTimeout(function(){ state.stop(); }, ${STOP_AFTER_MS});
  document.addEventListener('click', onClick, true);
  window.addEventListener('error', onError, true);
  state.stop = function(){
    clearTimeout(timer);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('error', onError, true);
    clearBusy();
  };
  window[KEY] = state;
})();`
}

type WithState = Window & { [PREHYDRATION_KEY]?: PrehydrationState }

/**
 * Whether a tap before hydration asked for `intent`; true at most once per page load (the first
 * caller takes it). Also stops the catcher: from now on a tap reaches the button's own handler.
 * Call it from the owning component's mount effect.
 */
export function consumePrehydrationIntent(intent: PrehydrationIntent, win: WithState = window as WithState, now = Date.now()): boolean {
  const state = win[PREHYDRATION_KEY]
  if (state === undefined) return false
  state.stop()
  const wanted = state.intent === intent && now - state.at <= INTENT_TTL_MS
  if (state.intent === intent) state.intent = null
  return wanted
}

/** Stop catching (the app is up): a tap now reaches the buttons' handlers. The busy look clears. */
export function stopPrehydrationCatcher(win: WithState = window as WithState): void {
  win[PREHYDRATION_KEY]?.stop()
}
