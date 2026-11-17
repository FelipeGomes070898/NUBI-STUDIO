from .base import Adapter, AdapterError, AdapterUnavailable, Detection
from .ffmpeg import FFmpegAdapter
from .blender import BlenderAdapter
from .animate import AnimateAdapter
from .after_effects import AfterEffectsAdapter
from .others import UnrealAdapter, DaVinciAdapter, ToonBoomAdapter, MohoAdapter

ALL = [FFmpegAdapter, BlenderAdapter, AnimateAdapter, AfterEffectsAdapter,
       UnrealAdapter, DaVinciAdapter, ToonBoomAdapter, MohoAdapter]


def detect_all(logfile=None) -> dict:
    out = {}
    for cls in ALL:
        d = cls(logfile).detect()
        out[d.name] = d
    return out
