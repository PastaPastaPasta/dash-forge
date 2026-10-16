'use client'

/**
 * "Not shown on this site" (docs/hosted-curation.md): what a hosted build shows in place of a
 * repo, or of the repos of an identity, that its curation list hides. It says what this is and
 * what it is not: the data is still on Dash Platform, other clients read it, and `dash://` works.
 * The repo's page chrome is read to find its owner (one request) but none of it is rendered, and
 * no code, issue or other content is loaded.
 */

import { EyeOff, ExternalLink } from 'lucide-react'
import { CopyRow } from '@/components/ui/copy-row'
import { EmptyState } from '@/components/ui/states'
import { DOCS } from '@/lib/docs-links'
import { cloneByIdCommand } from '@/lib/view/repo-commands'

const LINK = 'hit-area inline-flex items-center gap-1 text-dense text-forge-700 underline dark:text-forge-400'

export function HiddenNotice({ what, repoId, heading = 'h1' }: { what: 'repo' | 'identity'; repoId?: string; heading?: 'h1' | 'h2' | 'h3' }): JSX.Element {
  return (
    <div data-testid="hidden-notice" className="mx-auto max-w-xl">
      <EmptyState
        heading={heading}
        icon={EyeOff}
        title="Not shown on this site"
        body={
          what === 'repo'
            ? 'This repository still exists on Dash Platform, and other clients can read it. This site does not list or open it.'
            : "This identity's repositories still exist on Dash Platform, and other clients can read them. This site does not list or open them."
        }
        action={
          <div className="flex flex-col items-center gap-3">
            {what === 'repo' && repoId ? <CopyRow text={cloneByIdCommand(repoId)} label="Copy the clone command" className="mb-0 text-left" /> : null}
            <a href={DOCS.hostedCuration} target="_blank" rel="noreferrer noopener" className={LINK}>
              Why a site hides something <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </div>
        }
      />
    </div>
  )
}
