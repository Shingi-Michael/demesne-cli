# The flagship "Demesne" for the Milky Way theme: an original design, a procedural model rendered with Cycles.
# usage: python3 ship3d.py out.png [w h samples camname]
import bpy, random, math, sys, json
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

out = sys.argv[1]
W = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
H = int(sys.argv[3]) if len(sys.argv) > 3 else 500
SAMPLES = int(sys.argv[4]) if len(sys.argv) > 4 else 24
CAM = sys.argv[5] if len(sys.argv) > 5 else "front"
random.seed(11)
R = random.random
def U(a, b): return a + (b - a) * R()

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

V = []; F = []; FC = []; FM = []          # verts, faces, face colour, face material index
HULL, GLOW, ENGINE, DARK = 0, 1, 2, 3

def vadd(p):
    V.append((p.x, p.y, p.z)); return len(V) - 1
def face(pts, col, mat=HULL):
    F.append([vadd(p) for p in pts]); FC.append(col); FM.append(mat)
def nrm(A, B, C, D):
    n = (B - A).cross(D - A)
    if n.length < 1e-9: n = (C - B).cross(A - B)
    return n.normalized() if n.length > 1e-9 else Vector((0, 0, 1))
def box(A, B, C, D, n, h, col, mat=HULL, lift=0.0, topcol=None):
    a, b, c, d = (p + n * lift for p in (A, B, C, D))
    ta, tb, tc, td = (p + n * h for p in (a, b, c, d))
    face([ta, tb, tc, td], topcol or col, mat)
    for p, q, tq, tp in ((a, b, tb, ta), (b, c, tc, tb), (c, d, td, tc), (d, a, ta, td)):
        face([p, q, tq, tp], col, mat)

def grey(v, warm=0.012):
    return (v + warm, v, v - warm * 0.6, 1.0)

CALM = []    # (x0,x1,y0,y1,zmin) regions kept flat (name plate)
STRIPES = [(3.1, 3.55), (-8.6, -8.25)]
RED = (0.30, 0.045, 0.035, 1.0)

def greeble(A, B, C, D, kind):
    n = nrm(A, B, C, D)
    lu = ((B - A).length + (C - D).length) / 2
    lv = ((D - A).length + (C - B).length) / 2
    if lu < 0.05 or lv < 0.05: return
    def P(u, v): return (A * (1 - u) + B * u) * (1 - v) + (D * (1 - u) + C * u) * v
    prm = {"deck": (0.9, 0.2), "bevel": (0.8, 0.19), "trench": (0.34, 0.1), "tower": (0.5, 0.14), "fin": (0.7, 0.2)}[kind]
    mx, mn = prm
    leaves = []
    def split(u0, u1, v0, v1, depth=0):
        su, sv = (u1 - u0) * lu, (v1 - v0) * lv
        big = max(su, sv)
        if big > mx or (big > mn * 2 and R() < 0.62 and depth < 9):
            t = U(0.36, 0.64)
            if su >= sv: m = u0 + (u1 - u0) * t; split(u0, m, v0, v1, depth + 1); split(m, u1, v0, v1, depth + 1)
            else: m = v0 + (v1 - v0) * t; split(u0, u1, v0, m, depth + 1); split(u0, u1, m, v1, depth + 1)
        else: leaves.append((u0, u1, v0, v1))
    split(0, 1, 0, 1)
    g = 0.016
    for (u0, u1, v0, v1) in leaves:
        gu, gv = g / lu, g / lv
        if u1 - u0 < 3 * gu or v1 - v0 < 3 * gv: continue
        a, b, c, d = P(u0 + gu, v0 + gv), P(u1 - gu, v0 + gv), P(u1 - gu, v1 - gv), P(u0 + gu, v1 - gv)
        ctr = (a + b + c + d) / 4
        calm = any(x0 <= ctr.x <= x1 and y0 <= ctr.y <= y1 and ctr.z >= z for (x0, x1, y0, y1, z) in CALM)
        tone = min(0.78, max(0.36, random.gauss(0.60, 0.045)))
        col = grey(tone)
        if R() < 0.07: col = grey(U(0.24, 0.34))
        if kind in ("deck", "bevel") and n.z > 0.2 and any(s0 <= ctr.x <= s1 for s0, s1 in STRIPES): col = RED
        r = R()
        if calm:
            box(a, b, c, d, n, 0.03, grey(0.63)); continue
        if kind == "trench":
            if r < 0.55: cluster(P, u0 + gu, u1 - gu, v0 + gv, v1 - gv, lu, lv, n, 0.03, 0.12)
            elif r < 0.85: box(a, b, c, d, n, U(0.03, 0.09), grey(U(0.34, 0.5)))
            continue
        if kind == "tower":
            if r < 0.7: box(a, b, c, d, n, U(0.012, 0.035), col)
            elif r < 0.85: cluster(P, u0 + gu, u1 - gu, v0 + gv, v1 - gv, lu, lv, n, 0.02, 0.07)
            continue
        if r < 0.74: box(a, b, c, d, n, U(0.012, 0.034), col)
        elif r < 0.82: box(a, b, c, d, n, U(0.045, 0.08), col)
        elif r < 0.90: cluster(P, u0 + gu, u1 - gu, v0 + gv, v1 - gv, lu, lv, n, 0.02, 0.085)
        # else: left open, the darker hull shows through

