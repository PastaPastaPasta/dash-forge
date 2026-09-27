'use client'

/**
 * Settings → Diffs: the diff display choices, stored in this browser (nothing here is secret).
 */

import { usePrefs } from '@/hooks/use-prefs'

export function DisplayPrefsPanel(): JSX.Element {
  const [prefs, update] = usePrefs()
  return (
    <div className="space-y-3" data-testid="display-prefs">
      <fieldset className="space-y-1.5">
        <legend className="text-dense font-medium text-anvil-700 dark:text-anvil-200">Diffs</legend>
        <label className="flex items-center gap-2 text-dense">
          <input type="checkbox" checked={prefs.diffLayout === 'split'} onChange={(e) => update({ diffLayout: e.target.checked ? 'split' : 'unified' })} />
          Side by side on wide screens
        </label>
        <label className="flex items-center gap-2 text-dense">
          <input type="checkbox" checked={prefs.ignoreWhitespace} onChange={(e) => update({ ignoreWhitespace: e.target.checked })} />
          Hide whitespace changes
        </label>
        <label className="flex items-center gap-2 text-dense">
          <input type="checkbox" checked={prefs.palette === 'colorblind'} onChange={(e) => update({ palette: e.target.checked ? 'colorblind' : 'standard' })} />
          Blue/orange diff colors (color-blind friendly)
        </label>
      </fieldset>
    </div>
  )
}
