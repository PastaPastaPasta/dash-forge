'use client'

/**
 * The compose dialog's template picker: the repo's `.forge/ISSUE_TEMPLATE` (else
 * `.github/ISSUE_TEMPLATE`) files on the default branch, read through the browse reader when
 * the dialog opens. A repo with no pushed code, no templates, or unreadable storage simply
 * shows no picker.
 */

import { FileText } from 'lucide-react'
import { useBrowse } from '@/hooks/use-browse'
import { useAsync } from '@/hooks/use-async'
import { selectRef, tipOidOf, type RepoHome } from '@/lib/view'
import { readIssueTemplates, type IssueTemplate } from '@/lib/view/issue-templates'
import { cn } from '@/lib/utils'
import { onRadioGroupKeyDown, radioTabIndex } from '@/components/ui/radio-group'

export function IssueTemplatePicker({
  home,
  selected,
  onPick,
}: {
  home: RepoHome
  selected: IssueTemplate | null
  onPick: (t: IssueTemplate | null) => void
}): JSX.Element | null {
  const tip = tipOidOf(selectRef(home.branches, home.tags, home.defaultBranch, '').ref)
  const browse = useBrowse(tip ? home.repo : null)
  const reader = browse.data?.kind === 'ready' ? browse.data.context.reader : null
  const { data } = useAsync<IssueTemplate[]>(
    () => readIssueTemplates(reader!, tip!).catch(() => []),
    [tip ?? '', reader === null ? 0 : 1],
    { enabled: reader !== null && tip !== null && tip !== '' },
  )
  if (!data || data.length === 0) return null
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-dense font-medium text-anvil-700 dark:text-anvil-200">Template</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Issue template" onKeyDown={onRadioGroupKeyDown}>
        {[null, ...data].map((t, i, all) => {
          const on = (t?.file ?? null) === (selected?.file ?? null)
          return (
            <button
              key={t?.file ?? 'blank'}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={radioTabIndex(on, i, all.some((x) => (x?.file ?? null) === (selected?.file ?? null)))}
              onClick={() => onPick(t)}
              title={t?.about || undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-dense',
                on ? 'border-forge-500 bg-forge-500/10 text-forge-700 dark:text-forge-300' : 'border-anvil-300 text-anvil-600 hover:border-anvil-400 dark:border-anvil-700 dark:text-anvil-300',
              )}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden /> {t?.name ?? 'Blank issue'}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
