/**
 * Byte ranges of a UnixFS file, read block by block: only the nodes and leaves that hold
 * `[start, end)` are asked for, the siblings of one node all at once.
 */

import { blockKey, CODEC_DAG_PB, CODEC_RAW, parseFileNode, type BlockId, type FileNode } from './wire'

/** A block by CID, already hashed against it. */
export type GetBlock = (id: BlockId) => Promise<Uint8Array>

/** Parsed interior nodes (those with links), by {@link blockKey}, shared between reads (a range read walks one root again and again). */
export class NodeCache {
  private readonly nodes = new Map<string, FileNode>()
  constructor(private readonly max: number) {}

  async get(id: BlockId, getBlock: GetBlock): Promise<FileNode> {
    const key = blockKey(id)
    const hit = this.nodes.get(key)
    if (hit !== undefined) {
      this.nodes.delete(key)
      this.nodes.set(key, hit)
      return hit
    }
    const block = await getBlock(id)
    const node = parseFileNode(block)
    // A dag-pb leaf (a file not imported with raw leaves) is content, not structure: not kept.
    if (node.links.length > 0) {
      // Parsed from a copy: the block is a view into its whole bitswap message, which a kept node would pin.
      this.nodes.set(key, parseFileNode(block.slice()))
      if (this.nodes.size > this.max) this.nodes.delete(this.nodes.keys().next().value as string)
    }
    return node
  }
}

/** Bytes `[start, end)` of the file rooted at `root`. */
export async function readFileRange(root: BlockId, start: number, end: number, getBlock: GetBlock, nodes: NodeCache): Promise<Uint8Array> {
  if (start < 0 || end < start) throw new RangeError(`bad range ${start}-${end}`)
  const out = new Uint8Array(end - start)
  if (end > start) await fill(root, start, end, out, 0, getBlock, nodes)
  return out
}

async function fill(id: BlockId, start: number, end: number, out: Uint8Array, at: number, getBlock: GetBlock, nodes: NodeCache): Promise<void> {
  if (id.codec === CODEC_RAW) {
    const block = await getBlock(id)
    if (end > block.length) throw new Error('range past the end of a raw block')
    out.set(block.subarray(start, end), at)
    return
  }
  if (id.codec !== CODEC_DAG_PB) throw new Error(`codec 0x${id.codec.toString(16)} is not a file`)
  const node = await nodes.get(id, getBlock)
  const own = node.data.length
  if (start < own) out.set(node.data.subarray(start, Math.min(end, own)), at)
  if (node.sizes.reduce((a, b) => a + b, own) < end) throw new Error('range past the end of the file')
  const jobs: Promise<void>[] = []
  let offset = own
  for (let i = 0; i < node.links.length && offset < end; i++) {
    const size = node.sizes[i] as number
    const from = Math.max(start, offset)
    const to = Math.min(end, offset + size)
    if (from < to) jobs.push(fill(node.links[i] as BlockId, from - offset, to - offset, out, at + (from - start), getBlock, nodes))
    offset += size
  }
  await Promise.all(jobs)
}
