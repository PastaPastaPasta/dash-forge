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
