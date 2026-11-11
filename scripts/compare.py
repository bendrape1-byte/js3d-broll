# Compares a path-traced reference with our renderer's frame: PSNR at quarter size, mean colour of named regions.
import sys, math
from PIL import Image, ImageChops, ImageStat
ref, ours = [Image.open(p).convert('RGB') for p in sys.argv[1:3]]
def psnr(a, b):
    a, b = [x.resize((270, 480), Image.BOX) for x in (a, b)]
    mse = sum(ImageStat.Stat(ImageChops.difference(a, b)).sum2) / (270 * 480 * 3)
    return 10 * math.log10(255 ** 2 / mse)
R = {'sky': (90, 615, 270, 795), 'crown': (450, 90, 750, 345), 'hedge': (90, 945, 300, 1050), 'fence': (450, 1095, 720, 1290), 'trunk': (285, 795, 352, 1245),
     'bath': (900, 1245, 960, 1440), 'lawn mid': (375, 1410, 675, 1515), 'lawn front': (300, 1665, 900, 1875), 'rabbit': (750, 1500, 870, 1575), 'whole frame': (0, 0, 1080, 1920)}
print(f'PSNR at quarter size: {psnr(ref, ours):.1f} dB')
print(f'{"region":12} {"reference":>16} {"ours":>16} {"ours - ref":>16}')
for k, box in R.items():
    a, b = [ImageStat.Stat(x.crop(box)).mean for x in (ref, ours)]
    print(f'{k:12} {" ".join(f"{v:5.1f}" for v in a)} {" ".join(f"{v:5.1f}" for v in b)} {" ".join(f"{y - x:+5.1f}" for x, y in zip(a, b))}')
