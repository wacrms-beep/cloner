"""
Report (engine/packaging/report.py) :
Génère `report.json` et `report.md` résumant le clonage (pages, assets, poids total,
endpoints XHR/Fetch, tables déduites, avertissements, trackers retirés et éléments
non clonés tels que iframes tierces, WebSockets ou authentification).
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from typing import Any, Dict, List
from models import AssetRecord, EndpointRecord, PageRecord, TableSpec


class ReportGenerator:
    def generate_reports(
        self,
        output_dir: str,
        url: str,
        domain: str,
        pages: List[PageRecord],
        assets: List[AssetRecord],
        total_bytes: int,
        endpoints: List[EndpointRecord],
        tables: List[TableSpec],
        warnings: List[str],
        removed_trackers: List[str],
    ) -> Dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        summary = {
            "url": url,
            "domain": domain,
            "generatedAt": now_iso,
            "pages": len(pages),
            "assets": len(assets),
            "bytes": int(total_bytes),
            "endpoints": len(endpoints),
            "tables": len(tables),
            "tableSpecs": [t.to_dict() for t in tables],
            "warnings": warnings[:100],
            "removedTrackersCount": len(removed_trackers),
            "unclonedLimitations": [
                "Les iframes tierces (hors domaine) sont conservées vers leur origine distante.",
                "Les flux temps réel WebSockets (ws:// / wss://) et WebRTC ne sont pas rejoués hors ligne.",
                "Les espaces protégés par authentification/session serveur ou CAPTCHA sont hors périmètre.",
            ],
        }

        report_json_path = os.path.join(output_dir, "report.json")
        with open(report_json_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "summary": summary,
                    "pages": [p.to_dict() for p in pages],
                    "endpoints": [e.to_dict() for e in endpoints],
                    "tables": [t.to_dict() for t in tables],
                },
                f,
                indent=2,
                ensure_ascii=False,
            )

        report_md_path = os.path.join(output_dir, "report.md")
        md_lines = [
            f"# Rapport de Clonage — {domain}",
            "",
            f"- **URL source** : `{url}`",
            f"- **Date (UTC)** : `{now_iso}`",
            f"- **Pages HTML aspirées** : `{len(pages)}`",
            f"- **Assets téléchargés** : `{len(assets)}` (`{round(total_bytes / (1024 * 1024), 2)} Mo`)",
            f"- **Endpoints API XHR/Fetch capturés** : `{len(endpoints)}`",
            f"- **Tables SQL déduites** : `{len(tables)}`",
            f"- **Trackers retirés** : `{len(removed_trackers)}`",
            "",
            "## Pages clonées",
            "",
        ]
        for p in pages[:100]:
            md_lines.append(f"- `{p.local_path}` ← `{p.url}` (HTTP {p.status_code})")

        md_lines.extend(["", "## Endpoints API détectés", ""])
        if endpoints:
            for e in endpoints:
                md_lines.append(f"- **{e.method}** `{e.normalized_path}` ({e.hits} appel(s), HTTP {e.status_code})")
        else:
            md_lines.append("- Aucun appel XHR/Fetch JSON capturé.")

        md_lines.extend(["", "## Tables de base de données générées", ""])
        if tables:
            for t in tables:
                cols_str = ", ".join(f"`{c.name}` ({c.sql_type})" for c in t.columns)
                md_lines.append(f"- **`{t.name}`** ({len(t.sample_rows)} lignes) : {cols_str}")
        else:
            md_lines.append("- `clone_metadata` (site statique)")

        if warnings:
            md_lines.extend(["", "## Avertissements", ""])
            for w in warnings[:50]:
                md_lines.append(f"- {w}")

        md_lines.extend(["", "## Éléments hors périmètre / non clonés", ""])
        for lim in summary["unclonedLimitations"]:
            md_lines.append(f"- {lim}")

        with open(report_md_path, "w", encoding="utf-8") as f:
            f.write("\n".join(md_lines) + "\n")

        return summary
