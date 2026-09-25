/** The mark a v1 repo carries: its own contract, readable here, while new repos are forge-v2. */
export function V1Badge({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span
      className={`shrink-0 rounded bg-anvil-100 px-1.5 py-0.5 font-mono text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300 ${className}`}
      title="A v1 repo: its own contract, with a token ACL. Readable here; new repos are forge-v2."
    >
      v1
    </span>
  )
}
