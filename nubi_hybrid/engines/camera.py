"""CAMERA ENGINE — enquadramentos, movimentos e projeção (usada também pelo QC e VFX)."""
from __future__ import annotations

import math

import numpy as np

SENSOR_W = 36.0
PRESETS = {  # dist (m), altura da câmera, altura do alvo, lente (mm), f-stop
    "wide":          dict(dist=11.0, h=2.0, tgt_h=1.6, focal=26, fstop=8.0),
    "medium_wide":   dict(dist=7.5, h=1.7, tgt_h=1.3, focal=30, fstop=6.0),
    "medium":        dict(dist=5.4, h=1.5, tgt_h=1.2, focal=32, fstop=5.6),
    "close":         dict(dist=3.3, h=1.35, tgt_h=1.28, focal=40, fstop=2.2),
    "extreme_close": dict(dist=1.9, h=1.4, tgt_h=1.4, focal=50, fstop=1.8),
}
SCENE_CENTER = (2.5, 3.0, 2.0)


def smooth(u: float) -> float:
    return u * u * (3 - 2 * u)


def plan_camera(shot_type: str, movement: str, subject: list | None, frames: int,
                step: int = 3) -> dict:
    """subject: [(x,y,z)] por quadro (pés do personagem) ou None (plano de ambiente)."""
    pr = PRESETS[shot_type]
    keys = []
    for f in list(range(0, frames, step)) + [frames - 1]:
        u = smooth(f / max(1, frames - 1))
        if subject:
            sx, sy, sz = subject[min(f, len(subject) - 1)]
            d = pr["dist"]
            lead = 0.0
            tgt = [sx, sy, sz + pr["tgt_h"]]
            if movement in ("dolly_in", "zoom_in"):
                d *= 1.30 - 0.42 * u
            elif movement in ("dolly_out", "dolly_out_tilt"):
                d *= 0.85 + 0.55 * u
            elif movement == "travelling":
                lead = 0.7
                d *= 1.0
            if movement in ("tilt_up", "dolly_out_tilt"):
                tgt[2] += 1.1 * u
            if movement == "pan":
                tgt[0] += -1.5 + 3.0 * u
            cam = [sx + lead + (0.35 * (1 - u) if movement.startswith("dolly") else 0), sy - d, pr["h"] + sz + (0.6 * u if movement == "dolly_out_tilt" else 0)]
            tgt[0] += lead + 0.25
            focal = pr["focal"] * (1 + 0.25 * u if movement == "zoom_in" else 1)
        else:
            cx, cy, cz = SCENE_CENTER
            k = {"dolly_in": (u, 1), "dolly_out": (1 - u, 1), "static": (0.5, 0)}.get(movement, (u, 1))[0]
            cam = [-7.0 + 4.5 * k, -13.0 + 4.0 * k, 2.6 - 0.9 * k]
            tgt = [cx + 0.5 * k, cy, cz]
            focal = pr["focal"]
        keys.append({"frame": f + 1, "location": [round(v, 4) for v in cam], "target": [round(v, 4) for v in tgt],
                     "focal": round(focal, 3), "fstop": pr["fstop"]})
    return {"keyframes": keys, "interp": "BEZIER"}


def project(cam: dict, point, res=(960, 540)) -> tuple[float, float, float]:
    """Projeta ponto do mundo -> pixels (modelo pinhole = câmera Blender, sensor 36 mm horizontal)."""
    c, t = np.array(cam["location"], float), np.array(cam["target"], float)
    fwd = t - c
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    v = np.array(point, float) - c
    depth = float(v @ fwd)
    if depth <= 0.05:
        return (-1e6, -1e6, depth)
    aspect = res[0] / res[1]
    xn = (v @ right) / depth * cam["focal"] / (SENSOR_W / 2)
    yn = (v @ up) / depth * cam["focal"] / (SENSOR_W / 2 / aspect)
    return ((xn * 0.5 + 0.5) * res[0], (0.5 - yn * 0.5) * res[1], depth)


def cam_at(keys: list, frame: int) -> dict:
    """Interpola câmera (aprox. linear sobre keys densas) no quadro 1-based."""
    ks = keys
    if frame <= ks[0]["frame"]:
        return ks[0]
    for a, b in zip(ks, ks[1:]):
        if a["frame"] <= frame <= b["frame"]:
            u = (frame - a["frame"]) / max(1, b["frame"] - a["frame"])
            mix = lambda p, q: [p[i] + (q[i] - p[i]) * u for i in range(3)]
            return {"location": mix(a["location"], b["location"]), "target": mix(a["target"], b["target"]),
                    "focal": a["focal"] + (b["focal"] - a["focal"]) * u}
    return ks[-1]
