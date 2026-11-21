/**
 * EnforcedBy: the one way the UI says who enforces a rule (style guide §C, rule 7).
 *
 * - `platform`: Dash Platform refuses a write that breaks it, whatever app sent it (member
 *   roles, a limited key's budget).
 * - `apps`: Forge's web app and CLI apply it, and Platform does not check it (branch policy,
 *   archiving). A maintainer's override of such a rule is recorded where everyone sees it.
 * - `both`: protected branches (#625). Platform lets only maintainers write the protected-ref
 *   update; Forge apps ignore a plain update of a protected ref, which Platform accepts.
 *
 * It replaces the prose ("consensus", "client rule", "Forge clients") that used to explain this
 * differently on every screen. The chip links to the guide section that explains the difference.
 */

import Link from 'next/link'
import { AppWindow, ShieldCheck, ShieldHalf } from 'lucide-react'

import { DOCS } from '@/lib/docs-links'
import { cn } from '@/lib/utils'

export type Enforcer = 'platform' | 'apps' | 'both'

export const ENFORCED_BY: Readonly<Record<Enforcer, { readonly label: string; readonly detail: string }>> = {
  platform: {
    label: 'Enforced by Dash Platform',
    detail: 'Dash Platform refuses any change that breaks this rule, whichever app sends it.',
  },
  apps: {
    label: 'Forge apps enforce this',
    detail: "The Forge web app and CLI apply this rule. Dash Platform doesn't check it.",
  },
  both: {
    label: 'Enforced by Dash Platform and Forge apps',
    detail:
      "Dash Platform lets only maintainers write a protected branch's update. Forge apps ignore any other update to it, so a writer's push never moves the branch in Forge.",
  },
}

const ICON: Readonly<Record<Enforcer, typeof ShieldCheck>> = { platform: ShieldCheck, apps: AppWindow, both: ShieldHalf }

export function EnforcedBy({ by, className }: { by: Enforcer; className?: string }): JSX.Element {
  const { label, detail } = ENFORCED_BY[by]
  const Icon = ICON[by]
  return (
    <Link prefetch={false}
      href={DOCS.enforcement}
      target="_blank"
      rel="noreferrer"
      title={detail}
      data-testid={`enforced-by-${by}`}
      className={cn(
        'hit-area inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium no-underline',
        'border-anvil-200 bg-anvil-50 text-anvil-700 hover:border-anvil-300 hover:bg-anvil-100',
        'dark:border-anvil-700 dark:bg-anvil-850 dark:text-anvil-200 dark:hover:border-anvil-600 dark:hover:bg-anvil-800',
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {label}
      <span className="sr-only">. {detail} How enforcement works, opens in a new tab.</span>
    </Link>
  )
}
