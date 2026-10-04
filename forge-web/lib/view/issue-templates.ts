/**
 * Issue templates (`platform-parity-spec.md` §1.2, P1-6): the templates in
 * `.forge/ISSUE_TEMPLATE/`, else `.github/ISSUE_TEMPLATE/`, else `.gitlab/issue_templates/`, on
 * the default branch, read at compose time through the browse reader. A Markdown template is
 * GitHub's (optional YAML front matter: `name`, `about`, `title`, `labels`, then the body) or
 * GitLab's (all body, named after the file); a `*.yml` / `*.yaml` file is a GitHub issue form
 * (`issue-forms.ts`). The directory's `config.yml` may turn blank issues off and list contact
 * links, as GitHub's template chooser does.
 */

import { load } from 'js-yaml'

import { MODE_GITLINK, MODE_TREE, type BrowseReader } from '../browse'
import { decodeTextBlob, type TreeEntry } from './git-objects'
import { isRecord, parseIssueForm, type IssueForm } from './issue-forms'
import { commitRootTree, readBlob, readTree } from './tree-nav'

/** One issue template. */
export interface IssueTemplate {
  /** The file name (stable key). */
  readonly file: string
  readonly name: string
  readonly about: string
  /** The title the new issue starts with. */
  readonly title: string
  /** Labels the template asks for (applied with the issue when the author may label). */
  readonly labels: readonly string[]
  readonly body: string
  /** A YAML issue form: the issue's body is built from its answers (`body` is empty). */
  readonly form?: IssueForm
}

/** A link the template chooser offers instead of an issue (`config.yml`'s `contact_links`). */
export interface ContactLink {
  readonly name: string
  readonly url: string
  readonly about: string
}

/** What "Open an issue" offers: the templates, whether a blank issue is allowed, and links. */
export interface IssueChooser {
  readonly templates: readonly IssueTemplate[]
  readonly blankIssuesEnabled: boolean
  readonly contactLinks: readonly ContactLink[]
}

/** The directories searched, in order: the first that holds templates (or a config) wins. */
const TEMPLATE_DIRS = ['.forge/ISSUE_TEMPLATE', '.github/ISSUE_TEMPLATE', '.gitlab/issue_templates'] as const

/** Most templates read, and the size of one (a template is a short form). Shared with PR templates. */
export const MAX_TEMPLATES = 20
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

/** Whether a file name is a chooser config (`config.yml`), never a template. */
const isConfig = (name: string): boolean => /^config\.(ya?ml|md)$/i.test(name)

/** Whether an entry is a file (not a directory or a submodule). */
export const isFileEntry = (e: TreeEntry): boolean => e.mode !== MODE_TREE && e.mode !== MODE_GITLINK

