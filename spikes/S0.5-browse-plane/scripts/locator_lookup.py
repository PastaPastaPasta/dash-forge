#!/usr/bin/env python3
"""Prove an objectLocator lookup = fanout header + ONE 1/256 slice via Range.
Fetches only the header (1024B) + the target oid's first-byte slice, binary-
searches it, returns (offset,length,span). O(1/256) of the locator, not O(all).
"""
import sys, struct, urllib.request, time, bisect
URL=sys.argv[1]; OIDHEX=sys.argv[2]
ROW=20+2+5+4+4  # widened layout in build_locator.py
oid=bytes.fromhex(OIDHEX)
def rng(a,b):
    r=urllib.request.Request(URL,headers={"Range":f"bytes={a}-{b}"})
    return urllib.request.urlopen(r).read()
t0=time.time()
fan=struct.unpack(">256I", rng(0,1023))         # header
b=oid[0]
lo=fan[b-1] if b>0 else 0; hi=fan[b]
start=1024+lo*ROW; end=1024+hi*ROW-1
slice_bytes=rng(start,end)                        # one 1/256 slice
dt=time.time()-t0
# binary search within slice
n=hi-lo; found=None
lo2,hi2=0,n
while lo2<hi2:
    mid=(lo2+hi2)//2
    roid=slice_bytes[mid*ROW:mid*ROW+20]
    if roid<oid: lo2=mid+1
    elif roid>oid: hi2=mid
    else:
        off=int.from_bytes(slice_bytes[mid*ROW+22:mid*ROW+27],'big')
        length=int.from_bytes(slice_bytes[mid*ROW+27:mid*ROW+31],'big')
        span=int.from_bytes(slice_bytes[mid*ROW+31:mid*ROW+35],'big')
        found=(off,length,span); break
total=1024+len(slice_bytes)
print(f"lookup fetched header(1024B)+slice({len(slice_bytes)}B, {n} rows) = {total}B in {dt*1000:.1f}ms")
print(f"  result offset,length,span = {found}")
print(f"  vs full locator download would be many MB")
