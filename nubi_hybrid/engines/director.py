"""AI FILM DIRECTOR — interpreta o roteiro e produz um plano de produção EXECUTÁVEL.

Sem dependência de IA paga: análise determinística por regras (formato de roteiro +
palavras-chave em português). A camada de IA fica isolada aqui; os demais motores só
consomem o JSON do plano (`plan.json`), então um LLM pode substituir `Director.parse`
sem tocar nos adaptadores.

Formato do roteiro:
    TITULO: ...
    PERSONAGEM: Mira (2d, id=char_mira_v1)      PERSONAGEM: Lumi (orbe)
    AMBIENTE: floresta_cogumelos
    CENA 2 — Título da cena [5s]
    Texto de ação...
    MIRA: (surpresa) Fala...
    [camera: close, dolly_in] [vfx: explosao_de_luz] [modo: hibrido]
"""
from __future__ import annotations

import re
import unicodedata

FPS = 24
EMOTION = {"surpresa": "surprised", "surpresa.": "surprised", "feliz": "happy", "alegre": "happy",
           "calma": "neutral", "neutra": "neutral", "preocupada": "worried", "preocupado": "worried",
           "determinada": "determined", "determinado": "determined", "triste": "sad", "animada": "happy"}
ENVIRONMENTS = {"floresta_cogumelos": "mushroom_forest"}
MODES = {"2d": "2d", "3d": "3d", "hibrido": "hybrid_2d_3d", "híbrido": "hybrid_2d_3d",
         "cinematico": "cinematic_vfx", "cinematográfico": "cinematic_vfx"}
SHOT_TYPES = {"wide", "medium_wide", "medium", "close", "extreme_close"}
MOVES = {"static", "dolly_in", "dolly_out", "travelling", "pan", "tilt_up", "dolly_out_tilt", "zoom_in"}


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def infer_action(text: str, has_dialogue: bool) -> str:
    t = _norm(text)
    if re.search(r"\b(caminha|anda|segue|entra|avanca)\b", t):
        return "walk"
    if re.search(r"levanta os bracos|comemora|celebra|salta|pula de alegria", t):
        return "celebrate"
    if has_dialogue:
        return "talk"
    return "idle"


