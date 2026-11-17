"""HYBRID ANIMATION ENGINE — integra personagem 2D no cenário 3D.

Método implementado: (1) personagem 2D em cenário 3D (billboard com sequência RGBA no Blender,
sombra de contato + sombra projetada real + luz do orbe iluminando o personagem).
Pendentes (documentados): Grease Pencil em 3D e composição 2.5D em camadas.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from . import camera as cam_engine
from .character import (CharacterSheet, Pose, motion_celebrate, motion_idle, motion_talk,
                        motion_walk, render_pose, lipsync_track, W as CW, H as CH)

WALK_SPEED = 1.45      # m/s  (ciclo de 1,0 s => passo de 0,725 m: sem escorregar)
WALK_CYCLE_S = 1.0
SPAWN_X = -4.0


def char_metrics(sheet: CharacterSheet) -> dict:
    """Mede o personagem desenhado para escalá-lo à altura real em metros."""
    im = render_pose(sheet, Pose(view="front"))
    a = np.asarray(im)[..., 3] > 20
    rows = np.where(a.any(1))[0]
    top, bottom = int(rows[0]), int(rows[-1])
    ppm = (bottom - top) / sheet.height_m
    return {"ppm": ppm, "plane_h": CH / ppm, "plane_aspect": CW / CH,
            "foot_offset": (CH - bottom) / ppm, "top_px": top, "bottom_px": bottom}


def blocking(plan: dict) -> None:
    """Posições dos personagens por tomada, com continuidade entre tomadas."""
    x = SPAWN_X
    for s in plan["shots"]:
        for c in s["characters"]:
            if c["action"] == "walk":
                c["path"] = [(x + WALK_SPEED * (f / plan["fps"]), 0.0, 0.0) for f in range(s["frames"])]
                x = c["path"][-1][0]
            else:
                c["path"] = [(x, 0.0, 0.0)] * s["frames"]
            c["facing"] = 1


def pose_for(shot: dict, ch: dict, f: int, fps: int, speech: dict | None) -> Pose:
    t = f / fps
    act, expr = ch["action"], ch["expression"]
    if act == "walk":
        return motion_walk(t, facing=ch["facing"], expr=expr, cycle_s=WALK_CYCLE_S)
    if act == "celebrate":
        tb = shot.get("burst_s", 0.3 * shot["duration_s"])
        if t < tb:
            p = motion_idle(t, expr="surprised", view="front")
            p.head_tilt = -5 + 2 * math.sin(t * 3)
            return p
        u = min(1.0, (t - tb) / 0.25)
        p = motion_celebrate(t - tb, expr="happy")
        p.arms = ((-150 * u + 8 * (1 - u), 20), (150 * u - 8 * (1 - u), 20)) if u < 1 else p.arms
        return p
    if act == "talk":
        if speech and speech["speaker"] == "MIRA":
            return motion_talk(t, expr=speech["emotion"], view="front", viseme=speech["viseme"],
                               op=speech["open"], gesture=0.35 * speech["open"])
        listening = "happy" if speech is None else expr
        return motion_talk(t, expr=listening if shot["dialogue"] and t > 0.3 else "neutral", view="front")
    return motion_idle(t, expr=expr, view=ch.get("view", "front"))


def speech_tracks(shot: dict, fps: int) -> list:
    """Por quadro: fala ativa (speaker, viseme, abertura, emoção) ou None."""
    n = shot["frames"]
    out = [None] * n
    for ln in shot.get("audio_lines", []):
        track = lipsync_track(ln["text"], ln["env"], fps, 0.01)
        f0 = int(round(ln["start_s"] * fps))
        for i, (vis, op) in enumerate(track):
            if 0 <= f0 + i < n:
                out[f0 + i] = {"speaker": ln["speaker"], "viseme": vis, "open": op, "emotion": ln["emotion"],
                               "active": op > 0}
        for i in range(f0, min(n, f0 + len(track))):
            if out[i] is None:
                out[i] = {"speaker": ln["speaker"], "viseme": "rest", "open": 0.0, "emotion": ln["emotion"], "active": False}
    return out


def render_char_frames(sheet, shot, ch, fps, out_dir: Path, speech) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in range(shot["frames"]):
        p = out_dir / f"char_{f + 1:04d}.png"
        if p.exists():
            continue
        sp = speech[f]
        pose = pose_for(shot, ch, f, fps, sp)
        render_pose(sheet, pose).save(p)
    return shot["frames"]


def orb_keys(shot: dict, ch_pos: tuple, fps: int) -> list | None:
    if not shot.get("orb"):
        return None
    n = shot["frames"]
    x, y, z = ch_pos
    P0 = np.array([x + 1.15, y - 0.2, 1.5])
    # envelope da voz do orbe (Lumi), por quadro
    pulse = np.zeros(n)
    for ln in shot.get("audio_lines", []):
        if ln["speaker"] == "LUMI":
            e = ln["env"] / (ln["env"].max() + 1e-9)
            f0 = int(round(ln["start_s"] * fps))
            for i in range(n):
                k = int((i - f0) / fps / 0.01)
                if 0 <= k < len(e):
                    pulse[i] = max(pulse[i], e[max(0, k - 2):k + 3].max())
    keys = []
    burst = shot.get("burst_s")
    for f in range(n):
        t = f / fps
        if burst is None:      # tomada de encontro: orbe flutua e pulsa com a voz
            pos = P0 + np.array([0, 0, 0.06 * math.sin(t * 2.2)])
            keys.append({"frame": f + 1, "pos": pos.tolist(), "scale": 1.0 + 0.25 * pulse[f],
                         "energy": 220 * (1 + 2.2 * pulse[f]), "emit": 9 + 14 * pulse[f]})
        else:
            u = min(1.0, t / burst)
            ease = u * u * (3 - 2 * u)
            P1 = np.array([x + 0.5, y - 0.1, 2.45])
            if t < burst:
                pos = P0 + (P1 - P0) * ease
                sc = 1.0 + 0.7 * ease
                en, em = 220 + 1500 * ease ** 2, 10 + 30 * ease ** 2
                col = [0.55, 0.92, 1.0]
            else:
                d = t - burst
                pos = P1
                sc = max(0.01, 1.7 + 1.2 * min(1, d / 0.12) - 2.9 * min(1.0, d / 0.5)) if d < 0.5 else 0.01
                en = (14000 * math.exp(-d * 6) + 500 * math.exp(-d * 0.9)) if d < 5 else 100
                em = 90 * math.exp(-d * 9) if d < 0.5 else 0.0
                col = [1.0, 0.85, 0.55] if d > 0.05 else [1.0, 1.0, 1.0]
            keys.append({"frame": f + 1, "pos": pos.tolist(), "scale": float(sc), "energy": float(en),
                         "emit": float(em), "color": col})
    return keys


def build_job(project, plan, shot, sheet, settings, metrics, subject_path, char_dir: Path | None) -> dict:
    fps, n = plan["fps"], shot["frames"]
    cam = cam_engine.plan_camera(shot["camera"]["shot_type"], shot["camera"]["movement"],
                                 subject_path if shot["characters"] else None, n)
    job = {"job": shot["id"], "environment": shot["environment"], "seed": 7,
           "resolution": [settings.width, settings.height], "fps": fps, "samples": settings.samples,
           "engine": settings.engine, "frame_start": 1, "frame_end": n,
           "output_dir": str(project.p("intermediate", "renders", shot["id"], "plate", "x").parent),
           "output_prefix": "plate_", "camera": cam,
           "exposure": 0.0}
    if shot["characters"] and char_dir:
        job["character"] = {
            "sequence_dir": str(char_dir), "pattern": "char_%04d.png", "frames": n,
            "height": metrics["plane_h"], "aspect": metrics["plane_aspect"], "foot_offset": metrics["foot_offset"],
            "path": [[i + 1, list(p)] for i, p in enumerate(subject_path)],
            "shadow_scale": 1.0}
    orb = orb_keys(shot, subject_path[0] if subject_path else (0, 0, 0), fps)
    if orb:
        job["orb"] = {"keyframes": orb}
    return job
