"""Logging central: console + arquivo por projeto."""
import logging
import sys
from pathlib import Path

_FMT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def get_logger(name: str, logfile: Path | None = None) -> logging.Logger:
    log = logging.getLogger(f"nubi.{name}")
    if not log.handlers:
        log.setLevel(logging.DEBUG)
        h = logging.StreamHandler(sys.stderr)
        h.setLevel(logging.INFO)
        h.setFormatter(logging.Formatter(_FMT))
        log.addHandler(h)
    if logfile is not None:
        logfile.parent.mkdir(parents=True, exist_ok=True)
        if not any(getattr(x, "_nubi_file", None) == str(logfile) for x in log.handlers):
            fh = logging.FileHandler(logfile, encoding="utf-8")
            fh._nubi_file = str(logfile)  # type: ignore[attr-defined]
            fh.setLevel(logging.DEBUG)
            fh.setFormatter(logging.Formatter(_FMT))
            log.addHandler(fh)
    return log
