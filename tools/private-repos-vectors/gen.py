import hashlib, hmac, json, struct
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend
H = lambda b: b.hex()
def sha256(b): return hashlib.sha256(b).digest()
repoId = bytes([0x11])*32; ownerId = bytes([0x22])*32
K0 = bytes(range(0,32)); K1 = bytes(range(32,64))
def prk(K): return hmac.new(repoId, K, hashlib.sha256).digest()
def expand(PRK, info, L=32): return HKDFExpand(algorithm=hashes.SHA256(), length=L, info=info).derive(PRK)
def info(label, epoch, extra=b""): return b"dash-forge/v2/" + label + b"\x00" + struct.pack(">I", epoch) + extra
def tlv(*f): return b"".join(bytes([t])+struct.pack(">H",len(v))+v for t,v in f)
out = {}
PRK0, PRK1 = prk(K0), prk(K1)
out["prk_e0"]=H(PRK0)
K_doc0=expand(PRK0,info(b"doc",0)); K_ref0=expand(PRK0,info(b"ref",0)); KCV0=expand(PRK0,info(b"kcv",0))[:14]; C0=expand(PRK0,info(b"commit",0))
K_doc1=expand(PRK1,info(b"doc",1)); K_ref1=expand(PRK1,info(b"ref",1)); KCV1=expand(PRK1,info(b"kcv",1))[:14]; C1=expand(PRK1,info(b"commit",1))
out.update(K_doc_e0=H(K_doc0),K_ref_e0=H(K_ref0),kcv_e0=H(KCV0),commit_e0=H(C0),K_doc_e1=H(K_doc1),K_ref_e1=H(K_ref1),kcv_e1=H(KCV1),commit_e1=H(C1))
rnh=hmac.new(K_ref0,b"refs/heads/main",hashlib.sha256).digest()
out["refNameHash_main_e0"]=H(rnh); out["refNameHash_main_e1"]=H(hmac.new(K_ref1,b"refs/heads/main",hashlib.sha256).digest())
out["public_sha256_main"]=H(sha256(b"refs/heads/main"))
def ad(ver, doctype, epoch, bind): return b"dash-forge/v2/doc\x00"+bytes([ver])+repoId+ownerId+struct.pack(">I",epoch)+doctype+b"\x00"+bind
def oidf(o): return bytes([len(o)])+o
nonce=bytes.fromhex("000102030405060708090a0b")
def seal1(K, doctype, epoch, bind, pt):
    A=ad(1,doctype,epoch,bind); return A, b"\x01"+nonce+AESGCM(K).encrypt(nonce,pt,A)
def seal2(K, C, epoch, pt):
    A=ad(2,b"config",epoch,C); return A, b"\x02"+C+nonce+AESGCM(K).encrypt(nonce,pt,A)