def cluster(P, u0, u1, v0, v1, lu, lv, n, h0, h1):
    nu = max(1, int((u1 - u0) * lu / U(0.07, 0.13))); nv = max(1, int((v1 - v0) * lv / U(0.07, 0.13)))
    nu, nv = min(nu, 9), min(nv, 9)
    # one low tray, then bits on it
    box(P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1), n, 0.012, grey(0.36))
    for i in range(nu):
        for j in range(nv):
            if R() < 0.38: continue
            a0 = u0 + (u1 - u0) * (i + U(0.05, 0.2)) / nu; a1 = u0 + (u1 - u0) * (i + U(0.75, 0.95)) / nu
            b0 = v0 + (v1 - v0) * (j + U(0.05, 0.2)) / nv; b1 = v0 + (v1 - v0) * (j + U(0.75, 0.95)) / nv
            if R() < 0.25 and i + 1 < nu: a1 = u0 + (u1 - u0) * (i + 1.9) / nu      # a pipe run
            box(P(a0, b0), P(a1, b0), P(a1, b1), P(a0, b1), n, U(h0, h1), grey(U(0.36, 0.56)), lift=0.012)

def windows(A, B, C, D, rows, lift=0.05, p_on=0.3, step=0.07):
    n = nrm(A, B, C, D)
    lu = ((B - A).length + (C - D).length) / 2; lv = ((D - A).length + (C - B).length) / 2
    if lu < 0.3: return
    def P(u, v): return (A * (1 - u) + B * u) * (1 - v) + (D * (1 - u) + C * u) * v
    k = int(lu / step)
    for v in rows:
        on = False
        for i in range(k):
            if R() < 0.22: on = not on
            if not on or R() > p_on + 0.35: continue
            u = (i + 0.5) / k; du = 0.016 / lu; dv = 0.011 / lv
            warm = (1.0, 0.78, 0.45, 1) if R() < 0.82 else (0.5, 0.75, 1.0, 1)
            box(P(u - du, v - dv), P(u + du, v - dv), P(u + du, v + dv), P(u - du, v + dv), n, 0.012, warm, GLOW, lift=lift)

SOLIDS = []
def solid(quads):
    """quads: list of (A,B,C,D,kind). Fix winding against the solid's centroid, add base face + greebles."""
    pts = [p for q in quads for p in q[:4]]
    cen = sum(pts, Vector((0, 0, 0))) / len(pts)
    for (A, B, C, D, kind) in quads:
        n = nrm(A, B, C, D)
        if n.dot((A + B + C + D) / 4 - cen) < 0: A, B, C, D = B, A, D, C
        face([A, B, C, D], grey(0.30))
        if kind != "plain": greeble(A, B, C, D, kind)
        SOLIDS.append((A, B, C, D, kind))

def octa(x, w, zt, zb, c, t, y0=0.0, zm=0.0):
    return [Vector((x, y0 - (w - c), zt)), Vector((x, y0 + (w - c), zt)), Vector((x, y0 + w, zm + t)), Vector((x, y0 + w, zm - t)),
            Vector((x, y0 + (w - c), zb)), Vector((x, y0 - (w - c), zb)), Vector((x, y0 - w, zm - t)), Vector((x, y0 - w, zm + t))]
