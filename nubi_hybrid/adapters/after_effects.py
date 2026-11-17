"""Adobe After Effects Adapter — ExtendScript (.jsx) + aerender.

NÃO TESTADO neste ambiente (After Effects não está instalado aqui).
"""
from __future__ import annotations

import re
from pathlib import Path

from .base import Adapter, Detection, which_any

AE_GLOBS = [r"C:\Program Files\Adobe\Adobe After Effects *\Support Files\AfterFX.exe",
            "/Applications/Adobe After Effects */Adobe After Effects *.app/Contents/MacOS/After Effects"]
AR_GLOBS = [r"C:\Program Files\Adobe\Adobe After Effects *\Support Files\aerender.exe",
            "/Applications/Adobe After Effects */aerender"]


class AfterEffectsAdapter(Adapter):
    name = "after_effects"
    capabilities = ["extendscript_comp_build", "aerender"]

    def _detect(self) -> Detection:
        ae = which_any(["AfterFX", "afterfx"], AE_GLOBS)
        ar = which_any(["aerender"], AR_GLOBS)
        if not (ae or ar):
            return Detection(self.name, False, notes="After Effects/aerender não encontrado")
        self._ae, self._ar = ae, ar
        m = re.search(r"After Effects (\d{4})", ae or ar)
        return Detection(self.name, True, m.group(1) if m else "?", ar or ae, True, self.capabilities)

    @staticmethod
    def build_vfx_jsx(comp_name: str, plate_seq: Path, vfx_seq: Path | None, out_aep: Path,
                      width: int, height: int, fps: int, frames: int) -> str:
        p = lambda x: str(Path(x).resolve()).replace("\\", "/")
        vfx = ""
        if vfx_seq:
            vfx = f"""
var vfxIO = new ImportOptions(new File("{p(vfx_seq)}")); vfxIO.sequence = true;
var vfx = app.project.importFile(vfxIO);
var vl = comp.layers.add(vfx); vl.blendingMode = BlendingMode.ADD; vl.name = "NUBI_VFX";
var glow = vl.property("Effects").addProperty("ADBE Glo2"); """
        return f"""// Gerado por NUBI Hybrid Animation Engine
app.beginUndoGroup("NUBI {comp_name}");
var comp = app.project.items.addComp("{comp_name}", {width}, {height}, 1, {frames}/{fps}, {fps});
var plateIO = new ImportOptions(new File("{p(plate_seq)}")); plateIO.sequence = true;
var plate = app.project.importFile(plateIO);
var pl = comp.layers.add(plate); pl.name = "NUBI_PLATE";{vfx}
app.project.save(new File("{p(out_aep)}"));
app.endUndoGroup();
"""

    def render(self, aep: Path, comp: str, out: Path, timeout: float = 3600):
        d = self.require()
        return self.run([self._ar or d.path, "-project", aep, "-comp", comp, "-output", out], timeout=timeout)
