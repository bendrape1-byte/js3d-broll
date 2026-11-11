# Spot falloff: the key light (58 deg, blend 0.65) 9.5 m above a white plane; radiance along a line through the axis.
import bpy, sys, math, numpy as np
out = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
s = bpy.context.scene; s.render.engine = "CYCLES"; s.cycles.device = "CPU"; s.cycles.samples = 64; s.cycles.use_denoising = False
s.render.resolution_x, s.render.resolution_y = 256, 8; s.view_settings.view_transform = "Standard"
s.world = bpy.data.worlds.new("W"); s.world.use_nodes = True; s.world.node_tree.nodes["Background"].inputs[1].default_value = 0
bpy.ops.mesh.primitive_plane_add(size=60)
m = bpy.data.materials.new("M"); m.use_nodes = True; p = m.node_tree.nodes["Principled BSDF"]
p.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1); p.inputs["Roughness"].default_value = 1.0; p.inputs["IOR"].default_value = 1.0
bpy.context.object.data.materials.append(m)
d = bpy.data.lights.new("L", "SPOT"); d.energy = 9000; d.spot_size = math.radians(58); d.spot_blend = 0.65; d.shadow_soft_size = 0
o = bpy.data.objects.new("L", d); s.collection.objects.link(o); o.location = (0, 0, 9.5)
c = bpy.data.cameras.new("C"); c.type = "ORTHO"; c.ortho_scale = 12.8
co = bpy.data.objects.new("C", c); s.collection.objects.link(co); co.location = (0, 0, 3); s.camera = co
s.render.image_settings.file_format = "OPEN_EXR"; s.render.filepath = out
bpy.ops.render.render(write_still=True)
im = bpy.data.images.load(out); px = np.array(im.pixels[:]).reshape(8, 256, 4)[:, :, 0].mean(0)
r = (np.arange(256) + 0.5) / 256 * 12.8 - 6.4
print("SPOT", " ".join(f"{x:.2f}:{v:.4f}" for x, v in zip(r[128::8], px[128::8])))
