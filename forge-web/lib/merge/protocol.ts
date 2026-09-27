/**
 * Messages between the page and the merge worker. The worker does the CPU work (merge-base
 * search, tree merge, deflating and hashing the pack); every object it needs it asks the page
 * for, and the page answers from the repos' browse readers, which fetch and hash-verify them.
 */

import type { GitObject } from '../browse'
import type { MergeCheck, MergeInput, MergeOutcome, MergePlan } from './engine'

export type MergeResult = MergeOutcome | Extract<MergePlan, { kind: 'conflict' | 'malformed' | 'up-to-date' | 'unrelated' }>

export type ToWorker =
  | { readonly type: 'check'; readonly input: MergeInput }
  | { readonly type: 'run'; readonly input: MergeInput }
  | { readonly type: 'object'; readonly req: number; readonly object?: GitObject; readonly error?: string }

export type FromWorker =
  | { readonly type: 'read'; readonly req: number; readonly oid: string }
  | { readonly type: 'progress'; readonly phase: 'analyse' | 'merge' | 'pack'; readonly detail?: string }
  | { readonly type: 'checked'; readonly check: MergeCheck }
  | { readonly type: 'done'; readonly result: MergeResult }
  | { readonly type: 'error'; readonly message: string }
