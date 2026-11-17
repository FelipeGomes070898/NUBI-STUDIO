"""Orquestra o fluxo: roteiro -> plano -> áudio/diálogo -> personagem -> storyboard/animatic
-> (aprovação) -> render 3D -> VFX -> áudio -> QC -> composição -> exportação."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import adapters as A
from .engines import audio, camera as cam_engine, hybrid, storyboard
from .engines.character import CharacterSheet, render_model_sheet, reference_signature
from .engines.director import Director
from .engines.render import RenderQueue
from .log import get_logger
from .project import MODES, Project


class ApprovalRequired(RuntimeError):
    pass


class Pipeline:
    def __init__(self, root: str | Path, mode: str = "economy"):
        self.project = Project(root)
        self.project.manifest.render = MODES[mode]
        self.log = get_logger("pipeline", self.project.p("logs", "nubi.log"))
        self.dets = A.detect_all(self.project.p("logs", "adapters.log"))
        self.project.manifest.software = {k: {"installed": v.installed, "version": v.version,
                                              "capabilities": v.capabilities, "notes": v.notes}
                                         for k, v in self.dets.items()}
        self.ffmpeg = A.FFmpegAdapter(self.project.p("logs", "adapters.log"))
        self.blender = A.BlenderAdapter(self.project.p("logs", "adapters.log"))
        self.sheet = CharacterSheet()
        self.plan: dict = {}
        self.lines: dict[str, list] = {}
        self.metrics: dict = {}
        self.queue = RenderQueue(self.project, {"blender_shot": self._h_blender})
        self.project.save()

    # ------------------------------------------------------------ 1. plano
    def make_plan(self, script_text: str) -> dict:
        self.plan = Director(self.dets).parse(script_text)
        hybrid.blocking(self.plan)
        for s in self.plan["shots"]:
            if "explosao_de_luz" in s["vfx"]:
                s["burst_s"] = round(0.3 * s["duration_s"], 3)
        self.project.log_event("director", f"{len(self.plan['shots'])} tomadas, {self.plan['duration_s']}s")
        return self.plan

    # ------------------------------------------------------------ 2. diálogo
    def synth_dialogue(self) -> None:
        for s in self.plan["shots"]:
            t, lines = 0.55, []
            for i, dl in enumerate(s["dialogue"]):
                ch = self.plan["characters"][dl["speaker"]]
                wav = self.project.p("intermediate", "audio", f"{s['id']}_{i}_{dl['speaker'].lower()}.wav")
                y = audio.tts(dl["text"], wav, pitch=ch["pitch"], speed=150 if ch["kind"] == "2d" else 160,
                              effect="ethereal" if ch["kind"] == "orb" else None)
                y = audio.trim_silence(y)
                audio.write_wav(wav, y)
                lines.append({**dl, "start_s": round(t, 3), "dur_s": round(len(y) / audio.SR, 3),
                              "wav": str(wav), "env": audio.envelope(y), "samples": y})
                t += len(y) / audio.SR + 0.45
            if lines and lines[-1]["start_s"] + lines[-1]["dur_s"] > s["duration_s"] - 0.2:
                self.log.warning("%s: fala excede a duração da tomada", s["id"])
            s["audio_lines"] = lines
            self.lines[s["id"]] = lines

    # ------------------------------------------------------------ 3. personagem + câmera + storyboard
    def prepare_characters(self) -> None:
        sheet_png = render_model_sheet(self.sheet, self.project.p("characters", f"{self.sheet.id}_model_sheet.png"))
        self.metrics = hybrid.char_metrics(self.sheet)
        self.project.manifest.characters = [{
            "id": self.sheet.id, "name": self.sheet.name, "signature": self.sheet.signature(),
            "model_sheet": self.project.rel(sheet_png), "sheet": {"palette": self.sheet.palette,
                                                                  "proportions": self.sheet.proportions,
                                                                  "accessories": self.sheet.accessories}}]
        for s in self.plan["shots"]:
            path = s["characters"][0]["path"] if s["characters"] else None
            s["camera_keys"] = cam_engine.plan_camera(
                s["camera"]["shot_type"], s["camera"]["movement"], path, s["frames"])["keyframes"]
            s["orb_track"] = hybrid.orb_keys(s, path[0] if path else (0, 0, 0), self.plan["fps"]) or []
        self.project.save()

    def render_char_frames(self) -> None:
        fps = self.plan["fps"]
        for s in self.plan["shots"]:
            if not s["characters"]:
                continue
            speech = hybrid.speech_tracks(s, fps)
            d = self.project.p("intermediate", "images", f"{s['id']}_char", "x").parent
            hybrid.render_char_frames(self.sheet, s, s["characters"][0], fps, d, speech)
            s["characters"][0]["frames_dir"] = str(d)
            s["speech"] = [(sp["viseme"], round(sp["open"], 3), sp["speaker"]) if sp else None for sp in speech]

    def build_storyboard(self) -> dict:
        orbs = {s["id"]: [k["pos"] for k in s["orb_track"]] for s in self.plan["shots"] if s["orb_track"]}
        sb = storyboard.build(self.project, self.plan, self.sheet, orbs)
        # animatic com a trilha de diálogo (rascunho de áudio)
        n = int(self.plan["duration_s"] * audio.SR)
        scratch = np.zeros(n, np.float32)
        for s in self.plan["shots"]:
            for ln in s["audio_lines"]:
                audio.place(scratch, ln["samples"], s["start_frame"] / self.plan["fps"] + ln["start_s"])
        wav = self.project.p("storyboard", "animatic_scratch.wav")
        audio.write_wav(wav, scratch * 0.9)
        out = self.ffmpeg.animatic(sb["images"], sb["durations"], self.project.p("storyboard", "animatic.mp4"),
                                   self.plan["fps"], audio=wav)
        self.project.manifest.files["storyboard_contact_sheet"] = self.project.rel(sb["contact_sheet"])
        self.project.manifest.files["animatic"] = self.project.rel(out)
        self.project.save()
        return sb

    def approve(self, what: str = "animatic") -> None:
        self.project.manifest.approvals[what] = True
        self.project.log_event("approval", what)

    # ------------------------------------------------------------ 4. render 3D
    def _h_blender(self, spec: dict, job: dict) -> None:
        self.blender.run_job(spec, self.project.p("intermediate", "jobs", f"{job['id']}.json"))

    def queue_renders(self) -> None:
        if not self.project.manifest.approvals.get("animatic"):
            raise ApprovalRequired("Animatic não aprovado: renderização final bloqueada (use approve('animatic')).")
        st = self.project.manifest.render
        for s in self.plan["shots"]:
            ch = s["characters"][0] if s["characters"] else None
            job = hybrid.build_job(self.project, self.plan, s, self.sheet, st, self.metrics,
                                   ch["path"] if ch else None, Path(ch["frames_dir"]) if ch else None)
            job["camera"] = {"keyframes": s["camera_keys"], "interp": "BEZIER"}
            odir = Path(job["output_dir"])
            expect = [str(odir / f"plate_{i:04d}.png") for i in range(1, s["frames"] + 1)]
            self.queue.add(f"blender_{s['id']}", "blender_shot", job, expect, order=s["index"])
