/**
 * Pull request templates (P1-6): the description a new PR starts with, read from the default
 * branch at compose time through the browse reader, as GitHub and GitLab read them.
 *
 * - GitHub's single template, `pull_request_template.md` (any case) in `.forge/`, `.github/`, the
 *   root or `docs/`: the first found is the default, filled in when the form opens.
 * - GitHub's several templates, the `*.md` files of a `PULL_REQUEST_TEMPLATE/` directory there
 *   (the first such directory), picked by name (`?template=bug.md`, as GitHub's link takes it).
 * - GitLab's `.gitlab/merge_request_templates/*.md`, whose `Default.md` (any case) is the default
 *   when there is no GitHub one.
 */

import { MODE_TREE, type BrowseReader } from '../browse'
import type { TreeEntry } from './git-objects'
import { MAX_TEMPLATES, byEntryName, dirAt, isFileEntry as isFile, templateText } from './issue-templates'
import { commitRootTree, readTree } from './tree-nav'

export interface PullTemplate {
  /** Its path in the repository (stable key). */
  readonly file: string
  readonly name: string
  readonly body: string
}

export interface PullTemplates {
  readonly templates: readonly PullTemplate[]
  /** The template a new PR starts with, or null. */
  readonly defaultFile: string | null
}

/** Where GitHub looks, in order. */
const GITHUB_DIRS = ['.forge', '.github', '', 'docs'] as const
const GITLAB_DIR = '.gitlab/merge_request_templates'

const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)

/**
 * Which files of a repository are PR templates, given a directory reader (`entriesOf('')` is the
 * root): the paths in the order offered, and the default's. Pure over the listing, for tests.
 */
export async function locatePullTemplates(entriesOf: (dir: string) => Promise<readonly TreeEntry[] | null>): Promise<{ files: { path: string; oid: string }[]; defaultPath: string | null }> {
  const files: { path: string; oid: string }[] = []
  let defaultPath: string | null = null
  let manyFrom: string | null = null
  for (const dir of GITHUB_DIRS) {
    const entries = await entriesOf(dir)
    if (entries === null) continue
    const single = entries.find((e) => isFile(e) && e.name.toLowerCase() === 'pull_request_template.md')
    if (single !== undefined && defaultPath === null) {
      defaultPath = join(dir, single.name)
      files.push({ path: defaultPath, oid: single.oid })
    }
    const many = entries.find((e) => e.mode === MODE_TREE && e.name.toLowerCase() === 'pull_request_template')
    if (many !== undefined && manyFrom === null) manyFrom = join(dir, many.name)
  }
  if (manyFrom !== null) {
    for (const e of [...((await entriesOf(manyFrom)) ?? [])].sort(byEntryName)) {
      if (isFile(e) && /\.md$/i.test(e.name)) files.push({ path: join(manyFrom, e.name), oid: e.oid })
    }
  }
  for (const e of [...((await entriesOf(GITLAB_DIR)) ?? [])].sort(byEntryName)) {
    if (!isFile(e) || !/\.md$/i.test(e.name)) continue
    const path = join(GITLAB_DIR, e.name)
    files.push({ path, oid: e.oid })
    if (defaultPath === null && e.name.toLowerCase() === 'default.md') defaultPath = path
  }
  return { files: files.slice(0, MAX_TEMPLATES), defaultPath }
}

/** A template's display name: the directory's file name without `.md`, or "Default". */
function templateName(path: string, isDefault: boolean): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (isDefault && base.toLowerCase() === 'pull_request_template.md') return 'Default'
  return base.replace(/\.md$/i, '')
}

/** The PR templates at `tipOid` (the default branch's tip). */
export async function readPullTemplates(reader: BrowseReader, tipOid: string): Promise<PullTemplates> {
  const { tree } = await commitRootTree(reader, tipOid)
  const root = await readTree(reader, tree)
  const seen = new Map<string, Promise<TreeEntry[] | null>>()
  const entriesOf = (dir: string): Promise<readonly TreeEntry[] | null> => {
    if (dir === '') return Promise.resolve(root)
    let p = seen.get(dir)
    if (p === undefined) {
      p = dirAt(reader, tree, dir)
      seen.set(dir, p)
    }
    return p
  }
  const { files, defaultPath } = await locatePullTemplates(entriesOf)
  // Read together, kept in the order offered.
  const read = await Promise.all(
    files.map(async (f): Promise<PullTemplate | null> => {
      const text = await templateText(reader, f.oid)
      return text === null ? null : { file: f.path, name: templateName(f.path, f.path === defaultPath), body: text.replace(/\r\n?/g, '\n').trim() }
    }),
  )
  const templates = read.filter((t): t is PullTemplate => t !== null)
  const defaultFile = templates.some((t) => t.file === defaultPath) ? defaultPath : null
  return { templates, defaultFile }
}

/**
 * The template a `?template=` link names (GitHub: the file name in `PULL_REQUEST_TEMPLATE/`),
 * matched by file name or path, any case; null when it names none.
 */
export function namedTemplate(templates: readonly PullTemplate[], name: string): PullTemplate | null {
  const n = name.trim().toLowerCase()
  if (n === '') return null
  return templates.find((t) => t.file.toLowerCase() === n || t.file.slice(t.file.lastIndexOf('/') + 1).toLowerCase() === n) ?? null
}
