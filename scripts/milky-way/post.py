# Engine light and bloom for the rendered ship. Output: ship.webp / ship.png (RGBA), padded on the left for the exhaust.
import numpy as np, json
from PIL import Image, ImageFilter
im = Image.open("ship-raw.png").convert("RGBA"); W0, H0 = im.size
meta = json.load(open("ship-raw.png.json"))
PAD = 760
W, H = W0 + PAD, H0
ship = np.zeros((H, W, 4), np.float32); ship[:, PAD:] = np.asarray(im, np.float32) / 255
ship[..., :3] *= ship[..., 3:4]                                   # premultiplied
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
pl = np.zeros((H, W, 3), np.float32); pa = np.zeros((H, W), np.float32)
for e in meta["engines"]:
    ax, ay = e["a"][0] * W0 + PAD, e["a"][1] * H0; bx, by = e["b"][0] * W0 + PAD, e["b"][1] * H0
    dx, dy = bx - ax, by - ay; L = np.hypot(dx, dy); ux, uy = dx / L, dy / L
    rpx = e["r"] * (L / 7.0) * 1.25
    Lp = L * 1.55
    t = ((xx - ax) * ux + (yy - ay) * uy) / Lp                    # 0 at the nozzle, 1 at the tail
    d = np.abs(-(xx - ax) * uy + (yy - ay) * ux)
    tt = np.clip(t, 0, 1)
    sig = rpx * (0.62 - 0.38 * tt)                                  # narrows to a point
    fall = np.where((t > -0.03) & (t < 1), (1 - tt) ** 1.7, 0)
    core = np.exp(-(d / (sig * 0.42)) ** 2) * fall * np.clip(1 - tt * 2.2, 0, 1)
    body = np.exp(-(d / sig) ** 2) * fall
    halo = np.exp(-(d / (sig * 2.6)) ** 2) * fall * 0.35
    pl += core[..., None] * np.array([1.0, 1.0, 1.0]) * 1.1 + body[..., None] * np.array([0.42, 0.68, 1.0]) * 0.95 + halo[..., None] * np.array([0.2, 0.4, 1.0])
    # a round bloom at the nozzle
    rr = np.hypot(xx - ax, yy - ay)
    pl += np.exp(-(rr / (rpx * 1.5)) ** 2)[..., None] * np.array([0.5, 0.72, 1.0]) * 0.55
from scipy.ndimage import gaussian_filter
def blur(a, r): return gaussian_filter(a, sigma=(r, r, 0))
pl = blur(pl, 5)
pa = np.clip(pl.max(-1), 0, 1); pl = np.clip(pl, 0, 1.0)
# bloom from the ship's own lights
lum = ship[..., :3].max(-1)
hot = np.clip((lum - 0.93) / 0.07, 0, 1)[..., None] * ship[..., :3]
bloom = blur(hot, 7) * 1.5 + blur(hot, 26) * 1.6
ba = np.clip(bloom.max(-1), 0, 1)
# compose: exhaust under the ship, bloom over it
a = ship[..., 3]
rgb = pl * (1 - a[..., None]) + ship[..., :3]
al = pa * (1 - a) + a
rgb = rgb + bloom * 0.9; al = np.clip(al + ba * (1 - al) * 0.9, 0, 1)
rgb = np.clip(rgb, 0, 1)
out = np.zeros((H, W, 4), np.float32); nz = al > 1e-4
out[..., :3][nz] = np.clip(rgb[nz] / al[nz][:, None], 0, 1); out[..., 3] = al
res = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")
bb = res.getbbox(); print("bbox", bb)
res = res.crop((max(0, bb[0] - 8), max(0, bb[1] - 20), min(W, bb[2] + 30), min(H, bb[3] + 20)))
res.save("ship.png"); print(res.size)
for w, name in ((2400, "ship-2400.webp"), (1500, "ship-1500.webp")):
    r = res.resize((w, round(res.height * w / res.width)), Image.LANCZOS); r.save(name, quality=90, method=6); 
import os; print({n: os.path.getsize(n) for n in ("ship.png", "ship-2400.webp", "ship-1500.webp")})
bg = Image.new("RGBA", res.size, (3, 4, 8, 255)); bg.alpha_composite(res); bg.convert("RGB").resize((1400, round(res.height * 1400 / res.width)), Image.LANCZOS).save("v-post.png")
bg2 = Image.new("RGBA", res.size, (214, 220, 242, 255)); bg2.alpha_composite(res); bg2.convert("RGB").resize((1400, round(res.height * 1400 / res.width)), Image.LANCZOS).save("v-post-dawn.png")
