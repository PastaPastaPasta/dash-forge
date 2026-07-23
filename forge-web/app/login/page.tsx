'use client'

/** `/login` — a dedicated entry point that opens the sign-in modal (also reachable from the header). */

import { useEffect } from 'react'
import Link from 'next/link'
import { KeyRound } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/states'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { IdentityPill } from '@/components/ui/identity-pill'

export default function LoginPage(): JSX.Element {
  const openLogin = useUiStore((s) => s.openLogin)
  const { identity } = useAuth()

  useEffect(() => {
    if (!identity) openLogin()
  }, [identity, openLogin])

  return (
    <AppShell>
      {identity ? (
        <EmptyState
          title="You're signed in"
          body="Your key is in the browser keystore for this network."
          action={
            <div className="flex items-center gap-3">
              <IdentityPill identityId={identity} />
              <Link href="/"><Button variant="primary">Go to discovery</Button></Link>
            </div>
          }
        />
      ) : (
        <EmptyState
          icon={KeyRound}
          title="Sign in to Dash Forge"
          body="Import an identity file or paste a key + id. Read-only browsing works without signing in."
          action={<Button variant="primary" onClick={openLogin}>Open sign-in</Button>}
        />
      )}
    </AppShell>
  )
}
