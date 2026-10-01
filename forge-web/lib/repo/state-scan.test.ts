/**
 * The state scan (`./state-scan`): what a newest-first read of a repo's state changes proves, and
 * what it leaves to a proved sum.
 */

import { describe, expect, it } from 'vitest'

import { ISSUE_CLOSE, ISSUE_LOCK, ISSUE_REOPEN, PR_CLOSE, PR_DRAFT, PR_DRAFT_CLOSE, PR_DRAFT_REOPEN, PR_LOCK, PR_MERGE, PR_READY, PR_REOPEN, deltaOf, threadStateOf } from '../rules/transition'
import type { RepoRef } from './contract'
import { mockSdk, newSeen } from './drive-mock'
import { SCAN_PAGE, codeAfter, newScan, readScanPage, recordScanPage, scanCodes, scanFloor, settledCode } from './state-scan'

const T = (id: string, target: string, number: number, kind: number, at: number) => ({
  $id: id,
  $createdAt: at,
  targetId: target,
  targetNumber: number,
  targetKind: Math.floor(kind / 10),
  kind,
})

/** A full page: `n` filler changes on targets of their own, newest first, ending at `last`. */
function filler(prefix: string, from: number, last: number, n = SCAN_PAGE) {
  return Array.from({ length: n }, (_, k) => T(`${prefix}${k}`, `${prefix}t${k}`, from - k, PR_MERGE, last + (n - 1 - k)))
}

