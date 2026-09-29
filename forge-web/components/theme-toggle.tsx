'use client'

/**
 * Theme toggle — follow the system (the default, L-66), dark, or light. One button cycles
 * system → dark → light; the choice persists in localStorage (`next-themes`, key `theme`) and
 * is applied before first paint by next-themes' inline head script, so a reload never flashes
 * the other theme. Hydration-safe: the icon renders only after mount (the server cannot know
 * the stored choice).
 */

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

export const THEME_CYCLE = ['system', 'dark', 'light'] as const
export type ThemeChoice = (typeof THEME_CYCLE)[number]

/** The choice after `current` (an unknown stored value restarts the cycle at system). */
export function nextTheme(current: string | undefined): ThemeChoice {
  const i = THEME_CYCLE.indexOf(current as ThemeChoice)
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length] as ThemeChoice
}

const LABEL: Record<ThemeChoice, string> = { dark: 'dark', light: 'light', system: 'system' }

export function ThemeToggle(): JSX.Element {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const current: ThemeChoice = mounted && THEME_CYCLE.includes(theme as ThemeChoice) ? (theme as ThemeChoice) : 'system'
  const next = nextTheme(current)
  const Icon = current === 'light' ? Sun : current === 'system' ? Monitor : Moon
  return (
    <Button
      variant="ghost"
      size="icon"
      data-testid="theme-toggle"
      data-theme-choice={mounted ? current : undefined}
      aria-label={`Theme: ${LABEL[current]}. Switch to ${LABEL[next]}`}
      title={`Theme: ${LABEL[current]} (click for ${LABEL[next]})`}
      onClick={() => setTheme(next)}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </Button>
  )
}
