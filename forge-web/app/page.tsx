import { GitBranch, Hammer, Lock, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { IdentityPill } from '@/components/ui/identity-pill'
import { VerificationChip } from '@/components/ui/verification-chip'
import { DEFAULT_NETWORK } from '@/lib/constants'

// Landing placeholder. Not the real discovery page — it exists to DEMONSTRATE the
// design system (foundry-dark surfaces, ember accent, mono OIDs, signature elements)
// so the tokens are exercised end-to-end. All real routes are query-param addressed.

const SAMPLE_OID = 'e3f9a1b2c3d4e5f60718293a4b5c6d7e8f901234'
const SAMPLE_IDENTITY = '5Dtb9k4wKf3Jpq3mR7nTgH2vQxYzA1BcD8eF6gH9jK'

export default function LandingPage(): JSX.Element {
  return (
    <main className="mx-auto min-h-screen max-w-[1280px] px-6 py-16">
      {/* Wordmark */}
      <header className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-forge-500/15">
          <Hammer className="h-5 w-5 text-forge-500" aria-hidden />
        </span>
        <span className="text-base font-semibold tracking-tight text-anvil-900 dark:text-anvil-50">
          Dash Forge
        </span>
        <span className="ml-2 rounded bg-anvil-100 px-1.5 py-0.5 font-mono text-[11px] uppercase text-anvil-500 dark:bg-anvil-800 dark:text-anvil-400">
          {DEFAULT_NETWORK}
        </span>
      </header>

      {/* Hero */}
      <section className="mt-16 max-w-2xl">
        <h1 className="text-3xl leading-tight tracking-tight sm:text-4xl">
          A git forge with{' '}
          <span className="text-forge-500">no server to trust.</span>
        </h1>
        <p className="mt-4 text-prose text-anvil-600 dark:text-anvil-400">
          Browse code, review pull requests, and collaborate — every view
          backed by cryptographic proofs and content hashes, served straight
          from Dash Platform and IPFS. Foundry, not SaaS.
        </p>

        {/* Signature element: verification chip row */}
        <div className="mt-6">
          <VerificationChip refs="verified" packs="verified" source="platform" />
        </div>
      </section>

      {/* A demo repo card so the tokens are exercised together */}
      <section className="mt-14">
        <div className="max-w-2xl overflow-hidden rounded-lg border border-anvil-200 bg-white shadow-sm dark:border-anvil-750 dark:bg-anvil-900">
          <div className="flex items-center justify-between border-b border-anvil-200 px-4 py-3 dark:border-anvil-800">
            <div className="flex items-center gap-2">
              <GitBranch
                className="h-4 w-4 text-anvil-500 dark:text-anvil-400"
                aria-hidden
              />
              <span className="font-mono text-anvil-900 dark:text-anvil-100">
                dash-org/forge-core
              </span>
            </div>
            <span className="rounded bg-anvil-100 px-1.5 py-0.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300">
              ⛓ platform
            </span>
          </div>

          <div className="space-y-3 px-4 py-4">
            <div className="flex items-center gap-2 text-anvil-600 dark:text-anvil-400">
              <span>Latest commit</span>
              {/* Signature element: mono OID, 7-char abbreviated */}
              <code
                className="rounded bg-anvil-100 px-1.5 py-0.5 text-anvil-800 dark:bg-anvil-800 dark:text-anvil-200"
                title={SAMPLE_OID}
              >
                {SAMPLE_OID.slice(0, 7)}
              </code>
              <span className="text-anvil-400 dark:text-anvil-500">by</span>
              {/* Signature element: identity pill */}
              <IdentityPill
                identityId={SAMPLE_IDENTITY}
                name="dashdev.dash"
                role="MAINTAIN"
              />
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <VerificationChip refs="verified" packs="verified" source="ipfs" />
              <VerificationChip
                refs="verified"
                packs="degraded"
                source="s3"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Capability strip */}
      <section className="mt-14 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
        <Feature
          icon={<Search className="h-4 w-4 text-forge-500" aria-hidden />}
          title="Size-independent browse"
          body="Tree, blob, and commit views ride the browse plane — O(view) bytes at any repo size."
        />
        <Feature
          icon={<Lock className="h-4 w-4 text-forge-500" aria-hidden />}
          title="Proof-verified reads"
          body="Refs by platform proof, packs by sha256. The trust panel shows the whole chain."
        />
        <Feature
          icon={<GitBranch className="h-4 w-4 text-forge-500" aria-hidden />}
          title="Review & merge in-browser"
          body="Line comments, approvals, and fast-forward merges signed by your Platform identity."
        />
      </section>
    </main>
  )
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: ReactNode
  title: string
  body: string
}): JSX.Element {
  return (
    <div className="rounded-lg border border-anvil-200 bg-anvil-50 p-4 dark:border-anvil-800 dark:bg-anvil-900">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm">{title}</h3>
      </div>
      <p className="mt-2 text-anvil-600 dark:text-anvil-400">{body}</p>
    </div>
  )
}
