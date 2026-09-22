"""Generate the repository-owned train icon using only Python's standard library."""
from pathlib import Path
import struct, zlib
out = Path(__file__).resolve().parent.parent / 'assets'
def png(size):
    rows = bytearray()
    def rounded(x, y, left, top, right, bottom, r):
        dx = max(left+r-x, 0, x-(right-r)); dy = max(top+r-y, 0, y-(bottom-r))
        return left <= x <= right and top <= y <= bottom and dx*dx+dy*dy <= r*r
    for j in range(size):
        rows.append(0)
        for i in range(size):
            x, y = (i+.5)/size, (j+.5)/size
            c = (0, 0, 0, 0)
            if rounded(x,y,.04,.04,.96,.96,.20): c = (42, 92, 162, 255)
            if rounded(x,y,.25,.20,.75,.73,.11): c = (247, 250, 255, 255)
            if rounded(x,y,.31,.30,.69,.48,.025): c = (42, 92, 162, 255)
            if ((x-.35)**2+(y-.62)**2 < .035**2 or (x-.65)**2+(y-.62)**2 < .035**2): c = (42, 92, 162, 255)
            if .70 < y < .83 and (abs(x-(.34-(y-.70)*.5)) < .025 or abs(x-(.66+(y-.70)*.5)) < .025): c = (247,250,255,255)
            rows.extend(c)
    def chunk(kind, data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(rows,9))+chunk(b'IEND',b'')
p256, p512, p1024 = png(256), png(512), png(1024)
(out/'icon.png').write_bytes(p1024)
(out/'icon.ico').write_bytes(struct.pack('<HHH',0,1,1)+struct.pack('<BBBBHHII',0,0,0,0,1,32,len(p256),22)+p256)
parts = b'ic09'+struct.pack('>I',len(p512)+8)+p512+b'ic10'+struct.pack('>I',len(p1024)+8)+p1024
(out/'icon.icns').write_bytes(b'icns'+struct.pack('>I',len(parts)+8)+parts)
