/**
 * The empty state of a discovery list with nothing to show yet (F15): what Forge is, and the three
 * ways in (create a repo, import one from GitHub, read the docs), not a dead "nothing here".
 */

import Link from 'next/link'
import { BookOpen, CopyPlus, Hammer, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function ForgeIntro({ title, heading: Heading = 'h3', testId = 'forge-intro' }: { title: string; heading?: 'h2' | 'h3'; testId?: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-anvil-300 bg-anvil-50 px-5 py-6 dark:border-anvil-700 dark:bg-anvil-900/60" data-testid={testId}>
      <div className="flex items-start gap-3">
        <Hammer className="mt-0.5 h-5 w-5 shrink-0 text-forge-600 dark:text-forge-400" aria-hidden />
        <div className="min-w-0">
          <Heading className="text-prose font-semibold">{title}</Heading>
          <p className="mt-1 max-w-2xl text-dense text-anvil-600 dark:text-anvil-300">
            Dash Forge is a git forge with no server: repositories, issues and pull requests live on Dash Platform, and your browser
            verifies everything it shows. Start a project, bring one over from GitHub, or read how it works.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/new/">
              <Button variant="primary" size="sm">
                <Plus className="h-4 w-4" aria-hidden /> Create a repository
              </Button>
            </Link>
            <Link href="/mirror/">
              <Button variant="outline" size="sm">
                <CopyPlus className="h-4 w-4" aria-hidden /> Import from GitHub
              </Button>
            </Link>
            <Link href="/docs/">
              <Button variant="ghost" size="sm">
                <BookOpen className="h-4 w-4" aria-hidden /> Read the docs
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
