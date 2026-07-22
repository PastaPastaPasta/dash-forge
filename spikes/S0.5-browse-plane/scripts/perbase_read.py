#!/usr/bin/env python3
"""Alternative to the single-span read: reconstruct a delta object by fetching
each chain member's OWN bytes via individual Range reads (depth RTTs, minimal
bytes). Proves the fallback for deeply-chained objects (root tree: 212x waste
under single-span). usage: perbase_read.py <idx> <pack> <oid> <url> [label]"""
import sys,struct,mmap,os,zlib,hashlib,time,urllib.request
IDX,PACK,OIDHEX,URL=sys.argv[1:5]; LABEL=sys.argv[5] if len(sys.argv)>5 else URL
idx=open(IDX,'rb').read();fanout=struct.unpack(">256I",idx[8:8+1024]);N=fanout[255]
p=8+1024;oids=idx[p:p+20*N];p+=20*N;p+=4*N
off32=struct.unpack(">%dI"%N,idx[p:p+4*N]);p+=4*N;big=p
def roff(i):
    v=off32[i]
    return struct.unpack(">Q",idx[big+8*(v&0x7fffffff):big+8*(v&0x7fffffff)+8])[0] if v&0x80000000 else v
oid_list=[oids[i*20:(i+1)*20] for i in range(N)];offsets=[roff(i) for i in range(N)]
packsize=os.path.getsize(PACK);order=sorted(range(N),key=lambda i:offsets[i]);endof={}
for k,i in enumerate(order): endof[i]=offsets[order[k+1]] if k+1<N else packsize-20
length=[endof[i]-offsets[i] for i in range(N)];off2i={offsets[i]:i for i in range(N)}
pf=open(PACK,'rb');mm=mmap.mmap(pf.fileno(),0,prot=mmap.PROT_READ)
def hdr(buf,pos):
    c=buf[pos];pos+=1;t=(c>>4)&7;sz=c&0xf;sh=4
    while c&0x80: c=buf[pos];pos+=1;sz|=(c&0x7f)<<sh;sh+=7
    br=None
    if t==6:
        c=buf[pos];pos+=1;ofs=c&0x7f
        while c&0x80: c=buf[pos];pos+=1;ofs=((ofs+1)<<7)|(c&0x7f)
        br=ofs
    return t,pos,br
# discover chain (offsets + lengths) from local pack headers
ti=oid_list.index(bytes.fromhex(OIDHEX));j=ti;chain=[]
while True:
    t,_,br=hdr(mm,offsets[j]);chain.append((offsets[j],length[j]))
    if t==6: j=off2i[offsets[j]-br]
    else: break
def rng(a,n):
    r=urllib.request.Request(URL,headers={"Range":f"bytes={a}-{a+n-1}"})
    return urllib.request.urlopen(r).read()
def apply_delta(base,delta):
    pos=0
    def rv():
        nonlocal pos;r=0;sh=0
        while True:
            b=delta[pos];pos+=1;r|=(b&0x7f)<<sh;sh+=7
            if not b&0x80: break
        return r
    rv();dst=rv();out=bytearray()
    while pos<len(delta):
        op=delta[pos];pos+=1
        if op&0x80:
            co=cs=0
            for i in range(4):
                if op&(1<<i): co|=delta[pos]<<(8*i);pos+=1
            for i in range(3):
                if op&(1<<(4+i)): cs|=delta[pos]<<(8*i);pos+=1
            if cs==0: cs=0x10000
            out+=base[co:co+cs]
        else: out+=delta[pos:pos+op];pos+=op
    return bytes(out)
t0=time.time();total=0;reads=0;content=None;btype=None
for (o,l) in reversed(chain):  # root first
    buf=rng(o,l);total+=len(buf);reads+=1
    t,hp,br=hdr(buf,0);payload=zlib.decompressobj().decompress(buf[hp:])
    if t!=6: content=payload;btype=t
    else: content=apply_delta(content,payload)
dt=time.time()-t0
TN={1:"commit",2:"tree",3:"blob",4:"tag"}
oid=hashlib.sha1(f"{TN[btype]} {len(content)}\0".encode()+content).hexdigest()
print(f"[{LABEL}] per-base: {reads} ranged reads, {total}B fetched, {dt*1000:.1f}ms, oid match={oid==OIDHEX}")
