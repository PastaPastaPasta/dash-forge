'use client'

/** `/mirror` — the GitHub mirror setup wizard (`components/mirror/mirror-wizard.tsx`). */

import { AppShell } from '@/components/app-shell'
import { MirrorWizard } from '@/components/mirror/mirror-wizard'

export default function MirrorPage(): JSX.Element {
  return (
    <AppShell>
      <MirrorWizard />
    </AppShell>
  )
}
