/** How long a new browser key lives: 30 days to a year (TS-06: a longer key means rarer renewals). */

import { KEY_LIFETIME_DAYS, lifetimeLabel } from '@/lib/auth'
import { Field } from '@/components/ui/input'

export function KeyLifetimeSelect({ id, value, onChange }: { readonly id: string; readonly value: number; readonly onChange: (days: number) => void }): JSX.Element {
  return (
    <Field label="Key expires after" htmlFor={id}>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-md border border-anvil-300 bg-transparent px-2 py-1.5 text-dense coarse:h-11 coarse:text-base dark:border-anvil-700"
      >
        {KEY_LIFETIME_DAYS.map((d) => (
          <option key={d} value={d}>
            {lifetimeLabel(d)}
          </option>
        ))}
      </select>
    </Field>
  )
}
