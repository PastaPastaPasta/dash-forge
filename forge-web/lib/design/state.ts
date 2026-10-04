/**
 * The colours of an issue's or a pull request's state, as GitHub draws them: open is green,
 * merged and completed are violet, a closed pull request is red, and draft and not planned are
 * grey. They are their own tokens (`--state-*` in app/globals.css), never the trust colours:
 * green "verified", red "failed" and Dash blue keep one meaning each (style guide §A).
 *
 * `lib/design/contrast.test.ts` checks the text tokens on every surface and the fills behind
 * white text, in both themes. The shape (icon) always differs too, so colour is never the only
 * signal.
 */

/** Where an issue or pull request is. `done`: merged, or closed as completed. `skipped`: closed as not planned or a duplicate. */
export type WorkState = 'open' | 'draft' | 'done' | 'closed' | 'skipped'

/** Icon and text colour of a state, on the page's surfaces. */
export const STATE_TEXT: Readonly<Record<WorkState, string>> = {
  open: 'text-state-open',
  draft: 'text-state-draft',
  done: 'text-state-done',
  closed: 'text-state-closed',
  skipped: 'text-state-draft',
}

/** A state badge's fill, behind white text. */
export const STATE_FILL: Readonly<Record<WorkState, string>> = {
  open: 'bg-state-open-fill',
  draft: 'bg-state-draft-fill',
  done: 'bg-state-done-fill',
  closed: 'bg-state-closed-fill',
  skipped: 'bg-state-draft-fill',
}

/** A pull request's state. */
export function pullState(state: { readonly open: boolean; readonly merged: boolean; readonly draft?: boolean | undefined }): WorkState {
  if (state.merged) return 'done'
  if (!state.open) return 'closed'
  return state.draft === true ? 'draft' : 'open'
}
