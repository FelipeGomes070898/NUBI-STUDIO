"""RENDER ENGINE — fila de tarefas persistente com cache, recuperação e exportações.

Estado em `intermediate/jobs/queue.json`. Tarefas 'running' encontradas ao reabrir viram
'pending' (processo interrompido); o runner do Blender pula quadros já renderizados, então a
retomada continua do ponto exato. Tarefas 'done' só são puladas se o cache_key (hash do spec)
for idêntico e as saídas existirem.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Callable

from ..log import get_logger


def _key(spec: dict) -> str:
    return hashlib.sha256(json.dumps(spec, sort_keys=True, default=str).encode()).hexdigest()[:16]


class RenderQueue:
    def __init__(self, project, handlers: dict[str, Callable]):
        self.project = project
        self.handlers = handlers
        self.path = project.p("intermediate", "jobs", "queue.json")
        self.log = get_logger("render", project.p("logs", "render.log"))
        self.jobs: dict[str, dict] = {}
        if self.path.exists():
            self.jobs = json.loads(self.path.read_text())
            for j in self.jobs.values():
                if j["status"] == "running":
                    j["status"] = "pending"
                    j["note"] = "recuperado após interrupção"
                    self.log.warning("job %s estava 'running': retomando", j["id"])
            self._save()

    def _save(self):
        self.path.write_text(json.dumps(self.jobs, indent=1, default=str))

    def add(self, job_id: str, kind: str, spec: dict, expect: list[str] | None = None, order: int = 0):
        old = self.jobs.get(job_id)
        key = _key(spec)
        if old and old["cache_key"] == key and old["status"] == "done":
            return
        self.jobs[job_id] = {"id": job_id, "kind": kind, "spec": spec, "cache_key": key, "status": "pending",
                             "expect": expect or [], "attempts": 0, "error": "", "seconds": 0.0, "order": order}
        self._save()

    def _outputs_ok(self, j) -> bool:
        return all(Path(p).exists() for p in j["expect"])

    def invalidate(self, job_id: str):
        """Revisão de tomada: força nova renderização."""
        if job_id in self.jobs:
            self.jobs[job_id]["status"] = "pending"
            self.jobs[job_id]["cache_key"] = ""
            self._save()

    def run(self, only: list[str] | None = None, retries: int = 1) -> dict:
        report = {"done": [], "cached": [], "failed": []}
        for j in sorted(self.jobs.values(), key=lambda x: x["order"]):
            if only and j["id"] not in only:
                continue
            if j["status"] == "done" and self._outputs_ok(j):
                self.log.info("cache hit: %s", j["id"])
                report["cached"].append(j["id"])
                continue
            for attempt in range(retries + 1):
                j["status"], j["attempts"] = "running", j["attempts"] + 1
                self._save()
                t0 = time.time()
                try:
                    self.log.info("job %s (%s) tentativa %d", j["id"], j["kind"], j["attempts"])
                    self.handlers[j["kind"]](j["spec"], j)
                    j["status"], j["error"] = "done", ""
                    j["seconds"] = round(time.time() - t0, 1)
                    self._save()
                    if not self._outputs_ok(j):
                        raise RuntimeError("saídas esperadas ausentes após execução")
                    report["done"].append(j["id"])
                    break
                except Exception as e:  # noqa: BLE001
                    j["status"], j["error"] = "failed", str(e)[:800]
                    self.log.error("job %s falhou: %s", j["id"], e)
                    self._save()
            if j["status"] == "failed":
                report["failed"].append(j["id"])
        return report
