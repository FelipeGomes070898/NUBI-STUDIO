"""Adaptadores só de detecção (sem operações implementadas ainda).

Declaram `capabilities = []` de propósito: o NUBI não finge integração.
"""
from __future__ import annotations

from .base import Adapter, Detection, which_any


class _DetectOnly(Adapter):
    exes: list = []
    globs: list = []

    def _detect(self) -> Detection:
        exe = which_any(self.exes, self.globs)
        if not exe:
            return Detection(self.name, False, notes="não encontrado")
        return Detection(self.name, True, "?", exe, True, [], "detecção apenas; sem operações implementadas")


class UnrealAdapter(_DetectOnly):
    name = "unreal_engine"
    exes = ["UnrealEditor-Cmd", "UnrealEditor"]
    globs = [r"C:\Program Files\Epic Games\UE_*\Engine\Binaries\Win64\UnrealEditor-Cmd.exe"]


class DaVinciAdapter(_DetectOnly):
    name = "davinci_resolve"
    exes = ["resolve", "Resolve"]
    globs = [r"C:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe"]


class ToonBoomAdapter(_DetectOnly):
    name = "toon_boom_harmony"
    exes = ["HarmonyPremium", "Harmony"]
    globs = [r"C:\Program Files\Toon Boom Animation\Toon Boom Harmony *\win64\bin\HarmonyPremium.exe"]


class MohoAdapter(_DetectOnly):
    name = "moho_pro"
    exes = ["Moho"]
    globs = [r"C:\Program Files\Moho *\Moho.exe"]
