# Exhaust, bloom and crop for the pieces (the flagship's post.py, padded on every side); writes piece-KIND.webp (and thumb-KIND.jpg previews).
import numpy as np, json, os, sys
from PIL import Image
from scipy.ndimage import gaussian_filter
REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../apps/desktop/workspace/assets")
def blur(a, r): return gaussian_filter(a, sigma=(r, r, 0))
def piece(name):
    im = Image.open(f"f-{name}.png").convert("RGBA"); W0, H0 = im.size
    meta = json.load(open(f"f-{name}.png.json")) if os.path.exists(f"f-{name}.png.json") else {"engines": []}
    PAD = 700 if meta["engines"] else 40
    W, H = W0 + 2 * PAD, H0 + 2 * PAD
    ship = np.zeros((H, W, 4), np.float32); ship[PAD:PAD + H0, PAD:PAD + W0] = np.asarray(im, np.float32) / 255
    ship[..., :3] *= ship[..., 3:4]
    pl = np.zeros((H, W, 3), np.float32)
    if meta["engines"]:
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        for e in meta["engines"]:
            ax, ay = e["a"][0] * W0 + PAD, e["a"][1] * H0 + PAD; bx, by = e["b"][0] * W0 + PAD, e["b"][1] * H0 + PAD
            dx, dy = bx - ax, by - ay; L = np.hypot(dx, dy); ux, uy = dx / L, dy / L
            rpx = e["r"] * (L / 7.0) * 1.25; Lp = L * 1.55
            t = ((xx - ax) * ux + (yy - ay) * uy) / Lp; d = np.abs(-(xx - ax) * uy + (yy - ay) * ux)
            tt = np.clip(t, 0, 1); sig = rpx * (0.62 - 0.38 * tt)
            fall = np.where((t > -0.03) & (t < 1), (1 - tt) ** 1.7, 0)
            core = np.exp(-(d / (sig * 0.42)) ** 2) * fall * np.clip(1 - tt * 2.2, 0, 1)
            body = np.exp(-(d / sig) ** 2) * fall; halo = np.exp(-(d / (sig * 2.6)) ** 2) * fall * 0.35
            pl += core[..., None] * np.array([1.0, 1.0, 1.0]) * 1.1 + body[..., None] * np.array([0.42, 0.68, 1.0]) * 0.95 + halo[..., None] * np.array([0.2, 0.4, 1.0])
            rr = np.hypot(xx - ax, yy - ay); pl += np.exp(-(rr / (rpx * 1.5)) ** 2)[..., None] * np.array([0.5, 0.72, 1.0]) * 0.55
        pl = blur(pl, 5)
    pa = np.clip(pl.max(-1), 0, 1); pl = np.clip(pl, 0, 1.0)
    lum = ship[..., :3].max(-1); hot = np.clip((lum - 0.93) / 0.07, 0, 1)[..., None] * ship[..., :3]
    bloom = blur(hot, 7) * 1.5 + blur(hot, 26) * 1.6; ba = np.clip(bloom.max(-1), 0, 1)
    a = ship[..., 3]; rgb = pl * (1 - a[..., None]) + ship[..., :3]; al = pa * (1 - a) + a
    rgb = rgb + bloom * 0.9; al = np.clip(al + ba * (1 - al) * 0.9, 0, 1); rgb = np.clip(rgb, 0, 1)
    out = np.zeros((H, W, 4), np.float32); nz = al > 1e-4
    out[..., :3][nz] = np.clip(rgb[nz] / al[nz][:, None], 0, 1); out[..., 3] = al
    res = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")
    al8 = np.asarray(res)[..., 3]; ys, xs = np.where(al8 > 3); bb = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    res = res.crop((max(0, bb[0] - 12), max(0, bb[1] - 12), min(W, bb[2] + 12), min(H, bb[3] + 12)))
    if res.width > 2400: res = res.resize((2400, round(res.height * 2400 / res.width)), Image.LANCZOS)
    res.save(f"piece-{name}.webp", quality=90, method=6); print(name, res.size, os.path.getsize(f"piece-{name}.webp"))
    return res
def thumb(name, p):
    W, H = 560, 230
    sky = Image.open(f"{REPO}/milky-way-night.jpg").convert("RGBA")
    s = max(W / sky.width, H / sky.height); sky = sky.resize((round(sky.width * s), round(sky.height * s)), Image.LANCZOS)
    sky = sky.crop(((sky.width - W) // 2, 0, (sky.width - W) // 2 + W, H))
    if p is not None:
        k = min(W * 0.66 / p.width, H * 0.88 / p.height); q = p.resize((round(p.width * k), round(p.height * k)), Image.LANCZOS)
        sky.alpha_composite(q, (W - q.width - 12, (H - q.height) // 2))
    sky.convert("RGB").save(f"thumb-{name}.jpg", quality=90)
for n in sys.argv[1:]:
    if n == "flagship": thumb(n, Image.open(f"{REPO}/milky-way-flagship.webp").convert("RGBA"))
    elif n == "none": thumb(n, None)
    else: thumb(n, piece(n))
