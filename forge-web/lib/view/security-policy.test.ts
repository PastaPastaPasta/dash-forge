/** Where the security policy is looked for (D37): GitHub's order, regular files only, one directory read at a time. */

import { describe, expect, it, vi } from 'vitest'

import { MODE_GITLINK, MODE_TREE } from '../browse'
import type { TreeEntry } from './git-objects'
import { pickSecurityPolicy, SECURITY_POLICY_PATHS } from './security-policy'

const FILE = 0o100644
const EXEC = 0o100755
const SYMLINK = 0o120000

const e = (name: string, oid: string, mode = FILE): TreeEntry => ({ name, oid, mode })

/** A repo: its root entries and the directories the root points to, by oid. */
function repo(root: TreeEntry[], dirs: Record<string, TreeEntry[]> = {}) {
  const readDir = vi.fn(async (oid: string) => {
    const dir = dirs[oid]
    if (dir === undefined) throw new Error(`no tree ${oid}`)
    return dir
  })
  return { root, readDir }
}

describe('security policy lookup', () => {
  it("is GitHub's order: .github, then the root, then docs", () => {
    // Same list as forge_core::rules::security_policy::SECURITY_POLICY_PATHS (dg repo view).
    expect([...SECURITY_POLICY_PATHS]).toEqual(['.github/SECURITY.md', 'SECURITY.md', 'docs/SECURITY.md'])
  })

  it('prefers .github/SECURITY.md over the root and docs', async () => {
    const { root, readDir } = repo(
      [e('SECURITY.md', 'root'), e('.github', 'gh-tree', MODE_TREE), e('docs', 'docs-tree', MODE_TREE)],
      { 'gh-tree': [e('SECURITY.md', 'gh')], 'docs-tree': [e('SECURITY.md', 'docs')] },
    )
    expect(await pickSecurityPolicy(root, readDir)).toEqual({ path: '.github/SECURITY.md', oid: 'gh' })
    // docs/ is never read when an earlier place has the file.
    expect(readDir).toHaveBeenCalledTimes(1)
    expect(readDir).toHaveBeenCalledWith('gh-tree')
  })

  it('falls back to the root, then docs', async () => {
    const dirs = { 'gh-tree': [e('CODEOWNERS', 'co')], 'docs-tree': [e('SECURITY.md', 'docs')] }
    const tree = [e('.github', 'gh-tree', MODE_TREE), e('docs', 'docs-tree', MODE_TREE)]
    const withRoot = repo([...tree, e('SECURITY.md', 'root', EXEC)], dirs)
    expect(await pickSecurityPolicy(withRoot.root, withRoot.readDir)).toEqual({ path: 'SECURITY.md', oid: 'root' })
    const docsOnly = repo(tree, dirs)
    expect(await pickSecurityPolicy(docsOnly.root, docsOnly.readDir)).toEqual({ path: 'docs/SECURITY.md', oid: 'docs' })
  })

  it('finds nothing in a repo without one, reading only the directories that exist', async () => {
    const none = repo([e('README.md', 'r'), e('docs', 'docs-tree', MODE_TREE)], { 'docs-tree': [e('guide.md', 'g')] })
    expect(await pickSecurityPolicy(none.root, none.readDir)).toBeNull()
    expect(none.readDir).toHaveBeenCalledTimes(1)
    const bare = repo([e('README.md', 'r')])
    expect(await pickSecurityPolicy(bare.root, bare.readDir)).toBeNull()
    expect(bare.readDir).not.toHaveBeenCalled()
  })

  it('counts only a regular file named exactly SECURITY.md', async () => {
    const { root, readDir } = repo(
      [
        // A directory, a symlink and a submodule named SECURITY.md are no policy.
        e('SECURITY.md', 'dir', MODE_TREE),
        e('.github', 'gh-tree', MODE_TREE),
        e('docs', 'docs-tree', MODE_TREE),
      ],
      {
        'gh-tree': [e('SECURITY.md', 'link', SYMLINK), e('security.md', 'lower'), e('SECURITY.rst', 'rst')],
        'docs-tree': [e('SECURITY.md', 'sub', MODE_GITLINK)],
      },
    )
    expect(await pickSecurityPolicy(root, readDir)).toBeNull()
    // A file named .github is not a directory to look in.
    const odd = repo([e('.github', 'blob'), e('SECURITY.md', 'root')])
    expect(await pickSecurityPolicy(odd.root, odd.readDir)).toEqual({ path: 'SECURITY.md', oid: 'root' })
    expect(odd.readDir).not.toHaveBeenCalled()
  })
})
