"""CHARACTER ENGINE + Character Consistency Engine.

Personagem 2D com identificador permanente, folha de modelo (frente/lado/costas),
expressões, visemas, rig por esqueleto (quadril/ombro/cotovelo/joelho) e biblioteca de
movimentos. A mesma `CharacterSheet` gera todas as poses => aparência idêntica entre cenas.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from ..fonts import font as _font

W, H = 420, 640          # canvas base do personagem (px)
SS = 2                   # super-amostragem p/ anti-aliasing
GROUND = 604


def _rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


def _shade(c, f):
    return (int(c[0] * f), int(c[1] * f), int(c[2] * f), c[3] if len(c) > 3 else 255)


@dataclass
class CharacterSheet:
    id: str = "char_mira_v1"
    name: str = "Mira"
    palette: dict = field(default_factory=lambda: {
        "skin": "#f2b48f", "hair": "#5b3a8c", "jacket": "#e8456f", "accent": "#ffd23f",
        "pants": "#3b4a8c", "boots": "#5a3b2e", "eye": "#2d9c9c", "outline": "#2a1838"})
    proportions: dict = field(default_factory=lambda: {
        "head_rx": 82, "head_ry": 88, "torso_h": 150, "torso_w": 96,
        "thigh": 92, "shin": 92, "arm_up": 78, "arm_low": 72, "limb_w": 30})
    voice: dict = field(default_factory=lambda: {"lang": "pt-br", "pitch": 62, "speed": 150})
    accessories: list = field(default_factory=lambda: ["headband", "scarf", "satchel", "ponytail"])
    height_m: float = 1.62

    def signature(self) -> str:
        blob = json.dumps({"p": self.palette, "pr": self.proportions, "a": self.accessories},
                          sort_keys=True)
        return hashlib.sha256(blob.encode()).hexdigest()[:16]


@dataclass
class Pose:
    view: str = "side"            # side | front | back
    facing: int = 1               # +1 direita / -1 esquerda (view side)
    phase: float = 0.0            # ciclo de caminhada 0..1
    walk: float = 0.0             # 0 parado .. 1 caminhando
    head_tilt: float = 0.0        # graus
    head_nod: float = 0.0         # px (vertical)
    yaw: float = 0.0              # -1..1 giro de cabeça (front)
    expr: str = "neutral"
    viseme: str = "rest"          # rest|MBP|AI|E|O|U
    open: float = 0.0             # abertura da boca 0..1
    blink: float = 0.0            # 0 aberto .. 1 fechado
    arms: tuple | None = None     # ((ang_L, bend_L), (ang_R, bend_R)) override
    sway: float = 0.0             # balanço do rabo de cavalo
    breathe: float = 0.0


EXPR = {  # brow_dy, brow_inner_angle, eye_open, smile, blush
    "neutral":    (0, 0, 1.0, 0.35, 0.25),
    "happy":      (-4, -4, 0.85, 1.0, 0.6),
    "surprised":  (-14, 10, 1.22, -0.1, 0.2),
    "worried":    (-3, 18, 1.0, -0.6, 0.1),
    "determined": (5, -16, 0.92, 0.25, 0.3),
    "sad":        (-2, 20, 0.9, -1.0, 0.1),
}
VISEMES = ["rest", "MBP", "AI", "E", "O", "U"]


# --------------------------------------------------------------------- desenho
class _Canvas:
    def __init__(self, size=(W, H), s=SS):
        self.s = s
        self.im = Image.new("RGBA", (size[0] * s, size[1] * s), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def P(self, *v):
        return [x * self.s for x in v]

    def ell(self, cx, cy, rx, ry, fill, line=None, ow=4):
        s = self.s
        if line:
            self.d.ellipse([(cx - rx - ow) * s, (cy - ry - ow) * s, (cx + rx + ow) * s, (cy + ry + ow) * s], fill=line)
        self.d.ellipse([(cx - rx) * s, (cy - ry) * s, (cx + rx) * s, (cy + ry) * s], fill=fill)

    def cap(self, p1, p2, w, fill, line=None, ow=4):
        s = self.s
        for width, col in ((w + 2 * ow, line), (w, fill)):
            if col is None:
                continue
            self.d.line([p1[0] * s, p1[1] * s, p2[0] * s, p2[1] * s], fill=col, width=int(width * s))
            for p in (p1, p2):
                r = width / 2
                self.d.ellipse([(p[0] - r) * s, (p[1] - r) * s, (p[0] + r) * s, (p[1] + r) * s], fill=col)

    def poly(self, pts, fill, line=None, ow=4):
        s = self.s
        P = [(x * s, y * s) for x, y in pts]
        if line:
            self.d.polygon(P, fill=line)
            self.d.line(P + [P[0]], fill=line, width=int(2 * ow * s), joint="curve")
        self.d.polygon(P, fill=fill)

    def curve(self, pts, w, col):
        s = self.s
        P = [(x * s, y * s) for x, y in pts]
        self.d.line(P, fill=col, width=int(w * s), joint="curve")
        for p in (P[0], P[-1]):
            r = w * s / 2
            self.d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=col)


def _bez(p0, p1, p2, n=16):
    out = []
    for i in range(n + 1):
        t = i / n
        out.append(((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
                    (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]))
    return out


def _draw_mouth(c: _Canvas, cx, cy, vis, op, smile, mw, ink):
    dark, tongue = (92, 24, 44, 255), (236, 110, 130, 255)
    if vis in ("rest", "MBP") or op < 0.08:
        k = smile * 12
        c.curve(_bez((cx - mw, cy), (cx, cy + k * 1.6), (cx + mw, cy)), 5, ink)
        if smile > 0.9 and vis == "rest":
            c.ell(cx, cy + 6, mw * 0.8, 7, dark)
        return
    if vis == "AI":
        c.ell(cx, cy + op * 7, mw * 0.78, 5 + op * 17, dark, ink, 3)
        c.ell(cx, cy + op * 7 + 8 * op, mw * 0.5, 4 + op * 5, tongue)
    elif vis == "E":
        c.ell(cx, cy + 2, mw * 1.05, 4 + op * 9, dark, ink, 3)
    elif vis == "O":
        c.ell(cx, cy + op * 5, mw * 0.42, 6 + op * 13, dark, ink, 3)
    else:  # U
        c.ell(cx, cy + op * 3, mw * 0.28, 4 + op * 8, dark, ink, 3)


def _draw_eye(c: _Canvas, cx, cy, open_, blink, eye_col, ink, look=0.0, happy=0.0):
    eo = max(0.0, open_ * (1 - blink))
    if eo < 0.12 or happy > 0.8 and blink < 0.5 and False:
        c.curve(_bez((cx - 17, cy + 2), (cx, cy - 4 if happy < 0.5 else cy - 12), (cx + 17, cy + 2)), 5, ink)
        return
    ry = 21 * eo
    c.ell(cx, cy, 17, ry, (255, 255, 255, 255), ink, 3)
    c.ell(cx + look * 5, cy + 1, 11, min(ry, 15), eye_col)
    c.ell(cx + look * 5, cy + 1, 5.5, min(ry, 8), (20, 20, 40, 255))
    c.ell(cx + look * 5 - 4, cy - 5, 3.2, 3.2, (255, 255, 255, 255))


def _render_head(sheet: CharacterSheet, pose: Pose, pal) -> Image.Image:
    """Cabeça numa camada própria (centro = pivô). Retorna imagem com SS aplicado."""
    pr = sheet.proportions
    rx, ry = pr["head_rx"], pr["head_ry"]
    c = _Canvas((300, 300))
    cx, cy = 150, 150
    ink, skin, hair = pal["outline"], pal["skin"], pal["hair"]
    brow_dy, brow_a, eye_o, smile, blush = EXPR[pose.expr]
    side = pose.view == "side"
    back = pose.view == "back"
    f = pose.facing if side else 1
    yaw = pose.yaw * 16
    dx = (0.30 * rx) if side else yaw           # deslocamento dos traços

    # cabelo de trás + rabo de cavalo
    c.ell(cx - (f * 8 if side else 0), cy - 6, rx * 1.04, ry * 1.04, _shade(hair, 0.8), ink)
    if "ponytail" in sheet.accessories:
        if side:
            base = (cx - f * rx * 0.8, cy - ry * 0.35)
            tip = (base[0] - f * (40 + pose.sway * 18), base[1] + 70 + abs(pose.sway) * 6)
            ctrl = (base[0] - f * (55 + pose.sway * 30), base[1] + 5)
            pts = _bez(base, ctrl, tip, 14)
            ws = [34 - 18 * i / len(pts) for i in range(len(pts))]
            for i in range(len(pts) - 1):      # 1ª passada: contorno contínuo
                c.cap(pts[i], pts[i + 1], ws[i] + 6, ink, None)
            for i in range(len(pts) - 1):      # 2ª passada: preenchimento
                c.cap(pts[i], pts[i + 1], ws[i], _shade(hair, 0.9), None)
        else:
            c.cap((cx + 55, cy - 50), (cx + 100 + pose.sway * 10, cy + 70), 36, _shade(hair, 0.9), ink, 3)
    if back:
        c.ell(cx, cy, rx, ry, hair, ink)
        if "headband" in sheet.accessories:
            c.cap((cx - rx * .96, cy - 18), (cx + rx * .96, cy - 18), 14, pal["accent"], ink, 3)
        return c.im
    # rosto
    c.ell(cx + (f * 4 if side else yaw * 0.3), cy + 8, rx * (0.96 if side else 1.0), ry * 0.94, skin, ink)
    ex1 = cx + f * dx if side else cx - rx * 0.40 + dx
    ex2 = cx + f * (dx + rx * 0.5) if side else cx + rx * 0.40 + dx
    ey = cy + 10
    eyes = [ex2] if side else [ex1, ex2]
    if side:
        eyes = [cx + f * rx * 0.45]
    for i, ex in enumerate(eyes):
        _draw_eye(c, ex, ey, eye_o, pose.blink, pal["eye"], ink, look=f * 0.4 if side else yaw / 16, happy=1.0 if pose.expr == "happy" else 0.0)
        # sobrancelha
        inner = (-1 if (not side and i == 0) else 1) * (1 if not side else f)
        ang = math.radians(brow_a) * (1 if (side or i == 1) else -1)
        bx0, by0 = ex - 20, ey - 30 + brow_dy
        bx1, by1 = ex + 20, ey - 30 + brow_dy
        if side:
            by0 -= brow_a * 0.0
        else:
            if i == 0:
                by1 -= brow_a * 0.55
            else:
                by0 -= brow_a * 0.55
        if side:
            by0 -= brow_a * 0.3 if f == 1 else 0
            by1 -= brow_a * 0.3 if f == -1 else 0
        c.curve([(bx0, by0), ((bx0 + bx1) / 2, (by0 + by1) / 2 - 4), (bx1, by1)], 6, _shade(hair, 0.9) if True else ink)
        if blush > 0.05:
            blush_c = (255, 120, 140, int(120 * blush))
            c.ell(ex + (f * 8 if side else (-10 if i == 0 else 10)), ey + 30, 16, 9, blush_c)
    # nariz
    nx = cx + (f * (rx * 0.82) if side else yaw * 1.1)
    if side:
        c.ell(nx, cy + 28, 8, 6, _shade(skin, 0.9), ink, 2)
    else:
        c.curve([(nx - 3, cy + 28), (nx + 3, cy + 31)], 4, _shade(skin, 0.7))
    # boca
    mx = cx + (f * rx * 0.50 if side else yaw * 1.0)
    mw = 24 if not side else 20
    vis, op = pose.viseme, pose.open
    if pose.expr == "surprised" and vis == "rest":
        vis, op = "O", 0.55
    _draw_mouth(c, mx, cy + 56, vis, op, smile, mw, ink)
    # franja e cabelo superior (cúpula elíptica + franja recortada)
    dome = [(cx + rx * 1.05 * math.cos(a), cy - 6 - ry * 1.10 * math.sin(a))
            for a in [math.pi * k / 24 for k in range(0, 25)]]
    n_sc = 6
    fringe = []
    for k in range(n_sc * 2 + 1):
        u = k / (n_sc * 2)
        x = cx - rx * 1.0 + 2 * rx * 1.0 * u
        y = cy - 46 + (22 if k % 2 else 0) * (0.6 + 0.4 * math.sin(u * 3.14))
        fringe.append((x, y))
    c.poly(dome + fringe[::-1] if False else dome + fringe, hair, ink, 4)
    if side:  # mecha atrás da orelha (não cobre o rosto)
        c.ell(cx - f * rx * 0.62, cy + 6, 20, 46, hair, ink, 3)
    else:
        c.ell(cx - rx * 0.95, cy + 24, 18, 54, hair, ink, 3)
        c.ell(cx + rx * 0.95, cy + 24, 18, 54, hair, ink, 3)
    if "headband" in sheet.accessories:
        c.cap((cx - rx * 0.97, cy - 58), (cx + rx * 0.97, cy - 58), 15, pal["accent"], ink, 3)
        c.ell(cx + rx * 0.62, cy - 58, 9, 9, (255, 255, 255, 255), ink, 2)
    return c.im


def render_pose(sheet: CharacterSheet, pose: Pose, size=(W, H)) -> Image.Image:
    pal = {k: _rgb(v) for k, v in sheet.palette.items()}
    pr = sheet.proportions
    ink = pal["outline"]
    c = _Canvas()
    cx = W / 2
    side = pose.view == "side"
    f = pose.facing if side else 1
    th, sh = pr["thigh"], pr["shin"]
    tw = pr["limb_w"]

    # pernas ---------------------------------------------------------
    p = pose.phase * 2 * math.pi
    amp = 30 * pose.walk
    legs = []
    for i, off in enumerate((0.0, math.pi)):
        a = amp * math.sin(p + off)
        knee = 38 * pose.walk * max(0.0, math.sin(p + off - math.pi / 2 * -1)) if True else 0
        knee = 42 * pose.walk * max(0.0, -math.cos(p + off + 0.2))
        legs.append((a, knee))
    spread = 0.0 if side else 1.0

    def leg_pts(a, k, hip, lateral=0.0):
        ar, kr = math.radians(a), math.radians(a - k)
        kn = (hip[0] + math.sin(ar) * th * f + lateral, hip[1] + math.cos(ar) * th)
        ft = (kn[0] + math.sin(kr) * sh * f, kn[1] + math.cos(kr) * sh)
        return kn, ft

    ext = [math.cos(math.radians(a)) * th + math.cos(math.radians(a - k)) * sh for a, k in legs]
    foot_drop = 14
    hip_y = GROUND - foot_drop - (max(ext) if pose.walk > 0 else th + sh) + pose.breathe * 2
    hip = (cx, hip_y)
    sy = hip_y - pr["torso_h"]
    lean = 8 * pose.walk * f if side else 0
    shoulder = (cx + lean, sy)

    def arm(sh_pt, ang, bend, col_a, lat=0.0):
        ar = math.radians(ang)
        el = (sh_pt[0] + math.sin(ar) * pr["arm_up"] * (f if side else 1) + lat, sh_pt[1] + math.cos(ar) * pr["arm_up"])
        br = math.radians(ang + bend)
        hd = (el[0] + math.sin(br) * pr["arm_low"] * (f if side else 1), el[1] + math.cos(br) * pr["arm_low"])
        return el, hd

    if pose.arms is not None:
        (aL, bL), (aR, bR) = pose.arms
    else:
        swing = 34 * pose.walk
        aL, aR = -swing * math.sin(p), swing * math.sin(p)
        bL, bR = 16 + 10 * pose.walk, 16 + 10 * pose.walk
        if not side:
            aL, aR = abs(aL) * -0.1 - 8, abs(aR) * 0.1 + 8
    jacket, jdark = pal["jacket"], _shade(pal["jacket"], 0.78)
    pants, boots = pal["pants"], pal["boots"]
    skin = pal["skin"]

    def draw_leg(a, k, lat, col):
        kn, ft = leg_pts(a, k, (hip[0] + lat, hip[1]))
        c.cap((hip[0] + lat, hip[1]), kn, tw, col, ink, 4)
        c.cap(kn, ft, tw - 2, col, ink, 4)
        fw = 30
        toe = (ft[0] + f * fw * (1 if side else 0.3), ft[1] + 6)
        c.ell((ft[0] + toe[0]) / 2, ft[1] + 6, 25 if side else 20, 14, boots, ink, 4)

    def draw_arm(sh_pt, ang, bend, col, lat=0.0):
        el, hd = arm(sh_pt, ang, bend, col, lat)
        c.cap(sh_pt, el, tw - 2, col, ink, 4)
        c.cap(el, hd, tw - 4, col, ink, 4)
        c.ell(hd[0], hd[1] + 4, 15, 15, skin, ink, 4)

    # ordem de desenho
    back_leg_i = 0 if f * math.sin(p) < 0 else 1
    if side:
        draw_arm((shoulder[0] - f * 4, shoulder[1] + 10), aL, bL, _shade(jacket, 0.7))
        draw_leg(*legs[1], 0, _shade(pants, 0.75))
    else:
        draw_leg(legs[0][0] * 0.2, 0, -26, pants)
        draw_leg(legs[1][0] * 0.2, 0, 26, pants)
    # torso
    c.cap(hip, shoulder, pr["torso_w"], jacket, ink, 5)
    c.cap((hip[0] - pr["torso_w"] * .45, hip_y - 18), (hip[0] + pr["torso_w"] * .45, hip_y - 18), 10, pal["accent"], ink, 2)
    if side:
        draw_leg(*legs[0], 0, pants)
    # cachecol e bolsa
    if "scarf" in sheet.accessories:
        c.cap((shoulder[0] - 34, shoulder[1] + 4), (shoulder[0] + 34, shoulder[1] + 4), 24, pal["accent"], ink, 4)
        if side:
            c.cap((shoulder[0] - f * 20, shoulder[1] + 6), (shoulder[0] - f * 52, shoulder[1] + 56 + pose.sway * 6), 18, pal["accent"], ink, 3)
    if "satchel" in sheet.accessories:
        if side:
            c.cap((shoulder[0] + f * 30, shoulder[1] - 4), (hip[0] - f * 30, hip_y + 4), 8, boots, ink, 2)
            c.poly([(hip[0] - f * 48, hip_y - 12), (hip[0] - f * 8, hip_y - 12), (hip[0] - f * 8, hip_y + 38), (hip[0] - f * 48, hip_y + 38)], boots, ink, 3)
        else:
            c.cap((shoulder[0] - 38, shoulder[1] - 2), (hip[0] + 40, hip_y - 8), 8, boots, ink, 2)
            c.poly([(hip[0] + 24, hip_y - 20), (hip[0] + 70, hip_y - 20), (hip[0] + 70, hip_y + 30), (hip[0] + 24, hip_y + 30)], boots, ink, 3)
    # braço da frente
    if side:
        draw_arm((shoulder[0] + f * 2, shoulder[1] + 10), aR, bR, jacket)
    else:
        draw_arm((shoulder[0] - 50, shoulder[1] + 14), aL, bL, jacket, 0)
        draw_arm((shoulder[0] + 50, shoulder[1] + 14), -aR if pose.arms is None else aR, bR, jacket, 0)
    body = c.im

    # cabeça (camada própria, gira em torno do pescoço) ---------------------
    head = _render_head(sheet, pose, pal)
    hs = head.size
    pivot = (hs[0] / 2, hs[1] / 2 + pr["head_ry"] * SS * 0.8)
    rot = head.rotate(-pose.head_tilt * (f if side else 1), resample=Image.BICUBIC, center=pivot)
    neck = (shoulder[0] + (6 * f if side else 0), sy - 10)
    hx = (neck[0]) * SS - hs[0] / 2
    hy = (neck[1] - pr["head_ry"] * 0.8 - 6 + pose.head_nod + pose.breathe) * SS - hs[1] / 2 - pr["head_ry"] * 0.0
    # pescoço
    c2 = ImageDraw.Draw(body)
    body.alpha_composite(rot, (int(hx), int(hy + pr["head_ry"] * 0.0 * SS)))
    img = body.resize(size, Image.LANCZOS) if size != body.size else body
    if side and f == -1:
        pass  # já espelhado via f
    return img


# ---------------------------------------------------------- biblioteca de movimentos
def _blink(t: float) -> float:
    """Piscadas a cada ~3.2 s, 0.14 s de duração."""
    ph = (t % 3.2)
    return max(0.0, 1 - abs(ph - 0.07) / 0.07) if ph < 0.14 else 0.0


def motion_idle(t: float, expr="neutral", view="side", facing=1, **kw) -> Pose:
    return Pose(view=view, facing=facing, expr=expr, blink=_blink(t + kw.get("seed", 0)),
                breathe=math.sin(t * 2.0), head_tilt=1.5 * math.sin(t * 0.9),
                sway=0.3 * math.sin(t * 1.3))


def motion_walk(t: float, facing=1, expr="happy", cycle_s=1.0, **kw) -> Pose:
    ph = (t / cycle_s) % 1.0
    return Pose(view="side", facing=facing, phase=ph, walk=1.0, expr=expr, blink=_blink(t),
                head_nod=-2.5 * abs(math.sin(ph * 2 * math.pi * 1.0)), head_tilt=2 * math.sin(ph * 2 * math.pi),
                sway=math.sin(ph * 2 * math.pi - 0.8))


def motion_talk(t: float, expr="neutral", view="front", viseme="rest", op=0.0, gesture=0.0, **kw) -> Pose:
    arms = None
    if gesture > 0:
        g = gesture
        arms = ((-6 - 4 * g, 30), (14 + 80 * g, 60 + 40 * g * math.sin(t * 5)))
    return Pose(view=view, expr=expr, viseme=viseme, open=op, blink=_blink(t),
                head_tilt=3 * math.sin(t * 1.7) + 2.5 * op, head_nod=-3 * op, yaw=0.35 * math.sin(t * 0.8),
                breathe=math.sin(t * 2.2), arms=arms, sway=0.4 * math.sin(t * 1.9))


def motion_celebrate(t: float, expr="happy", **kw) -> Pose:
    bob = abs(math.sin(t * 6))
    return Pose(view="front", expr=expr, blink=_blink(t), head_tilt=-6 + 4 * math.sin(t * 6),
                head_nod=-6 * bob, arms=((-150 + 14 * math.sin(t * 8), 10), (150 - 14 * math.sin(t * 8 + 1), 10)),
                breathe=2 * bob, sway=math.sin(t * 6), yaw=0.2 * math.sin(t * 2))


MOTIONS = {"idle": motion_idle, "walk": motion_walk, "talk": motion_talk, "celebrate": motion_celebrate}


# ---------------------------------------------------------------- viseme / lip sync
_VOWEL = {"a": "AI", "á": "AI", "à": "AI", "â": "AI", "ã": "AI", "e": "E", "é": "E", "ê": "E", "i": "E", "í": "E",
          "o": "O", "ó": "O", "ô": "O", "õ": "O", "u": "U", "ú": "U", "m": "MBP", "b": "MBP", "p": "MBP",
          "f": "E", "v": "E"}


def text_visemes(text: str) -> list[str]:
    seq = []
    for ch in text.lower():
        if ch in _VOWEL:
            seq.append(_VOWEL[ch])
        elif ch.isalpha():
            if not seq or seq[-1] != "E":
                seq.append("E")
    return seq or ["rest"]


def lipsync_track(text: str, env: np.ndarray, fps: int, hop_s: float) -> list[tuple[str, float]]:
    """Visemas por quadro a partir do TEXTO + envelope de energia REAL da voz.
    env: energia RMS por janela de hop_s segundos. Retorna [(viseme, abertura)] por quadro."""
    n_frames = int(math.ceil(len(env) * hop_s * fps))
    e = env / (env.max() + 1e-9)
    fe = np.array([e[int(fr / fps / hop_s): max(int(fr / fps / hop_s) + 1, int((fr + 1) / fps / hop_s))].max()
                   for fr in range(n_frames)])
    voiced = fe > 0.14
    seq = text_visemes(text)
    n_voiced = max(1, int(voiced.sum()))
    out, k = [], 0
    for fr in range(n_frames):
        if voiced[fr]:
            vis = seq[min(len(seq) - 1, int(k / n_voiced * len(seq)))]
            k += 1
            out.append((vis, float(min(1.0, 0.3 + fe[fr] * 0.9))))
        else:
            out.append(("rest", 0.0))
    return out


# ------------------------------------------------------------- model sheet / consistência
def render_model_sheet(sheet: CharacterSheet, out: Path) -> Path:
    cells = [Pose(view="front", expr="neutral"), Pose(view="side", expr="neutral"), Pose(view="back", expr="neutral")]
    imgs = [render_pose(sheet, p, (W // 2 * 1, H // 2 * 1)).resize((W * 2 // 3, H * 2 // 3), Image.LANCZOS) for p in cells]
    exprs = ["neutral", "happy", "surprised", "worried", "determined", "sad"]
    heads = []
    for e in exprs:
        im = render_pose(sheet, Pose(view="front", expr=e), (W, H))
        heads.append(im.crop((60, 40, 360, 290)).resize((150, 125), Image.LANCZOS))
    walk = [render_pose(sheet, motion_walk(i / 8), (W, H)).resize((W // 2, H // 2), Image.LANCZOS) for i in range(8)]
    sw, sh = 1400, 1010
    bg = Image.new("RGBA", (sw, sh), (214, 222, 236, 255))
    d = ImageDraw.Draw(bg)
    ink = (40, 30, 70)
    d.text((24, 16), f"MODEL SHEET - {sheet.name}   id={sheet.id}   assinatura={sheet.signature()}", fill=ink, font=_font(24))
    for i, im in enumerate(imgs):
        bg.alpha_composite(im, (24 + i * 290, 56))
    d.text((24, 484), "frente / lado / costas", fill=ink, font=_font(16))
    for i, im in enumerate(heads):
        x, y = 900 + (i % 3) * 165, 70 + (i // 3) * 190
        bg.alpha_composite(im, (x, y))
        d.text((x, y + 128), exprs[i], fill=ink, font=_font(16))
    for i, im in enumerate(walk):
        bg.alpha_composite(im, (24 + i * 170, 520))
    d.text((24, 506), "ciclo de caminhada (8 poses)", fill=ink, font=_font(16))
    for i, v in enumerate(VISEMES):
        im = render_pose(sheet, Pose(view="front", viseme=v, open=0.8, expr="neutral"), (W, H)).crop((120, 130, 300, 260))
        bg.alpha_composite(im.resize((160, 114)), (24 + i * 170, 850))
        d.text((24 + i * 170, 970), f"visema {v}", fill=ink, font=_font(16))
    out.parent.mkdir(parents=True, exist_ok=True)
    bg.convert("RGB").save(out)
    return out


def palette_signature(img: Image.Image, bins: int = 6) -> np.ndarray:
    """Histograma de cor quantizado dos pixels opacos (independe da pose)."""
    a = np.asarray(img.convert("RGBA"))
    m = a[..., 3] > 200
    px = a[..., :3][m] // (256 // bins)
    idx = px[:, 0].astype(int) * bins * bins + px[:, 1].astype(int) * bins + px[:, 2].astype(int)
    h = np.bincount(idx, minlength=bins ** 3).astype(np.float64)
    return h / max(h.sum(), 1.0)


def palette_distance(h1: np.ndarray, h2: np.ndarray) -> float:
    """1 - interseção de histogramas (0 = idêntico)."""
    return float(1.0 - np.minimum(h1, h2).sum())


def reference_signature(sheet: CharacterSheet) -> np.ndarray:
    hs = [palette_signature(render_pose(sheet, p, (W // 2, H // 2)))
          for p in (Pose(view="front"), motion_walk(0.1), motion_walk(0.35))]
    return np.mean(hs, axis=0)
