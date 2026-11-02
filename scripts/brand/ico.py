"""Packs favicon-16/32/48.png into favicon.ico and removes the temporary PNGs."""
import os, struct, sys
d = sys.argv[1]
sizes = [16, 32, 48]
pngs = [open(f"{d}/favicon-{s}.png", "rb").read() for s in sizes]
head = struct.pack("<HHH", 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
entries = b""
for s, data in zip(sizes, pngs):
    entries += struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
open(f"{d}/favicon.ico", "wb").write(head + entries + b"".join(pngs))
for s in sizes:
    os.remove(f"{d}/favicon-{s}.png")
