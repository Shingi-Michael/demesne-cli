"""A ringed planet rising at the lower right, lit from behind, for the full-screen ground. Original art."""
import bpy, sys, math
argv=sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
out=argv[0] if argv else "planet.png"; W=int(argv[1]) if len(argv)>1 else 1600; H=int(argv[2]) if len(argv)>2 else 1000; spp=int(argv[3]) if len(argv)>3 else 48
bpy.ops.wm.read_factory_settings(use_empty=True)
sc=bpy.context.scene; sc.render.engine="CYCLES"; sc.cycles.samples=spp; sc.cycles.use_denoising=True
try: sc.cycles.denoiser="OPENIMAGEDENOISE"
except Exception: pass
sc.render.resolution_x=W; sc.render.resolution_y=H; sc.render.film_transparent=True
sc.view_settings.view_transform="AgX"; sc.view_settings.look="AgX - Medium High Contrast"
w=bpy.data.worlds.new("w"); sc.world=w; w.use_nodes=True; w.node_tree.nodes["Background"].inputs[1].default_value=0.0
cam=bpy.data.cameras.new("c"); cam.lens=40; co=bpy.data.objects.new("c",cam); sc.collection.objects.link(co); sc.camera=co
co.location=(0,-30,0); co.rotation_euler=(math.radians(90),0,0)
def mat(name): m=bpy.data.materials.new(name); m.use_nodes=True; return m, m.node_tree.nodes, m.node_tree.links
# planet
bpy.ops.mesh.primitive_uv_sphere_add(segments=256,ring_count=128,radius=9,location=(9.5,8,-8.6)); P=bpy.context.object
bpy.ops.object.shade_smooth(); P.rotation_euler=(math.radians(14),math.radians(-22),0)
m,n,l=mat("planet"); b=n["Principled BSDF"]; b.inputs["Roughness"].default_value=0.9
tc=n.new("ShaderNodeTexCoord"); mp=n.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value=(0.6,0.6,6.0)
no=n.new("ShaderNodeTexNoise"); no.inputs["Scale"].default_value=2.2; no.inputs["Detail"].default_value=12; no.inputs["Distortion"].default_value=1.6
wv=n.new("ShaderNodeTexWave"); wv.wave_type="BANDS"; wv.bands_direction="Z"; wv.inputs["Scale"].default_value=1.6; wv.inputs["Distortion"].default_value=7; wv.inputs["Detail"].default_value=6
l.new(tc.outputs["Object"],mp.inputs["Vector"]); l.new(mp.outputs["Vector"],no.inputs["Vector"]); l.new(no.outputs["Color"],wv.inputs["Vector"])
ramp=n.new("ShaderNodeValToRGB"); e=ramp.color_ramp.elements
e[0].color=(0.13,0.14,0.17,1); e[1].color=(0.70,0.64,0.55,1)
x=e.new(0.45); x.color=(0.36,0.37,0.42,1); x2=e.new(0.7); x2.color=(0.50,0.47,0.43,1)
l.new(wv.outputs["Fac"],ramp.inputs["Fac"]); l.new(ramp.outputs["Color"],b.inputs["Base Color"])
P.data.materials.append(m)
# atmosphere: a thin glowing shell at the limb
bpy.ops.mesh.primitive_uv_sphere_add(segments=256,ring_count=128,radius=9.32,location=P.location); A=bpy.context.object; bpy.ops.object.shade_smooth()
m,n,l=mat("air"); out_=n["Material Output"]; n.remove(n["Principled BSDF"])
vs=n.new("ShaderNodeVolumeScatter"); vs.inputs["Density"].default_value=2.4; vs.inputs["Color"].default_value=(0.55,0.68,1.0,1); vs.inputs["Anisotropy"].default_value=0.75
l.new(vs.outputs["Volume"],out_.inputs["Volume"]); A.data.materials.append(m)
# ring: an annulus in the planet's equator plane, tilted a little toward us
import bmesh
me=bpy.data.meshes.new("ring"); bm=bmesh.new(); N=720; ri,ro=12.2,21.0
vi=[bm.verts.new((ri*math.cos(2*math.pi*k/N),ri*math.sin(2*math.pi*k/N),0)) for k in range(N)]
vo=[bm.verts.new((ro*math.cos(2*math.pi*k/N),ro*math.sin(2*math.pi*k/N),0)) for k in range(N)]
for k in range(N): bm.faces.new((vi[k],vi[(k+1)%N],vo[(k+1)%N],vo[k]))
bm.to_mesh(me); R=bpy.data.objects.new("ring",me); sc.collection.objects.link(R); R.location=P.location
R.rotation_euler=(math.radians(13),math.radians(-21),0); P.rotation_euler=R.rotation_euler
m,n,l=mat("ring"); b=n["Principled BSDF"]; b.inputs["Roughness"].default_value=0.8
tc=n.new("ShaderNodeTexCoord"); gr=n.new("ShaderNodeTexGradient"); gr.gradient_type="SPHERICAL"
mp=n.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value=(1/21,1/21,1/21)
l.new(tc.outputs["Object"],mp.inputs["Vector"]); l.new(mp.outputs["Vector"],gr.inputs["Vector"])
# bands across the radius from a stretched noise
no=n.new("ShaderNodeTexNoise"); no.inputs["Scale"].default_value=90; no.inputs["Detail"].default_value=8; no.inputs["Roughness"].default_value=0.62
cr=n.new("ShaderNodeCombineXYZ"); l.new(gr.outputs["Fac"],cr.inputs["X"])
l.new(cr.outputs["Vector"],no.inputs["Vector"])
ramp=n.new("ShaderNodeValToRGB"); e=ramp.color_ramp.elements; e[0].position=0.25; e[0].color=(0.15,0.15,0.15,1); e[1].position=0.75; e[1].color=(1,1,1,1)
l.new(no.outputs["Fac"],ramp.inputs["Fac"])
edge=n.new("ShaderNodeValToRGB"); f=edge.color_ramp.elements; f[0].position=0.0; f[0].color=(1,1,1,1); f[1].position=0.06; f[1].color=(1,1,1,1)
g1=f.new(0.33); g1.color=(1,1,1,1); g2=f.new(0.36); g2.color=(0.08,0.08,0.08,1); g3=f.new(0.40); g3.color=(1,1,1,1); g4=f.new(0.98); g4.color=(0.9,0.9,0.9,1); f[-1].position=1.0; f[-1].color=(0,0,0,1)
l.new(gr.outputs["Fac"],edge.inputs["Fac"])
mul=n.new("ShaderNodeMath"); mul.operation="MULTIPLY"; l.new(ramp.outputs["Color"],mul.inputs[0]); l.new(edge.outputs["Color"],mul.inputs[1])
mul2=n.new("ShaderNodeMath"); mul2.operation="MULTIPLY"; mul2.inputs[1].default_value=0.85; l.new(mul.outputs[0],mul2.inputs[0])
l.new(mul2.outputs[0],b.inputs["Alpha"])
col=n.new("ShaderNodeMixRGB"); col.inputs[1].default_value=(0.42,0.40,0.37,1); col.inputs[2].default_value=(0.78,0.76,0.72,1); l.new(ramp.outputs["Color"],col.inputs["Fac"]); l.new(col.outputs["Color"],b.inputs["Base Color"])
R.data.materials.append(m)
# the sun: behind the planet, up and to the left
s=bpy.data.lights.new("sun","SUN"); s.energy=7.0; s.angle=math.radians(0.6); s.color=(1.0,0.96,0.9)
so=bpy.data.objects.new("sun",s); sc.collection.objects.link(so); so.location=(-34,170,26)
t=so.constraints.new("TRACK_TO"); t.target=P; t.track_axis="TRACK_NEGATIVE_Z"; t.up_axis="UP_Y"
fill=bpy.data.lights.new("fill","SUN"); fill.energy=0.04; fill.color=(0.6,0.7,1.0); fo=bpy.data.objects.new("fill",fill); sc.collection.objects.link(fo); fo.rotation_euler=(math.radians(80),0,math.radians(20))
sc.render.filepath=out; bpy.ops.render.render(write_still=True); print("ok",out)
