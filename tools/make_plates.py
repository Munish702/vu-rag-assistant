"""Cut the blue-hour campus photo into depth planes for the website's layered hero.

    python tools/make_plates.py path/to/campus-blue.png web/assets

Needs numpy, opencv-python and pillow (not in requirements.txt: the site only
needs the finished .webp files, which are already in web/assets).
Coordinates are measured on the 1536 x 1024 photo.

Planes (same canvas, so they always align):
  sky       the clouds alone; everything in front of them filled in (only ever seen at the edges)
  building  the campus in front of the sky, tree branches included, lamp painted out (alpha)
  lamp      the street lamp in front of the stairs (alpha)
  bloom     soft glow from the lit windows (screen-blended)
  blur      the whole scene, blurred and darkened (the world after the hero)
  poster    the untouched composite, for the first paint
"""
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC, OUT = sys.argv[1], sys.argv[2]
im = Image.open(SRC).convert("RGB")
W, H = im.size                                    # 1536 x 1024
rgb = np.asarray(im).astype(np.float32) / 255.0
lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def to_img(a, mode="RGB"):
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), mode)


def poly_mask(points, blur=0.0):
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(m).astype(np.float32) / 255.0


# ---- what is solidly in front of the sky: glass box, dome, canopy, the near roof
solid = poly_mask([(0, 222), (65, 268), (150, 268), (152, 220), (742, 219), (748, 365), (770, 364),
                   (800, 361), (830, 366), (850, 378), (852, 421), (1001, 425), (1003, 432),
                   (962, 568), (925, 572), (925, H), (0, H)], blur=0.8)
eave = poly_mask([(0, 0), (44, 0), (44, 32), (28, 58), (0, 64)], blur=0.8)
street = np.zeros((H, W), np.float32)
street[770:, :] = 1.0                              # city lights, the bus, the street

# ---- the lamp: cone head, collar, pole
lamp = poly_mask([(971, 518), (1023, 518), (1016, 543), (1004, 556), (1003, 845), (995, 845),
                  (994, 556), (979, 543)], blur=0.7)

# ---- building plate: lamp painted out
bgr = cv2.cvtColor((rgb * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
lamp_hole = cv2.dilate((lamp > 0.02).astype(np.uint8) * 255, np.ones((7, 7), np.uint8))
clean = cv2.inpaint(bgr, lamp_hole, 6, cv2.INPAINT_TELEA)
clean = cv2.cvtColor(clean, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
# ---- to the right, trees against the sky: separate them by colour. The sky is
# deep blue (blue well above red and green); branches, lights and the crane are not.
excess = (clean[..., 2] - np.maximum(clean[..., 0], clean[..., 1])) * 255.0
branch = np.clip((42.0 - excess) / 26.0, 0, 1)
zone = np.zeros((H, W), np.float32)
zone[140:, 880:] = 1.0
zone = cv2.GaussianBlur(zone, (0, 0), 6)
front = np.maximum.reduce([solid, eave, street, branch * zone])
sky_a = 1.0 - front

# ---- the lamp: cone head, collar, pole
lamp = poly_mask([(971, 518), (1023, 518), (1016, 543), (1004, 556), (1003, 845), (995, 845),
                  (994, 556), (979, 543)], blur=0.7)

building = np.dstack([clean * (front[..., None] > 0.002), front])

# ---- sky plate: the sky where it is sky, and a filled-in sky everywhere else
small = cv2.resize(cv2.cvtColor((clean * 255).astype(np.uint8), cv2.COLOR_RGB2BGR), (W // 4, H // 4), interpolation=cv2.INTER_AREA)
hole = cv2.resize((front > 0.05).astype(np.uint8) * 255, (W // 4, H // 4), interpolation=cv2.INTER_NEAREST)
hole = cv2.dilate(hole, np.ones((3, 3), np.uint8))
filled = cv2.inpaint(small, hole, 9, cv2.INPAINT_TELEA)
filled = cv2.GaussianBlur(cv2.resize(filled, (W, H), interpolation=cv2.INTER_CUBIC), (0, 0), 6)
filled = cv2.cvtColor(filled, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
keep = np.clip((0.05 - front) / 0.05, 0, 1)        # only clear sky survives; anything touched by a branch is filled
keep = cv2.GaussianBlur(keep, (0, 0), 0.8)
sky = clean * keep[..., None] + filled * (1 - keep[..., None])

# ---- bloom: the warm windows, blurred wide
hi = np.clip((lum - 0.58) / 0.42, 0, 1) ** 1.5
bloom_img = to_img(rgb * hi[..., None]).filter(ImageFilter.GaussianBlur(26))

# ---- blurred world: the composite, blurred and pushed darker and bluer
navy = np.array([0.03, 0.06, 0.13], dtype=np.float32)
blur_img = im.resize((W // 2, H // 2), Image.LANCZOS).filter(ImageFilter.GaussianBlur(14))
ba = np.asarray(blur_img).astype(np.float32) / 255.0
ba = ba * 0.58 + navy * 0.42 * (1 - ba.mean(axis=2, keepdims=True))
blur_img = to_img(ba)

sky_img, building_img = to_img(sky), to_img(building, "RGBA")
lamp_img = to_img(np.dstack([rgb * (lamp[..., None] > 0.002), lamp]), "RGBA")


def export(name, img, box, size, q, alpha=False):
    c = img.crop(box)
    if c.size != size:
        c = c.resize(size, Image.LANCZOS)
    c.save(f"{OUT}/{name}.webp", quality=q, method=6, **({"exact": True} if alpha else {}))


D = (0, 0, W, H)              # desktop: the whole frame (1.5:1)
M = (300, 0, 960, H)          # phone: the glass box, the dome and the sky above them
for tag, box in (("d", D), ("m", M)):
    size = (box[2] - box[0], box[3] - box[1])
    export(f"sky-{tag}", sky_img, box, size, 82)
    export(f"building-{tag}", building_img, box, size, 86, alpha=True)
    export(f"lamp-{tag}", lamp_img, box, size, 88, alpha=True)
    half = (size[0] // 2, size[1] // 2)
    export(f"bloom-{tag}", bloom_img, box, half, 72)
    export(f"blur-{tag}", blur_img, tuple(v // 2 for v in box), half, 74)
    export(f"poster-{tag}", im, box, size, 84)
print("ok")
