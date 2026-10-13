import { shortId } from '@/lib/utils'
import type { PersonInputState } from '@/hooks/use-person-input'

/** Under a member field: that a typed name is being looked up, or which identity it resolved to. */
export function ResolvedPerson({ person }: { person: PersonInputState }): JSX.Element | null {
  if (person.resolving) return <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">Looking up the name…</p>
  if (person.name === null || person.id === null) return null
  return (
    <p className="mt-1 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="member-resolved">
      {person.name} is {shortId(person.id)}.
    </p>
  )
}
