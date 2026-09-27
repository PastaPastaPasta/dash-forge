/**
 * SigV4 parity with forge-core `backends/sigv4.rs`: the same AWS test-suite vectors and S3
 * API reference examples, so the browser and the CLI sign byte for byte alike.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY_PAYLOAD_SHA256,
  amzDate,
  canonicalHeaders,
  canonicalQuery,
  keyHasBadSegment,
  sha256Hex,
  signRequest,
  uriEncode,
  type SigningKeys,
} from './sigv4'

const SUITE: SigningKeys = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
const SUITE_DATE = { date: '20150830', datetime: '20150830T123600Z' }

async function suiteSign(
  method: string,
  path: string,
  query: [string, string][] = [],
  headers: [string, string][] = [],
  sessionToken?: string,
): Promise<string> {
  const out = await signRequest(
    {
      method,
      host: 'example.amazonaws.com',
      canonicalUri: uriEncode(path, true),
      query,
      headers,
      payloadHash: EMPTY_PAYLOAD_SHA256,
      region: 'us-east-1',
      service: 'service',
      contentSha256Header: false,
    },
    sessionToken ? { ...SUITE, sessionToken } : SUITE,
    SUITE_DATE,
  )
  const auth = out.find(([k]) => k === 'authorization')?.[1] ?? ''
  return auth.split('Signature=')[1] ?? ''
}

describe('SigV4 test suite (generic service)', () => {
  it.each([
    ['get-vanilla', 'GET', '/', [], [], '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'],
    ['get-space-unnormalized', 'GET', '/example space/', [], [], '652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741'],
    ['get-utf8', 'GET', '/ሴ', [], [], '8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85'],
    [
      'get-unreserved',
      'GET',
      '/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
      [],
      [],
      '07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f',
    ],
    ['query-order-key-case', 'GET', '/', [['Param2', 'value2'], ['Param1', 'value1']], [], 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500'],
    ['utf8-query-key', 'GET', '/', [['ሴ', 'bar']], [], '2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04'],
    ['post-header-key-sort', 'POST', '/', [], [['My-Header1', 'value1']], 'c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c'],
  ] as const)('%s', async (_name, method, path, query, headers, want) => {
    expect(await suiteSign(method, path, [...query] as [string, string][], [...headers] as [string, string][])).toBe(want)
  })

  it('signs the session token', async () => {
    expect(await suiteSign('GET', '/', [], [], '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267')).toBe(
      '07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8',
    )
  })
})

describe('S3 API reference examples', () => {
  const S3: SigningKeys = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }
  const DATE = amzDate(Date.UTC(2013, 4, 24))

  it('formats the UTC stamp', () => {
    expect(DATE).toEqual({ date: '20130524', datetime: '20130524T000000Z' })
    expect(amzDate(1_440_938_160_000).datetime).toBe('20150830T123600Z')
    expect(amzDate(951_782_400_000).date).toBe('20000229')
  })

  it('GET object with a range', async () => {
    const out = await signRequest(
      {
        method: 'GET',
        host: 'examplebucket.s3.amazonaws.com',
        canonicalUri: '/test.txt',
        headers: [['range', 'bytes=0-9']],
        payloadHash: EMPTY_PAYLOAD_SHA256,
        region: 'us-east-1',
        service: 's3',
        contentSha256Header: true,
      },
      S3,
      DATE,
    )
    expect(out.find(([k]) => k === 'authorization')?.[1]).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  it('PUT object whose key needs encoding', async () => {
    const payload = await sha256Hex(new TextEncoder().encode('Welcome to Amazon S3.'))
    expect(payload).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072')
    const uri = `/${uriEncode('test$file.text', true)}`
    expect(uri).toBe('/test%24file.text')
    const out = await signRequest(
      {
        method: 'PUT',
        host: 'examplebucket.s3.amazonaws.com',
        canonicalUri: uri,
        headers: [
          ['Date', 'Fri, 24 May 2013 00:00:00 GMT'],
          ['x-amz-storage-class', 'REDUCED_REDUNDANCY'],
        ],
        payloadHash: payload,
        region: 'us-east-1',
        service: 's3',
        contentSha256Header: true,
      },
      S3,
      DATE,
    )
    expect(out.find(([k]) => k === 'authorization')?.[1]).toMatch(
      /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/,
    )
  })
})

describe('canonicalization helpers', () => {
  it('encodes like forge-core', () => {
    expect(uriEncode('a b+c=d&e', true)).toBe('a%20b%2Bc%3Dd%26e')
    expect(uriEncode('dir/file', true)).toBe('dir/file')
    expect(uriEncode('dir/file', false)).toBe('dir%2Ffile')
    expect(uriEncode('ü', true)).toBe('%C3%BC')
    expect(uriEncode('100%', true)).toBe('100%25')
  })

  it('trims, collapses and merges headers', () => {
    expect(canonicalHeaders([['X-B', '  two   words '], ['x-a', '1'], ['X-A', '2']])).toEqual({
      canonical: 'x-a:1,2\nx-b:two words\n',
      signed: 'x-a;x-b',
    })
  })

  it('keeps = on an empty query value', () => {
    expect(canonicalQuery([['b', ''], ['a', 'x y']])).toBe('a=x%20y&b=')
  })

  it('refuses keys an HTTP stack would normalize', () => {
    expect(keyHasBadSegment('packs/abc.pack')).toBe(false)
    for (const k of ['', 'a//b', './a', 'a/../b', 'a/']) expect(keyHasBadSegment(k)).toBe(true)
  })
})
