"""Blender Adapter — API Python real (`bpy`).

Prioriza o binário `blender` (blender -b -P script). Se não houver binário,
usa um interpretador Python que consiga `import bpy` (módulo bpy).
O script executado dentro do Blender é `nubi_hybrid/scripts/blender_runner.py`.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

from .base import Adapter, AdapterError, Detection, RunResult, which_any

RUNNER = Path(__file__).resolve().parent.parent / "scripts" / "blender_runner.py"
MIN_VERSION = (3, 6)


def _py_with_bpy() -> tuple[str, str]:
    cands = [os.environ.get("NUBI_BPY_PYTHON", ""), sys.executable,
             str(Path(__file__).resolve().parents[2] / ".venv" / "bin" / "python")]
    for py in cands:
        if not py or not Path(py).exists():
            continue
        try:
            out = subprocess.run([py, "-I", "-c", "import bpy;print(bpy.app.version_string)"],
                                 capture_output=True, text=True, timeout=120)
        except Exception:
            continue
        if out.returncode == 0 and out.stdout.strip():
            return py, out.stdout.strip().splitlines()[-1]
    return "", ""


class BlenderAdapter(Adapter):
    name = "blender"
    capabilities = ["build_scene", "render_shot", "camera_keyframes", "image_sequence_billboard",
                    "cycles_render", "reusable_environment"]

    def _detect(self) -> Detection:
        exe = os.environ.get("NUBI_BLENDER") or which_any(
            ["blender"], [r"C:\Program Files\Blender Foundation\Blender *\blender.exe",
                          "/Applications/Blender.app/Contents/MacOS/Blender"])
        if exe:
            r = self.run([exe, "--version"], timeout=60)
            m = re.search(r"Blender (\d+)\.(\d+)", r.stdout)
            ver = f"{m.group(1)}.{m.group(2)}" if m else "?"
            ok = bool(m) and (int(m.group(1)), int(m.group(2))) >= MIN_VERSION
            self.mode = "binary"
            return Detection(self.name, True, ver, exe, ok, self.capabilities,
                             "" if ok else f"requer >= {MIN_VERSION}")
        py, ver = _py_with_bpy()
        if py:
            m = re.match(r"(\d+)\.(\d+)", ver)
            ok = bool(m) and (int(m.group(1)), int(m.group(2))) >= MIN_VERSION
            self.mode = "module"
            return Detection(self.name, True, ver, py, ok, self.capabilities, "módulo Python bpy")
        return Detection(self.name, False, notes="nem `blender` no PATH nem módulo bpy disponível")

    def run_job(self, job: dict, job_file: Path, timeout: float = 7200,
                mem_limit_mb: int | None = None) -> RunResult:
        d = self.require()
        job_file.parent.mkdir(parents=True, exist_ok=True)
        job_file.write_text(json.dumps(job, indent=1), encoding="utf-8")
        if self.mode == "binary":
            cmd = [d.path, "-b", "-noaudio", "-P", RUNNER, "--", job_file]
        else:
            cmd = [d.path, "-I", RUNNER, job_file]
        res = self.run(cmd, timeout=timeout, mem_limit_mb=mem_limit_mb)
        if not res.ok or "NUBI_JOB_DONE" not in res.stdout:
            raise AdapterError(f"Blender falhou no job {job.get('job')}: {res.stderr[-600:] or res.stdout[-600:]}", res)
        return res
