# Bake Blender's AgX + "Medium High Contrast" view into a 65^3 LUT. Input axis per channel: u in [0,1] -> linear
# 2^(u * 16.5 - 12.47393) (AgX's own log range). Output: display sRGB float32 RGB, r fastest.
import bpy, sys, numpy as np
N, out = 65, sys.argv[-1]
u = np.arange(N) / (N - 1)
lin = 2.0 ** (u * 16.499999 - 12.47393)
b, g, r = np.meshgrid(lin, lin, lin, indexing="ij")          # r fastest in memory
rgba = np.stack([r.ravel(), g.ravel(), b.ravel(), np.ones(N ** 3)], 1).astype(np.float32)
s = bpy.context.scene
s.view_settings.view_transform = "AgX"; s.view_settings.look = "AgX - Medium High Contrast"
s.render.dither_intensity = 0.0
s.render.image_settings.file_format = "OPEN_EXR"; s.render.image_settings.color_depth = "32"
W, H = N * N, N
img = bpy.data.images.new("L", W, H, float_buffer=True)
img.pixels.foreach_set(rgba.ravel())
img.save_render(out + ".exr", scene=s)
s.render.image_settings.file_format = "PNG"; s.render.image_settings.color_depth = "16"
img.save_render(out + ".png", scene=s)
im = bpy.data.images.load(out + ".png"); im.colorspace_settings.name = "Non-Color"
px = np.empty(W * H * 4, np.float32); im.pixels.foreach_get(px)
px.reshape(-1, 4)[:, :3].astype(np.float32).tofile(out)
print("LUT", px.reshape(-1, 4)[:, :3].min(), px.reshape(-1, 4)[:, :3].max())
