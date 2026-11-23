# The Milky Way pictures

These scripts make the three pictures Home's sky uses (`apps/desktop/workspace/assets/milky-way-*`). They are not part of the build: the pictures are checked in, and you only need this to change them.

| Script | Makes | Needs |
| --- | --- | --- |
| `ship3d.py` | the flagship as a 3D model, rendered with Blender's Cycles | `pip install bpy` |
| `post.py` | the engine exhaust and the glow round the lights, on top of that render | `pip install numpy pillow scipy` |
| `galaxy.py` | the night and dawn skies with the spiral galaxy | `pip install numpy pillow` |

```sh
cd scripts/milky-way
python3 ship3d.py ship-raw.png 2600 1100 110 front   # about two minutes on four cores
python3 post.py                                      # writes ship.png, ship-2400.webp, ship-1500.webp
python3 galaxy.py                                    # writes sky-night.jpg, sky-dawn.jpg
cp ship-2400.webp ../../apps/desktop/workspace/assets/milky-way-flagship.webp
cp sky-night.jpg ../../apps/desktop/workspace/assets/milky-way-night.jpg
cp sky-dawn.jpg ../../apps/desktop/workspace/assets/milky-way-dawn.jpg
```

`ship3d.py` takes the output file, width, height, samples and a camera: `front` (the one Home uses), `rear` (engines toward you) or `low` (from underneath). The ship is built from a fixed random seed, so it comes out the same every time.

The ship is an original design. It borrows the craft of film miniatures (a pale plated hull, small machinery in the trenches, one hard light), not any ship from a film.

Read more: [greebles](https://en.wikipedia.org/wiki/Greeble), [kitbashing](https://en.wikipedia.org/wiki/Kitbashing), [path tracing](https://en.wikipedia.org/wiki/Path_tracing), [the Blender Python API](https://docs.blender.org/api/current/).
