/**
 * Issue templates (`platform-parity-spec.md` §1.2): the markdown files in
 * `.forge/ISSUE_TEMPLATE/`, else `.github/ISSUE_TEMPLATE/`, on the default branch, read at
 * compose time through the browse reader. A template is GitHub's Markdown form: optional YAML
 * front matter (`name`, `about`, `title`, `labels`), then the body. YAML issue forms (`*.yml`)
 * are not read (P2).
 */

import { MODE_GITLINK, MODE_TREE, type BrowseReader } from '../browse'
import { decodeTextBlob, type TreeEntry } from './git-objects'
import { commitRootTree, readBlob, readTree } from './tree-nav'

/** One issue template. */
export interface IssueTemplate {
  /** The file name (stable key). */
  readonly file: string
  readonly name: string
  readonly about: string
  /** The title the new issue starts with. */
  readonly title: string
  /** Labels the template asks for (applied by a member after the issue is opened). */
  readonly labels: readonly string[]
  readonly body: string
}

/** The directories searched, in order: the first that holds templates wins. */
const TEMPLATE_DIRS = ['.forge/ISSUE_TEMPLATE', '.github/ISSUE_TEMPLATE'] as const

/** Most templates read, and the size of one (a template is a short form). */
const MAX_TEMPLATES = 20
const MAX_TEMPLATE_BYTES = 64 * 1024

/** A YAML scalar: quotes stripped. */
function scalar(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

/** `labels: bug, docs`, `labels: [bug, docs]` or a `- item` list. */
function labelList(inline: string, items: readonly string[]): string[] {
  const src = inline.trim().replace(/^\[|\]$/g, '')
  const raw = src !== '' ? src.split(',') : [...items]
  return raw.map(scalar).filter((l) => l !== '')
}

/**
 * Parse a Markdown issue template: `---` front matter (only the keys GitHub defines, flat
 * values and `- item` lists), then the body. A file without front matter is all body, named
 * after the file.
 */
export function parseIssueTemplate(file: string, text: string): IssueTemplate {
  const base = file.replace(/\.(md|markdown)$/i, '')
  const fallback: IssueTemplate = { file, name: base, about: '', title: '', labels: [], body: text.trim() }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return fallback
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return fallback
  const fields = new Map<string, { inline: string; items: string[] }>()
  let current: { inline: string; items: string[] } | null = null
  for (const line of lines.slice(1, end)) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && current) {
      current.items.push(item[1] ?? '')
      continue
    }
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/)
    if (!kv) continue
    current = { inline: kv[2] ?? '', items: [] }
    fields.set((kv[1] ?? '').toLowerCase(), current)
  }
  const get = (k: string): string => scalar(fields.get(k)?.inline ?? '')
  const labels = fields.get('labels')
  return {
    file,
    name: get('name') || base,
    about: get('about'),
    title: get('title'),
    labels: labels ? labelList(labels.inline, labels.items) : [],
    body: lines.slice(end + 1).join('\n').trim(),
  }
}

/** The template files of a directory listing, in name order. */
export function templateFiles(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries
    .filter((e) => e.mode !== MODE_TREE && e.mode !== MODE_GITLINK && /\.(md|markdown)$/i.test(e.name) && e.name.toLowerCase() !== 'config.md')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_TEMPLATES)
}

/** The entries of `path` under `tree`, or null when it is not a directory there. */
async function dirAt(reader: BrowseReader, tree: string, path: string): Promise<TreeEntry[] | null> {
  let oid = tree
  for (const seg of path.split('/')) {
    const next = (await readTree(reader, oid)).find((e) => e.name === seg && e.mode === MODE_TREE)
    if (next === undefined) return null
    oid = next.oid
  }
  return readTree(reader, oid)
}

/** The issue templates at `tipOid` (the default branch's tip), or [] when it has none. */
export async function readIssueTemplates(reader: BrowseReader, tipOid: string): Promise<IssueTemplate[]> {
  const { tree } = await commitRootTree(reader, tipOid)
  for (const dir of TEMPLATE_DIRS) {
    const entries = await dirAt(reader, tree, dir)
    if (entries === null) continue
    const files = templateFiles(entries)
    if (files.length === 0) continue
    const out: IssueTemplate[] = []
    for (const f of files) {
      const bytes = await readBlob(reader, f.oid)
      if (bytes.length > MAX_TEMPLATE_BYTES) continue
      const text = decodeTextBlob(bytes)
      if (text !== null) out.push(parseIssueTemplate(f.name, text))
    }
    return out
  }
  return []
}
