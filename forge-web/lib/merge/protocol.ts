/**
 * Messages between the page and the merge worker. The worker does the CPU work (merge-base
 * search, tree merge, deflating and hashing the pack); every object it needs it asks the page
 * for, and the page answers from the repos' browse readers, which fetch and hash-verify them.
 */

import type { GitObject } from '../browse'
import type { MergeCheckResult, MergeInput, MergeOutcome, MergePlan } from './engine'

export type MergeResult = MergeOutcome | Exclude<MergePlan, { kind: 'fast-forward' | 'merge' }>

export type ToWorker =
  | { readonly type: 'check'; readonly input: MergeInput }
  | { readonly type: 'run'; readonly input: MergeInput }
  | { readonly type: 'object'; readonly req: number; readonly object?: GitObject; readonly error?: string; readonly tooLarge?: { readonly size: number; readonly max: number } }

export type FromWorker =
  | { readonly type: 'read'; readonly req: number; readonly oid: string; readonly maxBytes?: number }
  | { readonly type: 'progress'; readonly phase: 'analyse' | 'merge' | 'pack'; readonly detail?: string }
  | { readonly type: 'checked'; readonly check: MergeCheckResult }
  | { readonly type: 'done'; readonly result: MergeResult }
  | { readonly type: 'error'; readonly message: string }
