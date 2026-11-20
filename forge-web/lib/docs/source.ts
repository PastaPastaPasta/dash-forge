/**
 * Reads a listed document's Markdown from the repository's `docs/` at build time (the `/docs`
 * routes are prerendered). Server-only: the browser gets the rendered page, never this module.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DocPage } from './catalog'

const REPO_ROOT = join(process.cwd(), '..')

export interface DocSource {
  /** The document's first `# ` heading (the page's h1), or the catalog title. */
  readonly title: string
  /** The Markdown after that heading. */
  readonly body: string
}

/** The document's title and body; the leading `# Title` becomes the page heading, not body text. */
export function splitTitle(markdown: string, fallback: string): DocSource {
  const m = /^\s*# +(.+?)\s*#*\s*(?:\r?\n|$)/.exec(markdown)
  if (m === null) return { title: fallback, body: markdown }
  return { title: m[1]!.trim(), body: markdown.slice(m[0].length) }
}

export function readDoc(page: DocPage): DocSource {
  return splitTitle(readFileSync(join(REPO_ROOT, page.path), 'utf8'), page.title)
}
