'use client'

/**
 * `/connect` — where a wallet returns after an App Connect v2 approval (`cb` in the request).
 * Static: it only passes the wallet's nudge to the tab that showed the code
 * (`components/auth/connect-return.tsx`, `lib/auth/connect-callback.ts`).
 */

import { AppShell } from '@/components/app-shell'
import { ConnectReturn } from '@/components/auth/connect-return'

export default function ConnectPage(): JSX.Element {
  return (
    <AppShell>
      <ConnectReturn />
    </AppShell>
  )
}
