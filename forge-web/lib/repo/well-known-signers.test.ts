/** Signatures by GitHub's web-flow keys: checked against the keys GitHub publishes, and a forgery is refused. */

import { describe, expect, it } from 'vitest'

import { verifyCommitSignature } from '../rules/signature'
import { serviceSignature } from './well-known-signers'

const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

/** dash-forge's merge of #700 on github.com, signed by GitHub's current key B5690EEEBB952194. */
const MERGE_2026 = bytes('dHJlZSA2OWVhNGVjMjI1MmVlNDliODI1NDk1MDBjZWQ2ZjNkOTM4MjI2Y2IyCnBhcmVudCA2ZGE3ZDFjNTEwZmMxNDhhYzgxNzgzMmZjMjUzYWY3MjMwNDBkNWUwCnBhcmVudCA4NDUyZWY2YTVmYWEwYzM1MGU0MDFlYjBkNTY5NzM3MDE0YmE4NjEyCmF1dGhvciBQYXN0YVBhc3RhUGFzdGEgPDY0NDMyMTArUGFzdGFQYXN0YVBhc3RhQHVzZXJzLm5vcmVwbHkuZ2l0aHViLmNvbT4gMTc5NTUzMzg4NCAtMDYwMApjb21taXR0ZXIgR2l0SHViIDxub3JlcGx5QGdpdGh1Yi5jb20+IDE3OTU1MzM4ODQgLTA2MDAKZ3Bnc2lnIC0tLS0tQkVHSU4gUEdQIFNJR05BVFVSRS0tLS0tCiAKIHdzRmNCQUFCQ0FBUUJRSnJCYXc4Q1JDMWFRN3V1NVVobEFBQVJsNFFBRVoxd3VidUgzb1RxNnQ5cUNQekxsVm8KIEd3eHBPUTJqNU1NNDNhUnY4QUV1WXN3VW9hRVlwS0JnZmZuczgzMG02dXBtY2U3L0F6S1NiaFRkVUVJMFN1YjQKIEtrMjBFa01yaGYvcC9NNTkzbElYRVU1ZHdXS3BhbVg2VCtLMGpZMzUxbkJ0bmdsUUx4Rm1yQ3hZTUpFdktvcUMKIEVlOUNKb0wrUUcyMFJjTzdCZGpZQWRrMCthL21EOXE2MklGalZLQjZNL1Z3YXdSQlNGK2JZZlpEMU1kWk5WdEYKIE1YcG84U0xLR3BqVi9IWlYwUTR2VUVTN1ZlK3VLREhicnpGMXpGVUNoOHBNNkxJMVJRK2RVelVoZXkzU216Ni8KIG1ZcFQzd0dhSmdxa01TQUhRSFJxVGhWek1JL3NGTjEwTnBjWENOOTJuZDBiWXFxQ011bHFpWW9SNHdwVi9nRSsKIEtmbGptLzVseDY5RnVMcDlXY29oelcrR2Fub1RuaElmMGd3U3pHVENrK2hDODdtUzBKd2gxT09pVDZDT3dCMXUKIFV0WVh2Ly9YODlHTWp3Sy9oOFBnNm9aTEVaQ0xJb0FHM3RSMVdpYkkyRzExNDhpdHh5K2YxYkJyQ3JHMUlMbUUKIGMrelZoc0dKYitHcnd1Z0paR28yT2pWWFlvU1JKb1dvRjFSeFc1b0lGY3kyendBazZNQTcxYmg0eDVsUW1KSisKIGt5QjliK1hrRGY5S2hSbk80RDlIWS9KNTJ5TmMra09pT1gwWEJqWm1mQi9Nb3FyZUZZR1ppY052d2o4T2FKRUkKIGpOWStKRkRoZFlFaUxBbFBuSWpxRUJRZFVCYXpTMk8zazhGYUx6WWpLajZ1OFcvUTdUb0drZEsrbElZdlRSb1UKIHBrSW9oUW05bG1yOWg2KytMaVhECiA9RXNyMwogLS0tLS1FTkQgUEdQIFNJR05BVFVSRS0tLS0tCiAKCk1lcmdlIHB1bGwgcmVxdWVzdCAjNzAwIGZyb20gUGFzdGFQYXN0YVBhc3RhL2xhdW5jaC9tYWlubmV0LXJlZ2lzdHJhdGlvbgoKY2hvcmUobWFpbm5ldCk6IHJlY29yZCB0aGUgRm9yZ2UgY29udHJhY3QgcmVnaXN0cmF0aW9uIG9uIG1haW5uZXQ=')
/** dashpay/dash 039529974a, merged on github.com in 2023 and signed by GitHub's retired 2017 key 4AEE18F83AFDEB23. */
const MERGE_2023 = bytes('dHJlZSAyNTBjMmJhZDYxMGMyNWY4MWZiM2MzZmRhNjNkMmU1YTZkZjA4M2Q5CnBhcmVudCAwNTMxOTczNzg3ODJlMGU1YWEwOTNmNzhlOGVlYjY2MTMwYzkyNjAzCnBhcmVudCAwMTg0MWRmNTBkMzZiN2ZhZmRhN2YwNjA2Zjc0MTFjMWI1NmM0NWQwCmF1dGhvciBQYXN0YVBhc3RhUGFzdGEgPDY0NDMyMTArUGFzdGFQYXN0YVBhc3RhQHVzZXJzLm5vcmVwbHkuZ2l0aHViLmNvbT4gMTcwMzk3NjI1NSAtMDYwMApjb21taXR0ZXIgR2l0SHViIDxub3JlcGx5QGdpdGh1Yi5jb20+IDE3MDM5NzYyNTUgLTA2MDAKZ3Bnc2lnIC0tLS0tQkVHSU4gUEdQIFNJR05BVFVSRS0tLS0tCiAKIHdzQmNCQUFCQ0FBUUJRSmxrSjAvQ1JCSzdoajRPdjNySXdBQTZwUUlBQ2FuR1RiK2llWUF3c0tGenJqamFNdFIKIFEvNmZOSXBUUk9zcWh5VlNFcXA5SndJaFQ3TXBrWXRkYkNkSU9LTHFTVE9LUVdZTE5obWVSUEJyTHRhQXEwYTUKIHY4U2V2c2pNa0c1K042TnVLcnRPSjhjSktvTi9RclROWVBLa0N3ODRGbXZvekdiQkhmSXlOenBCSmFKZ2lpZlIKIGFvZXVFbStxMEUzeTZ1ZnRXSC9TbituODV1aURQaDlHWmFkMml3WDJRaTNMY3QwNkNjYTA3RzJCMks2VTNST2MKIHE0b25LTVRVdDNrRG1GQkRXdVhoMy9qTG11aG42djFqWDZWZ29vSVZCZk1sa3ZOcTk4Y3JXUEZVS1dHcE5GR0YKIHlQSzdwbHQ0MVFZRkVIdTJtRm96TStRbmFEcVFrcW9PMDhtWnBhdzFOUTByaE9OdXkvaE9LQzdINFBNMXRqOD0KID1nWEVSCiAtLS0tLUVORCBQR1AgU0lHTkFUVVJFLS0tLS0KIAoKTWVyZ2UgcHVsbCByZXF1ZXN0ICM1Nzk0IGZyb20gVWRqaW5NNi9tZXJnZV9tYXN0ZXJfMjAuMC4zCgpjaG9yZTogTWVyZ2UgbWFzdGVyIDIwLjAuMyBiYWNrIGludG8gZGV2ZWxvcA==')
/** dash-forge 8452ef6a5, signed with an SSH key. */
const SSH_SIGNED = bytes('dHJlZSA2OWVhNGVjMjI1MmVlNDliODI1NDk1MDBjZWQ2ZjNkOTM4MjI2Y2IyCnBhcmVudCAwY2Y2NzQ5ZTBlNDMxODgyNWJiZTIzNzM0ODczODNjMjkwMWJhOWI1CmF1dGhvciBwYXN0YSA8cGFzdGFAZGFzaGJvb3N0Lm9yZz4gMTc5NTUzMzUwMiArMDAwMApjb21taXR0ZXIgcGFzdGEgPHBhc3RhQGRhc2hib29zdC5vcmc+IDE3OTU1MzM1MDIgKzAwMDAKZ3Bnc2lnIC0tLS0tQkVHSU4gU1NIIFNJR05BVFVSRS0tLS0tCiBVMU5JVTBsSEFBQUFBUUFBQURNQUFBQUxjM05vTFdWa01qVTFNVGtBQUFBZ1VrMW1Sai9PUGlxcTdmYUNxWmZTRkxJajJ2CiBISmswTlVkWFFVdDJSbFZYTUFBQUFEWjJsMEFBQUFBQUFBQUFaemFHRTFNVElBQUFCVEFBQUFDM056YUMxbFpESTFOVEU1CiBBQUFBUUNtZmJmRGtLSmRLNDZLVTF2TzFVMmFNL3dwcHQvOVJkamc4SFpMNXlmVU5tSHhXMTZ0N0VKc1IzMmpjZGhrSEc0CiBMOGNmK0FiQTBlR1crd2s4bjNJZ3M9CiAtLS0tLUVORCBTU0ggU0lHTkFUVVJFLS0tLS0KCnRlc3Q6IHN0b3AgdHJlYXRpbmcgbWFpbm5ldCBhcyB1bmRlcGxveWVkCgpUaGUgZG9jdG9yJ3MgZnJlc2gtaW5zdGFsbCB0ZXN0IHVzZWQgbWFpbm5ldCBhcyBpdHMgdW5kZXBsb3llZCBuZXR3b3JrLAphbmQgdGhlIHdlYiBzZWVkIHRlc3QgcGlubmVkIG1haW5uZXQncyBzZWVkIGNvdW50IGF0IDEwOyBtYWlubmV0IGlzIG5vdwpkZXBsb3llZCB3aXRoIHJlZnJlc2hlZCBzZWVkcy4KCkNvLUF1dGhvcmVkLUJ5OiBDbGF1ZGUgT3B1cyA1LjUgPG5vcmVwbHlAYW50aHJvcGljLmNvbT4K')

