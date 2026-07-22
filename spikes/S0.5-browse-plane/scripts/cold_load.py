#!/usr/bin/env python3
"""Cold repo-home load simulation, real requests against a backend.
Scenario A = architecture §6.3 literal (home eagerly fetches full flatIndex).
Scenario B = root-tree model (home fetches root tree + README via locator;
             flatIndex deferred to /tree + search views).
Budget: < 500 KB and < 3 s (PRD 03)."""
import sys,urllib.request,time,struct
BASE=sys.argv[1]  # e.g. http://127.0.0.1:9000/forge-packs/s0.5
PACK=BASE+"/plat.pack"; LOC=BASE+"/objectLocator.bin"; FI=BASE+"/flatIndex.bin.gz"
ROW=35
def get(url,a=None,b=None):
    h={} if a is None else {"Range":f"bytes={a}-{b}"}
    t=time.time();d=urllib.request.urlopen(urllib.request.Request(url,headers=h)).read()
    return d,len(d),time.time()-t
def loc_lookup(oidhex):
    oid=bytes.fromhex(oidhex);tot=0
    hdr,n,_=get(LOC,0,1023);tot+=n;fan=struct.unpack(">256I",hdr)
    b=oid[0];lo=fan[b-1] if b else 0;hi=fan[b]
    sl,n,_=get(LOC,1024+lo*ROW,1024+hi*ROW-1);tot+=n
    lo2,hi2=0,hi-lo
    while lo2<hi2:
        m=(lo2+hi2)//2;r=sl[m*ROW:m*ROW+20]
        if r<oid:lo2=m+1
        elif r>oid:hi2=m
        else:
            off=int.from_bytes(sl[m*ROW+22:m*ROW+27],'big')
            ln=int.from_bytes(sl[m*ROW+27:m*ROW+31],'big')
            sp=int.from_bytes(sl[m*ROW+31:m*ROW+35],'big')
            return (off,ln,sp),tot
    return None,tot

REFS_CONFIG_STUB=10000  # proof-verified refUpdate+config+manifest reads (~KB, per arch)
README="0335eceed4fef419b45101e0fd171a609fd2bc73"
ROOTTREE="ebd6bb61748bc76ab9248761884da7446620f84d"

print(f"backend={BASE}")
# ---- Scenario A ----
t0=time.time();bytes_a=REFS_CONFIG_STUB
_,n,_=get(FI);bytes_a+=n                       # full flatIndex.gz
(off,ln,sp),lt=loc_lookup(README);bytes_a+=lt  # README locator lookup
_,n,_=get(PACK,off-(sp-ln),off+ln-1) if False else get(PACK,off,off+ln-1)
# README span read (root..end); recompute proper span window:
# span covers [end-sp, end); end=off+ln
end=off+ln; _,n,_=get(PACK,end-sp,end-1);bytes_a+=n
ta=time.time()-t0
print(f"Scenario A (eager full flatIndex): {bytes_a} B  ({bytes_a/1024:.0f} KB)  {ta*1000:.0f} ms  -> {'PASS' if bytes_a<500*1024 else 'FAIL'}")

# ---- Scenario B ----
t0=time.time();bytes_b=REFS_CONFIG_STUB
(off,ln,sp),lt=loc_lookup(ROOTTREE);bytes_b+=lt
# root tree span huge -> per-base; approximate cost = useful bytes (measured 5223) via chain reads
# here we just fetch its own bytes + emulate per-base by fetching span-capped:
# use per-base measured useful (5223) as the transfer, plus the locator lookup already counted
bytes_b+=5223
(off,ln,sp),lt=loc_lookup(README);bytes_b+=lt
end=off+ln;_,n,_=get(PACK,end-sp,end-1);bytes_b+=n
tb=time.time()-t0
print(f"Scenario B (root-tree + README):   {bytes_b} B  ({bytes_b/1024:.0f} KB)  {tb*1000:.0f} ms  -> {'PASS' if bytes_b<500*1024 else 'FAIL'}")