/** Entries in name order (code-unit order, as git sorts them). */
export const byEntryName = (a: TreeEntry, b: TreeEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** The template files of a directory listing (Markdown and YAML forms), in name order. */
export function templateFiles(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries
    .filter((e) => isFileEntry(e) && /\.(md|markdown|ya?ml)$/i.test(e.name) && !isConfig(e.name))
    .sort(byEntryName)
    .slice(0, MAX_TEMPLATES)
}

/** A template file's text, or null when it is too large or not text. */
export async function templateText(reader: BrowseReader, oid: string): Promise<string | null> {
  const bytes = await readBlob(reader, oid)
  return bytes.length > MAX_TEMPLATE_BYTES ? null : decodeTextBlob(bytes)
}

/** One template file: a YAML form, else Markdown. Null for a YAML file that is not a valid form. */
export function parseTemplateFile(file: string, text: string): IssueTemplate | null {
  if (!/\.ya?ml$/i.test(file)) return parseIssueTemplate(file, text)
  const f = parseIssueForm(text)
  return f === null ? null : { file, name: f.name, about: f.about, title: f.title, labels: f.labels, body: '', form: f.form }
}

/** A `config.yml`'s chooser settings (GitHub's keys; anything malformed reads as the default). */
export function parseChooserConfig(text: string): Pick<IssueChooser, 'blankIssuesEnabled' | 'contactLinks'> {
  let doc: unknown
  try {
    doc = load(text)
  } catch {
    doc = null
  }
  const rec = isRecord(doc) ? doc : {}
  const links = Array.isArray(rec['contact_links']) ? rec['contact_links'] : []
  return {
    blankIssuesEnabled: rec['blank_issues_enabled'] !== false,
    contactLinks: links.flatMap((l): ContactLink[] => {
      if (!isRecord(l)) return []
      const { name, url, about } = l
      // `https` links only: a `javascript:` (or plain-HTTP) URL in someone's repo never becomes a link here.
      if (typeof name !== 'string' || typeof url !== 'string' || !/^https:\/\//i.test(url)) return []
      return [{ name, url, about: typeof about === 'string' ? about : '' }]
    }),
  }
}

/** The entries of `path` under `tree`, or null when it is not a directory there. */
export async function dirAt(reader: BrowseReader, tree: string, path: string): Promise<TreeEntry[] | null> {
  let oid = tree
  for (const seg of path.split('/')) {
    const next = (await readTree(reader, oid)).find((e) => e.name === seg && e.mode === MODE_TREE)
    if (next === undefined) return null
    oid = next.oid
  }
  return readTree(reader, oid)
}

/**
 * What "Open an issue" offers at `tipOid` (the default branch's tip): the templates of the first
 * directory that holds any, with that directory's `config.yml` (else the first one found before
 * it, so a `.forge/` config alone can add contact links to `.github/`'s templates).
 */
export async function readIssueChooser(reader: BrowseReader, tipOid: string): Promise<IssueChooser> {
  const { tree } = await commitRootTree(reader, tipOid)
  let config: TreeEntry | undefined
  let templates: IssueTemplate[] = []
  for (const dir of TEMPLATE_DIRS) {
    const entries = await dirAt(reader, tree, dir)
    if (entries === null) continue
    const own = entries.find((e) => isFileEntry(e) && /^config\.ya?ml$/i.test(e.name))
    if (own !== undefined && (config === undefined || templateFiles(entries).length > 0)) config = own
    const files = templateFiles(entries)
    if (files.length === 0) continue
    // Read together (a slow store pays for the slowest file, not their sum), kept in name order.
    const read = await Promise.all(files.map(async (f) => {
      const text = await templateText(reader, f.oid)
      return text === null ? null : parseTemplateFile(f.name, text)
    }))
    templates = read.filter((t): t is IssueTemplate => t !== null)
    break
  }
  const configText = config === undefined ? null : await templateText(reader, config.oid)
  const settings = configText === null ? { blankIssuesEnabled: true, contactLinks: [] } : parseChooserConfig(configText)
  // Blank issues stay on when no template is usable: nobody may be left unable to open one.
  return { templates, ...settings, blankIssuesEnabled: settings.blankIssuesEnabled || templates.length === 0 }
}

/**
 * The composer's title and body after picking `next` in place of `prev` (QW4-037: the picker's
 * arrow keys pick each template they pass): a field still empty, or still holding `prev`'s text
 * untouched, takes `next`'s (blank for "Blank issue"); anything the person typed stays.
 */
export function applyTemplate(
  fields: { readonly title: string; readonly body: string },
  prev: Pick<IssueTemplate, 'title' | 'body'> | null,
  next: Pick<IssueTemplate, 'title' | 'body'> | null,
): { title: string; body: string } {
  const untouched = (value: string, filled: string | undefined): boolean => value.trim() === '' || (filled !== undefined && value === filled)
  return {
    title: untouched(fields.title, prev?.title) ? (next?.title ?? '') : fields.title,
    body: untouched(fields.body, prev?.body) ? (next?.body ?? '') : fields.body,
  }
}
