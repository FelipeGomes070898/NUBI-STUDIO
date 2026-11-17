"""STORYBOARD ENGINE — quadros com posição de personagens, enquadramento, câmera, luz,
duração e transição; gera contact sheet e animatic (via FFmpeg) para aprovação."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import camera as cam_engine
from .character import CharacterSheet, Pose, motion_walk, motion_idle, render_pose, W as CW, H as CH

PW, PH = 960, 540
ARCH = (6.5, 3.2, 0.0)


from ..fonts import font as _font


def panel(shot: dict, cam: dict, char_pos, sheet: CharacterSheet, label: str, orb_pos=None) -> Image.Image:
    im = Image.new("RGB", (PW, PH), (60, 40, 90))
    d = ImageDraw.Draw(im)
    hz = cam_engine.project(cam, (cam["target"][0], 200, cam["location"][2]), (PW, PH))[1]
    for y in range(PH):   # céu
        u = min(1, y / max(1, hz))
        d.line([(0, y), (PW, y)], fill=(int(235 - 150 * u), int(120 - 60 * u), int(110 + 40 * u)) if y < hz else (40, 90, 80))
    # arco e orbe
    for dx in (-1.4, 1.4):
        p0 = cam_engine.project(cam, (ARCH[0] + dx, ARCH[1], 0), (PW, PH))
        p1 = cam_engine.project(cam, (ARCH[0] + dx, ARCH[1], 3.3), (PW, PH))
        if p0[2] > 0:
            d.rectangle([p0[0] - 0.12 * (p0[1] - p1[1]) / 6, p1[1], p0[0] + 0.12 * (p0[1] - p1[1]) / 6, p0[1]], fill=(130, 118, 140))
    if char_pos:
        foot = cam_engine.project(cam, char_pos, (PW, PH))
        head = cam_engine.project(cam, (char_pos[0], char_pos[1], char_pos[2] + sheet.height_m), (PW, PH))
        if foot[2] > 0:
            h_px = foot[1] - head[1]
            ppm = h_px / sheet.height_m
            ch = shot["characters"][0]
            pose = motion_walk(0.1) if ch["action"] == "walk" else motion_idle(0, expr=ch["expression"], view="front")
            spr = render_pose(sheet, pose)
            scale = h_px / (CH * 0.84)
            spr = spr.resize((max(1, int(CW * scale)), max(1, int(CH * scale))))
            im.paste(spr, (int(foot[0] - spr.width / 2), int(foot[1] - spr.height * 0.953)), spr)
    if orb_pos is not None:
        o = cam_engine.project(cam, orb_pos, (PW, PH))
        if o[2] > 0:
            r = 0.22 / o[2] * cam["focal"] / 18 * PW / 2
            d.ellipse([o[0] - r, o[1] - r, o[0] + r, o[1] + r], fill=(160, 240, 255))
    d.rectangle([0, 0, PW - 1, PH - 1], outline=(255, 255, 255), width=3)
    d.rectangle([0, PH - 64, PW, PH], fill=(15, 12, 30))
    d.text((14, PH - 58), f"{shot['id']} {label} · {shot['camera']['shot_type']}/{shot['camera']['movement']} · {shot['duration_s']}s · {shot['mode']}", fill=(255, 255, 255), font=_font(18))
    txt = " | ".join(f"{x['speaker']}: {x['text']}" for x in shot["dialogue"]) or shot["action_text"][:90]
    d.text((14, PH - 32), txt[:110], fill=(255, 220, 150), font=_font(16))
    return im


def build(project, plan, sheet, orb_positions: dict | None = None) -> dict:
    sb = project.p("storyboard")
    imgs, durs, files = [], [], []
    for s in plan["shots"]:
        path = (s["characters"] or [{"path": None}])[0].get("path")
        keys = s["camera_keys"]
        for label, fi in (("início", 0), ("fim", s["frames"] - 1)):
            cam = cam_engine.cam_at(keys, fi + 1)
            pos = path[fi] if path else None
            orb = (orb_positions or {}).get(s["id"], [None] * s["frames"])[fi]
            im = panel(s, cam, pos, sheet, label, orb)
            p = sb / f"{s['id']}_{'a' if fi == 0 else 'b'}.png"
            im.save(p)
            imgs.append(p)
            durs.append(s["duration_s"] / 2)
            files.append(str(p))
    cols = 2
    rows = (len(imgs) + cols - 1) // cols
    sheet_im = Image.new("RGB", (cols * (PW // 2 + 8) + 8, rows * (PH // 2 + 8) + 8), (20, 20, 30))
    for i, p in enumerate(imgs):
        t = Image.open(p).resize((PW // 2, PH // 2))
        sheet_im.paste(t, (8 + (i % cols) * (PW // 2 + 8), 8 + (i // cols) * (PH // 2 + 8)))
    contact = sb / "storyboard_contact_sheet.png"
    sheet_im.save(contact)
    return {"panels": files, "contact_sheet": str(contact), "images": imgs, "durations": durs}
