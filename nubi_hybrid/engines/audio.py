"""AUDIO ENGINE — vozes (TTS real: espeak-ng), envelope p/ lip-sync, música, ambiência,
efeitos sincronizados e mixagem. Tudo gerado localmente, sem serviço pago."""
from __future__ import annotations

import math
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np

SR = 44100


def tts(text: str, out: Path, lang="pt-br", pitch=60, speed=150, effect: str | None = None) -> np.ndarray:
    exe = shutil.which("espeak-ng") or shutil.which("espeak")
    if not exe:
        raise RuntimeError("espeak-ng não instalado: TTS indisponível (apt install espeak-ng)")
    out.parent.mkdir(parents=True, exist_ok=True)
    cp = subprocess.run([exe, "-v", lang, "-p", str(pitch), "-s", str(speed), "-a", "190", "-w", str(out), text],
                        capture_output=True, text=True)
    if cp.returncode != 0:
        raise RuntimeError(f"espeak-ng falhou: {cp.stderr[-300:]}")
    y = read_wav(out)
    if effect == "ethereal":      # voz do orbe: chorus + eco curto
        y = y + 0.45 * np.roll(y, int(0.021 * SR)) + 0.3 * np.roll(y, int(0.043 * SR)) + 0.22 * np.roll(y, int(0.19 * SR))
        y /= max(1e-6, np.abs(y).max()) * 1.05
        write_wav(out, y)
    return y


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        n, sr, ch, sw = w.getnframes(), w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = np.frombuffer(w.readframes(n), dtype={1: np.uint8, 2: np.int16, 4: np.int32}[sw]).astype(np.float32)
    if sw == 2:
        raw /= 32768.0
    if ch > 1:
        raw = raw.reshape(-1, ch).mean(1)
    if sr != SR:
        raw = np.interp(np.linspace(0, len(raw) - 1, int(len(raw) * SR / sr)), np.arange(len(raw)), raw).astype(np.float32)
    return raw


