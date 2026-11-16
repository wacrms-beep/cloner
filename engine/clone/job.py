"""
CloneJob & WebCloneModule (engine/clone/job.py) :
Orchestre les 6 phases du clonage avec les pourcentages exacts du cahier des charges (§7) :
1) Préparation (0-5 %)
2) Aspiration (5-60 %)
3) Réseau (en parallèle de 2, finalisé à 65 %)
4) Schéma (65-75 %)
5) Backend (75-90 %)
6) Emballage (90-100 %)

Vérifie l'annulation et la pause entre chaque étape.
Toute exception non fatale est journalisée en 'warn' et le job continue ;
une exception fatale émet 'error' avec fatal=True.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Any, Dict, List
from urllib.parse import urlparse

from config import DEFAULT_USER_AGENT
from models import CloneOptions, Module, TableSpec
from protocol import Emitter
from clone.asset_store import AssetStore
from clone.url_rewriter import UrlRewriter
from clone.robots import RobotsChecker
from clone.sanitizer import Sanitizer
from clone.crawler import Crawler
from sniff.network_sniffer import NetworkSniffer
from backend_gen.schema_inferrer import SchemaInferrer
from backend_gen.sql_generator import SqlGenerator
from backend_gen.php_generator import PhpGenerator
from packaging.report import ReportGenerator
from packaging.packager import Packager


class CloneJob:
    def __init__(
        self,
        clone_id: int,
        url: str,
        output_dir: str,
        options: CloneOptions,
        emitter: Emitter,
        cancel_event: threading.Event,
        pause_event: threading.Event,
    ) -> None:
        self.clone_id = int(clone_id)
        self.url = url.strip()
        self.output_dir = os.path.abspath(output_dir)
        self.site_dir = os.path.join(self.output_dir, "site")
        self.options = options
        self.emitter = emitter
        self.cancel_event = cancel_event
        self.pause_event = pause_event

        parsed = urlparse(self.url)
        self.domain = (parsed.hostname or "site").lower()

    def _wait_if_paused_or_cancelled(self) -> bool:
        while self.pause_event.is_set() and not self.cancel_event.is_set():
            time.sleep(0.15)
        return self.cancel_event.is_set()

    def run(self) -> Dict[str, Any]:
        try:
            # ====================================================================
            # PHASE 1 : PRÉPARATION (0 - 5 %)
            # ====================================================================
            self.emitter.progress(self.clone_id, "prepare", 1.0, "Préparation de l'espace de travail")
            self.emitter.log(self.clone_id, "info", "prepare", f"Démarrage du clonage de {self.url}")

            os.makedirs(self.site_dir, exist_ok=True)
            ua = self.options.user_agent or DEFAULT_USER_AGENT

            robots = RobotsChecker(
                base_url=self.url,
                user_agent=ua,
                respect_robots=self.options.respect_robots,
            )
            robots.load()

            if self.options.respect_robots and not robots.can_fetch(self.url):
                raise RuntimeError(f"L'accès à {self.url} est refusé par robots.txt.")

            asset_store = AssetStore(
                site_dir=self.site_dir,
                max_asset_mb=self.options.max_asset_mb,
                max_total_mb=self.options.max_total_mb,
            )
            rewriter = UrlRewriter(
                root_url=self.url,
                asset_lookup=asset_store.get_local_relpath,
                same_domain_only=self.options.same_domain_only,
                include_subdomains=self.options.include_subdomains,
            )
            sanitizer = Sanitizer(strip_trackers=self.options.strip_trackers)
            sniffer = NetworkSniffer(
                clone_id=self.clone_id,
                sample_limit_per_endpoint=self.options.sample_limit_per_endpoint,
                emitter=self.emitter,
            )

            self.emitter.progress(self.clone_id, "prepare", 5.0, "Préparation terminée")
            if self._wait_if_paused_or_cancelled():
                return {"cancelled": True}

            # ====================================================================
            # PHASE 2 : ASPIRATION (5 - 60 %) + PHASE 3 : RÉSEAU EN PARALLÈLE
            # ====================================================================
            self.emitter.progress(self.clone_id, "crawl", 6.0, "Ouverture de Chromium et aspiration des pages")
            crawler = Crawler(
                clone_id=self.clone_id,
                start_url=self.url,
                site_dir=self.site_dir,
                output_dir=self.output_dir,
                options=self.options,
                asset_store=asset_store,
                rewriter=rewriter,
                robots=robots,
                sanitizer=sanitizer,
                sniffer=sniffer,
                emitter=self.emitter,
                cancel_event=self.cancel_event,
                pause_event=self.pause_event,
            )
            pages = crawler.crawl()

            if self._wait_if_paused_or_cancelled():
                return {"cancelled": True}

            self.emitter.progress(self.clone_id, "crawl", 60.0, f"{len(pages)} page(s) aspirée(s)")

            # ====================================================================
            # PHASE 3 : FINALISATION RÉSEAU (60 - 65 %)
            # ====================================================================
            endpoints_list = list(sniffer.endpoints.values())
            self.emitter.progress(
                self.clone_id,
                "network",
                65.0,
                f"{len(endpoints_list)} endpoint(s) API XHR/Fetch consolidé(s)",
            )
            self.emitter.log(
                self.clone_id,
                "info",
                "network",
                f"Analyse réseau finalisée : {len(endpoints_list)} endpoint(s) JSON capturé(s)",
            )

            if self._wait_if_paused_or_cancelled():
                return {"cancelled": True}

            # ====================================================================
            # PHASE 4 : INFÉRENCE DU SCHÉMA (65 - 75 %)
            # ====================================================================
            self.emitter.progress(self.clone_id, "schema", 68.0, "Inférence du schéma relationnel")
            inferred_tables: List[TableSpec] = []
            try:
                if self.options.sniff_api and endpoints_list:
                    inferrer = SchemaInferrer()
                    inferred_tables = inferrer.infer_from_endpoints(endpoints_list)
                self.emitter.log(
                    self.clone_id,
                    "info",
                    "schema",
                    f"{len(inferred_tables)} table(s) SQL déduite(s) des réponses JSON",
                )
            except Exception as exc:
                self.emitter.log(self.clone_id, "warn", "schema", f"Avertissement inférence schéma : {exc}")

            self.emitter.stat(
                self.clone_id,
                pages=len(pages),
                assets=len(asset_store.records),
                bytes_count=asset_store.total_bytes,
                endpoints=len(endpoints_list),
                tables=len(inferred_tables),
            )
            self.emitter.progress(self.clone_id, "schema", 75.0, "Schéma de base de données validé")

            if self._wait_if_paused_or_cancelled():
                return {"cancelled": True}

            # ====================================================================
            # PHASE 5 : GÉNÉRATION BACKEND PHP 8 & SQL (75 - 90 %)
            # ====================================================================
            self.emitter.progress(self.clone_id, "backend", 78.0, "Génération de database.sql et preview.sqlite")
            try:
                sql_gen = SqlGenerator()
                sql_gen.write_database_files(
                    output_dir=self.output_dir,
                    tables=inferred_tables,
                    domain=self.domain,
                )
                if self.options.generate_backend:
                    self.emitter.progress(self.clone_id, "backend", 84.0, "Génération du backend PHP 8 natif (PDO)")
                    php_gen = PhpGenerator()
                    php_gen.generate(
                        output_dir=self.output_dir,
                        tables=inferred_tables,
                        endpoints=endpoints_list,
                        domain=self.domain,
                    )
                self.emitter.log(
                    self.clone_id,
                    "info",
                    "backend",
                    "Fichiers database.sql, preview.sqlite et dossier backend/ générés avec succès",
                )
            except Exception as exc:
                self.emitter.log(self.clone_id, "warn", "backend", f"Avertissement génération backend : {exc}")

            self.emitter.progress(self.clone_id, "backend", 90.0, "Backend PHP 8 et bases SQL prêts")

            if self._wait_if_paused_or_cancelled():
                return {"cancelled": True}

            # ====================================================================
            # PHASE 6 : EMBALLAGE & RAPPORT (90 - 100 %)
            # ====================================================================
            self.emitter.progress(self.clone_id, "package", 93.0, "Génération des rapports report.json et report.md")
            all_warnings = crawler.warnings + asset_store.skipped_warnings
            report_gen = ReportGenerator()
            summary = report_gen.generate_reports(
                output_dir=self.output_dir,
                url=self.url,
                domain=self.domain,
                pages=pages,
                assets=asset_store.records,
                total_bytes=asset_store.total_bytes,
                endpoints=endpoints_list,
                tables=inferred_tables,
                warnings=all_warnings,
                removed_trackers=sanitizer.removed_items,
            )

            self.emitter.progress(self.clone_id, "package", 97.0, "Compression de l'archive .zip")
            zip_path = Packager.create_zip_archive(self.output_dir)

            self.emitter.progress(self.clone_id, "package", 100.0, "Clonage terminé avec succès")
            self.emitter.log(self.clone_id, "info", "package", f"Archive créée : {zip_path}")
            self.emitter.result(
                clone_id=self.clone_id,
                output_dir=self.output_dir,
                zip_path=zip_path,
                summary=summary,
            )
            return {
                "outputDir": self.output_dir,
                "zipPath": zip_path,
                "summary": summary,
            }

        except Exception as exc:
            self.emitter.error(
                clone_id=self.clone_id,
                code="CLONE_FATAL_ERROR",
                message=str(exc),
                fatal=True,
                phase="error",
            )
            return {"error": str(exc)}


class WebCloneModule(Module):
    """
    Première implémentation de l'interface abstraite Module (§11).
    """

    @property
    def name(self) -> str:
        return "web_clone"

    @property
    def supported_inputs(self) -> List[str]:
        return ["http", "https"]

    def run(
        self,
        params: Dict[str, Any],
        emitter: Emitter,
        cancel_event: threading.Event,
        pause_event: threading.Event,
    ) -> Dict[str, Any]:
        clone_id = int(params.get("cloneId", 1))
        url = str(params.get("url", ""))
        output_dir = str(params.get("outputDir", "./output/clone"))
        options = CloneOptions.from_dict(params.get("options") or {})

        job = CloneJob(
            clone_id=clone_id,
            url=url,
            output_dir=output_dir,
            options=options,
            emitter=emitter,
            cancel_event=cancel_event,
            pause_event=pause_event,
        )
        return job.run()
