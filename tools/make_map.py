"""Bake the two map layers the rulebook dives through.

Classes (stored as grey = class * 40):
  0 outside / sea   1 land   2 built-up   3 water   4 motorway   5 VU campus
Sources: Natural Earth 1:10m (public domain) for coastline, lakes, built-up
areas, rivers and motorways. Natural Earth simplifies the A10 into a loose oval,
so the Amsterdam layer draws the ring through real anchor points instead
(Sloterdijk, Lelylaan, Zuid and RAI stations sit on it; Science Park beside it).

Get the data (about 120 MB of GeoJSON) and run:
  git clone --depth 1 --filter=blob:none --no-checkout https://github.com/nvkelso/natural-earth-vector ne
  cd ne && git checkout HEAD -- geojson/ne_10m_admin_0_countries.geojson geojson/ne_10m_lakes.geojson \
      geojson/ne_10m_lakes_europe.geojson geojson/ne_10m_rivers_europe.geojson \
      geojson/ne_10m_roads.geojson geojson/ne_10m_urban_areas.geojson && cd ..
  python tools/make_map.py ne/geojson web/assets
"""
import json, math, sys
from PIL import Image, ImageDraw

NE, OUT = sys.argv[1], sys.argv[2]
K = math.cos(math.radians(52.2))
VU = (4.8657, 52.3341)

BBOX = (2.8, 50.5, 7.6, 53.8)
def pts(c):
    if not c: return
    if isinstance(c[0], (int, float)): yield c
    else:
        for k in c: yield from pts(k)
def load(n):                      # only what touches the Netherlands
    out = []
    for f in json.load(open(f"{NE}/ne_10m_{n}.geojson"))["features"]:
        g = f.get("geometry")
        if g and any(BBOX[0] <= p[0] <= BBOX[2] and BBOX[1] <= p[1] <= BBOX[3] for p in pts(g["coordinates"])):
            out.append(f)
    return out
def polys(g):
    if g["type"] == "Polygon": yield g["coordinates"]
    elif g["type"] == "MultiPolygon": yield from g["coordinates"]
def lines(g):
    if g["type"] == "LineString": yield g["coordinates"]
    elif g["type"] == "MultiLineString": yield from g["coordinates"]

class Layer:
    def __init__(s, lon0, lat0, lon1, lat1, step):
        s.b = (lon0, lat0, lon1, lat1)
        s.W = int(round((lon1 - lon0) * K / step)); s.H = int(round((lat1 - lat0) / step))
        s.im = Image.new("L", (s.W, s.H), 0); s.d = ImageDraw.Draw(s.im); s.step = step
    def P(s, c):
        lon0, lat0, lon1, lat1 = s.b
        return ((c[0] - lon0) / (lon1 - lon0) * s.W, (lat1 - c[1]) / (lat1 - lat0) * s.H)
    def poly(s, ring, v): s.d.polygon([s.P(c) for c in ring], fill=v * 40)
    def line(s, pts, v, metres):
        w = max(1, int(round(metres / (s.step * 111320))))
        s.d.line([s.P(c) for c in pts], fill=v * 40, width=w, joint="curve")
        r = w / 2
        for c in pts:
            x, y = s.P(c); s.d.ellipse((x - r, y - r, x + r, y + r), fill=v * 40)
    def save(s, path): s.im.save(path, optimize=True); print(path, s.W, s.H)

nl = [f for f in load("admin_0_countries") if f["properties"].get("ADM0_A3") == "NLD"]; lakes = load("lakes") + load("lakes_europe")
urban = load("urban_areas"); roads = load("roads"); rivers = load("rivers_europe")

def base(L):
    for f in nl:
        for p in polys(f["geometry"]):
            L.poly(p[0], 1)
            for h in p[1:]: L.poly(h, 0)
    mask = L.im.copy()
    for f in urban:
        for p in polys(f["geometry"]):
            L.poly(p[0], 2)
            for h in p[1:]: L.poly(h, 1)
    return mask

def clip_to(L, mask):            # nothing outside the Netherlands
    px, m = L.im.load(), mask.load()
    for y in range(L.H):
        for x in range(L.W):
            if m[x, y] == 0: px[x, y] = 0

