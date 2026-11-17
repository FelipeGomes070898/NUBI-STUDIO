"""Fontes com suporte a acentos (fallback para a fonte embutida do Pillow)."""
from functools import lru_cache
from PIL import ImageFont

_CAND = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
         "C:\\Windows\\Fonts\\arial.ttf", "/System/Library/Fonts/Helvetica.ttc"]
_BOLD = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
         "C:\\Windows\\Fonts\\arialbd.ttf"] + _CAND


@lru_cache(maxsize=64)
def font(size: int, bold: bool = False):
    for p in (_BOLD if bold else _CAND):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)
