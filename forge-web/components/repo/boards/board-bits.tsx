'use client'

/**
 * Pieces the board layout's cards and the item panel share (`docs/design/boards.md` §4.1, §5.5),
 * beside the ones every board surface shares (`board-fields.tsx`): an item's state in words, and
 * a custom field's value as a small chip on a card.
 */

import type { BoardField, BoardItem, FieldValue } from '@/lib/rules/boards'

import { ColorDot, fieldValueText } from './board-fields'

/** What an item's state is called ("Open issue", "Merged pull request"). */
export function itemStateWords(item: Pick<BoardItem, 'kind' | 'state'>): string {
  if (item.kind === 'issue') return item.state === 'open' ? 'Open issue' : 'Closed issue'
  switch (item.state) {
    case 'merged':
      return 'Merged pull request'
    case 'closed':
      return 'Closed pull request'
    default:
      return 'Open pull request'
  }
}

/** A custom field's value as a chip on a card: `Estimate 3`, `● P1`, `Iteration 4`. */
export function FieldChip({ field, value }: { field: BoardField; value: FieldValue }): JSX.Element {
  const text = fieldValueText(field, value)
  const option = field.type === 'sel' ? field.options?.find((o) => o.id === value) : undefined
  // A number or a date names its field ("Estimate 3"); an option, an iteration or text speaks for itself.
  const shown = field.type === 'num' || field.type === 'date' ? `${field.name} ${text}` : text
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded border border-anvil-200 px-1.5 text-[11px] leading-[18px] text-anvil-600 dark:border-anvil-750 dark:text-anvil-300"
      title={`${field.name}: ${text}`}
      data-field={field.id}
    >
      {option !== undefined ? <ColorDot color={option.color} className="h-2 w-2" /> : null}
      <span className="truncate">{shown}</span>
    </span>
  )
}
