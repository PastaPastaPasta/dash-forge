'use client'

/**
 * `/private` — what a private repository hides and what it does not (CJ-5). A security reviewer
 * should be able to say yes or no from this page alone: how sealing works, the metadata that
 * stays public (docs/security/private-repos.md §7, docs/contracts/forge-v2.md §5), what removing
 * a member does, and what is refused. The normative design stays in the linked spec.
 */

import Link from 'next/link'
import { Eye, EyeOff, ExternalLink, KeyRound, Lock, Plus, UserMinus } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { DOCS } from '@/lib/docs-links'

const SEALED: readonly string[] = [
  'Code, commits and file names',
  'Branch and tag names',
  'Issue and pull request titles and text',
  'Comments, review comments and the files they point at',
  'Release notes, assets and tags',
  'Which label or milestone an issue carries',
  'Repository settings, such as the default branch',
]

const VISIBLE: readonly string[] = [
  'That the repository exists, with its name, description, topics and owner',
  'Its members, their roles and when each joined',
  'When anything happens and who did it: pushes, issues, pull requests, comments and reviews',
  'File sizes, and roughly how long each piece of text is',
  'Issue and pull request numbers, and review verdicts',
  'Commit ids, so someone who already knows a commit can confirm the repository has it',
  'Label names and colours, and check names',
  'Who is assigned to an issue or pull request',
]

function Section({ icon, title, id, children }: { icon: ReactNode; title: string; id: string; children: ReactNode }): JSX.Element {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-800 dark:bg-anvil-900">
      <h2 id={id} className="flex items-center gap-2 text-prose font-semibold">
        {icon}
        {title}
      </h2>
      <div className="mt-2 space-y-2 text-dense text-anvil-700 dark:text-anvil-300">{children}</div>
    </section>
  )
}

function List({ items, testId }: { items: readonly string[]; testId: string }): JSX.Element {
  return (
    <ul className="list-disc space-y-1 pl-5" data-testid={testId}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

export default function PrivateReposPage(): JSX.Element {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4" data-testid="private-repos">
        <div>
          <h1 className="text-2xl">Private repositories</h1>
          <p className="mt-2 text-prose text-anvil-600 dark:text-anvil-300">
            A private repository is encrypted on your device before anything is stored. Only its members hold the key, and Dash Platform
            refuses unencrypted content for it: privacy is a network rule, not a promise from a server.
          </p>
        </div>

        <Section icon={<Lock className="h-4 w-4 text-forge-500" aria-hidden />} title="How sealing works" id="private-how">
          <ol className="list-decimal space-y-1 pl-5">
            <li>Each private repository has its own key. Every member gets a copy, encrypted to their identity.</li>
            <li>Your browser or the command line encrypts code, branch names, issues, pull requests, comments, reviews and releases before they leave your device.</li>
            <li>Dash Platform rejects any unencrypted issue, pull request, comment, review, branch update or release for a private repository.</li>
            <li>Storage, whether your own bucket, IPFS or Dash Platform, only ever holds encrypted files.</li>
            <li>Members decrypt in their own browser or terminal. There is no Forge server that could read anything.</li>
          </ol>
        </Section>

        <section aria-labelledby="private-visibility" className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-800 dark:bg-anvil-900">
          <h2 id="private-visibility" className="text-prose font-semibold">
            What stays visible
          </h2>
          <p className="mt-2 text-dense text-anvil-700 dark:text-anvil-300">
            Encryption hides content, not activity. Anyone can read the public network, so plan for this list to be public.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-4 text-dense text-anvil-700 dark:text-anvil-300 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 flex items-center gap-2 font-semibold text-anvil-900 dark:text-anvil-50">
                <EyeOff className="h-4 w-4 text-verify" aria-hidden /> Only members can read
              </h3>
              <List items={SEALED} testId="private-sealed" />
            </div>
            <div>
              <h3 className="mb-1 flex items-center gap-2 font-semibold text-anvil-900 dark:text-anvil-50">
                <Eye className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden /> Anyone can see
              </h3>
              <List items={VISIBLE} testId="private-visible" />
            </div>
          </div>
        </section>

        <Section icon={<UserMinus className="h-4 w-4 text-forge-500" aria-hidden />} title="When you remove a member" id="private-remove">
          <p>
            Removing a member changes the key. Everything written after that uses the new key, which they never receive. What they could read
            before stays readable to them: nothing can take back a copy they may have kept.
          </p>
        </Section>

        <Section icon={<KeyRound className="h-4 w-4 text-forge-500" aria-hidden />} title="What private repositories can't do" id="private-limits">
          <p>
            Forks and webhooks are turned off, because both would publish content unencrypted. Merging a pull request needs the{' '}
            <code className="font-mono">dg</code> command line for now.
          </p>
        </Section>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Link href="/new/">
            <Button variant="primary">
              <Plus className="h-4 w-4" aria-hidden /> New private repository
            </Button>
          </Link>
          <a
            href={DOCS.privateDesign}
            target="_blank"
            rel="noreferrer noopener"
            className="hit-area inline-flex items-center gap-1 text-dense text-forge-700 underline dark:text-forge-400"
          >
            Read the full design <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>
      </div>
    </AppShell>
  )
}
