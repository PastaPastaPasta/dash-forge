#!/usr/bin/env python3
"""Build objectLocator from a git pack + idx, computing deltaChainSpan.

Validates the architecture §6.3 / data-contracts §2.3 claims:
 - OFS_DELTA bases are earlier in the SAME pack -> single contiguous ranged read
 - deltaChainSpan field width (~2 B in the estimate) is / isn't sufficient
 - ~32 B/object locator size estimate
"""
import sys, struct, mmap, os, json, zlib

IDX = sys.argv[1]
PACK = sys.argv[2]
OUT = sys.argv[3]  # locator binary output path

# ---- parse idx v2 ----
with open(IDX, "rb") as f:
    idx = f.read()
assert idx[:4] == b"\xfftOc", "not idx v2"
assert struct.unpack(">I", idx[4:8])[0] == 2
fanout = struct.unpack(">256I", idx[8:8 + 1024])
N = fanout[255]
p = 8 + 1024
oids = idx[p:p + 20 * N]; p += 20 * N
p += 4 * N  # crc
off32 = struct.unpack(">%dI" % N, idx[p:p + 4 * N]); p += 4 * N
# large offset table (needed: pack > 2GB)
big_count = 0
big_table_off = p
def resolve_off(i):
    v = off32[i]
    if v & 0x80000000:
        j = v & 0x7fffffff
        return struct.unpack(">Q", idx[big_table_off + 8 * j: big_table_off + 8 * j + 8])[0]
    return v

oid_list = [oids[i*20:(i+1)*20] for i in range(N)]
offsets = [resolve_off(i) for i in range(N)]
n_big = sum(1 for i in range(N) if off32[i] & 0x80000000)

packsize = os.path.getsize(PACK)
trailer = 20
# on-disk length: sort offsets, gap to next offset (or pack end - trailer)
order = sorted(range(N), key=lambda i: offsets[i])
end_of = {}
for k, i in enumerate(order):
    o = offsets[i]
    nxt = offsets[order[k+1]] if k+1 < N else (packsize - trailer)
    end_of[i] = nxt
length = [end_of[i] - offsets[i] for i in range(N)]

# ---- parse pack object headers (type + delta base) ----
OBJ_COMMIT,OBJ_TREE,OBJ_BLOB,OBJ_TAG,OBJ_OFS,OBJ_REF = 1,2,3,4,6,7
pf = open(PACK, "rb")
mm = mmap.mmap(pf.fileno(), 0, prot=mmap.PROT_READ)

obj_type = [0]*N
base_off = [None]*N   # for OFS_DELTA: absolute base offset (same pack)
ref_delta = [False]*N

offset_to_i = {offsets[i]: i for i in range(N)}

def read_header(o):
    """return (type, size, pos_after_header)"""
    pos = o
    c = mm[pos]; pos += 1
    t = (c >> 4) & 7
    size = c & 0x0f
    shift = 4
    while c & 0x80:
        c = mm[pos]; pos += 1
        size |= (c & 0x7f) << shift
        shift += 7
    return t, size, pos

n_ref = 0
for i in range(N):
    o = offsets[i]
    t, size, pos = read_header(o)
    obj_type[i] = t
    if t == OBJ_OFS:
        c = mm[pos]; pos += 1
        ofs = c & 0x7f
        while c & 0x80:
            c = mm[pos]; pos += 1
            ofs = ((ofs + 1) << 7) | (c & 0x7f)
        base_off[i] = o - ofs
    elif t == OBJ_REF:
        ref_delta[i] = True
        n_ref += 1

