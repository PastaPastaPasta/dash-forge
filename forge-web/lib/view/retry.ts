/**
 * Read-after-write: a DAPI node one block behind answers "not found" for a document this
 * browser just wrote. Retry a read that came back empty a few times (1.5 s apart) before
 * believing it.
 */
export async function retryWhileMissing<T>(read: () => Promise<T | null>, attempts: number, delayMs = 1500): Promise<T | null> {
  for (let i = 0; ; i++) {
    const value = await read()
    if (value !== null || i >= attempts) return value
    await new Promise((r) => setTimeout(r, delayMs))
  }
}

/**
 * Read-after-write for a value that exists but must show a write this browser just made (a
 * branch a merge moved): re-read until `done` holds, `attempts` more times at most, then take
 * what the last read said.
 */
export async function retryUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, attempts: number, delayMs = 1500): Promise<T> {
  for (let i = 0; ; i++) {
    const value = await read()
    if (done(value) || i >= attempts) return value
    await new Promise((r) => setTimeout(r, delayMs))
  }
}

/**
 * Read, then re-read (`delayMs` apart, at most `attempts` more times) until every expectation in
 * `want` holds of the value: a page waiting for its own writes to show. A null read is returned at
 * once (not found is the caller's to handle). `signal.aborted` stops the polling early (a newer
 * read took over), returning the latest value.
 */
export async function readUntil<T>(
  read: () => Promise<T | null>,
  want: readonly ((v: T) => boolean)[],
  { attempts = 8, delayMs = 1500, signal }: { attempts?: number; delayMs?: number; signal?: { readonly aborted: boolean } } = {},
): Promise<T | null> {
  const stopped = (): boolean => signal?.aborted === true
  let v = await read()
  for (let i = 0; v !== null && !want.every((w) => w(v as T)) && i < attempts && !stopped(); i++) {
    await new Promise((r) => setTimeout(r, delayMs))
    if (stopped()) break
    v = await read()
  }
  return v
}
