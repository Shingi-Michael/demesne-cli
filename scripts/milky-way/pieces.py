"""The other pieces for Home's sky (pass 276), built with the flagship's kit. python3 pieces.py -- KIND out.png W H SPP
KIND: station | freighter | scout. Original designs."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
argv = sys.argv[sys.argv.index("--") + 1:]
KIND, OUT = argv[0], argv[1]; W, H, SPP = int(argv[2]), int(argv[3]), int(argv[4])
from kit import *
import kit
TAU = 2 * math.pi

def circ(c, u, v, ru, rv, N, ph=0.0):
    return [c + u * (ru * math.cos(ph + TAU * k / N)) + v * (rv * math.sin(ph + TAU * k / N)) for k in range(N)]
def sweep(secs, kinds, closed=False, win=(), caps=True, rows=(0.15, 0.85), p_on=0.3):
    n = len(secs)
    for i in range(n if closed else n - 1):
        s0, s1 = secs[i], secs[(i + 1) % n]; N = len(s0)
        quads = [(s0[k], s1[k], s1[(k + 1) % N], s0[(k + 1) % N], kinds[k % len(kinds)]) for k in range(N)]
        pts = [p for q in quads for p in q[:4]]; cen = sum(pts, Vector()) / len(pts)
        fixed = []
        for (A, B, C, D, kd) in quads:
            nn = nrm(A, B, C, D)
            if nn.dot((A + B + C + D) / 4 - cen) < 0: A, B, C, D = B, A, D, C
            fixed.append((A, B, C, D, kd))
        solid(fixed)
        for j, (A, B, C, D, kd) in enumerate(fixed):
            if j % len(kinds) in win or (kd in win): windows(A, B, C, D, rows=list(rows), lift=0.05, p_on=p_on)
    if caps and not closed:
        face(secs[0], grey(0.22)); face(list(reversed(secs[-1])), grey(0.22))

ENGINES = []
def engine(x, y, z, r):
    N = 28
    def ring(xx, rr): return [Vector((xx, y + rr * math.cos(TAU * i / N), z + rr * math.sin(TAU * i / N))) for i in range(N)]
    r0, r1, r2 = ring(x + 0.05, r * 0.82), ring(x - 0.7, r), ring(x - 0.62, r * 0.84)
    for i in range(N):
        j = (i + 1) % N
        face([r0[i], r0[j], r1[j], r1[i]], grey(0.2), DARK); face([r1[i], r1[j], r2[j], r2[i]], grey(0.16), DARK)
    face(ring(x - 0.3, r * 0.84), (0.55, 0.78, 1.0, 1), ENGINE)
    ENGINES.append((x, y, z, r))

def band(q):
    """A lit window band across the four sides of a block (the flagship's bridge)."""
    for (A, B, C, D, kind) in q[1:5]:
        n = nrm(A, B, C, D)
        def P(u, v, A=A, B=B, C=C, D=D): return (A * (1 - u) + B * u) * (1 - v) + (D * (1 - u) + C * u) * v
        box(P(0.04, 0.42), P(0.96, 0.42), P(0.96, 0.7), P(0.04, 0.7), n, 0.01, (0.55, 0.8, 1.0, 1), GLOW, lift=0.004)
        k = max(2, int((B - A).length / 0.16))
        for i in range(k + 1):
            u = 0.04 + 0.92 * i / k
            box(P(u - 0.006, 0.38), P(u + 0.006, 0.38), P(u + 0.006, 0.74), P(u - 0.006, 0.74), n, 0.03, grey(0.5))

def solar(c, along, across, length, width, cells_u, cells_v):
    """A flat solar wing: frame plus dark cells, facing +n."""
    n = along.cross(across).normalized()
    def P(u, v): return c + along * (u * length) + across * ((v - 0.5) * width)
    box(P(0, 0), P(1, 0), P(1, 1), P(0, 1), n, 0.03, grey(0.42), lift=-0.015)
    for i in range(cells_u):
        for j in range(cells_v):
            u0, u1 = (i + 0.06) / cells_u, (i + 0.94) / cells_u; v0, v1 = (j + 0.06) / cells_v, (j + 0.94) / cells_v
            t = random.uniform(0.05, 0.09)
            box(P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1), n, 0.012, (t * 0.8, t * 0.95, t * 1.5, 1), DARK if R() < 0.15 else HULL, lift=0.015)
            box(P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1), -n, 0.012, grey(0.3), lift=0.015)