# ---- deltaChainSpan: walk OFS base chain, span = obj.end - root_base.offset ----
# also validate base is always at an EARLIER offset (same pack)
span = [0]*N
chain_depth = [0]*N
base_before = True
max_span = 0
spans_over_64k = 0
spans_over_16m = 0
for i in range(N):
    o = offsets[i]
    end = end_of[i]
    min_off = o
    depth = 0
    j = i
    seen = 0
    while base_off[j] is not None:
        b = base_off[j]
        if b >= offsets[j]:
            base_before = False  # violation: base not earlier
        bi = offset_to_i.get(b)
        if bi is None:
            break
        if b < min_off:
            min_off = b
        depth += 1
        j = bi
        seen += 1
        if seen > 1000:
            break
    s = end - min_off
    span[i] = s
    chain_depth[i] = depth
    if s > max_span: max_span = s
    if s > 0xffff: spans_over_64k += 1
    if s > 0xffffff: spans_over_16m += 1

# ---- field-width analysis vs data-contracts estimate ----
max_off = max(offsets)
max_len = max(length)
max_depth = max(chain_depth)

# ---- write locator binary: fanout(256*u32) + rows ----
# row = oid(20) packRef(2) offset(5) length(4) span(4)  -- we widen offset/len/span
# but also emit the SPEC-WIDTH variant size for comparison
def u_be(v, nbytes):
    return v.to_bytes(nbytes, "big")

order_oid = sorted(range(N), key=lambda i: oid_list[i])
# fanout over first byte
fan = [0]*256
for i in order_oid:
    fan[oid_list[i][0]] += 1
cum = 0; fanout_out = []
for b in range(256):
    cum += fan[b]; fanout_out.append(cum)

with open(OUT, "wb") as w:
    w.write(struct.pack(">256I", *fanout_out))
    PACKREF = 0  # single pack in this repo
    for i in order_oid:
        w.write(oid_list[i])                 # 20
        w.write(u_be(PACKREF, 2))            # 2 packRef
        w.write(u_be(offsets[i], 5))         # 5 offset
        w.write(u_be(min(length[i],0xffffffff), 4))  # 4 length (widened)
        w.write(u_be(min(span[i],0xffffffff), 4))    # 4 span (widened)

row_bytes_widened = 20+2+5+4+4
locator_size = 1024 + N*row_bytes_widened
spec_row = 20+2+5+3+2   # data-contracts §2.3 estimate widths
spec_size = 1024 + N*spec_row

# how many objects would OVERFLOW the spec widths?
overflow_len_3B = sum(1 for i in range(N) if length[i] > 0xffffff)
overflow_span_2B = spans_over_64k
overflow_off_5B = sum(1 for i in range(N) if offsets[i] > 0xffffffffff)

stats = {
  "N_objects": N,
  "n_big_offsets(>2GB)": n_big,
  "packsize": packsize,
  "REF_DELTA_count(should_be_0)": n_ref,
  "all_OFS_bases_earlier_same_pack": base_before,
  "max_offset": max_off,
  "max_ondisk_length": max_len,
  "max_delta_depth": max_depth,
  "deltaChainSpan": {
     "max_span_bytes": max_span,
     "spans_over_64KB(2B_field_overflow)": spans_over_64k,
     "spans_over_16MB": spans_over_16m,
  },
  "spec_field_overflows(data-contracts_widths)": {
     "offset_5B_overflow": overflow_off_5B,
     "length_3B_overflow": overflow_len_3B,
     "span_2B_overflow": overflow_span_2B,
  },
  "locator_size_widened_bytes": locator_size,
  "locator_bytes_per_object_widened": round(locator_size/N,2),
  "locator_size_spec32B_bytes": spec_size,
  "locator_bytes_per_object_spec": round(spec_size/N,2),
  "type_hist": {},
}
th = {}
for i in range(N):
    th[obj_type[i]] = th.get(obj_type[i],0)+1
names={1:"commit",2:"tree",3:"blob",4:"tag",6:"ofs_delta",7:"ref_delta"}
stats["type_hist"] = {names.get(k,str(k)):v for k,v in sorted(th.items())}

print(json.dumps(stats, indent=2))
# emit a machine-readable sidecar
with open(OUT+".stats.json","w") as s:
    json.dump(stats,s,indent=2)
