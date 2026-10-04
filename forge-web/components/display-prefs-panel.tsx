'use client'

/**
 * Settings → Merge commits: who a merge commit made in this browser is authored by. Stored in
 * this browser; nothing here is secret. How diffs show is under Appearance (appearance-panel.tsx).
 */

import { Field, Input } from '@/components/ui/input'
import { usePrefs } from '@/hooks/use-prefs'
import { mergeIdentityValid } from '@/lib/view/prefs'

export function DisplayPrefsPanel(): JSX.Element {
  const [prefs, update] = usePrefs()
  const invalid = (prefs.mergeName !== '' || prefs.mergeEmail !== '') && !mergeIdentityValid(prefs)
  return (
    <div className="space-y-3" data-testid="display-prefs">
      <p className="text-dense text-anvil-600 dark:text-anvil-300">
        A merge commit made in this browser is authored and committed with this name and email, like git&apos;s user.name and
        user.email.
      </p>
      <Field label="Merge commit name" htmlFor="merge-name">
        <Input id="merge-name" value={prefs.mergeName} onChange={(e) => update({ mergeName: e.target.value })} placeholder="Alice Example" />
      </Field>
      <Field label="Merge commit email" htmlFor="merge-email">
        <Input id="merge-email" type="email" value={prefs.mergeEmail} onChange={(e) => update({ mergeEmail: e.target.value })} placeholder="alice@example.com" />
      </Field>
      {invalid ? <p className="text-[12px] text-danger-700 dark:text-danger-400">Enter a name and an email address (no &lt; or &gt;).</p> : null}
    </div>
  )
}