pt=tlv((1,b"Rotate the signing key"),(2,b"See the runbook."))
A,e=seal1(K_doc0,b"issue",0,struct.pack(">I",7),pt); out["issue"]=dict(ad=H(A),pt=H(pt),enc=H(e),enc_len=len(e))
newOid=bytes([0xaa])*20
pt2=tlv((3,b"refs/heads/main")); A,e=seal1(K_doc0,b"refUpdate",0,rnh+oidf(newOid)+oidf(b"")+b"\x00",pt2); out["refUpdate"]=dict(ad=H(A),pt=H(pt2),enc=H(e))
# refUpdate with wrong refNameHash (hash of refs/heads/dev) but refName main inside -> Malformed
rnh_dev=hmac.new(K_ref0,b"refs/heads/dev",hashlib.sha256).digest()
A,e=seal1(K_doc0,b"refUpdate",0,rnh_dev+oidf(newOid)+oidf(b"")+b"\x00",pt2); out["refUpdate_hash_mismatch"]=dict(refNameHash=H(rnh_dev),enc=H(e))
A,e=seal1(K_doc0,b"comment",0,bytes([0x33])*32,b""); out["comment_empty"]=dict(ad=H(A),enc=H(e),enc_len=len(e))
ptc=tlv((2,b"nit: rename"),(10,b"src/lib.rs")); A,e=seal1(K_doc0,b"comment",0,bytes([0x33])*32,ptc); out["comment_inline"]=dict(pt=H(ptc),enc=H(e))
pt0=tlv((6,b"refs/heads/main")); A,e=seal2(K_doc0,C0,0,pt0); out["config_anchor_e0"]=dict(ad=H(A),pt=H(pt0),enc=H(e),enc_len=len(e))
pt3=tlv((6,b"refs/heads/main"),(7,b"refs/heads/main"),(8,struct.pack(">I",0)),(9,K0)); A,e=seal2(K_doc1,C1,1,pt3); out["config_anchor_e1"]=dict(ad=H(A),pt=H(pt3),enc=H(e))
# v2 config under K1 but with commit of a different key (split view) -> commit mismatch, alert
Kx=bytes([0x77])*32; PRKx=prk(Kx); Cx=expand(PRKx,info(b"commit",1)); K_docx=expand(PRKx,info(b"doc",1))
A,e=seal2(K_docx,Cx,1,pt3); out["config_anchor_e1_other_key"]=dict(commit=H(Cx),enc=H(e))
# empty-config epoch 0 minimal v2 length: 1+32+12+16 = 61
file_id=bytes.fromhex("f0e1d2c3b4a5968778695a4b3c2d1e0f"); L=14; S=1<<L
plain=bytes(i%251 for i in range(40000))
header=b"DFPK"+b"\x01"+bytes([L])+b"\x00\x00"+struct.pack(">I",0)+struct.pack(">Q",len(plain))+file_id
K_file=expand(PRK0,info(b"pack",0,b"\x01"+file_id)); nseg=max(1,-(-len(plain)//S))
sealed=bytearray(header); tags=[]
for i in range(nseg):
    seg=plain[i*S:(i+1)*S]; n=struct.pack(">Q",i)+b"\x00\x00\x00"+bytes([1 if i==nseg-1 else 0])
    c=AESGCM(K_file).encrypt(n,seg,header); sealed+=c; tags.append(H(c[-16:]))
out["pack"]=dict(header=H(header),K_file=H(K_file),nseg=nseg,sealed_len=len(sealed),packHash=H(sha256(bytes(sealed))),plain_sha256=H(sha256(plain)),tags=tags)
h0=b"DFPK"+b"\x01"+bytes([L])+b"\x00\x00"+struct.pack(">I",0)+struct.pack(">Q",0)+file_id
out["empty_pack_sealed"]=H(h0+AESGCM(K_file).encrypt(struct.pack(">Q",0)+b"\x00\x00\x00\x01",b"",h0))
P=2**256-2**32-977; N=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G=(0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
def inv(a): return pow(a,P-2,P)
def add(p,q):
    if p is None: return q
    if q is None: return p
    if p[0]==q[0] and (p[1]+q[1])%P==0: return None
    l=(3*p[0]*p[0])*inv(2*p[1])%P if p==q else (q[1]-p[1])*inv(q[0]-p[0])%P
    x=(l*l-p[0]-q[0])%P; return (x,(l*(p[0]-x)-p[1])%P)
def mul(k,p):
    r=None
    while k:
        if k&1: r=add(r,p)
        p=add(p,p); k>>=1
    return r
def comp(pt): return bytes([2+(pt[1]&1)])+pt[0].to_bytes(32,"big")
d_s=int.from_bytes(sha256(b"dash-forge vectors: sender"),"big")%N; d_r=int.from_bytes(sha256(b"dash-forge vectors: recipient"),"big")%N
Ps,Pr=mul(d_s,G),mul(d_r,G); shared=sha256(comp(mul(d_s,Pr))); assert shared==sha256(comp(mul(d_r,Ps)))
iv=bytes.fromhex("0f0e0d0c0b0a09080706050403020100"); wrap_pt=b"\x01"+KCV0+K0; assert len(wrap_pt)==47
pad=16-len(wrap_pt)%16; padded=wrap_pt+bytes([pad])*pad
enc=Cipher(algorithms.AES(shared),modes.CBC(iv),backend=default_backend()).encryptor()
wrapped=iv+enc.update(padded)+enc.finalize()
out["wrap"]=dict(sender_priv=d_s.to_bytes(32,"big").hex(),sender_pub=H(comp(Ps)),recipient_priv=d_r.to_bytes(32,"big").hex(),recipient_pub=H(comp(Pr)),shared=H(shared),plaintext=H(wrap_pt),wrapped=H(wrapped),wrapped_len=len(wrapped))
print(json.dumps(out,indent=1))