const judge = async (b: Uint8Array) => {
  const v = await verifyCommitSignature(b, [])
  if (v === null) throw new Error('unsigned')
  return { v, service: await serviceSignature(b, v) }
}

describe('serviceSignature', () => {
  it("checks GitHub's current web-flow key", async () => {
    const { v, service } = await judge(MERGE_2026)
    expect(v).toMatchObject({ status: 'unverified', reason: 'unknown_key', format: 'openpgp' })
    expect(service).toBe('github')
  })

  it("does not trust GitHub's retired 2017 key", async () => {
    const { v, service } = await judge(MERGE_2023)
    expect(v).toMatchObject({ reason: 'unknown_key', key: '4AEE18F83AFDEB23' })
    expect(service).toBeNull()
  })

  it("refuses GitHub's signature moved onto another commit", async () => {
    const forged = new TextDecoder().decode(MERGE_2026).replace(/^tree [0-9a-f]{40}$/m, `tree ${'0'.repeat(40)}`)
    expect((await judge(new TextEncoder().encode(forged))).service).toBe('bad')
  })

  it("refuses a commit changed after GitHub signed it", async () => {
    const text = new TextDecoder().decode(MERGE_2026).replace('Merge pull request #700', 'Merge pull request #701')
    expect((await judge(new TextEncoder().encode(text))).service).toBe('bad')
  })

  it('leaves other keys alone', async () => {
    expect((await judge(SSH_SIGNED)).service).toBeNull()
  })
})
