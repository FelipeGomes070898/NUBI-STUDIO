"""Adobe Animate Adapter — automação oficial via JSFL.

Gera JSFL real a partir da folha de personagem e executa `Animate` com o script.
NÃO TESTADO neste ambiente (Animate não está instalado aqui): `detect()` informa
a realidade e `run_jsfl` só executa se o programa existir.
"""
from __future__ import annotations

import re
from pathlib import Path

from .base import Adapter, Detection, which_any

GLOBS = [r"C:\Program Files\Adobe\Adobe Animate *\Animate.exe",
         "/Applications/Adobe Animate */Adobe Animate *.app/Contents/MacOS/Adobe Animate *"]


class AnimateAdapter(Adapter):
    name = "adobe_animate"
    capabilities = ["jsfl_character_import", "jsfl_publish_png_sequence"]

    def _detect(self) -> Detection:
        exe = which_any([], GLOBS)  # nunca por nome no PATH: `animate` é do ImageMagick
        if not exe:
            return Detection(self.name, False, notes="Adobe Animate não encontrado")
        m = re.search(r"Animate (\d{4})", exe)
        return Detection(self.name, True, m.group(1) if m else "?", exe, True, self.capabilities)

    @staticmethod
    def build_character_jsfl(char_id: str, parts_dir: Path, out_dir: Path, fps: int = 24) -> str:
        """JSFL: importa partes PNG como símbolos gráficos e publica sequência PNG."""
        parts = sorted(Path(parts_dir).glob("*.png"))
        uri = lambda p: "file:///" + str(Path(p).resolve()).replace("\\", "/").lstrip("/")
        imports = "\n".join(
            f'  importPart("{uri(p)}", "{p.stem}");' for p in parts)
        return f"""// Gerado por NUBI Hybrid Animation Engine — personagem {char_id}
var doc = fl.createDocument("timeline");
doc.frameRate = {fps};
function importPart(uri, name) {{
  doc.importFile(uri, true);
  var lib = doc.library;
  var sel = doc.selection;
  if (sel.length) {{ doc.convertToSymbol("graphic", "{char_id}_" + name, "center"); }}
}}
{imports}
doc.exportPNG("{uri(out_dir)}/{char_id}.png", true, true);
fl.saveDocument(doc, "{uri(out_dir)}/{char_id}.fla");
"""

    def run_jsfl(self, jsfl: Path, timeout: float = 900):
        d = self.require()
        return self.run([d.path, jsfl], timeout=timeout)
