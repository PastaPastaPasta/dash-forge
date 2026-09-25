/**
 * The line a list shows when it skipped documents: not well-formed for the repo (plaintext in
 * a private repo, ciphertext in a public one) or a stranger's ciphertext in a private repo
 * (`forge-v2.md` §5). Never silent — a list that quietly shrinks looks like an empty repo.
 */
export function HiddenNote({ hidden, what }: { hidden: number; what: string }): JSX.Element | null {
  if (hidden <= 0) return null
  return (
    <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
      {hidden} newer {what}
      {hidden === 1 ? ' was' : ' were'} hidden: not readable in this repo (malformed, or encrypted
      by someone who is not a member).
    </p>
  )
}
