/** Small helpers shared by the live test (`./probe`) and the upload path (`./upload`). */

/** Whether `a` and `b` hold the same bytes. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The message of a thrown value, as a row detail or a failure reason. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
