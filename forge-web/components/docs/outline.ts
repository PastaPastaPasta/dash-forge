import { headingSlug, parseMarkdown } from '@/lib/view'
import { anchorTarget, textOf } from '@/components/markdown-view'

export interface OutlineEntry {
  readonly id: string
  readonly text: string
  readonly level: 2 | 3
}

/**
 * A document's `##` and `###` headings, with the DOM ids MarkdownView gives them (the same slug
 * numbering, counted over every heading), for the "On this page" list.
 */
export function outline(source: string): OutlineEntry[] {
  const slugs = new Map<string, number>()
  const out: OutlineEntry[] = []
  for (const b of parseMarkdown(source, { breaks: false })) {
    if (b.t !== 'heading') continue
    const text = textOf(b.c)
    const base = headingSlug(text)
    const n = slugs.get(base) ?? 0
    slugs.set(base, n + 1)
    if (b.level === 2 || b.level === 3) out.push({ id: anchorTarget(n === 0 ? base : `${base}-${n}`), text, level: b.level })
  }
  return out
}
