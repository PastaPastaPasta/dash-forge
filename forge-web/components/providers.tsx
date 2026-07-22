'use client'

import { ThemeProvider } from 'next-themes'
import type { ReactNode } from 'react'

/**
 * App-wide client providers. Dark mode is the primary theme (class-based, per style guide);
 * light mode fully supported. `next-themes` toggles the `class` on <html>.
 */
export function Providers({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  )
}
