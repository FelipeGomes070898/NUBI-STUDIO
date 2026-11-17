"""Projeto, diretórios padronizados e manifesto (JSON)."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

from . import __version__

STD_DIRS = [
    "storyboard", "characters", "environments", "logs",
    "intermediate/images", "intermediate/video", "intermediate/audio", "intermediate/renders",
    "intermediate/jobs", "cache", "output",
]


@dataclass
class RenderSettings:
    mode: str = "economy"          # economy | cinematic | advanced
    width: int = 960
    height: int = 540
    fps: int = 24
    samples: int = 16
    engine: str = "CYCLES"


MODES = {
    "economy":   RenderSettings("economy", 960, 540, 24, 8),
    "cinematic": RenderSettings("cinematic", 1280, 720, 24, 48),
    "advanced":  RenderSettings("advanced", 1920, 1080, 24, 128),
}


@dataclass
class Manifest:
    name: str
    version: str = __version__
    created: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%S"))
    fps: int = 24
    duration_s: float = 0.0
    render: RenderSettings = field(default_factory=RenderSettings)
    characters: list = field(default_factory=list)   # [{id, name, signature, sheet}]
    shots: list = field(default_factory=list)        # [{id, duration, mode, software, files...}]
    files: dict = field(default_factory=dict)        # papel -> caminho relativo
    approvals: dict = field(default_factory=lambda: {"animatic": False})
    software: dict = field(default_factory=dict)     # detecção dos adaptadores
    history: list = field(default_factory=list)


class Project:
    def __init__(self, root: str | Path, name: str | None = None):
        self.root = Path(root).resolve()
        self.name = name or self.root.name
        for d in STD_DIRS:
            (self.root / d).mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.root / "manifest.json"
        if self.manifest_path.exists():
            self.manifest = self._load()
        else:
            self.manifest = Manifest(name=self.name)
            self.save()

    def p(self, *parts: str) -> Path:
        path = self.root.joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def rel(self, path: Path | str) -> str:
        return str(Path(path).resolve().relative_to(self.root))

    def _load(self) -> Manifest:
        d = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        d["render"] = RenderSettings(**d.get("render", {}))
        return Manifest(**d)

    def save(self) -> None:
        self.manifest_path.write_text(
            json.dumps(asdict(self.manifest), indent=2, ensure_ascii=False), encoding="utf-8")

    def log_event(self, stage: str, detail: str) -> None:
        self.manifest.history.append({"t": time.strftime("%H:%M:%S"), "stage": stage, "detail": detail})
        self.save()
