#!/usr/bin/env python3
"""Ranged-read a single blob from a pack over HTTP Range, reconstruct via the
OFS_DELTA chain, verify the git OID. Proves O(blob) browsing on real backends.

usage: ranged_read.py <idx> <pack> <oid_hex> <url> [label]
The <url> must serve the pack bytes with HTTP Range support.
"""
import sys, struct, mmap, os, zlib, hashlib, time, urllib.request

IDX,PACK,OIDHEX,URL = sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
LABEL = sys.argv[5] if len(sys.argv)>5 else URL

# --- parse idx just enough to find the object + its OFS chain offsets ---
with open(IDX,"rb") as f: idx=f.read()
fanout=struct.unpack(">256I",idx[8:8+1024]); N=fanout[255]
p=8+1024; oids=idx[p:p+20*N]; p+=20*N; p+=4*N
off32=struct.unpack(">%dI"%N,idx[p:p+4*N]); p+=4*N; big=p
def roff(i):
    v=off32[i]
    if v&0x80000000:
        j=v&0x7fffffff; return struct.unpack(">Q",idx[big+8*j:big+8*j+8])[0]
    return v
oid_list=[oids[i*20:(i+1)*20] for i in range(N)]
offsets=[roff(i) for i in range(N)]
packsize=os.path.getsize(PACK)
order=sorted(range(N),key=lambda i:offsets[i])
endof={}
for k,i in enumerate(order):
    endof[i]= offsets[order[k+1]] if k+1<N else packsize-20
off2i={offsets[i]:i for i in range(N)}
target=bytes.fromhex(OIDHEX)
ti=oid_list.index(target)

# read headers locally (we already have the pack) to find chain offsets/types.
pf=open(PACK,"rb"); mm=mmap.mmap(pf.fileno(),0,prot=mmap.PROT_READ)
OFS=6
def parse_hdr(buf,pos):
    c=buf[pos]; pos+=1; t=(c>>4)&7; size=c&0x0f; sh=4
    while c&0x80:
        c=buf[pos]; pos+=1; size|=(c&0x7f)<<sh; sh+=7
    base_rel=None
    if t==OFS:
        c=buf[pos]; pos+=1; ofs=c&0x7f
        while c&0x80:
            c=buf[pos]; pos+=1; ofs=((ofs+1)<<7)|(c&0x7f)
        base_rel=ofs
    return t,size,pos,base_rel
# build chain (list of object abs offsets from target down to root base)
chain=[]; j=ti
while True:
    o=offsets[j]; t,size,hp,brel=parse_hdr(mm,o)
    chain.append((j,o,t))
    if t==OFS:
        b=o-brel; j=off2i[b]
    else:
        break
root_off=min(offsets[j] for j,_,_ in chain)
end=endof[ti]
span=end-root_off
mm.close(); pf.close()

# --- HTTP Range fetch ONLY the span ---
req=urllib.request.Request(URL, headers={"Range":f"bytes={root_off}-{end-1}"})
t0=time.time()
resp=urllib.request.urlopen(req)
data=resp.read()
dt=time.time()-t0
status=resp.status
cr=resp.headers.get("Content-Range")
assert len(data)==span, f"got {len(data)} want {span}"

# --- reconstruct: inflate root base, apply deltas up the chain ---
def inflate_at(buf, rel):
    # rel is offset within `data` buffer; parse header then zlib-decompress payload
    t,size,hp,brel=parse_hdr(buf,rel)
    d=zlib.decompressobj()
    out=d.decompress(buf[hp:])
    # may need more but our range ends at target end; for chained bases the
    # payload is fully inside the range (bases are earlier, fully contained)
    return t,brel,out
def apply_delta(base, delta):
    # parse src size, dst size (varint), then copy/insert ops
    pos=0
    def rv():
        nonlocal pos
        r=0; sh=0
        while True:
            b=delta[pos]; pos+=1; r|=(b&0x7f)<<sh; sh+=7
            if not b&0x80: break
        return r
    srclen=rv(); dstlen=rv(); out=bytearray()
    while pos<len(delta):
        op=delta[pos]; pos+=1
        if op&0x80:
            cp_off=0; cp_size=0
            for i in range(4):
                if op&(1<<i): cp_off|=delta[pos]<<(8*i); pos+=1
            for i in range(3):
                if op&(1<<(4+i)): cp_size|=delta[pos]<<(8*i); pos+=1
            if cp_size==0: cp_size=0x10000
            out+=base[cp_off:cp_off+cp_size]
        else:
            out+=delta[pos:pos+op]; pos+=op
    assert len(out)==dstlen
    return bytes(out)

# chain is [target, ..., root]; reconstruct from root
content=None; base_type=None
for (j,o,t) in reversed(chain):
    rel=o-root_off
    typ,brel,payload=inflate_at(data,rel)
    if typ!=OFS:
        content=payload; base_type=typ
    else:
        content=apply_delta(content,payload)
# git oid (type from root base)
TNAME={1:"commit",2:"tree",3:"blob",4:"tag"}
tn=TNAME[base_type]
hdr=f"{tn} {len(content)}\0".encode()
oid=hashlib.sha1(hdr+content).hexdigest()

ok = oid==OIDHEX
print(f"[{LABEL}] status={status} range={cr}")
print(f"  span_fetched={span}B  time={dt*1000:.1f}ms  speed={span/dt/1e6:.1f}MB/s")
print(f"  reconstructed {len(content)}B  oid={oid}  match={ok}")
if not ok: sys.exit(1)