OK = ["deck", "bevel", "trench", "bevel", "deck", "bevel", "trench", "bevel"]
def loft(secs, winrows=True):
    q = []
    for i in range(len(secs) - 1):
        s0, s1 = secs[i], secs[i + 1]
        for k in range(8):
            q.append((s0[k], s1[k], s1[(k + 1) % 8], s0[(k + 1) % 8], OK[k]))
    solid(q)
    for s, flip in ((secs[0], True), (secs[-1], False)):
        face(list(reversed(s)) if not flip else s, grey(0.22))
    if winrows:
        for (A, B, C, D, kind) in q:
            if kind == "bevel": windows(A, B, C, D, rows=[0.1, 0.9], lift=0.06)

def hexa(b, t, kinds):
    """b,t: 4 bottom + 4 top corners in matching order. kinds: [top, side0..3, bottom]"""
    q = [(t[0], t[1], t[2], t[3], kinds[0])]
    for i in range(4):
        j = (i + 1) % 4
        q.append((b[i], b[j], t[j], t[i], kinds[1 + i]))
    q.append((b[0], b[1], b[2], b[3], kinds[5]))
    solid(q); return q
def block(x0, x1, y0, y1, z0, z1, ix0=0.0, ix1=0.0, iy=0.0, side="tower", top="deck", rows=None):
    b = [Vector((x0, y0, z0)), Vector((x1, y0, z0)), Vector((x1, y1, z0)), Vector((x0, y1, z0))]
    t = [Vector((x0 + ix0, y0 + iy, z1)), Vector((x1 - ix1, y0 + iy, z1)), Vector((x1 - ix1, y1 - iy, z1)), Vector((x0 + ix0, y1 - iy, z1))]
    q = hexa(b, t, [top, side, side, side, side, "plain"])
    if rows:
        for (A, B, C, D, kind) in q[1:5]: windows(A, B, C, D, rows=rows, lift=0.045, p_on=0.5)
    return q

# ---------------------------------------------------------------- the ship (nose at +X, Z up)
CALM.append((2.0, 6.6, -1.2, 0.0, 0.3))
main = [octa(-9.0, 2.9, 0.85, -0.95, 0.9, 0.13), octa(-2.2, 3.0, 1.0, -1.15, 0.95, 0.14), octa(0.4, 1.55, 0.82, -0.95, 0.5, 0.12),
        octa(7.2, 1.2, 0.6, -0.72, 0.4, 0.1), octa(10.4, 0.62, 0.34, -0.42, 0.22, 0.07), octa(11.9, 0.3, 0.16, -0.22, 0.1, 0.04)]
loft(main)
for sy in (-1, 1):                                              # engine nacelles on outriggers
    y = sy * 4.7
    loft([octa(-10.6, 0.82, 0.62, -0.62, 0.3, 0.08, y), octa(-5.2, 0.9, 0.7, -0.7, 0.32, 0.09, y), octa(-3.4, 0.55, 0.42, -0.42, 0.2, 0.06, y), octa(-2.3, 0.16, 0.12, -0.12, 0.06, 0.03, y)], winrows=False)
    y0, y1 = sy * 2.7, sy * 3.95                                # pylon, swept
    b = [Vector((-8.4, y0, -0.2)), Vector((-3.6, y0, -0.2)), Vector((-5.2, y1, -0.16)), Vector((-8.8, y1, -0.16))]
    t = [p + Vector((0, 0, 0.42 if i < 2 else 0.34)) for i, p in enumerate(b)]
    hexa(b, t, ["deck", "tower", "tower", "tower", "tower", "deck"])
    block(-9.6, -6.4, y - 0.07, y + 0.07, 0.6, 1.9, ix0=0.2, ix1=1.7, side="fin", top="plain")   # nacelle fin
