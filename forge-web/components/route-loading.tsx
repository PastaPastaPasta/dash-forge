'use client'

/** The SSG fallback shell for query-param pages — chrome + a quiet spinner until hydration. */

import { AppShell } from '@/components/app-shell'
import { LoadingBlock } from '@/components/ui/states'

export function RouteLoading({ wide = false }: { wide?: boolean }): JSX.Element {
  return (
    <AppShell wide={wide}>
      <LoadingBlock />
    </AppShell>
  )
}
