# Light-unit calibration: a white diffuse plane (albedo 0.8) lit by one light 5 m above; read linear radiance.
import bpy, sys, math, numpy as np
kind, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
s = bpy.context.scene; s.render.engine = "CYCLES"; s.cycles.device = "CPU"; s.cycles.samples = 256; s.cycles.use_denoising = False
s.render.resolution_x = s.render.resolution_y = 32; s.view_settings.view_transform = "Standard"
s.world = bpy.data.worlds.new("W"); s.world.use_nodes = True; s.world.node_tree.nodes["Background"].inputs[1].default_value = 0
bpy.ops.mesh.primitive_plane_add(size=40)
m = bpy.data.materials.new("M"); m.use_nodes = True; p = m.node_tree.nodes["Principled BSDF"]
p.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1); p.inputs["Roughness"].default_value = 1.0; p.inputs["IOR"].default_value = 1.0
bpy.context.object.data.materials.append(m)
if kind == "area":
    d = bpy.data.lights.new("L", "AREA"); d.energy = 100; d.size = 0.5
elif kind == "spot":
    d = bpy.data.lights.new("L", "SPOT"); d.energy = 100; d.spot_size = math.radians(90); d.spot_blend = 0; d.shadow_soft_size = 0
else:
    d = bpy.data.lights.new("L", "POINT"); d.energy = 100; d.shadow_soft_size = 0
o = bpy.data.objects.new("L", d); s.collection.objects.link(o); o.location = (0, 0, 5)   # lights point down -Z by default
c = bpy.data.cameras.new("C"); c.type = "ORTHO"; c.ortho_scale = 0.2
co = bpy.data.objects.new("C", c); s.collection.objects.link(co); co.location = (0, -0.01, 3); co.rotation_euler = (0.0, 0, 0); s.camera = co
s.render.image_settings.file_format = "OPEN_EXR"; s.render.filepath = out
bpy.ops.render.render(write_still=True)
im = bpy.data.images.load(out); px = np.array(im.pixels[:]).reshape(32, 32, 4)
print("CAL", kind, px[8:24, 8:24, :3].mean())
