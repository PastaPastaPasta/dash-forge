'use client'

/**
 * Settings → Appearance: the theme and how diffs show. Kept in this browser, and shown signed out
 * too: reading needs no identity, so neither does choosing how it looks.
 */

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { usePrefs } from '@/hooks/use-prefs'
import { THEME_CYCLE, type ThemeChoice } from '@/components/theme-toggle'

const THEME_LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' }

export function AppearancePanel(): JSX.Element {
  const { theme, setTheme } = useTheme()
  // The stored theme is known only in the browser: no radio is checked until then.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const current = mounted ? ((THEME_CYCLE as readonly string[]).includes(theme ?? '') ? theme : 'system') : undefined
  const [prefs, update] = usePrefs()

  return (
    <div className="space-y-4" data-testid="appearance">
      <fieldset>
        <legend className="mb-1.5 text-dense font-medium text-anvil-700 dark:text-anvil-200">Theme</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <label key={t} className="flex items-center gap-2 text-dense coarse:min-h-11">
              <input type="radio" name="theme" value={t} checked={current === t} onChange={() => setTheme(t)} />
              {THEME_LABEL[t]}
            </label>
          ))}
        </div>
        <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">System follows your device&apos;s light or dark setting.</p>
      </fieldset>
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
          Blue and orange diff colors, for red-green color blindness
        </label>
      </fieldset>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Saved in this browser only.</p>
    </div>
  )
}
