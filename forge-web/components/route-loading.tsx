'use client'

/**
 * The page frame for query-param pages (`/repo?owner=&name=`, `/u?name=`). Their content reads
 * `useSearchParams`, so a static export renders it on the client only (a Suspense bailout). The
 * chrome is rendered OUTSIDE that Suspense: the header is in the exported HTML and hydrates with
 * the page (its Sign in works as soon as the app does, and it is not remounted when the content
 * resolves); only the content area shows a spinner until then.
 */

import { Suspense, type ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { LoadingBlock } from '@/components/ui/states'

export function QueryPage({ wide = false, children }: { wide?: boolean; children: ReactNode }): JSX.Element {
  return (
    <AppShell wide={wide}>
      <Suspense fallback={<LoadingBlock />}>{children}</Suspense>
    </AppShell>
  )
}
