# The Milky Way pictures

These scripts make the pictures Home's sky uses (`apps/desktop/workspace/assets/milky-way-*`). They are not part of the build: the pictures are checked in, and you only need this to change them.

| Script | Makes | Needs |
| --- | --- | --- |
| `ship3d.py` | the flagship as a 3D model, rendered with Blender's Cycles | `pip install bpy` |
| `post.py` | the engine exhaust and the glow round the lights, on top of that render | `pip install numpy pillow scipy` |
| `galaxy.py` | the night and dawn skies with the spiral galaxy | `pip install numpy pillow` |
| `band.py` | a whole sky of the Milky Way seen from inside it: the band, its dust lanes and its stars | `pip install numpy pillow scipy` |
| `planet.py` | the ringed planet as a 3D model, lit from behind, rendered with Cycles | `pip install bpy` |
| `kit.py` | the flagship's modelling kit (plates, windows, lofts, hull paint), shared with `pieces.py` | `pip install bpy` |
| `pieces.py` | the other things that can fly over Home: the wheel station, the freighter and the twin-hull scout | `pip install bpy` |
| `gas.py`, `planet-whole.py` | the whole ringed planet for Home: a banded gas giant, a thin atmosphere, a ring with gaps | `pip install bpy numpy pillow scipy` |
| `pieces-post.py` | exhaust, glow and crop for those pieces | `pip install numpy pillow scipy` |
| `fullscreen.py` | the full-screen sky (the planet over the band, at night and at dawn), already frosted | `pip install numpy pillow scipy` |

```sh
cd scripts/milky-way
python3 ship3d.py ship-raw.png 2600 1100 110 front   # about two minutes on four cores
python3 post.py                                      # writes ship.png, ship-2400.webp, ship-1500.webp
python3 galaxy.py                                    # writes sky-night.jpg, sky-dawn.jpg
cp ship-2400.webp ../../apps/desktop/workspace/assets/milky-way-flagship.webp
cp sky-night.jpg ../../apps/desktop/workspace/assets/milky-way-night.jpg
cp sky-dawn.jpg ../../apps/desktop/workspace/assets/milky-way-dawn.jpg
```

For the sky under the glass in full screen (`milky-way-full-night.jpg`, `milky-way-full-dawn.jpg`):

```sh
python3 band.py 3200 2000 band.png 14 0.36      # width, height, file, the band's angle and height
python3 planet.py -- planet.png 3200 2000 64     # about three and a half minutes on four cores
python3 fullscreen.py                            # writes planet-night.jpg, planet-dawn.jpg
cp planet-night.jpg ../../apps/desktop/workspace/assets/milky-way-full-night.jpg
cp planet-dawn.jpg ../../apps/desktop/workspace/assets/milky-way-full-dawn.jpg
```

For the other pieces you can pick in **Settings › Appearance › Home's sky** (`milky-way-station.webp`, `-freighter`, `-scout`, `-planet`):

```sh
for k in station freighter scout; do python3 pieces.py -- $k f-$k.png 2400 1200 64; done   # one to two minutes each
python3 gas.py && python3 planet-whole.py -- f-planet.png 2400 1200 64
python3 pieces-post.py station freighter scout planet                                     # writes piece-*.webp
```

Then copy each `piece-KIND.webp` to `../../apps/desktop/workspace/assets/milky-way-KIND.webp` (the app's are 2000 wide at quality 86).

The planet is frosted in the picture itself, once, so the app never blurs anything while it runs.

`ship3d.py` takes the output file, width, height, samples and a camera: `front` (the one Home uses), `rear` (engines toward you) or `low` (from underneath). The ship is built from a fixed random seed, so it comes out the same every time.

The ship is an original design. It borrows the craft of film miniatures (a pale plated hull, small machinery in the trenches, one hard light), not any ship from a film.

The planet is original too, and it is the one in the d. mark's full stop.

Read more: [Saturn's rings](https://science.nasa.gov/saturn/rings/), [the Great Rift](https://en.wikipedia.org/wiki/Great_Rift_(astronomy)), [greebles](https://en.wikipedia.org/wiki/Greeble), [kitbashing](https://en.wikipedia.org/wiki/Kitbashing), [path tracing](https://en.wikipedia.org/wiki/Path_tracing), [the Blender Python API](https://docs.blender.org/api/current/).

The station, freighter and scout are original designs too, built from the same kit as the flagship so they look like one fleet.