# superstructure, stepped up toward the stern
block(-8.2, -0.6, -1.75, 1.75, 0.9, 1.4, ix0=0.25, ix1=0.9, iy=0.2, rows=[0.35, 0.7])
block(-7.6, -2.4, -1.25, 1.25, 1.4, 1.95, ix0=0.2, ix1=0.7, iy=0.18, rows=[0.3, 0.65])
block(-7.1, -3.9, -0.85, 0.85, 1.95, 2.4, ix0=0.15, ix1=0.5, iy=0.14, rows=[0.5])
br = block(-6.7, -4.7, -1.35, 1.35, 2.4, 2.78, ix0=0.1, ix1=0.35, iy=0.1, side="plain")           # bridge, wide
# bridge window band, front and both sides
for (A, B, C, D, kind) in br[1:5]:
    n = nrm(A, B, C, D)
    def P(u, v, A=A, B=B, C=C, D=D): return (A * (1 - u) + B * u) * (1 - v) + (D * (1 - u) + C * u) * v
    box(P(0.04, 0.42), P(0.96, 0.42), P(0.96, 0.7), P(0.04, 0.7), n, 0.01, (0.55, 0.8, 1.0, 1), GLOW, lift=0.004)
    k = max(2, int((B - A).length / 0.16))
    for i in range(k + 1):
        u = 0.04 + 0.92 * i / k
        box(P(u - 0.006, 0.38), P(u + 0.006, 0.38), P(u + 0.006, 0.74), P(u - 0.006, 0.74), n, 0.03, grey(0.5))
    box(P(0, 0.0), P(1, 0.0), P(1, 0.36), P(0, 0.36), n, 0.02, grey(0.6)); box(P(0, 0.76), P(1, 0.76), P(1, 1), P(0, 1), n, 0.02, grey(0.62))
block(-5.9, -5.5, -0.05, 0.05, 2.78, 4.3, ix0=0.15, ix1=0.15, iy=0.03, side="plain", top="plain")   # mast
block(-6.5, -6.3, 0.55, 0.61, 2.78, 3.6, side="plain", top="plain"); block(-6.5, -6.3, -0.61, -0.55, 2.78, 3.3, side="plain", top="plain")
block(-6.1, -5.3, -0.5, 0.5, 3.55, 3.62, side="plain", top="plain")                                # yard
# forward: dorsal spine, turrets, keel blade
block(0.6, 8.6, -0.22, 0.22, 0.6, 0.86, ix0=0.1, ix1=2.4, iy=0.05, side="trench", top="deck")
for x, y in ((1.4, 0.75), (1.4, -0.75), (-0.2, 2.0), (-0.2, -2.0), (-1.6, 2.3), (-1.6, -2.3), (8.0, 0.0)):
    z = 0.66 if x > 5 else (0.86 if abs(y) < 1 else 1.0)
    block(x - 0.2, x + 0.2, y - 0.2, y + 0.2, z, z + 0.16, ix0=0.03, ix1=0.03, iy=0.03, side="plain", top="plain")
    block(x - 0.13, x + 0.15, y - 0.13, y + 0.13, z + 0.16, z + 0.3, ix0=0.02, ix1=0.05, iy=0.02, side="plain", top="plain")
    for dy in (-0.06, 0.06):
        block(x + 0.1, x + 0.62, y + dy - 0.018, y + dy + 0.018, z + 0.2, z + 0.24, side="plain", top="plain")
b = [Vector((1.0, -0.1, -0.85)), Vector((6.6, -0.1, -0.7)), Vector((6.6, 0.1, -0.7)), Vector((1.0, 0.1, -0.85))]
t = [Vector((2.4, -0.05, -2.3)), Vector((4.4, -0.05, -2.3)), Vector((4.4, 0.05, -2.3)), Vector((2.4, 0.05, -2.3))]
hexa(b, t, ["plain", "fin", "plain", "fin", "plain", "plain"])
# hangar mouth, port and starboard, lit from inside
for sy in (-1, 1):
    y = sy * 3.02
    box(Vector((-6.4, y, -0.09)), Vector((-4.2, y, -0.09)), Vector((-4.2, y, 0.11)), Vector((-6.4, y, 0.11)), Vector((0, sy, 0)), 0.02, (0.6, 0.85, 1.0, 1), GLOW, lift=0.2)
# name stencilled on the port deck
GL = {"D": "11110 10001 10001 10001 10001 10001 11110", "E": "11111 10000 10000 11110 10000 10000 11111", "M": "10001 11011 10101 10101 10001 10001 10001",
      "S": "01111 10000 10000 01110 00001 00001 11110", "N": "10001 11001 10101 10011 10001 10001 10001"}
cs = 0.052; x0 = 2.7; ytop = -0.36
for li, ch in enumerate("DEMESNE"):
    for rj, row in enumerate(GL[ch].split()):
        for ci, bit in enumerate(row):
            if bit != "1": continue
            x = x0 + li * cs * 6.6 + ci * cs; y = ytop - rj * cs
            z = 0.82 - (x - 0.4) * 0.22 / 6.8 + 0.031
            box(Vector((x, y - cs, z)), Vector((x + cs, y - cs, z)), Vector((x + cs, y, z)), Vector((x, y, z)), Vector((0, 0, 1)), 0.006, (0.035, 0.04, 0.05, 1))