describe('state scan', () => {
  it("each state-moving kind leaves its target in the state the contract's c1–c5 rules require; locks move none", () => {
    // The same answer as the target's delta sum after a legal history ending in that kind.
    const histories: [number[], number][] = [
      [[ISSUE_CLOSE], 1],
      [[ISSUE_CLOSE, ISSUE_REOPEN], 0],
      [[PR_CLOSE], 1],
      [[PR_CLOSE, PR_REOPEN], 0],
      [[PR_MERGE], 2],
      [[PR_DRAFT], 8],
      [[PR_DRAFT, PR_READY], 0],
      [[PR_DRAFT, PR_DRAFT_CLOSE], 9],
      [[PR_DRAFT, PR_DRAFT_CLOSE, PR_DRAFT_REOPEN], 8],
    ]
    for (const [kinds, code] of histories) {
      const sum = kinds.reduce((a, k) => a + (deltaOf(k) ?? 0), 0)
      expect(threadStateOf(sum).code).toBe(code)
      expect(codeAfter(kinds[kinds.length - 1] as number)).toBe(code)
    }
    expect(codeAfter(ISSUE_LOCK)).toBeNull()
    expect(codeAfter(PR_LOCK)).toBeNull()
  })

  it("a target's newest state change decides it, once the scan is past that change's timestamp", () => {
    const scan = newScan()
    // Newest first: #7 reopened at 900 after a close at 500; #8 merged at 899; then filler down to 400.
    recordScanPage(scan, [T('a', 'p7', 7, PR_REOPEN, 900), T('b', 'p8', 8, PR_MERGE, 899), T('c', 'p7', 7, PR_CLOSE, 500), ...filler('f', 6, 400, SCAN_PAGE - 3)])
    expect(scan.watermark).toBe(400)
    expect(settledCode(scan, scan.targets.get('p7')!)).toBe(0)
    expect(settledCode(scan, scan.targets.get('p8')!)).toBe(2)
    // The page's last change sits on the watermark: another change at 400 may be unread.
    expect(settledCode(scan, scan.targets.get('ft96')!)).toBeNull()
    expect(scan.byNumber.get(7)).toBe('p7')
  })

  it('two state moves of one target in one block are left to the proved sum', () => {
    const scan = newScan()
    recordScanPage(scan, [T('a', 'p7', 7, PR_REOPEN, 900), T('b', 'p7', 7, PR_CLOSE, 900)])
    expect(scan.done).toBe(true)
    expect(settledCode(scan, scan.targets.get('p7')!)).toBeNull()
  })

  it('a lock alone settles nothing; the state change below it does', () => {
    const scan = newScan()
    recordScanPage(scan, [T('a', 'i3', 3, ISSUE_LOCK, 900), T('b', 'i3', 3, ISSUE_CLOSE, 800)])
    expect(settledCode(scan, scan.targets.get('i3')!)).toBe(1)
    const lockOnly = newScan()
    recordScanPage(lockOnly, [T('a', 'i3', 3, ISSUE_LOCK, 900)])
    expect(settledCode(lockOnly, lockOnly.targets.get('i3')!)).toBeNull()
  })

  it('a short page ends the scan; a full page that adds nothing says it is stuck on its timestamp', () => {
    const scan = newScan()
    expect(recordScanPage(scan, filler('f', 500, 1000))).toBe(true)
    expect(scan.done).toBe(false)
    expect(scan.pages).toBe(1)
    expect(recordScanPage(scan, filler('g', 300, 10, 40))).toBe(true)
    expect(scan.done).toBe(true)
    // The same page again (100+ changes on one timestamp read so): nothing new, and not done.
    const tie = newScan()
    const same = Array.from({ length: SCAN_PAGE }, (_, k) => T(`s${k}`, `t${k}`, 1000 - k, PR_MERGE, 777))
    expect(recordScanPage(tie, same)).toBe(true)
    expect(recordScanPage(tie, same)).toBe(false)
    expect(tie.done).toBe(false)
  })

  it('a timestamp shared by 100+ changes is read whole, then the scan goes below it (a bulk import in one block)', async () => {
    const repoId = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
    const repo: RepoRef = { forge: { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }, repoId, ownerId: 'o', name: 'n', visibility: 'public' }
    const doc = (k: number, number: number, kind: number, at: number) => ({ $id: `x${String(k).padStart(4, '0')}`, $createdAt: at, repoId, targetId: `t${number}`, targetNumber: number, targetKind: 1, kind })
    // 10 newer changes, 150 in one block at 500 (#42 among them closed; its reopen in the same
    // block), and 30 older ones.
    const docs = [
      ...Array.from({ length: 10 }, (_, k) => doc(k, 1000 + k, PR_MERGE, 900 + k)),
      ...Array.from({ length: 148 }, (_, k) => doc(100 + k, 600 + k, PR_MERGE, 500)),
      doc(300, 42, PR_CLOSE, 500),
      doc(301, 42, PR_REOPEN, 500),
      ...Array.from({ length: 30 }, (_, k) => doc(400 + k, 100 + k, PR_MERGE, 100 + k)),
    ]
    const seen = newSeen()
    const sdk = mockSdk({ COLLAB: { transition: docs } }, seen)
    const scan = newScan()
    for (let k = 0; k < 10 && !scan.done; k++) await readScanPage(sdk, repo, scan)
    expect(scan.done && scan.complete).toBe(true)
    expect(scan.seen.size).toBe(docs.length)
    // Its two moves in one block: the scan leaves #42 to the proved sum.
    expect(settledCode(scan, scan.targets.get('t42')!)).toBeNull()
    expect(settledCode(scan, scan.targets.get('t600')!)).toBe(2)
  })

  it("the floor is the oldest page's middle number: a page of late closes of old rows does not drag it down", () => {
    const scan = newScan()
    expect(scanFloor(scan)).toBe(Infinity)
    // 30 late closes of rows numbered 1-30, then 70 changes of rows 1000-931.
    const late = Array.from({ length: 30 }, (_, k) => T(`l${k}`, `lt${k}`, k + 1, PR_CLOSE, 5000 - k))
    recordScanPage(scan, [...late, ...filler('f', 1000, 1000, 70)])
    expect(scanFloor(scan)).toBeGreaterThan(900)
  })

  it('codes a read row needs no sum for: settled targets, and never-moved rows created after the watermark', () => {
    const scan = newScan()
    recordScanPage(scan, [T('a', 'p7', 7, PR_MERGE, 900), ...filler('f', 6, 400, SCAN_PAGE - 1)])
    const doc = (id: string, at: number) => ({ $id: id, $createdAt: at })
    const codes = scanCodes(scan, [doc('p7', 100), doc('new', 401), doc('old', 399), doc('edge', 400)])
    expect(codes.get('p7')).toBe(2)
    expect(codes.get('new')).toBe(0)
    // Created at or before the watermark: a change of its may be unread.
    expect(codes.has('old')).toBe(false)
    expect(codes.has('edge')).toBe(false)
    // Once every change is read, a row no change names never moved.
    const all = newScan()
    recordScanPage(all, [T('a', 'p7', 7, PR_MERGE, 900)])
    expect(scanCodes(all, [doc('old', 1)]).get('old')).toBe(0)
  })
})
