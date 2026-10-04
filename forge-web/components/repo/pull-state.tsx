import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react'
import { pullState, STATE_TEXT, type PullWorkState } from '@/lib/design/state'

const ICON = { open: GitPullRequest, draft: GitPullRequestDraft, done: GitMerge, closed: GitPullRequestClosed } as const
const LABEL: Readonly<Record<PullWorkState, string>> = { open: 'Open', draft: 'Draft', done: 'Merged', closed: 'Closed' }

/** A pull request's state as a list row shows it: its label, icon and colour class (from {@link pullState}). */
export function pullStateView(state: Parameters<typeof pullState>[0]): { state: PullWorkState; label: string; Icon: (typeof ICON)[PullWorkState]; klass: string } {
  const s = pullState(state)
  return { state: s, label: LABEL[s], Icon: ICON[s], klass: STATE_TEXT[s] }
}
