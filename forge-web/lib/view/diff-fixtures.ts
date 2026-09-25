/**
 * TEST FIXTURES ONLY — a tiny content-addressed git object store for the diff tests (imported
 * by `*-diff.test.ts`; never by app code, so never bundled). Objects get their real git oids,
 * so trees and commits reference each other the way a pack does.
 */

import { hexToBytes } from '@noble/hashes/utils.js'

import { gitOidHex, MODE_GITLINK, MODE_TREE, type GitObject, type LocatorEntry } from '../browse'
import type { ObjectReader } from './tree-nav'

const encoder = new TextEncoder()

export interface Entry {
  readonly name: string
  readonly oid: string
  readonly mode?: number
}

export class Store {
  readonly objects = new Map<string, GitObject>()
  readonly reads: string[] = []
  private clock = 1

  private put(type: GitObject['type'], bytes: Uint8Array): string {
    const oid = gitOidHex(type, bytes)
    this.objects.set(oid, { type, bytes })
    return oid
  }

  blob(text: string | Uint8Array): string {
    return this.put('blob', typeof text === 'string' ? encoder.encode(text) : text)
  }

  tree(entries: readonly Entry[]): string {
    // git orders tree entries by name (directories compare as `name/`); tests use plain names.
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))
    const parts: Uint8Array[] = []
    for (const e of sorted) {
      parts.push(encoder.encode(`${(e.mode ?? 0o100644).toString(8)} ${e.name}\0`), hexToBytes(e.oid))
    }
    const total = parts.reduce((n, p) => n + p.length, 0)
    const bytes = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
      bytes.set(p, at)
      at += p.length
    }
    return this.put('tree', bytes)
  }

  /** A tree from a `{ path: content }` map; nested paths make subtrees. */
  files(files: Readonly<Record<string, string>>): string {
    const here: Entry[] = []
    const dirs = new Map<string, Record<string, string>>()
    for (const [path, content] of Object.entries(files)) {
      const slash = path.indexOf('/')
      if (slash === -1) {
        here.push({ name: path, oid: this.blob(content) })
      } else {
        const dir = path.slice(0, slash)
        const sub = dirs.get(dir) ?? {}
        sub[path.slice(slash + 1)] = content
        dirs.set(dir, sub)
      }
    }
    for (const [name, sub] of dirs) here.push({ name, oid: this.files(sub), mode: MODE_TREE })
    return this.tree(here)
  }

  /** A commit; each call is one second newer than the last, like a real linear history. */
  commit(tree: string, parents: readonly string[] = [], message = 'test'): string {
    return this.commitAt(tree, parents, this.clock++, message)
  }

  /** A commit with an explicit committer time (seconds) — e.g. to model a skewed clock. */
  commitAt(tree: string, parents: readonly string[], when: number, message = 'test'): string {
    const headers = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`)]
    const ident = `Test <test@example.com> ${when} +0000`
    return this.put(
      'commit',
      encoder.encode(`${headers.join('\n')}\nauthor ${ident}\ncommitter ${ident}\n\n${message}\n`),
    )
  }

  /** A reader over a subset of this store (default: all of it), recording each read. */
  reader(only?: ReadonlySet<string>, locate?: (oid: string) => LocatorEntry | null): ObjectReader {
    return {
      readObject: (oid: string): Promise<GitObject> => {
        this.reads.push(oid)
        const object = only === undefined || only.has(oid) ? this.objects.get(oid) : undefined
        return object ? Promise.resolve(object) : Promise.reject(new Error(`object not in locator: ${oid}`))
      },
      ...(locate ? { locate } : {}),
    }
  }

  /** Every oid currently stored — snapshot one repo's contents before adding another's. */
  snapshot(): Set<string> {
    return new Set(this.objects.keys())
  }
}

export { MODE_GITLINK, MODE_TREE }