XF = Matrix()
if KIND == "station":
    kit.STRIPES[:] = []
    # Wheel station, axis Z. Habitat ring of plated segments with bigger node modules, four spokes, hub, spindle, wings.
    Rr = 9.0; NS = 72
    secs = []
    for i in range(NS):
        a = TAU * i / NS
        c = Vector((Rr * math.cos(a), Rr * math.sin(a), 0)); rad = Vector((math.cos(a), math.sin(a), 0)); up = Vector((0, 0, 1))
        node = (i % 9) in (0, 1, 2)
        ru, rv = (1.3, 1.05) if node else (0.95, 0.72)
        if (i % 9) == 0: secs.append(circ(c, rad, up, 0.95, 0.72, 8, math.pi / 8))
        secs.append(circ(c, rad, up, ru, rv, 8, math.pi / 8))
        if (i % 9) == 2: secs.append(circ(c, rad, up, 0.95, 0.72, 8, math.pi / 8))
    # sides: k=0 outer-low... order around the section from angle pi/8
    sweep(secs, ["bevel", "deck", "deck", "trench", "trench", "deck", "deck", "bevel"], closed=True, win=(0, 7), rows=(0.25, 0.75), p_on=0.45)
    # spokes
    for k in range(4):
        a = TAU * k / 4 + TAU / 8 + TAU / NS * 1.5
        rad = Vector((math.cos(a), math.sin(a), 0)); side = Vector((-math.sin(a), math.cos(a), 0)); up = Vector((0, 0, 1))
        ss = []
        for t, r in ((2.2, 0.42), (2.6, 0.42), (2.6, 0.32), (7.4, 0.32), (7.4, 0.44), (8.2, 0.44)):
            ss.append(circ(rad * t, side, up, r, r, 8, math.pi / 8))
        sweep(ss, ["tower"], win=())
        for t in (4.2, 5.9):
            c = rad * t
            q = [c + side * 0.45 * sx + up * 0.45 * sz for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            b = [p - rad * 0.3 for p in q]; tt = [p + rad * 0.3 for p in q]
            hexa(b, tt, ["deck", "tower", "tower", "tower", "tower", "deck"])
    # hub drum
    hub = []
    for z, r in ((-1.6, 1.4), (-1.3, 2.2), (1.3, 2.2), (1.6, 1.4)):
        hub.append(circ(Vector((0, 0, z)), Vector((1, 0, 0)), Vector((0, 1, 0)), r, r, 16))
    sweep(hub, ["bevel", "deck"], win=("bevel",), rows=(0.3, 0.7), p_on=0.5)
    # spindle up: collars, a docking bay, then the wing mast
    up_s = []
    for z, r in ((1.6, 0.9), (2.4, 0.9), (2.4, 1.25), (3.0, 1.25), (3.0, 0.75), (4.6, 0.75), (4.6, 1.05), (5.2, 1.05), (5.2, 0.5), (7.6, 0.45), (7.6, 0.8), (8.0, 0.6)):
        up_s.append(circ(Vector((0, 0, z)), Vector((1, 0, 0)), Vector((0, 1, 0)), r, r, 12))
    sweep(up_s, ["tower", "bevel"], win=("bevel",), rows=(0.5,), p_on=0.4)
    # spindle down: radiator fins and a docking cone
    dn = []
    for z, r in ((-1.6, 0.85), (-3.6, 0.85), (-3.6, 1.15), (-4.1, 1.15), (-4.1, 0.6), (-5.0, 0.4)):
        dn.append(circ(Vector((0, 0, z)), Vector((1, 0, 0)), Vector((0, 1, 0)), r, r, 12))
    sweep(dn, ["tower"], win=())
    for k in range(4):
        a = TAU * k / 4
        d = Vector((math.cos(a), math.sin(a), 0)); s = Vector((-math.sin(a), math.cos(a), 0))
        b = [d * 0.8 + s * -0.04 + Vector((0, 0, -1.9)), d * 0.8 + s * 0.04 + Vector((0, 0, -1.9)), d * 0.8 + s * 0.04 + Vector((0, 0, -3.4)), d * 0.8 + s * -0.04 + Vector((0, 0, -3.4))]
        t = [p + d * 2.4 for p in b]; t[2] = t[2] + d * -0.6; t[3] = t[3] + d * -0.6
        hexa([b[0], b[1], b[2], b[3]], [t[0], t[1], t[2], t[3]], ["plain", "fin", "plain", "fin", "plain", "plain"])
    # solar wings on the mast
    for sgn in (-1, 1):
        block(-0.08, 0.08, sgn * 0.45 if sgn > 0 else -6.6, 6.6 if sgn > 0 else -0.45, 6.25, 6.4, side="plain", top="plain")
        for j in range(2):
            y0 = sgn * (1.2 + j * 2.75)
            solar(Vector((0, y0, 6.32)), Vector((0, sgn, 0)), Vector((1, 0, 0)), 2.5, 2.2, 6, 5)
    # nav lights
    for p, c in ((Vector((0, 0, 8.05)), (1.0, 0.25, 0.2, 1)), (Vector((0, 0, -5.05)), (0.3, 1.0, 0.5, 1))):
        box(p + Vector((-0.06, -0.06, 0)), p + Vector((0.06, -0.06, 0)), p + Vector((0.06, 0.06, 0)), p + Vector((-0.06, 0.06, 0)), Vector((0, 0, 1)), 0.1, c, GLOW)
    XF = Matrix.Rotation(math.radians(14), 4, "Y") @ Matrix.Rotation(math.radians(10), 4, "Z")
    VIEW = (Vector((0.45, -1.0, 0.95)), 0.96, -4.0); KEY = (-0.6, -0.55, 0.6)
elif KIND == "freighter":
    # A long-haul freighter, nose at +X: command block, a spine stacked with container pods, radiators, a big drive block.
    sp = [octa(x, w, zt, zb, c, t) for (x, w, zt, zb, c, t) in ((-9.2, 0.55, 0.5, -0.5, 0.2, 0.06), (8.6, 0.55, 0.5, -0.5, 0.2, 0.06))]
    loft(sp, winrows=False)
    # command section
    loft([octa(8.4, 1.5, 1.2, -1.1, 0.5, 0.12), octa(10.6, 1.6, 1.3, -1.2, 0.55, 0.12), octa(12.6, 1.1, 0.9, -0.9, 0.4, 0.1), octa(13.6, 0.5, 0.45, -0.5, 0.18, 0.05)])
    br = block(9.0, 11.4, -1.0, 1.0, 1.25, 1.75, ix0=0.15, ix1=0.4, iy=0.12, side="plain"); band(br)
    block(9.6, 10.4, -0.1, 0.1, 1.75, 2.7, ix0=0.1, ix1=0.1, iy=0.02, side="plain", top="plain")
    # container rings
    def container(x0, x1, dy, dz, h):
        tone = random.uniform(0.42, 0.66); tn = random.choice(((1, 1, 1), (1, 1, 1), (1, 1, 1), (1.06, 1.0, 0.9), (0.94, 0.98, 1.07), (1.07, 0.93, 0.88)))
        col = tuple(c * t for c, t in zip(grey(tone), tn)) + (1.0,)
        col = col[:4]
        up = Vector((0, 0, 1))
        def q(xa, xb, s):
            return [Vector((xa, dy - s, dz - s)), Vector((xb, dy - s, dz - s)), Vector((xb, dy + s, dz - s)), Vector((xa, dy + s, dz - s))]
        A, B, C, D = q(x0 + 0.02, x1 - 0.02, h); box(A, B, C, D, up, 2 * h, col)
        n = max(3, int((x1 - x0) / 0.42))
        for i in range(n + 1):
            xr = x0 + 0.06 + (x1 - x0 - 0.12) * i / n
            A, B, C, D = q(xr - 0.025, xr + 0.025, h + 0.025); box(A, B, C, D, up, 2 * h + 0.05, tuple(c * 0.9 for c in col[:3]) + (1.0,))
        for xe in (x0, x1 - 0.04):
            A, B, C, D = q(xe, xe + 0.04, h + 0.04); box(A, B, C, D, up, 2 * h + 0.08, grey(0.3))
    x = 7.6
    while x > -7.6:
        L_ = random.choice((1.6, 2.0, 2.4))
        for (dy, dz) in ((0, 1.1), (0, -1.1), (1.1, 0), (-1.1, 0), (1.1, 1.1), (-1.1, 1.1), (1.1, -1.1), (-1.1, -1.1)):
            if R() < (0.1 if dy == 0 or dz == 0 else 0.45): continue
            container(x - L_, x, dy, dz, 0.5)
        kit.TINT[:] = [1, 1, 1]
        # a frame collar between rings
        loft([octa(x - L_ - 0.02, 1.0, 0.95, -0.95, 0.35, 0.08), octa(x - L_ - 0.12, 1.0, 0.95, -0.95, 0.35, 0.08)], winrows=False)
        x -= L_ + 0.14
    # radiators
    for sy in (-1, 1):
        b = [Vector((-6.5, sy * 2.0, -0.04)), Vector((-1.5, sy * 2.0, -0.04)), Vector((-2.6, sy * 6.2, -0.03)), Vector((-6.0, sy * 6.2, -0.03))]
        t = [p + Vector((0, 0, 0.09)) for p in b]
        hexa(b, t, ["fin", "plain", "plain", "plain", "plain", "fin"])
    # drive block
    loft([octa(-9.0, 2.3, 2.0, -2.0, 0.8, 0.14), octa(-10.4, 2.6, 2.3, -2.3, 0.9, 0.15), octa(-12.6, 2.6, 2.3, -2.3, 0.9, 0.15), octa(-13.0, 2.2, 1.9, -1.9, 0.75, 0.12)], winrows=False)
    for (y, z, r) in ((-1.15, 1.0, 0.82), (1.15, 1.0, 0.82), (-1.15, -1.0, 0.82), (1.15, -1.0, 0.82)):
        engine(-12.95, y, z, r)
    XF = Matrix()
    VIEW = (Vector((0.73, -0.68, 0.36)), 0.95, -6.0); KEY = (-0.3, -0.75, 0.6)
elif KIND == "scout":
    # A twin-hulled scout: two long greebled hulls joined by a wing deck, a cockpit pod on the deck, engines aft.
    for sy in (-1, 1):
        y = sy * 2.6
        loft([octa(-7.0, 0.95, 0.8, -0.8, 0.32, 0.09, y), octa(-4.0, 1.05, 0.92, -0.9, 0.36, 0.1, y), octa(2.0, 0.9, 0.78, -0.78, 0.3, 0.09, y), octa(5.5, 0.55, 0.45, -0.5, 0.2, 0.06, y), octa(7.3, 0.18, 0.15, -0.18, 0.06, 0.03, y)])
        engine(-7.0, y, 0.0, 0.66)
        block(-6.6, -3.6, y - 0.06, y + 0.06, 0.85, 1.9, ix0=0.3, ix1=1.6, side="fin", top="plain")
        block(-2.0, 3.2, y - 0.3, y + 0.3, -1.25, -0.75, ix0=0.3, ix1=1.0, iy=0.05, side="tower", top="deck")
    # wing deck between the hulls, swept
    b = [Vector((-5.4, -2.0, -0.22)), Vector((0.6, -2.0, -0.22)), Vector((1.8, 2.0, -0.22)), Vector((-5.4, 2.0, -0.22))]
    b = [Vector((-5.4, -2.0, -0.22)), Vector((1.4, -2.0, -0.22)), Vector((1.4, 2.0, -0.22)), Vector((-5.4, 2.0, -0.22))]
    t = [p + Vector((0, 0, 0.44)) for p in b]
    hexa(b, t, ["deck", "tower", "tower", "tower", "tower", "deck"])
    # central pod with the cockpit
    loft([octa(-5.0, 0.95, 0.9, -0.5, 0.35, 0.09), octa(-1.0, 1.05, 1.05, -0.55, 0.38, 0.1), octa(2.6, 0.7, 0.75, -0.4, 0.26, 0.08), octa(4.2, 0.3, 0.35, -0.2, 0.1, 0.04)])
    ck = block(-1.2, 1.0, -0.62, 0.62, 1.0, 1.42, ix0=0.12, ix1=0.45, iy=0.1, side="plain"); band(ck)
    engine(-5.0, 0.0, 0.2, 0.55)
    for x in (-3.6, -2.6):
        block(x - 0.25, x + 0.25, -0.25, 0.25, 0.95, 1.15, ix0=0.04, ix1=0.04, iy=0.04, side="plain", top="plain")
    XF = Matrix()
    VIEW = (Vector((0.73, -0.68, 0.3)), 0.95, -6.0); KEY = (-0.55, -0.62, 0.55)

ship = build()
ship.matrix_world = XF
def sun(name, frm, energy, col, angle=0.6):
    l = bpy.data.lights.new(name, "SUN"); l.energy = energy; l.color = col; l.angle = math.radians(angle)
    ob = bpy.data.objects.new(name, l); scene.collection.objects.link(ob)
    ob.rotation_euler = (-Vector(frm)).to_track_quat("-Z", "Y").to_euler(); return ob
sun("key", KEY, 4.2, (1.0, 0.96, 0.9)); sun("fill", (0.5, -0.3, -0.75), 0.22, (0.45, 0.6, 1.0), 8); sun("rim", (0.2, 0.9, 0.25), 0.9, (0.6, 0.72, 1.0), 2)
if ENGINES:
    pl = bpy.data.lights.new("eng", "POINT"); pl.energy = 6000; pl.color = (0.5, 0.72, 1.0); pl.shadow_soft_size = 1.0
    po = bpy.data.objects.new("eng", pl); po.location = XF @ Vector((min(e[0] for e in ENGINES) - 2.5, 0, 0)); scene.collection.objects.link(po)
wd = bpy.data.worlds.new("w"); scene.world = wd; wd.use_nodes = True
bg = wd.node_tree.nodes["Background"]; bg.inputs[0].default_value = (0.02, 0.03, 0.06, 1); bg.inputs[1].default_value = 0.35
bpy.context.view_layer.update()
pts = [XF @ Vector(p) for p in V[::7]]
ctr = sum(pts, Vector()) / len(pts)
cam = bpy.data.cameras.new("c"); cam.lens = 70; cam.sensor_fit = "HORIZONTAL"; co = bpy.data.objects.new("c", cam); scene.collection.objects.link(co); scene.camera = co
d, fill, roll = VIEW; d = d.normalized(); dist = 60.0
tx = 18 / cam.lens; ty = tx * H / W
for it in range(5):
    co.location = ctr + d * dist; co.rotation_euler = (ctr - co.location).to_track_quat("-Z", "Y").to_euler(); co.rotation_euler.rotate_axis("Z", math.radians(roll)); bpy.context.view_layer.update()
    inv = co.matrix_world.inverted(); q = [inv @ p for p in pts]
    xs = [v.x / -v.z for v in q]; ys = [v.y / -v.z for v in q]
    k = max((max(xs) - min(xs)) / (2 * tx), (max(ys) - min(ys)) / (2 * ty)) / (0.92 * fill)
    dist *= k
cam.shift_x = (max(xs) + min(xs)) / 2 / (2 * tx); cam.shift_y = (max(ys) + min(ys)) / 2 / (2 * tx)
scene.render.engine = "CYCLES"; scene.cycles.samples = SPP; scene.cycles.use_denoising = True
try: scene.cycles.denoiser = "OPENIMAGEDENOISE"
except Exception: pass
scene.render.film_transparent = True; scene.render.resolution_x = W; scene.render.resolution_y = H
scene.view_settings.view_transform = "AgX"; scene.view_settings.look = "AgX - Medium High Contrast"
bpy.context.view_layer.update()
eng = []
for (x, y, z, r) in ENGINES:
    a = world_to_camera_view(scene, co, XF @ Vector((x - 0.7, y, z))); b = world_to_camera_view(scene, co, XF @ Vector((x - 7.7, y, z)))
    eng.append({"a": [a.x, 1 - a.y], "b": [b.x, 1 - b.y], "r": r})
json.dump({"engines": eng, "faces": len(F)}, open(OUT + ".json", "w")); print("faces", len(F))
scene.render.filepath = OUT; bpy.ops.render.render(write_still=True); print("ok", OUT)
