"""
Packager (engine/packaging/packager.py) :
Assemble le dossier de sortie final `output/<domaine>_<AAAAMMJJ-HHMM>/` contenant :
- `site/`
- `backend/` (si généré)
- `database.sql`
- `preview.sqlite`
- `report.json` et `report.md`
- `thumbnail.png`
Puis crée l'archive `.zip` correspondante à côté du dossier de sortie.
"""
from __future__ import annotations

import os
import zipfile


class Packager:
    @staticmethod
    def create_zip_archive(output_dir: str) -> str:
        abs_dir = os.path.abspath(output_dir.rstrip("/\\"))
        zip_path = f"{abs_dir}.zip"

        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(abs_dir):
                for file in files:
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, start=abs_dir)
                    zf.write(full_path, arcname=rel_path)

        return zip_path
