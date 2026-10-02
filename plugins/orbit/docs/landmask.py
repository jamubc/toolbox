import json, sys, base64
W, H = int(sys.argv[1]), int(sys.argv[2])
data = json.load(open('countries.geo.json'))
mask = bytearray(W*H//8)
def fill(ring):
    # scanline polygon fill in equirectangular pixel space
    pts = [(((lon+180)/360)*W, ((90-lat)/180)*H) for lon, lat in ring]
    n = len(pts)
    ys = [p[1] for p in pts]
    y0, y1 = max(0, int(min(ys))), min(H-1, int(max(ys))+1)
    for y in range(y0, y1+1):
        cy = y + 0.5
        xs = []
        for i in range(n):
            (xa, ya), (xb, yb) = pts[i], pts[(i+1)%n]
            if (ya <= cy < yb) or (yb <= cy < ya):
                xs.append(xa + (cy-ya)*(xb-xa)/(yb-ya))
        xs.sort()
        for i in range(0, len(xs)-1, 2):
            for x in range(max(0, int(xs[i]+0.5)), min(W, int(xs[i+1]+0.5))):
                idx = y*W+x
                mask[idx>>3] ^= (0x80 >> (idx & 7))
for f in data['features']:
    g = f['geometry']
    polys = g['coordinates'] if g['type']=='Polygon' else [p for mp in g['coordinates'] for p in mp]
    for ring in polys:
        fill(ring)
sys.stdout.write(base64.b64encode(bytes(mask)).decode())
