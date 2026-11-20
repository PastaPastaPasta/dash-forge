import { headingSlug, parseMarkdown, type Block } from '@/lib/view'
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
  // Every heading takes a slug number, nested ones (in a quote or a list) too, in the renderer's
  // order; only the top-level ones are listed.
  const visit = (node: unknown, top: boolean): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n, top)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const b = node as Block
    if (b.t === 'heading') {
      const text = textOf(b.c)
      const base = headingSlug(text)
      const n = slugs.get(base) ?? 0
      slugs.set(base, n + 1)
      if (top && (b.level === 2 || b.level === 3)) out.push({ id: anchorTarget(n === 0 ? base : `${base}-${n}`), text, level: b.level })
      return
    }
    for (const v of Object.values(b)) if (Array.isArray(v)) visit(v, false)
  }
  visit(parseMarkdown(source, { breaks: false }), true)
  return out
}