# ---- country layer ------------------------------------------------------------
A = Layer(3.2, 50.6, 7.4, 53.7, 0.003)
mask = base(A)
AMS_BOX = (4.60, 52.20, 5.16, 52.52)
for f in roads:
    if f["properties"].get("expressway") != 1: continue
    for l in lines(f["geometry"]):
        seg = [c for c in l]
        if all(AMS_BOX[0] <= c[0] <= AMS_BOX[2] and AMS_BOX[1] <= c[1] <= AMS_BOX[3] for c in seg): continue
        A.line(seg, 4, 700)
for f in lakes:
    for p in polys(f["geometry"]): A.poly(p[0], 3)
clip_to(A, mask)
A.save(f"{OUT}/map-nl.png")

# ---- Amsterdam layer ----------------------------------------------------------
B = Layer(4.62, 52.22, 5.14, 52.50, 0.0004)
mask = base(B)
for f in lakes:
    for p in polys(f["geometry"]): B.poly(p[0], 3)
for f in rivers:
    for l in lines(f["geometry"]):
        if any(4.6 <= c[0] <= 5.0 and 52.35 <= c[1] <= 52.47 for c in l) and f["properties"].get("name") is None:
            B.line(l, 3, 420)              # the Noordzeekanaal and the IJ
RING = [  # the A10, clockwise from De Nieuwe Meer
    (4.8370, 52.3445), (4.8480, 52.3425), (4.8600, 52.3408), (4.87306, 52.33889),  # Zuid
    (4.89056, 52.33667), (4.9050, 52.3345), (4.9170, 52.3300),                         # RAI, Amstel
    (4.9300, 52.3320), (4.9450, 52.3370), (4.9520, 52.3430), (4.9550, 52.3500),       # Watergraafsmeer, Science Park
    (4.9580, 52.3600), (4.9620, 52.3680), (4.9650, 52.3770), (4.9620, 52.3850),       # Zeeburg, under the IJ
    (4.9500, 52.3950), (4.9300, 52.4040), (4.9050, 52.4120), (4.8800, 52.4180),       # A10 Noord
    (4.8600, 52.4200), (4.8520, 52.4140), (4.8410, 52.3990), (4.83806, 52.38917),     # Coenplein, Coentunnel, Sloterdijk
    (4.8360, 52.3800), (4.8350, 52.3700), (4.83389, 52.35722), (4.8335, 52.3500),     # Lelylaan
    (4.8370, 52.3445)]
RADIALS = [
    [(4.8370, 52.3445), (4.8150, 52.3330), (4.7900, 52.3200), (4.7650, 52.3070), (4.7000, 52.2700)],  # A4
    [(4.9170, 52.3300), (4.9200, 52.3111), (4.9238, 52.3023), (4.9290, 52.2944), (4.9353, 52.2868), (4.9518, 52.2761), (4.9627, 52.2662), (4.9681, 52.2528), (4.9709, 52.2221)],  # A2
    [(4.9520, 52.3430), (4.9700, 52.3400), (4.9909, 52.3338), (5.0503, 52.3185), (5.1400, 52.2950)],  # A1
    [(4.8600, 52.4200), (4.8560, 52.4400), (4.8500, 52.4700), (4.8450, 52.5000)],                      # A8
]
B.line(RING, 4, 120)
for r in RADIALS: B.line(r, 4, 100)
CAMPUS = [(4.8580, 52.3330), (4.8710, 52.3330), (4.8710, 52.3368), (4.8580, 52.3368)]
B.poly(CAMPUS, 5)
clip_to(B, mask)
B.save(f"{OUT}/map-ams.png")

# how far the farthest Dutch land is from the VU (normalises the light wave)
px = A.im.load(); far = 0
lon0, lat0, lon1, lat1 = A.b
for y in range(0, A.H, 2):
    for x in range(0, A.W, 2):
        if px[x, y]:
            lon = lon0 + (x + 0.5) / A.W * (lon1 - lon0); lat = lat1 - (y + 0.5) / A.H * (lat1 - lat0)
            far = max(far, math.hypot((lon - VU[0]) * K, lat - VU[1]))
print("A", A.b, A.W, A.H, "B", B.b, B.W, B.H, "maxD", round(far, 4))
