'use client'

/**
 * Settings → Diffs and merges: the browser-merge identity (who a merge commit is authored by)
 * and the diff display choices. All stored in this browser; nothing here is secret.
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
      <fieldset className="space-y-1.5 border-t border-anvil-100 pt-3 dark:border-anvil-850">
        <legend className="text-dense font-medium text-anvil-700 dark:text-anvil-200">Diffs</legend>
        <label className="flex items-center gap-2 text-dense coarse:min-h-11">
          <input type="checkbox" checked={prefs.diffLayout === 'split'} onChange={(e) => update({ diffLayout: e.target.checked ? 'split' : 'unified' })} />
          Side by side on wide screens
        </label>
        <label className="flex items-center gap-2 text-dense coarse:min-h-11">
          <input type="checkbox" checked={prefs.ignoreWhitespace} onChange={(e) => update({ ignoreWhitespace: e.target.checked })} />
          Hide whitespace changes
        </label>
        <label className="flex items-center gap-2 text-dense coarse:min-h-11">
          <input type="checkbox" checked={prefs.palette === 'colorblind'} onChange={(e) => update({ palette: e.target.checked ? 'colorblind' : 'standard' })} />
          Blue/orange diff colors (color-blind friendly)
        </label>
      </fieldset>
    </div>
  )
}