# engines
ENG = [(-9.0, -1.75, 0, 0.72), (-9.0, 0, 0, 0.82), (-9.0, 1.75, 0, 0.72), (-10.6, -4.7, 0, 0.56), (-10.6, 4.7, 0, 0.56)]
for (x, y, z, r) in ENG:
    N = 28
    def ring(xx, rr): return [Vector((xx, y + rr * math.cos(2 * math.pi * i / N), z + rr * math.sin(2 * math.pi * i / N))) for i in range(N)]
    r0, r1, r2 = ring(x + 0.05, r * 0.82), ring(x - 0.7, r), ring(x - 0.62, r * 0.84)
    for i in range(N):
        j = (i + 1) % N
        face([r0[i], r0[j], r1[j], r1[i]], grey(0.2), DARK); face([r1[i], r1[j], r2[j], r2[i]], grey(0.16), DARK)
    face(ring(x - 0.3, r * 0.84), (0.55, 0.78, 1.0, 1), ENGINE)

me = bpy.data.meshes.new("ship"); me.from_pydata(V, [], F); me.update()
ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
cols = []
for f, c in zip(F, FC): cols.extend(list(c) * len(f))
ca.data.foreach_set("color", cols)
me.polygons.foreach_set("material_index", FM)

def nodes_of(m):
    try: m.use_nodes = True
    except Exception: pass
    return m.node_tree
def mk(name):
    m = bpy.data.materials.new(name); nt = nodes_of(m); nt.nodes.clear()
    o = nt.nodes.new("ShaderNodeOutputMaterial"); return m, nt, o
# hull paint: plate tone x streaky grime, rounded edges
m, nt, o = mk("hull")
bs = nt.nodes.new("ShaderNodeBsdfPrincipled"); at = nt.nodes.new("ShaderNodeAttribute"); at.attribute_name = "Col"
tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (0.25, 5.0, 5.0)
nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 2.2; nz.inputs["Detail"].default_value = 7
nz2 = nt.nodes.new("ShaderNodeTexNoise"); nz2.inputs["Scale"].default_value = 0.9; nz2.inputs["Detail"].default_value = 5
mr = nt.nodes.new("ShaderNodeMapRange"); mr.inputs["From Min"].default_value = 0.3; mr.inputs["From Max"].default_value = 0.7; mr.inputs["To Min"].default_value = 0.62; mr.inputs["To Max"].default_value = 1.06
mr2 = nt.nodes.new("ShaderNodeMapRange"); mr2.inputs["From Min"].default_value = 0.35; mr2.inputs["From Max"].default_value = 0.7; mr2.inputs["To Min"].default_value = 0.78; mr2.inputs["To Max"].default_value = 1.04
mul = nt.nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"
sc = nt.nodes.new("ShaderNodeVectorMath"); sc.operation = "SCALE"
bv = nt.nodes.new("ShaderNodeBevel"); bv.samples = 4; bv.inputs["Radius"].default_value = 0.012
L = nt.links.new
L(tc.outputs["Object"], mp.inputs["Vector"]); L(mp.outputs["Vector"], nz.inputs["Vector"]); L(tc.outputs["Object"], nz2.inputs["Vector"])
L(nz.outputs[0], mr.inputs["Value"]); L(nz2.outputs[0], mr2.inputs["Value"]); L(mr.outputs[0], mul.inputs[0]); L(mr2.outputs[0], mul.inputs[1])
L(at.outputs["Color"], sc.inputs[0]); L(mul.outputs[0], sc.inputs["Scale"]); L(sc.outputs[0], bs.inputs["Base Color"])
L(bv.outputs[0], bs.inputs["Normal"]); bs.inputs["Roughness"].default_value = 0.62; bs.inputs["Metallic"].default_value = 0.0
L(bs.outputs[0], o.inputs[0]); me.materials.append(m)
m, nt, o = mk("glow"); em = nt.nodes.new("ShaderNodeEmission"); at = nt.nodes.new("ShaderNodeAttribute"); at.attribute_name = "Col"
nt.links.new(at.outputs["Color"], em.inputs["Color"]); em.inputs["Strength"].default_value = 9; nt.links.new(em.outputs[0], o.inputs[0]); me.materials.append(m)
m, nt, o = mk("engine"); em = nt.nodes.new("ShaderNodeEmission"); em.inputs["Color"].default_value = (0.5, 0.75, 1.0, 1); em.inputs["Strength"].default_value = 60
nt.links.new(em.outputs[0], o.inputs[0]); me.materials.append(m)
m, nt, o = mk("dark"); bs = nt.nodes.new("ShaderNodeBsdfPrincipled"); bs.inputs["Base Color"].default_value = (0.05, 0.05, 0.055, 1); bs.inputs["Metallic"].default_value = 0.9; bs.inputs["Roughness"].default_value = 0.4
nt.links.new(bs.outputs[0], o.inputs[0]); me.materials.append(m)
ship = bpy.data.objects.new("ship", me); scene.collection.objects.link(ship)