def write_wav(path: Path, y: np.ndarray) -> None:
    y = np.atleast_2d(y) if y.ndim == 1 else y
    data = y.T if y.shape[0] in (1, 2) and y.ndim == 2 and y.shape[0] < y.shape[1] else y
    pcm = (np.clip(data, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[1] if pcm.ndim == 2 else 1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def envelope(y: np.ndarray, hop_s: float = 0.01) -> np.ndarray:
    hop = int(SR * hop_s)
    n = len(y) // hop
    return np.sqrt((y[: n * hop].reshape(n, hop) ** 2).mean(1))


def trim_silence(y: np.ndarray, thr=0.01, pad=0.04) -> np.ndarray:
    idx = np.where(np.abs(y) > thr)[0]
    if not len(idx):
        return y
    a, b = max(0, idx[0] - int(pad * SR)), min(len(y), idx[-1] + int(pad * SR))
    return y[a:b]


# --------------------------------------------------------------- sons sintéticos
def _t(d): return np.arange(int(d * SR)) / SR


def footstep(seed=0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = _t(0.16)
    noise = rng.standard_normal(len(t))
    k = 40
    noise = np.convolve(noise, np.ones(k) / k, mode="same")          # passa-baixa (grama/terra)
    thump = np.sin(2 * np.pi * (95 - 40 * t / 0.16) * t)
    env = np.exp(-t * 32)
    return ((noise * 6 + thump * 0.8) * env).astype(np.float32)


def magic_burst(dur=2.2) -> np.ndarray:
    t = _t(dur)
    sweep = np.sin(2 * np.pi * (220 * t + 260 * t ** 2 / 0.4)) * np.clip(t / 0.35, 0, 1) * (t < 0.4)
    rng = np.random.default_rng(3)
    swell = np.convolve(rng.standard_normal(len(t)), np.ones(6) / 6, "same") * np.exp(-((t - 0.45) ** 2) / 0.06)
    chime = sum(np.sin(2 * np.pi * f * t) * np.exp(-(t - 0.4).clip(0) * r) * (t > 0.4) * a
                for f, r, a in ((1174.7, 2.0, .5), (1568.0, 2.4, .35), (2349.3, 3.0, .25), (1760, 2.2, .3)))
    return (0.5 * sweep + 0.35 * swell + 0.45 * chime).astype(np.float32)


def ambience(dur: float, seed=1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    wind = np.convolve(rng.standard_normal(n), np.ones(900) / 900, "same")
    wind *= (0.6 + 0.4 * np.sin(2 * np.pi * 0.17 * _t(dur) + 1))
    cr = np.zeros(n, np.float32)
    t = _t(dur)
    gate = (np.sin(2 * np.pi * 3.1 * t) > 0.55) * (np.sin(2 * np.pi * 0.37 * t + 2) > -0.2)
    cr = np.sin(2 * np.pi * 4300 * t) * gate * 0.025 + np.sin(2 * np.pi * 5100 * t + 1) * (np.sin(2 * np.pi * 2.3 * t) > 0.6) * 0.015
    wind = wind / max(1e-6, np.abs(wind).max())
    return (wind * 0.22 + cr).astype(np.float32)


def music(dur: float, bpm=92) -> np.ndarray:
    """Pad + arpejo pentatônico (Ré maior) gerados por síntese aditiva."""
    t = _t(dur)
    out = np.zeros_like(t)
    beat = 60 / bpm
    root = 146.83
    for ci, chord in enumerate(((0, 4, 7), (-3, 0, 4), (-5, -1, 2), (-3, 0, 7))):
        a, b = ci * 4 * beat, (ci + 1) * 4 * beat
        for k in range(0, int(dur / (16 * beat)) + 2):
            s0, s1 = (a + k * 16 * beat), (b + k * 16 * beat)
            m = (t >= s0) & (t < s1)
            if not m.any():
                continue
            env = np.clip((t[m] - s0) / 0.8, 0, 1) * np.clip((s1 - t[m]) / 0.8, 0, 1)
            for semi in chord:
                f = root * 2 ** (semi / 12)
                out[m] += env * (np.sin(2 * np.pi * f * t[m]) + 0.3 * np.sin(2 * np.pi * 2 * f * t[m])) * 0.16
    scale = [0, 2, 4, 7, 9, 12, 14, 16]
    rng = np.random.default_rng(5)
    for n in range(int(dur / (beat / 2))):
        t0 = n * beat / 2
        semi = scale[(n * 3 + int(rng.integers(0, 3))) % len(scale)]
        f = root * 2 * 2 ** (semi / 12)
        m = (t >= t0) & (t < t0 + 0.9)
        tt = t[m] - t0
        out[m] += np.sin(2 * np.pi * f * tt) * np.exp(-tt * 5) * 0.22 * (1 if n % 2 == 0 else 0.7)
    d = np.roll(out, int(0.31 * SR)) * 0.35 + np.roll(out, int(0.57 * SR)) * 0.2
    return (out + d).astype(np.float32)


def place(buf: np.ndarray, clip: np.ndarray, at_s: float, gain=1.0) -> None:
    a = int(at_s * SR)
    b = min(len(buf), a + len(clip))
    if a < len(buf) and b > a:
        buf[a:b] += clip[: b - a] * gain


def mix_project(total_s: float, dialogue: list[dict], steps: list[float], bursts: list[float],
                out: Path) -> dict:
    """dialogue: [{'wav': np.ndarray, 'start_s': float}] ; steps/bursts: tempos (s)."""
    n = int(total_s * SR)
    voice = np.zeros(n, np.float32)
    for d in dialogue:
        place(voice, d["samples"], d["start_s"], 1.0)
    sfx = np.zeros(n, np.float32)
    for i, ts in enumerate(steps):
        place(sfx, footstep(i), ts, 0.5)
    for tb in bursts:
        place(sfx, magic_burst(), tb, 0.75)
    mus = music(total_s)
    # sidechain simples: música abaixa 6 dB sob a voz
    env = np.convolve(np.abs(voice), np.ones(int(0.08 * SR)) / int(0.08 * SR), "same")
    duck = 1.0 - 0.5 * np.clip(env / 0.15, 0, 1)
    amb = ambience(total_s)
    fade = np.clip(_t(total_s) / 1.2, 0, 1) * np.clip((total_s - _t(total_s)) / 1.5, 0, 1)
    mono = voice * 0.95 + sfx + mus * 0.55 * duck * fade + amb * 0.5
    peak = np.abs(mono).max()
    mono = np.tanh(mono * (0.9 / max(peak, 1e-6)) * 1.15) * 0.93
    left = mono + 0.05 * np.roll(amb, 300)
    right = mono - 0.05 * np.roll(amb, 300)
    st = np.stack([left, right], 1)
    write_wav(out, st)
    return {"path": str(out), "peak": float(np.abs(st).max()), "seconds": total_s}
