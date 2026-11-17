"""Contrato comum dos adaptadores de software externo.

Cada adaptador: detecta instalação/versão, checa compatibilidade, executa,
monitora (timeout), captura erros e registra logs. Nunca simula execução:
se o software não existe, `detect().installed` é False e `run` levanta
AdapterUnavailable.
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..log import get_logger


class AdapterUnavailable(RuntimeError):
    pass


class AdapterError(RuntimeError):
    def __init__(self, msg: str, result: "RunResult | None" = None):
        super().__init__(msg)
        self.result = result


@dataclass
class Detection:
    name: str
    installed: bool
    version: str = ""
    path: str = ""
    compatible: bool = False
    capabilities: list = field(default_factory=list)   # o que o adaptador realmente implementa
    notes: str = ""


@dataclass
class RunResult:
    cmd: list
    returncode: int
    stdout: str
    stderr: str
    seconds: float

    @property
    def ok(self) -> bool:
        return self.returncode == 0


class Adapter:
    name = "base"
    capabilities: list = []

    def __init__(self, logfile: Path | None = None):
        self.log = get_logger(f"adapter.{self.name}", logfile)
        self._det: Detection | None = None

    # -- detecção -----------------------------------------------------
    def _detect(self) -> Detection:  # pragma: no cover - sobrescrito
        raise NotImplementedError

    def detect(self, refresh: bool = False) -> Detection:
        if self._det is None or refresh:
            self._det = self._detect()
            self.log.info("detect %s -> installed=%s version=%s",
                          self.name, self._det.installed, self._det.version)
        return self._det

    def require(self) -> Detection:
        d = self.detect()
        if not d.installed:
            raise AdapterUnavailable(f"{self.name} não está instalado neste computador")
        if not d.compatible:
            raise AdapterUnavailable(f"{self.name} {d.version} incompatível: {d.notes}")
        return d

    # -- execução -----------------------------------------------------
    def run(self, cmd: list, timeout: float = 3600, cwd: Path | None = None,
            env: dict | None = None, mem_limit_mb: int | None = None) -> RunResult:
        self.log.info("run: %s", " ".join(str(c) for c in cmd))
        preexec = None
        if mem_limit_mb and os.name == "posix":
            import resource

            def preexec():  # limite de memória virtual do processo filho
                lim = mem_limit_mb * 1024 * 1024
                resource.setrlimit(resource.RLIMIT_AS, (lim, lim))
        t0 = time.time()
        try:
            cp = subprocess.run([str(c) for c in cmd], capture_output=True, text=True,
                                timeout=timeout, cwd=cwd, env=env, preexec_fn=preexec)
        except subprocess.TimeoutExpired as e:
            self.log.error("timeout após %.0fs: %s", timeout, cmd[0])
            raise AdapterError(f"timeout ({timeout}s)") from e
        res = RunResult([str(c) for c in cmd], cp.returncode, cp.stdout, cp.stderr, time.time() - t0)
        if not res.ok:
            self.log.error("falha rc=%s stderr=%s", res.returncode, res.stderr[-800:])
        else:
            self.log.debug("ok em %.1fs", res.seconds)
        return res


def which_any(names: list[str], globs: list[str] | None = None) -> str:
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    for pattern in globs or []:
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[-1]
    return ""
