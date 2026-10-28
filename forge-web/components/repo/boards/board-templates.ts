/**
 * The new-board templates (design `docs/design/boards.md` §2.1-§2.3): each a complete board
 * definition the create dialog writes as is, editable afterwards in the board's settings.
 *
 * - **Kanban**: the rules' template (`defaultSpec`): Todo / In progress / Done, the home
 *   repository's issues and pull requests, Priority, Estimate and a two-week Iteration.
 * - **Sprint board**: Backlog / Todo / In progress / In review / Done, an Iteration (two weeks
 *   from this week's Monday) and an Estimate, with a "Current sprint" view.
 * - **Bug triage**: Needs triage / Confirmed / In progress / Fixed, sourcing the home
 *   repository's issues labelled `bug`, with a Priority.
 * - **Empty**: one column and no sources: it holds only the items members add.
 */

import { defaultSpec, mondayOf, type BoardField, type BoardSpec } from '@/lib/rules/boards'

export type BoardTemplateKey = 'kanban' | 'sprint' | 'triage' | 'empty'

export interface BoardTemplate {
  readonly key: BoardTemplateKey
  readonly name: string
  /** One line under the name in the create dialog. */
  readonly blurb: string
  /** The definition for a board of home repository `home` created at `now`. */
  spec(home: string, now: number): BoardSpec
}

const PRIORITY: BoardField = {
  id: 1,
  name: 'Priority',
  type: 'sel',
  options: [
    { id: 1, name: 'P0', color: '#d1242f' },
    { id: 2, name: 'P1', color: '#fb8f44' },
    { id: 3, name: 'P2', color: '#d4a72c' },
    { id: 4, name: 'P3', color: '#8c959f' },
  ],
}

export const BOARD_TEMPLATES: readonly BoardTemplate[] = [
  {
    key: 'kanban',
    name: 'Kanban',
    blurb: 'Todo, In progress and Done, with priority, estimate and iterations.',
    spec: defaultSpec,
  },
  {
    key: 'sprint',
    name: 'Sprint board',
    blurb: 'Two-week sprints from backlog to review, with estimates.',
    spec: (home, now) => ({
      v: 1,
      columns: [
        { id: 1, name: 'Backlog' },
        { id: 2, name: 'Todo' },
        { id: 3, name: 'In progress' },
        { id: 4, name: 'In review' },
        { id: 5, name: 'Done' },
      ],
      def: 1,
      done: 5,
      sources: [{ r: home, k: 'a', q: '' }],
      fields: [
        { id: 1, name: 'Iteration', type: 'iter', start: mondayOf(now), days: 14 },
        { id: 2, name: 'Estimate', type: 'num' },
      ],
      views: [
        { id: 1, name: 'Board', layout: 'board', q: '' },
        { id: 2, name: 'Current sprint', layout: 'board', q: 'iteration:@current' },
        { id: 3, name: 'Table', layout: 'table', q: '', group: 'f1', cols: ['title', 'status', 'assignees', 'f1', 'f2'] },
        { id: 4, name: 'Roadmap', layout: 'roadmap', q: '', date: [1] },
      ],
      arch: 14,
    }),
  },
  {
    key: 'triage',
    name: 'Bug triage',
    blurb: 'Every issue labelled bug, from triage to fixed.',
    spec: (home) => ({
      v: 1,
      columns: [
        { id: 1, name: 'Needs triage' },
        { id: 2, name: 'Confirmed' },
        { id: 3, name: 'In progress' },
        { id: 4, name: 'Fixed' },
      ],
      def: 1,
      done: 4,
      sources: [{ r: home, k: 'i', q: 'label:bug' }],
      fields: [PRIORITY],
      views: [
        { id: 1, name: 'Board', layout: 'board', q: '' },
        { id: 2, name: 'By priority', layout: 'table', q: 'is:open', group: 'f1', cols: ['title', 'status', 'assignees', 'labels', 'f1'] },
      ],
      arch: 14,
    }),
  },
  {
    key: 'empty',
    name: 'Empty',
    blurb: 'One column and nothing added for you.',
    spec: () => ({ v: 1, columns: [{ id: 1, name: 'Todo' }], def: 1, done: 0, sources: [], fields: [], views: [], arch: 0 }),
  },
]

/** A template by key (Kanban for an unknown one). */
export function boardTemplate(key: string): BoardTemplate {
  return BOARD_TEMPLATES.find((t) => t.key === key) ?? (BOARD_TEMPLATES[0] as BoardTemplate)
}
