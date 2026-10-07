"""Cut the night campus photo into depth planes for the website's layered hero.

    python tools/make_plates.py path/to/night-photo.jpg web/assets

Needs numpy, opencv-python and pillow (not in requirements.txt: the site only
needs the finished .webp files, which are already in web/assets).
The coordinates below were measured on the original 3024 x 4032 photo.

Planes (same canvas, so they always align):
  sky       clean background plate (below-skyline area filled, never visible)
  building  everything below the skyline, lamp painted out (alpha)
  lamp      the foreground lamp post (alpha)
  bloom     soft glow from the lit facade (screen-blended)
  blur      the whole scene, blurred and darkened (the world after the hero)
"""
import sys
import numpy as np
import cv2
from PIL import Image, ImageOps, ImageFilter, ImageDraw

SRC, OUT = sys.argv[1], sys.argv[2]
im = ImageOps.exif_transpose(Image.open(SRC)).convert("RGB")
W, H = im.size  # 3024 x 4032
rgb = np.asarray(im).astype(np.float32) / 255.0

# ---- night grade: cool the shadows toward navy, keep the lamp's warmth ----
lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
navy = np.array([0.035, 0.075, 0.135], dtype=np.float32)
k = (1.0 - np.clip(lum, 0, 1)) ** 3 * 0.42
graded = rgb * (1 - k[..., None]) + navy * k[..., None]
graded = graded * np.array([0.965, 0.99, 1.045], dtype=np.float32)   # cooler white balance
graded = np.clip(graded, 0, 1)

def to_img(a, mode="RGB"):
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), mode)

# ---- skyline mask (full-res coordinates, measured on the photo) ----
skyline = [(0, 1940), (1483, 1877), (1534, 2052), (1850, 1966), (2000, 1954),
           (2120, 1988), (2236, 2124), (2250, 2288), (2570, 2288), (2585, 2442),
           (2800, 2482), (3024, 2432), (3024, H), (0, H)]
mask_b = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask_b).polygon(skyline, fill=255)
mask_b = mask_b.filter(ImageFilter.GaussianBlur(2.2))

# ---- lamp mask: cone head, collar, pole ----
lamp_poly = [(1309, 2735), (1320, 2725), (1513, 2721), (1524, 2731), (1450, 2822),
             (1430, 2846), (1430, H), (1391, H), (1392, 2846), (1376, 2823)]
mask_l = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask_l).polygon(lamp_poly, fill=255)
mask_l = mask_l.filter(ImageFilter.GaussianBlur(1.4))

# ---- building plate: lamp painted out (inpaint on a dilated lamp mask) ----
g8 = (graded * 255).astype(np.uint8)
lm = np.asarray(mask_l)
inp_mask = cv2.dilate((lm > 8).astype(np.uint8) * 255, np.ones((15, 15), np.uint8))
bgr = cv2.cvtColor(g8, cv2.COLOR_RGB2BGR)
clean = cv2.inpaint(bgr, inp_mask, 9, cv2.INPAINT_TELEA)
clean = cv2.cvtColor(clean, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0

# ---- sky plate: denoise the sky into a smooth gradient, fill below the skyline ----
sky = graded.copy()
mb = np.asarray(mask_b).astype(np.float32) / 255.0
# fill everything below the skyline with the colour of the sky just above it, row by row
fill_row = graded[1800:1860].mean(axis=(0, 1))
sky = sky * (1 - mb[..., None]) + fill_row * mb[..., None]
sky_img = to_img(sky).filter(ImageFilter.GaussianBlur(28))
# a faint luminous haze above the lit facade (light spill), very subtle
haze = np.zeros((H, W), np.float32)
yy, xx = np.mgrid[0:H, 0:W]
haze += np.exp(-(((xx - 700) / 1100.0) ** 2 + ((yy - 1900) / 420.0) ** 2)) * 0.10
sky_arr = np.asarray(sky_img).astype(np.float32) / 255.0 + haze[..., None] * np.array([0.55, 0.72, 1.0])
sky_img = to_img(sky_arr)

building = np.dstack([clean, np.asarray(mask_b).astype(np.float32) / 255.0])
building_img = to_img(building, "RGBA")
lamp = np.dstack([graded, np.asarray(mask_l).astype(np.float32) / 255.0])
lamp_img = to_img(lamp, "RGBA")

# ---- bloom: the brightest parts of the facade, blurred wide ----
hi = np.clip((lum - 0.55) / 0.45, 0, 1) ** 1.6
bloom = graded * hi[..., None]
bloom_img = to_img(bloom).filter(ImageFilter.GaussianBlur(38))

# ---- blurred world: the composite, blurred and pushed darker/bluer ----
comp = to_img(graded)
blur_img = comp.resize((W // 4, H // 4), Image.LANCZOS).filter(ImageFilter.GaussianBlur(9))
ba = np.asarray(blur_img).astype(np.float32) / 255.0
ba = ba * 0.62 + navy * 0.38 * (1 - ba.mean(axis=2, keepdims=True))
blur_img = to_img(ba)

def export(name, img, box, size, q, alpha=False):
    c = img.crop(box).resize(size, Image.LANCZOS)
    c.save(f"{OUT}/{name}.webp", quality=q, method=6, **({"exact": True} if alpha else {}))

# desktop: landscape crop with the sky band above the cube
D = (0, 1250, 3024, 3140)          # 3024 x 1890 (1.6:1)
DS = (2400, 1500)
# phone: portrait crop
M = (0, 520, 2268, 4032)           # 2268 x 3512
MS = (1080, 1672)
for tag, box, size in (("d", D, DS), ("m", M, MS)):
    export(f"sky-{tag}", sky_img, box, size, 78)
    export(f"building-{tag}", building_img, box, size, 84, alpha=True)
    export(f"lamp-{tag}", lamp_img, box, size, 86, alpha=True)
    export(f"bloom-{tag}", bloom_img, box, (size[0] // 2, size[1] // 2), 70)
    bb = (box[0] // 4, box[1] // 4, box[2] // 4, box[3] // 4)
    export(f"blur-{tag}", blur_img, bb, (size[0] // 2, size[1] // 2), 72)
    # full composite poster (used as the instant first paint and the reduced-motion still)
    export(f"poster-{tag}", comp, box, size, 80)
print("ok")
