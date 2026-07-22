#!/usr/bin/env python3
"""Over-fetch analysis for the single-contiguous-ranged-read claim.

For each object: span_bytes (one range covering obj+OFS base chain) vs
useful_bytes (sum of on-disk lengths of the chain members). Waste =
intervening unrelated objects pulled in by the single range.
Focus on BLOBS (the browse/blob-view case) and locate the README blob.
"""
import sys, struct, mmap, os, zlib, json, statistics

IDX, PACK, README_OID = sys.argv[1], sys.argv[2], sys.argv[3]

with open(IDX,"rb") as f: idx=f.read()
fanout=struct.unpack(">256I", idx[8:8+1024]); N=fanout[255]
p=8+1024
oids=idx[p:p+20*N]; p+=20*N; p+=4*N
off32=struct.unpack(">%dI"%N, idx[p:p+4*N]); p+=4*N
big_off=p
def roff(i):
    v=off32[i]
    if v&0x80000000:
        j=v&0x7fffffff
        return struct.unpack(">Q", idx[big_off+8*j:big_off+8*j+8])[0]
    return v
oid_list=[oids[i*20:(i+1)*20] for i in range(N)]
offsets=[roff(i) for i in range(N)]
packsize=os.path.getsize(PACK)
order=sorted(range(N), key=lambda i:offsets[i])
endof={}
for k,i in enumerate(order):
    endof[i]= offsets[order[k+1]] if k+1<N else packsize-20
length=[endof[i]-offsets[i] for i in range(N)]
off2i={offsets[i]:i for i in range(N)}

pf=open(PACK,"rb"); mm=mmap.mmap(pf.fileno(),0,prot=mmap.PROT_READ)
OFS,REF=6,7
otype=[0]*N; baseoff=[None]*N
def hdr(o):
    pos=o; c=mm[pos]; pos+=1; t=(c>>4)&7; size=c&0x0f; sh=4
    while c&0x80:
        c=mm[pos]; pos+=1; size|=(c&0x7f)<<sh; sh+=7
    return t,size,pos
for i in range(N):
    t,sz,pos=hdr(offsets[i]); otype[i]=t
    if t==OFS:
        c=mm[pos]; pos+=1; ofs=c&0x7f
        while c&0x80:
            c=mm[pos]; pos+=1; ofs=((ofs+1)<<7)|(c&0x7f)
        baseoff[i]=offsets[i]-ofs

def chain(i):
    members=[i]; j=i
    while baseoff[j] is not None:
        bi=off2i.get(baseoff[j])
        if bi is None: break
        members.append(bi); j=bi
        if len(members)>2000: break
    return members

# blob analysis
blob_over=[]; blob_span=[]; blob_useful=[]
allspan=[]
for i in range(N):
    ch=chain(i)
    minoff=min(offsets[k] for k in ch)
    span=endof[i]-minoff
    useful=sum(length[k] for k in ch)
    allspan.append(span)
    if otype[i]==3 or (otype[i]==OFS):  # count deltas too but we tag blobs via non-delta base type is unknown here
        pass
    # determine root type
    root=ch[-1]
    if otype[root]==3:   # blob-rooted chain -> a blob object
        blob_span.append(span); blob_useful.append(useful)
        blob_over.append(span/max(useful,1))

def pct(a,q):
    a=sorted(a); k=int(q*(len(a)-1)); return a[k]

# README specific
target=bytes.fromhex(README_OID)
ri=None
for i in range(N):
    if oid_list[i]==target: ri=i; break
readme={}
if ri is not None:
    ch=chain(ri); minoff=min(offsets[k] for k in ch)
    readme={"oid":README_OID,"offset":offsets[ri],"ondisk_len":length[ri],
            "chain_depth":len(ch)-1,"span_bytes":endof[ri]-minoff,
            "useful_bytes":sum(length[k] for k in ch),
            "root_offset":minoff,"is_delta":baseoff[ri] is not None}

out={
 "blob_objects_analyzed":len(blob_span),
 "blob_span_bytes":{"median":int(statistics.median(blob_span)),"p95":pct(blob_span,.95),
                    "p99":pct(blob_span,.99),"max":max(blob_span)},
 "blob_useful_bytes":{"median":int(statistics.median(blob_useful)),"p95":pct(blob_useful,.95),"max":max(blob_useful)},
 "blob_overfetch_ratio_span_over_useful":{"median":round(statistics.median(blob_over),2),
      "p95":round(pct(blob_over,.95),2),"p99":round(pct(blob_over,.99),2),"max":round(max(blob_over),2)},
 "all_objects_span":{"median":int(statistics.median(allspan)),"p95":pct(allspan,.95),
     "p99":pct(allspan,.99),"p999":pct(allspan,.999),"max":max(allspan)},
 "README":readme,
}
print(json.dumps(out,indent=2))
json.dump(out, open("/Users/pasta/workspace/dash-forge/spikes/S0.5-browse-plane/artifacts/span_analysis.json","w"), indent=2)
