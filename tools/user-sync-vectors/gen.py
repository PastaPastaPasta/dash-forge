"""Shared vectors for forge-user sync crypto (docs/design/identity-synced-state.md section 4).

python3 -I tools/user-sync-vectors/gen.py > forge-contracts/fixtures/user-sync/vectors.json
Deterministic: every key and nonce is derived from fixed labels. Test keys only.
"""
import hashlib, json, struct, zlib
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58(b):
    n = int.from_bytes(b, 'big'); s = ''
    while n: n, r = divmod(n, 58); s = B58[r] + s
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + s
def h(label): return hashlib.sha256(b'forge-user-vectors/' + label.encode()).digest()
def hkdf(ikm, salt, info): return HKDF(hashes.SHA256(), 32, salt, info).derive(ikm)
def u32(x): return struct.pack('>I', x)
def lp(s): b = s.encode(); return bytes([len(b)]) + b
def priv(label):
    k = ec.derive_private_key(int.from_bytes(h(label), 'big') % (2**256 - 2**32 - 977), ec.SECP256K1())
    return k
def privbytes(k): return k.private_numbers().private_value.to_bytes(32, 'big')
def pub(k): return k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.CompressedPoint)
def deflate_raw(b):
    c = zlib.compressobj(9, zlib.DEFLATED, -15); return c.compress(b) + c.flush()

NETWORK = 'testnet'
owner_id = h('owner-id'); member_id = h('member-id'); repo_id = h('repo-id')
E_owner = priv('owner-enc'); E_member = priv('member-enc')
OWNER_KEY_ID, MEMBER_KEY_ID = 7, 9

def state_key(E, identity, slot):
    return hkdf(privbytes(E), identity, b'forge-user/v1/state/' + NETWORK.encode() + b'/' + slot.encode())
def state_aad(identity, slot, v, key_id):
    return b'forge-user/v1' + lp(NETWORK) + identity + lp(slot) + bytes([v]) + u32(key_id)
def rsk(E, repo, epoch):
    return hkdf(privbytes(E), repo, b'forge-user/v1/repo-storage/' + NETWORK.encode() + b'/' + u32(epoch))
def share_aad(repo, epoch, key_id):
    return b'forge-user/v1/share' + lp(NETWORK) + repo + u32(epoch) + u32(key_id)
def grant_key(shared, repo, member, epoch, sender_kid, recipient_kid):
    return hkdf(shared, repo, b'forge-user/v1/grant/' + lp(NETWORK) + member + u32(epoch) + u32(sender_kid) + u32(recipient_kid))

storage_doc = {
    'format': 'forge-user/storage', 'version': 1,
    'entries': {
        'profile:r2-main': {'at': 1764000000000, 'v': {'settings': {'kind': 's3', 'provider': 'r2', 'endpoint': 'https://acct.r2.cloudflarestorage.com', 'region': 'auto', 'bucket': 'forge', 'pathStyle': True, 'publicUrl': 'https://packs.example.org', 'prefix': ''}, 'secrets': {'accessKeyId': 'AKIDTEST', 'secretAccessKey': 'test-secret-not-real'}}},
        'profile:old-kubo': {'at': 1764000100000, 'v': None},
        'default': {'at': 1764000000000, 'v': {'targets': ['r2-main'], 'replicas': 1, 'platformFallback': False}},
    },
}
prefs_doc = {'format': 'forge-user/prefs', 'version': 1, 'entries': {'diff': {'at': 1764000000000, 'v': {'diffLayout': 'unified', 'ignoreWhitespace': True, 'palette': 'colorblind'}}, 'mergeIdentity': {'at': 1764000000000, 'v': {'name': 'Test User', 'email': 'test@example.org'}}}}