class Director:
    def __init__(self, detections: dict | None = None):
        self.det = detections or {}

    def _avail(self, name: str) -> bool:
        d = self.det.get(name)
        return bool(d and d.installed and d.compatible and d.capabilities)

    def parse(self, text: str) -> dict:
        plan = {"title": "", "fps": FPS, "characters": {}, "environment": "mushroom_forest", "shots": []}
        cur = None
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"TITULO:\s*(.+)", line, re.I)
            if m:
                plan["title"] = m.group(1).strip()
                continue
            m = re.match(r"PERSONAGEM:\s*(\w+)\s*\(([^)]*)\)", line, re.I)
            if m:
                name, opts = m.group(1), [o.strip() for o in m.group(2).split(",")]
                kind = "orb" if any(o.startswith("orb") for o in opts) else "2d"
                cid = next((o.split("=")[1] for o in opts if o.startswith("id=")), f"char_{_norm(name)}_v1")
                pitch = next((int(o.split("=")[1]) for o in opts if o.startswith("pitch=")), 62 if kind == "2d" else 92)
                plan["characters"][name.upper()] = {"name": name, "id": cid, "kind": kind, "pitch": pitch}
                continue
            m = re.match(r"AMBIENTE:\s*(\w+)", line, re.I)
            if m:
                plan["environment"] = ENVIRONMENTS.get(m.group(1), m.group(1))
                continue
            m = re.match(r"CENA\s+(\d+)\s*[—\-–]\s*(.*?)\s*\[(\d+(?:\.\d+)?)s\]", line, re.I)
            if m:
                cur = {"id": f"shot_{int(m.group(1)):02d}", "index": int(m.group(1)), "title": m.group(2),
                       "duration_s": float(m.group(3)), "duration_locked": True, "action_text": [],
                       "dialogue": [], "directives": {}}
                plan["shots"].append(cur)
                continue
            if cur is None:
                continue
            m = re.match(r"([A-ZÀ-Ú]{2,}):\s*(?:\(([^)]*)\))?\s*(.+)", line)
            if m and m.group(1) in plan["characters"]:
                emo = EMOTION.get((m.group(2) or "calma").lower().strip(), "neutral")
                cur["dialogue"].append({"speaker": m.group(1), "emotion": emo, "text": m.group(3).strip()})
                continue
            dirs = re.findall(r"\[([^\]]+)\]", line)
            if dirs and not re.sub(r"\[[^\]]+\]", "", line).strip():
                for d in dirs:
                    k, _, v = d.partition(":")
                    cur["directives"][_norm(k.strip())] = [x.strip() for x in v.split(",") if x.strip()]
                continue
            cur["action_text"].append(line)
        for s in plan["shots"]:
            self._plan_shot(plan, s)
        plan["duration_s"] = round(sum(s["duration_s"] for s in plan["shots"]), 3)
        f = 0
        for s in plan["shots"]:
            s["frames"] = int(round(s["duration_s"] * plan["fps"]))
            s["start_frame"] = f
            f += s["frames"]
        plan["total_frames"] = f
        return plan

    # ------------------------------------------------------------------
    def _plan_shot(self, plan: dict, s: dict) -> None:
        text = " ".join(s["action_text"])
        d = s["directives"]
        has_2d = any(c["kind"] == "2d" for c in plan["characters"].values()) and (
            bool(s["dialogue"]) or re.search(r"\bmira\b|personagem", _norm(text)))
        cam = d.get("camera", [])
        s["camera"] = {"shot_type": next((c for c in cam if c in SHOT_TYPES), "medium"),
                       "movement": next((c for c in cam if c in MOVES), "static")}
        s["vfx"] = [v for v in d.get("vfx", [])]
        s["title_card"] = " ".join(d.get("titulo", [])) if "titulo" in d else ""
        s["end_card"] = bool(d.get("fim"))
        s["environment"] = plan["environment"]
        action = infer_action(text, bool(s["dialogue"]))
        if not has_2d:
            s["characters"] = []
            s["mode"] = "3d"
        else:
            emo = s["dialogue"][0]["emotion"] if s["dialogue"] else ("happy" if action in ("walk", "celebrate") or s.get("end_card") else "neutral")
            s["characters"] = [{"name": "MIRA", "id": plan["characters"]["MIRA"]["id"], "action": action,
                                "expression": emo, "view": "side" if action == "walk" else "front"}]
            s["mode"] = "hybrid_2d_3d"
        if "modo" in d:
            s["mode"] = MODES.get(_norm(d["modo"][0]), s["mode"])
        if s["vfx"] and s["mode"] in ("hybrid_2d_3d", "3d"):
            s["cinematic_vfx"] = True
        s["orb"] = any(c["kind"] == "orb" for c in plan["characters"].values()) and (
            any(dl["speaker"] == "LUMI" for dl in s["dialogue"]) or "orbe" in s["vfx"]
            or "explosao_de_luz" in s["vfx"] or "orbe" in _norm(text))
        s["software"] = self._select_software(s)
        s["action_text"] = text

    def _select_software(self, s: dict) -> list[dict]:
        sw = []
        if s["characters"]:
            if self._avail("adobe_animate"):
                sw.append({"role": "2d_character", "tool": "adobe_animate"})
            else:
                sw.append({"role": "2d_character", "tool": "nubi_character_engine",
                           "why": "Adobe Animate indisponível"})
        sw.append({"role": "3d_scene_render", "tool": "blender"})
        if s["vfx"]:
            if self._avail("after_effects"):
                sw.append({"role": "vfx", "tool": "after_effects"})
            else:
                sw.append({"role": "vfx", "tool": "nubi_vfx_engine",
                           "why": "After Effects indisponível"})
        sw.append({"role": "composition_encode", "tool": "nubi_composition+ffmpeg"})
        return sw
