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
import { ACTIVE_NETWORK } from '@/lib/constants'

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
          heading="h1"
          icon={KeyRound}
          title="Sign in to Dash Forge"
          body={
            ACTIVE_NETWORK.v2 === null
              ? `Dash Forge is not deployed on ${ACTIVE_NETWORK.key}, so there is nothing to sign in to here. Read-only browsing of other networks needs their own build.`
              : 'Sign in with a Dash wallet, an identity file or your recovery phrase, or create a new identity. Reading works without signing in.'
          }
          action={<Button variant="primary" onClick={() => openLogin()}>Open sign-in</Button>}
        />
      )}
    </AppShell>
  )
}
