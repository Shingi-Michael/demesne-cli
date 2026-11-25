"""The ringed planet, whole, for Home's sky: textured gas giant, thin atmosphere, a ring with real gaps. Original art.
python3 planet-whole.py -- out.png W H SPP (run gas.py first)"""
import bpy, bmesh, math, sys, os
from mathutils import Vector
argv = sys.argv[sys.argv.index("--") + 1:]; OUT = argv[0]; W, H, SPP = int(argv[1]), int(argv[2]), int(argv[3])
HERE = os.path.dirname(os.path.abspath(__file__))
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
def mat(name):
    m = bpy.data.materials.new(name)
    try: m.use_nodes = True
    except Exception: pass
    return m, m.node_tree.nodes, m.node_tree.links
TILT = (math.radians(24), math.radians(-18), math.radians(-20))
bpy.ops.mesh.primitive_uv_sphere_add(segments=256, ring_count=128, radius=5.0); P = bpy.context.object; bpy.ops.object.shade_smooth()
m, n, l = mat("gas"); b = n["Principled BSDF"]; b.inputs["Roughness"].default_value = 1.0
tx = n.new("ShaderNodeTexImage"); tx.image = bpy.data.images.load(os.path.join(HERE, "gas.png")); tx.interpolation = "Cubic"
l.new(tx.outputs["Color"], b.inputs["Base Color"]); P.data.materials.append(m)
P.rotation_euler = TILT
# atmosphere shell: a soft blue limb
bpy.ops.mesh.primitive_uv_sphere_add(segments=192, ring_count=96, radius=5.12); A = bpy.context.object; bpy.ops.object.shade_smooth()
m, n, l = mat("air"); o = n["Material Output"]; n.remove(n["Principled BSDF"])
vs = n.new("ShaderNodeVolumeScatter"); vs.inputs["Density"].default_value = 1.6; vs.inputs["Color"].default_value = (0.6, 0.72, 1.0, 1); vs.inputs["Anisotropy"].default_value = 0.6
l.new(vs.outputs["Volume"], o.inputs["Volume"]); A.data.materials.append(m)
# ring with UVs: u across the radius
me = bpy.data.meshes.new("ring"); bm = bmesh.new(); N = 720; ri, ro = 6.4, 11.6
vi = [bm.verts.new((ri * math.cos(2 * math.pi * k / N), ri * math.sin(2 * math.pi * k / N), 0)) for k in range(N)]
vo = [bm.verts.new((ro * math.cos(2 * math.pi * k / N), ro * math.sin(2 * math.pi * k / N), 0)) for k in range(N)]
uv = bm.loops.layers.uv.new()
for k in range(N):
    f = bm.faces.new((vi[k], vi[(k + 1) % N], vo[(k + 1) % N], vo[k]))
    for lp in f.loops: lp[uv].uv = (0.0 if lp.vert in vi else 1.0, 0.5)
bm.to_mesh(me); Rg = bpy.data.objects.new("ring", me); sc.collection.objects.link(Rg); Rg.rotation_euler = TILT
m, n, l = mat("ring"); b = n["Principled BSDF"]; b.inputs["Roughness"].default_value = 0.85
tx = n.new("ShaderNodeTexImage"); tx.image = bpy.data.images.load(os.path.join(HERE, "ringprof.png")); tx.extension = "EXTEND"; tx.interpolation = "Linear"
l.new(tx.outputs["Color"], b.inputs["Base Color"])
tr = n.new("ShaderNodeBsdfTranslucent"); l.new(tx.outputs["Color"], tr.inputs["Color"])
mx = n.new("ShaderNodeMixShader"); mx.inputs[0].default_value = 0.3; l.new(b.outputs[0], mx.inputs[1]); l.new(tr.outputs[0], mx.inputs[2])
tp = n.new("ShaderNodeBsdfTransparent"); mx2 = n.new("ShaderNodeMixShader"); l.new(tx.outputs["Alpha"], mx2.inputs[0]); l.new(tp.outputs[0], mx2.inputs[1]); l.new(mx.outputs[0], mx2.inputs[2])
l.new(mx2.outputs[0], n["Material Output"].inputs["Surface"])
try: m.blend_method = "BLEND"
except Exception: pass
Rg.data.materials.append(m)
# light: the sun up and to the left, a little in front, so the planet is mostly lit with its night side to the right
s = bpy.data.lights.new("sun", "SUN"); s.energy = 6.0; s.angle = math.radians(0.5); s.color = (1.0, 0.96, 0.9)
so = bpy.data.objects.new("sun", s); sc.collection.objects.link(so); so.rotation_euler = (-Vector((-0.75, -0.55, 0.38))).to_track_quat("-Z", "Y").to_euler()
f = bpy.data.lights.new("fill", "SUN"); f.energy = 0.05; f.color = (0.5, 0.62, 1.0); fo = bpy.data.objects.new("fill", f); sc.collection.objects.link(fo)
fo.rotation_euler = (-Vector((0.7, -0.3, -0.4))).to_track_quat("-Z", "Y").to_euler()
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True; w.node_tree.nodes["Background"].inputs[1].default_value = 0.0
cam = bpy.data.cameras.new("c"); cam.lens = 85; co = bpy.data.objects.new("c", cam); sc.collection.objects.link(co); sc.camera = co
d = Vector((0.0, -1.0, 0.0)); dist = 95; co.location = d * dist; co.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
cam.sensor_fit = "HORIZONTAL"
sc.render.engine = "CYCLES"; sc.cycles.samples = SPP; sc.cycles.use_denoising = True
try: sc.cycles.denoiser = "OPENIMAGEDENOISE"
except Exception: pass
sc.cycles.volume_step_rate = 2.0
sc.render.film_transparent = True; sc.render.resolution_x = W; sc.render.resolution_y = H
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"
sc.render.filepath = OUT; bpy.ops.render.render(write_still=True); print("ok", OUT)
