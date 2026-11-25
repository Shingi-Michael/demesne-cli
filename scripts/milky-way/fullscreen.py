"""The sky under the glass in full screen (pass 275 C): the ringed planet rising at the lower
left with the Milky Way above it, at night and at dawn, already frosted.

  python3 band.py 3200 2000 band.png 14 0.36      # the Milky Way, band high
  python3 planet.py -- planet.png 3200 2000 64     # the planet, about 3.5 minutes on four cores
  python3 fullscreen.py                            # writes planet-night.jpg, planet-dawn.jpg

In a full-screen Space nothing is behind the window, so this picture stands in for the wallpaper
that the glass would frost. It is frosted here, once, so nothing is blurred while the app runs."""
import numpy as np
from PIL import Image, ImageOps
from scipy.ndimage import gaussian_filter, maximum_filter

def frost(a, sigma=20, lift=1.5, colour=1.35, points=110):
    """Blur like glass does, a little brighter and richer, keeping the brightest stars as soft points."""
    b = np.stack([gaussian_filter(a[..., i], sigma) for i in range(3)], -1)
    lum = b.mean(-1, keepdims=True); b = lum + (b - lum) * colour; b = b * lift
    if points:
        l = gaussian_filter(a.mean(-1), 0.8); pk = l == maximum_filter(l, 31)
        vals = np.sort(l[pk])[::-1]; pk &= l >= vals[min(points, len(vals) - 1)]
        pts = np.zeros_like(a); pts[pk] = a[pk]
        b += np.stack([gaussian_filter(pts[..., i], 2.2) for i in range(3)], -1) * 9
    return np.clip(b, 0, 1)

def save(a, path):
    noise = np.random.default_rng(1).random(a.shape) * 1.5   # a little grain, so the blur never bands
    Image.fromarray((a * 255 + noise).clip(0, 255).astype(np.uint8)).save(path, quality=88, optimize=True, progressive=True)

size = (1600, 1000)
sky = np.asarray(Image.open("band.png").convert("RGB").resize(size, Image.LANCZOS), np.float32) / 255
planet = np.asarray(ImageOps.mirror(Image.open("planet.png").convert("RGBA")).resize(size, Image.LANCZOS), np.float32) / 255
alpha, rgb = planet[..., 3:4], planet[..., :3]

night = sky * 0.85 * (1 - alpha) + rgb * alpha
save(frost(night), "planet-night.jpg")

# Dawn: a pale sky warming toward the planet, the planet a slate shape with the same lit edge.
y, x = np.mgrid[0:size[1], 0:size[0]].astype(np.float32)
t = (y / size[1])[..., None]
glow = np.exp(-(((x - size[0] * 0.25) / (size[0] * 0.5)) ** 2 + ((y - size[1] * 0.8) / (size[1] * 0.45)) ** 2))[..., None]
pale = np.array([0.80, 0.83, 0.93]) * (1 - t) + np.array([0.90, 0.88, 0.92]) * t
pale = pale + glow * (np.array([0.99, 0.90, 0.86]) - pale) * 0.7
lit = rgb.mean(-1, keepdims=True)
body = np.array([0.56, 0.59, 0.70]) * (1 - lit) + np.array([1.0, 0.95, 0.88]) * lit
dawn = pale * (1 - alpha) + body * alpha
# the lit edge glows warm into the sky round it
rim = gaussian_filter((lit * alpha)[..., 0], 26)[..., None]
dawn = dawn + rim * np.array([0.9, 0.55, 0.35]) * 1.6
save(frost(dawn, lift=1.0, colour=1.15, points=0), "planet-dawn.jpg")
print("ok planet-night.jpg planet-dawn.jpg")
