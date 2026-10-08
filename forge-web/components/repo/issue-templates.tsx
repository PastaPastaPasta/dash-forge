'use client'

/**
 * Templates at compose time (P1-6): the issue template chooser (Markdown templates, YAML issue
 * forms, `config.yml`) and the PR templates, read from the default branch through the browse
 * reader when the form opens. A repo with no pushed code, no templates, or unreadable storage
 * simply shows no picker.
 */

import { ExternalLink, FileText } from 'lucide-react'
import { useBrowse } from '@/hooks/use-browse'
import { useAsync } from '@/hooks/use-async'
import { selectRef, tipOidOf, type RepoHome } from '@/lib/view'
import { readIssueChooser, type IssueChooser } from '@/lib/view/issue-templates'
import { readPullTemplates, type PullTemplates } from '@/lib/view/pull-templates'
import type { BrowseReader } from '@/lib/browse'
import { cn } from '@/lib/utils'
import { onRadioGroupKeyDown, radioTabIndex } from '@/components/ui/radio-group'

/**
 * The default branch's tip and a reader for it (null until both are known, or while not `enabled`:
 * nothing is loaded then). `unavailable`: the browse context settled without a reader (storage a
 * browser cannot reach, an index not published, no packs), so none is coming.
 */
export function useDefaultBranchReader(
  home: RepoHome,
  enabled: boolean,
): { readonly tip: string | null; readonly reader: BrowseReader | null; readonly unavailable: boolean } {
  const tip = tipOidOf(selectRef(home.branches, home.tags, home.defaultBranch, '').ref) || null
  const browse = useBrowse(enabled && tip ? home.repo : null)
  const reader = browse.data?.kind === 'ready' ? browse.data.context.reader : null
  return { tip, reader, unavailable: reader === null && browse.settled && (browse.error !== null || browse.data !== null) }
}

/** What "Open an issue" offers (null while it is read, or when nothing could be). */
export function useIssueChooser(home: RepoHome, enabled: boolean): IssueChooser | null {
  const { tip, reader } = useDefaultBranchReader(home, enabled)
  const { data } = useAsync<IssueChooser | null>(() => readIssueChooser(reader!, tip!).catch(() => null), [tip ?? '', reader === null ? 0 : 1], {
    enabled: reader !== null && tip !== null,
  })
  return data
}

/** The PR templates of the default branch (null while they are read, or when they cannot be). */
export function usePullTemplates(home: RepoHome): PullTemplates | null {
  const { tip, reader } = useDefaultBranchReader(home, true)
  const { data } = useAsync<PullTemplates | null>(() => readPullTemplates(reader!, tip!).catch(() => null), [tip ?? '', reader === null ? 0 : 1], {
    enabled: reader !== null && tip !== null,
  })
  return data
}

/**
 * A row of template buttons (a radio group): `blank` is the "no template" choice's label, or
 * null when there is none (a chooser whose `config.yml` turns blank issues off).
 */
export function TemplatePicker<T extends { readonly file: string; readonly name: string; readonly about?: string }>({
  templates,
  selected,
  onPick,
  blank,
  label,
}: {
  templates: readonly T[]
  selected: T | null
  onPick: (t: T | null) => void
  blank: string | null
  label: string
}): JSX.Element | null {
  if (templates.length === 0) return null
  const choices: (T | null)[] = blank === null ? [...templates] : [null, ...templates]
  const isOn = (t: T | null): boolean => (t?.file ?? null) === (selected?.file ?? null)
  const anyOn = choices.some(isOn)
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-dense font-medium text-anvil-700 dark:text-anvil-200">Template</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label} onKeyDown={onRadioGroupKeyDown}>
        {choices.map((t, i) => {
          const on = isOn(t)
          return (
            <button
              key={t?.file ?? 'blank'}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={radioTabIndex(on, i, anyOn)}
              onClick={() => onPick(t)}
              title={t?.about || undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-dense coarse:min-h-11',
                on ? 'border-forge-500 bg-forge-500/10 text-forge-700 dark:text-forge-300' : 'border-anvil-300 text-anvil-600 hover:border-anvil-400 dark:border-anvil-700 dark:text-anvil-300',
              )}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden /> {t?.name ?? blank}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

/** `config.yml`'s contact links: where to go instead of opening an issue. */
export function ContactLinks({ links }: { links: IssueChooser['contactLinks'] }): JSX.Element | null {
  if (links.length === 0) return null
  return (
    <ul className="space-y-1 text-dense" aria-label="Other places to ask">
      {links.map((l) => (
        <li key={`${l.name}:${l.url}`}>
          <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-medium text-forge-700 underline underline-offset-2 dark:text-forge-400">
            {l.name} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
          {l.about ? <span className="text-anvil-600 dark:text-anvil-400"> — {l.about}</span> : null}
        </li>
      ))}
    </ul>
  )
}
