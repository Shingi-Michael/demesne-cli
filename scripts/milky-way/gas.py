# Equirectangular gas-giant texture and a ring profile, all procedural. Original art.
import numpy as np
from PIL import Image
from scipy.ndimage import zoom, gaussian_filter, map_coordinates
rng = np.random.default_rng(5)
W, H = 4096, 2048
def noise(gw, gh, w=W, h=H):
    g = rng.standard_normal((gh, gw))
    g = np.concatenate([g, g[:, :3]], 1)                      # wrap in x
    z = zoom(g, (h / gh, (w + 3 * w / gw) / (gw + 3)), order=3)[:h, :w]
    return z
def fbm(base_w, base_h, oct=6, stretch=1.0):
    t = np.zeros((H, W)); a = 1.0; s = 0
    for o in range(oct):
        gw, gh = int(base_w * 2 ** o), max(2, int(base_h * 2 ** o / stretch))
        t += a * noise(gw, gh); s += a; a *= 0.55
    return t / s
y = np.linspace(-1, 1, H)[:, None] * np.ones((1, W)); x = np.linspace(0, 1, W)[None, :] * np.ones((H, 1))
lat = y * np.pi / 2
# zonal jets shear the turbulence sideways by latitude
warp = fbm(6, 6, 6, stretch=1.0)
warp2 = fbm(10, 40, 6, stretch=3.0)
jet = np.sin(lat * 9) * 0.06 + np.sin(lat * 23 + 1.3) * 0.02
xs = (x + jet + warp2 * 0.02) % 1.0
la = lat + warp * 0.045 + warp2 * 0.012
# sample warp once more along the sheared x for curl
w3 = map_coordinates(fbm(14, 28, 5, 2.0), [ (la / (np.pi / 2) + 1) / 2 * (H - 1), xs * (W - 1)], order=1, mode="wrap")
la = la + w3 * 0.02
# band function
f = (np.sin(la * 13 + 0.4) * 0.5 + np.sin(la * 29 + 2.1) * 0.25 + np.sin(la * 57 + 0.7) * 0.12 + np.sin(la * 5) * 0.35)
f = (f - f.min()) / (f.max() - f.min())
stops = np.array([0.0, 0.22, 0.38, 0.5, 0.63, 0.8, 1.0])
cols = np.array([[0.36, 0.37, 0.42], [0.55, 0.52, 0.47], [0.78, 0.73, 0.64], [0.66, 0.62, 0.55], [0.86, 0.82, 0.74], [0.52, 0.53, 0.58], [0.74, 0.70, 0.63]])
img = np.stack([np.interp(f, stops, cols[:, c]) for c in range(3)], -1)
# fine streaks
st = fbm(40, 400, 4, stretch=6.0)[..., None]
img *= 1 + st * 0.08
# polar haze, slightly blue-grey
pole = np.clip((np.abs(y) - 0.62) / 0.38, 0, 1)[..., None] ** 1.4
img = img * (1 - pole * 0.55) + np.array([0.42, 0.45, 0.52]) * pole * 0.55
# a few storms
for (cx, cy, rx, ry, tone) in ((0.31, -0.33, 0.035, 0.06, 0.92), (0.72, 0.18, 0.018, 0.03, 0.85), (0.55, -0.12, 0.012, 0.02, 0.4)):
    dx = ((x - cx + 0.5) % 1 - 0.5) / rx; dy = (y - cy) / ry * (H / W) * 2
    r = np.sqrt(dx ** 2 + dy ** 2)
    m = np.exp(-r ** 2 * 1.6)[..., None]
    ring = np.exp(-((r - 1.0) / 0.25) ** 2)[..., None]
    img = img * (1 - m * 0.7) + m * 0.7 * np.array([tone, tone * 0.93, tone * 0.82]) - ring * 0.05
img = np.clip(img, 0, 1)
Image.fromarray((img ** (1 / 1.0) * 255).astype(np.uint8)).save("gas.png")
# ring profile: radial density with gaps, 2048 x 8
R = 4096; r = np.linspace(0, 1, R)
d = 0.62 + 0.08 * np.sin(r * 47) + 0.22 * gaussian_filter(rng.standard_normal(R), 2) / 0.28 * 0.5 + 0.25 * gaussian_filter(rng.standard_normal(R), 18)
d *= np.clip(r / 0.04, 0, 1) * np.clip((1 - r) / 0.03, 0, 1)
for (c, w, depth) in ((0.36, 0.035, 0.97), (0.62, 0.008, 0.85), (0.82, 0.012, 0.9), (0.15, 0.02, 0.6), (0.91, 0.004, 0.8)):
    d *= 1 - depth * np.exp(-((r - c) / w) ** 2 * 3)
d[(r > 0.0) & (r < 0.33)] *= np.linspace(0.35, 1, ((r > 0.0) & (r < 0.33)).sum())   # faint inner ring
d = np.clip(d, 0, 1)
tone = 0.62 + 0.25 * gaussian_filter(rng.standard_normal(R), 25) / 0.2 * 0.2
rgb = np.stack([tone * 1.02, tone * 0.98, tone * 0.92], -1).clip(0, 1)
row = np.concatenate([rgb, d[:, None]], -1)
Image.fromarray((np.repeat(row[None], 8, 0) * 255).astype(np.uint8), "RGBA").save("ringprof.png")
print("ok")