out = {'description': 'forge-user sync crypto vectors; see docs/design/identity-synced-state.md section 4. Test keys only.', 'network': NETWORK,
       'ownerId': b58(owner_id), 'memberId': b58(member_id), 'repoId': b58(repo_id),
       'ownerEncPrivHex': privbytes(E_owner).hex(), 'ownerEncPubHex': pub(E_owner).hex(), 'ownerKeyId': OWNER_KEY_ID,
       'memberEncPrivHex': privbytes(E_member).hex(), 'memberEncPubHex': pub(E_member).hex(), 'memberKeyId': MEMBER_KEY_ID,
       'state': [], 'share': None, 'grant': None}
for slot, doc in (('storage', storage_doc), ('prefs', prefs_doc)):
    plain = json.dumps(doc, separators=(',', ':'), sort_keys=True).encode()
    comp = deflate_raw(plain)
    key = state_key(E_owner, owner_id, slot); n = h('nonce/' + slot)[:12]; aad = state_aad(owner_id, slot, 1, OWNER_KEY_ID)
    ct = AESGCM(key).encrypt(n, comp, aad)
    out['state'].append({'slot': slot, 'v': 1, 'keyHex': key.hex(), 'aadHex': aad.hex(), 'nonceHex': n.hex(), 'compressedHex': comp.hex(), 'ciphertextHex': ct.hex(), 'd0Hex': ct[:5000].hex(), 'plaintextJson': doc})

# a state blob over 5000 bytes splits into d0/d1/d2
big = {'format': 'forge-user/prefs', 'version': 1, 'entries': {f'k{i}': {'at': i, 'v': hashlib.sha256(str(i).encode()).hexdigest()} for i in range(150)}}
comp = deflate_raw(json.dumps(big, separators=(',', ':'), sort_keys=True).encode())
key = state_key(E_owner, owner_id, 'big'); n = h('nonce/big')[:12]; aad = state_aad(owner_id, 'big', 1, OWNER_KEY_ID)
ct = AESGCM(key).encrypt(n, comp, aad)
assert 5000 < len(ct) <= 15000, len(ct)
out['state'].append({'slot': 'big', 'v': 1, 'keyHex': key.hex(), 'aadHex': aad.hex(), 'nonceHex': n.hex(), 'ciphertextHex': ct.hex(), 'd0Hex': ct[:5000].hex(), 'd1Hex': ct[5000:10000].hex(), 'd2Hex': ct[10000:].hex() or None, 'plaintextJson': big})

epoch = 3
r = rsk(E_owner, repo_id, epoch)
share_plain = {'format': 'forge-user/share', 'version': 1, 'profiles': {'r2-main': storage_doc['entries']['profile:r2-main']['v']}, 'policy': {'targets': ['r2-main'], 'replicas': 1, 'platformFallback': False}}
comp = deflate_raw(json.dumps(share_plain, separators=(',', ':'), sort_keys=True).encode())
n = h('nonce/share')[:12]; aad = share_aad(repo_id, epoch, OWNER_KEY_ID)
ct = AESGCM(r).encrypt(n, comp, aad)
out['share'] = {'epoch': epoch, 'rskHex': r.hex(), 'aadHex': aad.hex(), 'nonceHex': n.hex(), 'ciphertextHex': ct.hex(), 'plaintextJson': share_plain}

shared_o = E_owner.exchange(ec.ECDH(), E_member.public_key())
shared_m = E_member.exchange(ec.ECDH(), E_owner.public_key())
assert shared_o == shared_m
w = grant_key(shared_o, repo_id, member_id, epoch, OWNER_KEY_ID, MEMBER_KEY_ID)
n = h('nonce/grant')[:12]
wrapped = n + AESGCM(w).encrypt(n, r, owner_id)
assert len(wrapped) == 60
out['grant'] = {'epoch': epoch, 'senderKeyId': OWNER_KEY_ID, 'recipientKeyId': MEMBER_KEY_ID, 'sharedXHex': shared_o.hex(), 'wrapKeyHex': w.hex(), 'aadHex': owner_id.hex(), 'wrappedHex': wrapped.hex()}
print(json.dumps(out, indent=1))
