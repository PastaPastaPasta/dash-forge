#!/usr/bin/env python3
"""Build flatIndex from `git ls-tree -r -l -t HEAD`.

Format: tipOid(20) + varint(nrows) + path-sorted rows.
Row = mode(u32) oid(20) size(varint) pathlen(varint) path(utf8)
Then compare gzip vs zstd. Injects a synthetic gitlink (mode 160000)
to demonstrate submodule handling (platform repo has none).
"""
import sys, subprocess, struct, gzip, io, json, os

GITDIR=sys.argv[1]; TIP=sys.argv[2]; OUT=sys.argv[3]
env=dict(os.environ, GIT_DIR=GITDIR)
# -r recursive files, -t include tree entries too? GitHub flatIndex = files+dirs.
# We include blobs + gitlinks (submodules). Dirs are derivable from paths, but
# include them so directory nodes carry their tree oid. Use -r -t.
raw=subprocess.check_output(["git","ls-tree","-r","-t","-l","-z",TIP],env=env)
rows=[]
for rec in raw.split(b"\x00"):
    if not rec: continue
    meta, path = rec.split(b"\t",1)
    mode, typ, oid, size = meta.split()
    sz = 0 if size==b"-" else int(size)
    rows.append((path, int(mode,8), bytes.fromhex(oid.decode()), sz, typ))

# inject synthetic gitlink to prove submodule (mode 160000) support
rows.append((b"vendor/libsubmodule", 0o160000,
             bytes.fromhex("deadbeef"*5), 0, b"commit"))

rows.sort(key=lambda r:r[0])  # path-sorted

def wv(buf,v):
    while True:
        b=v&0x7f; v>>=7
        if v: buf.append(b|0x80)
        else: buf.append(b); break

body=bytearray()
wv(body,len(rows))
for path,mode,oid,sz,typ in rows:
    body += struct.pack(">I",mode)
    body += oid
    wv(body,sz)
    wv(body,len(path))
    body += path

blob = bytes.fromhex(TIP) + bytes(body)
open(OUT,"wb").write(blob)
gz = gzip.compress(blob,9)
open(OUT+".gz","wb").write(gz)
try:
    import subprocess as sp
    zst = sp.run(["zstd","-19","-q","-c"],input=blob,capture_output=True).stdout
    open(OUT+".zst","wb").write(zst)
    zlen=len(zst)
except Exception as e:
    zlen=None

nfiles=sum(1 for r in rows if r[4]==b"blob")
ntrees=sum(1 for r in rows if r[4]==b"tree")
nlinks=sum(1 for r in rows if r[4]==b"commit")
out={
 "tip":TIP,
 "rows_total":len(rows),
 "blobs":nfiles,"trees":ntrees,"gitlinks":nlinks,
 "raw_bytes":len(blob),
 "gzip_bytes":len(gz),
 "zstd19_bytes":zlen,
 "bytes_per_row_raw":round(len(blob)/len(rows),1),
 "bytes_per_row_gzip":round(len(gz)/len(rows),1),
 "bytes_per_file_gzip":round(len(gz)/nfiles,1),
}
print(json.dumps(out,indent=2))
json.dump(out, open("/Users/pasta/workspace/dash-forge/spikes/S0.5-browse-plane/artifacts/flatindex_stats.json","w"),indent=2)
