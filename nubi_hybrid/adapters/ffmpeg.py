"""FFmpeg Adapter — operações reais por linha de comando."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .base import Adapter, AdapterError, Detection, which_any


class FFmpegAdapter(Adapter):
    name = "ffmpeg"
    capabilities = ["encode_sequence", "mux", "probe", "export_aspect", "concat", "animatic"]

    def _detect(self) -> Detection:
        exe = which_any(["ffmpeg"])
        if not exe:
            return Detection(self.name, False, notes="ffmpeg não encontrado no PATH")
        r = self.run([exe, "-version"], timeout=20)
        m = re.search(r"ffmpeg version (\S+)", r.stdout)
        ver = m.group(1) if m else "?"
        enc = self.run([exe, "-hide_banner", "-encoders"], timeout=20).stdout
        ok = "libx264" in enc and "aac" in enc
        return Detection(self.name, True, ver, exe, ok, self.capabilities,
                         "" if ok else "faltam encoders libx264/aac")

    def _exe(self) -> str:
        return self.require().path

    def _check(self, r, what):
        if not r.ok:
            raise AdapterError(f"ffmpeg falhou em {what}: {r.stderr[-400:]}", r)
        return r

    def probe(self, path: Path) -> dict:
        exe = self._exe().replace("ffmpeg", "ffprobe")
        r = self.run([exe, "-v", "error", "-show_format", "-show_streams", "-of", "json", path], timeout=60)
        self._check(r, "probe")
        return json.loads(r.stdout)

    def encode_sequence(self, frames_pattern: str, fps: int, out: Path, audio: Path | None = None,
                        crf: int = 17, preset: str = "medium") -> Path:
        cmd = [self._exe(), "-y", "-hide_banner", "-framerate", fps, "-i", frames_pattern]
        if audio:
            cmd += ["-i", audio, "-c:a", "aac", "-b:a", "192k", "-shortest"]
        cmd += ["-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", out]
        self._check(self.run(cmd, timeout=3600), "encode_sequence")
        return Path(out)

    def raw_pipe_cmd(self, width: int, height: int, fps: int, out: Path, audio: Path | None,
                     crf: int = 17, preset: str = "medium") -> list:
        """Comando para receber frames RGB crus via stdin (composição em streaming)."""
        cmd = [self._exe(), "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo",
               "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-r", fps, "-i", "-"]
        if audio:
            cmd += ["-i", audio, "-c:a", "aac", "-b:a", "192k"]
        cmd += ["-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", "-shortest", out]
        return [str(c) for c in cmd]

    def export_aspect(self, src: Path, out: Path, width: int, height: int) -> Path:
        """Reenquadra (crop central) para outra proporção/resolução."""
        vf = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"
        self._check(self.run([self._exe(), "-y", "-hide_banner", "-i", src, "-vf", vf,
                              "-c:v", "libx264", "-crf", 18, "-pix_fmt", "yuv420p",
                              "-c:a", "copy", out], timeout=1800), "export_aspect")
        return Path(out)

    def animatic(self, images: list[Path], durations: list[float], out: Path,
                 fps: int = 24, size: tuple[int, int] = (960, 540), audio: Path | None = None) -> Path:
        """Monta um animatic a partir dos quadros de storyboard."""
        listfile = out.with_suffix(".txt")
        lines = []
        for img, d in zip(images, durations):
            lines += [f"file '{Path(img).resolve()}'", f"duration {d:.4f}"]
        lines.append(f"file '{Path(images[-1]).resolve()}'")
        listfile.write_text("\n".join(lines), encoding="utf-8")
        cmd = [self._exe(), "-y", "-hide_banner", "-f", "concat", "-safe", 0, "-i", listfile]
        if audio:
            cmd += ["-i", audio, "-c:a", "aac", "-shortest"]
        cmd += ["-vf", f"scale={size[0]}:{size[1]},fps={fps}", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]
        self._check(self.run(cmd, timeout=600), "animatic")
        return Path(out)
