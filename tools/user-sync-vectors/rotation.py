"""Vectors for the forge-user sync key at each rotation (docs/design/identity-synced-state.md).

python3 -I tools/user-sync-vectors/rotation.py > forge-contracts/fixtures/user-sync/rotation.json

The wallet's DIP-13 application encryption key, computed independently of rust-dashcore: BIP39
seed (PBKDF2-HMAC-SHA512, empty passphrase), BIP32 master, then hardened children of
m/9'/coin'/5'/7'/0'/identityId'/contractId'/1'/rotation' where identityId and contractId are
DIP-14 256-bit hardened indices (HMAC input 0x00 || k || the 32 bytes). Test keys only.
"""
import hashlib, hmac, json

N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
P = 2**256 - 2**32 - 977
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

def add(a, b):
    if a is None: return b
    if b is None: return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0: return None
    if a == b: l = 3 * a[0] * a[0] * pow(2 * a[1], -1, P) % P
    else: l = (b[1] - a[1]) * pow(b[0] - a[0], -1, P) % P
    x = (l * l - a[0] - b[0]) % P
    return (x, (l * (a[0] - x) - a[1]) % P)

def mul(k):
    r, q = None, G
    while k:
        if k & 1: r = add(r, q)
        q = add(q, q); k >>= 1
    return r

def compressed(k):
    x, y = mul(k)
    return bytes([2 + (y & 1)]) + x.to_bytes(32, 'big')

B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def unb58(s):
    n = 0
    for c in s: n = n * 58 + B58.index(c)
    return n.to_bytes(32, 'big')

MNEMONIC = ('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon '
            'abandon about')
IDENTITY = '9oaYDFZ9n1zsuzMRdGLyUatghRj1zhTGJNi7uNQZzDjX'
CONTRACT = '46phmETaASw6L1AsBc3MDTCQTMGkiVV8hGwsgi5ay6BU'
PURPOSE = 1

def seed(words):
    return hashlib.pbkdf2_hmac('sha512', words.encode(), b'mnemonic', 2048)

def child(k, c, data):
    i = hmac.new(c, b'\0' + k.to_bytes(32, 'big') + data, hashlib.sha512).digest()
    return (int.from_bytes(i[:32], 'big') + k) % N, i[32:]

def derive(s, path):
    i = hmac.new(b'Bitcoin seed', s, hashlib.sha512).digest()
    k, c = int.from_bytes(i[:32], 'big'), i[32:]
    for level in path:
        k, c = child(k, c, level if isinstance(level, bytes) else (level | 1 << 31).to_bytes(4, 'big'))
    return k

def path(mainnet, identity, contract, purpose, rotation):
    return [9, 5 if mainnet else 1, 5, 7, 0, identity, contract, purpose, rotation]

def shown(p):
    return 'm/' + '/'.join(('0x' + l.hex() if isinstance(l, bytes) else str(l)) + "'" for l in p)

def vector(network, rotation):
    p = path(network == 'mainnet', unb58(IDENTITY), unb58(CONTRACT), PURPOSE, rotation)
    k = derive(seed(MNEMONIC), p)
    return {'network': network, 'rotation': rotation, 'path': shown(p),
            'privateKeyHex': k.to_bytes(32, 'big').hex(), 'publicKeyHex': compressed(k).hex()}

# dashpay/kotlin-platform platform-mobile/src/key_wallet.rs `rotation_level_vectors_on_mainnet`.
WALLET = [
    (bytes([0x35] * 32), bytes([0x6b] * 32), 1, 0,
     '031a882c119e2b1f8e0349b444d877afa2599efeef49a26930fd25518cb6e9d57a'),
    (bytes([0x35] * 32), bytes([0x6b] * 32), 1, 1,
     '03d0f6f0f48d968b9554d8e7fe467d7135bacf29d5c4994ca593bd10ebeed696f6'),
    (bytes(range(32)), bytes(0xff - i for i in range(32)), 1, 0,
     '02dfed57ddaaea8c0758e8da44513520038eb8d6b0b92109953c14d6ab1087259b'),
]
for identity, contract, purpose, rotation, want in WALLET:
    got = compressed(derive(seed(MNEMONIC), path(True, identity, contract, purpose, rotation))).hex()
    assert got == want, (got, want)

print(json.dumps({
    'description': 'The forge-user ENCRYPTION key at rotation r, derived from the recovery phrase '
                   'as DashPay derives it; see docs/design/identity-synced-state.md. Test keys only.',
    'mnemonic': MNEMONIC,
    'passphrase': '',
    'identityId': IDENTITY,
    'contractId': CONTRACT,
    'purpose': PURPOSE,
    'vectors': [vector(n, r) for n in ('testnet', 'mainnet') for r in (0, 1, 2)],
    'walletVectors': [
        {'network': 'mainnet', 'identityIdHex': i.hex(), 'contractIdHex': c.hex(),
         'purpose': pu, 'rotation': r, 'publicKeyHex': w}
        for i, c, pu, r, w in WALLET
    ],
}, indent=1))