# light: one hard key, as on a film model, and almost nothing else
def sun(name, frm, energy, col, angle=0.6):
    l = bpy.data.lights.new(name, "SUN"); l.energy = energy; l.color = col; l.angle = math.radians(angle)
    ob = bpy.data.objects.new(name, l); scene.collection.objects.link(ob)
    ob.rotation_euler = (-Vector(frm)).to_track_quat("-Z", "Y").to_euler(); return ob
KEY = {"front": (-0.55, -0.62, 0.55), "rear": (0.6, -0.55, 0.5), "low": (-0.5, -0.7, 0.25)}[CAM]
sun("key", KEY, 4.2, (1.0, 0.96, 0.9))
sun("fill", (0.5, -0.3, -0.75), 0.22, (0.45, 0.6, 1.0), 8)
sun("rim", (0.2, 0.9, 0.25), 0.9, (0.6, 0.72, 1.0), 2)
pl = bpy.data.lights.new("eng", "POINT"); pl.energy = 9000; pl.color = (0.5, 0.72, 1.0); pl.shadow_soft_size = 1.0
po = bpy.data.objects.new("eng", pl); po.location = (-12.5, 0, 0); scene.collection.objects.link(po)
wd = bpy.data.worlds.new("w"); scene.world = wd; nt = nodes_of(wd)
bg = nt.nodes.get("Background") or nt.nodes.new("ShaderNodeBackground")
bg.inputs[0].default_value = (0.02, 0.03, 0.06, 1); bg.inputs[1].default_value = 0.35
if not nt.nodes.get("World Output"):
    wo = nt.nodes.new("ShaderNodeOutputWorld"); nt.links.new(bg.outputs[0], wo.inputs[0])

cam = bpy.data.cameras.new("cam"); co = bpy.data.objects.new("cam", cam); scene.collection.objects.link(co); scene.camera = co
CAMS = {"front": ((27.0, -25.0, 11.5), (0.25, 0.3, 0.25), 64, -7.0), "rear": ((-26.0, -24.0, 9.0), (0.6, 0.3, 0.0), 58, 7.0), "low": ((24.0, -27.0, -7.5), (0.2, 0.3, 0.2), 60, -8.0)}
loc, tgt, lens, roll = CAMS[CAM]
cam.lens = lens; co.location = loc
q = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y"); co.rotation_euler = q.to_euler()
co.rotation_euler.rotate_axis("Z", math.radians(roll))

scene.render.engine = "CYCLES"; cy = scene.cycles; cy.samples = SAMPLES; cy.device = "CPU"
try: cy.use_denoising = True; cy.denoiser = "OPENIMAGEDENOISE"
except Exception as e: print("denoise:", e)
scene.render.film_transparent = True; scene.render.resolution_x = W; scene.render.resolution_y = H; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"; scene.render.image_settings.color_mode = "RGBA"
try: scene.view_settings.view_transform = "AgX"; scene.view_settings.look = "AgX - Medium High Contrast"
except Exception as e: print("look:", e)
scene.view_settings.exposure = 0.0
scene.render.filepath = out; scene.render.threads_mode = "AUTO"
bpy.context.view_layer.update()
eng = []
for (x, y, z, r) in ENG:
    a = world_to_camera_view(scene, co, Vector((x - 0.7, y, z))); b = world_to_camera_view(scene, co, Vector((x - 7.7, y, z)))
    eng.append({"a": [a.x, 1 - a.y], "b": [b.x, 1 - b.y], "r": r, "depth": a.z})
json.dump({"engines": eng, "faces": len(F)}, open(out + ".json", "w"))
print("faces", len(F))
bpy.ops.render.render(write_still=True)
