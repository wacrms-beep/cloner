"""
Crawler (engine/clone/crawler.py) :
Parcours en largeur (BFS) depuis l'URL de départ :
- File de pages (url, depth), normalisation d'URL, dédoublonnage
- Respect de max_depth, max_pages, same_domain_only, include_subdomains, robots.txt
- Interception automatique de toutes les réponses d'assets (CSS, JS, images, polices, médias)
  vers AssetStore et des appels XHR/Fetch vers NetworkSniffer
- Défilement progressif (scroll_to_bottom / scroll_steps) pour déclencher le lazy-loading
  et le scroll infini (ex: quotes.toscrape.com/scroll)
- Capture d'une miniature thumbnail.png sur la page d'accueil
- Sauvegarde du DOM final et post-traitement complet par HtmlProcessor et CssProcessor.
"""
from __future__ import annotations

from collections import deque
import os
import threading
import time
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse, urljoin
from bs4 import BeautifulSoup

from models import CloneOptions, PageRecord
from protocol import Emitter
from clone.browser_session import BrowserSession
from clone.asset_store import AssetStore
from clone.url_rewriter import (
    UrlRewriter,
    normalize_page_url,
    page_url_to_local_relpath,
)
from clone.robots import RobotsChecker
from clone.sanitizer import Sanitizer
from clone.css_processor import CssProcessor
from clone.html_processor import HtmlProcessor


class Crawler:
    def __init__(
        self,
        clone_id: int,
        start_url: str,
        site_dir: str,
        output_dir: str,
        options: CloneOptions,
        asset_store: AssetStore,
        rewriter: UrlRewriter,
        robots: RobotsChecker,
        sanitizer: Sanitizer,
        sniffer: Optional[ object ] = None,
        emitter: Optional[Emitter] = None,
        cancel_event: Optional[threading.Event] = None,
        pause_event: Optional[threading.Event] = None,
    ) -> None:
        self.clone_id = clone_id
        self.start_url = normalize_page_url(start_url)
        self.site_dir = site_dir
        self.output_dir = output_dir
        self.options = options
        self.asset_store = asset_store
        self.rewriter = rewriter
        self.robots = robots
        self.sanitizer = sanitizer
        self.sniffer = sniffer
        self.emitter = emitter
        self.cancel_event = cancel_event or threading.Event()
        self.pause_event = pause_event or threading.Event()

        self.visited_pages: Dict[str, str] = {}  # norm_url -> local_relpath
        self.raw_html_by_url: Dict[str, Tuple[str, str, int, str, int]] = {}
        self.pages: List[PageRecord] = []
        self.warnings: List[str] = []

    def _check_pause_or_cancel(self) -> bool:
        while self.pause_event.is_set() and not self.cancel_event.is_set():
            time.sleep(0.15)
        return self.cancel_event.is_set()

    def crawl(self) -> List[PageRecord]:
        queue: deque[Tuple[str, int]] = deque([(self.start_url, 0)])
        queued_urls: set[str] = {self.start_url}
        thumbnail_captured = False

        with BrowserSession(self.options) as session:
            page = session.context.new_page()

            # Attachement des écouteurs réseau (AssetStore + NetworkSniffer)
            def on_response(response) -> None:
                try:
                    req = response.request
                    res_type = req.resource_type
                    url = response.url
                    status = response.status
                    headers = response.headers or {}
                    ctype = headers.get("content-type", "")

                    # 1. Sniffer XHR/Fetch
                    if self.sniffer and self.options.sniff_api and res_type in ("xhr", "fetch"):
                        self.sniffer.record_exchange(req, response)

                    # 2. Sauvegarde des assets statiques (hors document HTML principal)
                    if res_type in ("stylesheet", "script", "image", "font", "media", "other"):
                        if self.sanitizer.is_tracker_url(url):
                            return
                        if 200 <= status < 300:
                            body = response.body()
                            self.asset_store.save_asset(url, body, ctype)
                except Exception:
                    pass

            page.on("response", on_response)

            while queue and len(self.pages) < self.options.max_pages:
                if self._check_pause_or_cancel():
                    break

                current_url, depth = queue.popleft()
                norm_url = normalize_page_url(current_url)
                if norm_url in self.visited_pages:
                    continue

                if not self.robots.can_fetch(norm_url):
                    msg = f"URL bloquée par robots.txt : {norm_url}"
                    self.warnings.append(msg)
                    if self.emitter:
                        self.emitter.log(self.clone_id, "warn", "crawl", msg)
                    continue

                # Respect du délai entre requêtes (et crawl-delay de robots.txt)
                delay_s = max(
                    self.options.request_delay_ms / 1000.0,
                    self.robots.crawl_delay_s or 0.0,
                )
                if len(self.pages) > 0 and delay_s > 0:
                    time.sleep(min(delay_s, 3.0))

                local_rel = "index.html" if len(self.pages) == 0 else page_url_to_local_relpath(norm_url)
                self.visited_pages[norm_url] = local_rel
                self.rewriter.known_pages[norm_url] = local_rel

                try:
                    wait_until = (
                        self.options.wait_strategy
                        if self.options.wait_strategy in ("networkidle", "load", "domcontentloaded")
                        else "networkidle"
                    )
                    resp = page.goto(norm_url, wait_until=wait_until, timeout=int(self.options.timeout_s * 1000))
                    status_code = resp.status if resp else 200

                    # Défilement progressif pour déclencher le lazy-loading et les appels API de scroll
                    if self.options.scroll_to_bottom and self.options.scroll_steps > 0:
                        self._perform_progressive_scroll(page, self.options.scroll_steps)

                    if self.options.extra_wait_ms > 0:
                        page.wait_for_timeout(min(self.options.extra_wait_ms, 5000))

                    # Capture de la miniature (thumbnail.png) sur la première page
                    if not thumbnail_captured:
                        thumb_path = os.path.join(self.output_dir, "thumbnail.png")
                        try:
                            page.screenshot(path=thumb_path, full_page=False)
                            thumbnail_captured = True
                        except Exception:
                            pass

                    title = page.title() or ""
                    dom_html = page.content()

                    self.raw_html_by_url[norm_url] = (dom_html, local_rel, status_code, title, depth)
                    rec = PageRecord(
                        url=norm_url,
                        local_path=f"site/{local_rel}",
                        status_code=status_code,
                        title=title,
                        depth=depth,
                    )
                    self.pages.append(rec)

                    if self.emitter:
                        pct = 5.0 + min(50.0, (len(self.pages) / max(1, self.options.max_pages)) * 50.0)
                        self.emitter.page(self.clone_id, norm_url, f"site/{local_rel}", status_code, title, depth)
                        self.emitter.progress(
                            self.clone_id,
                            "crawl",
                            pct,
                            f"Page aspirée ({len(self.pages)}/{self.options.max_pages}) : {title or norm_url}",
                        )
                        self.emitter.stat(
                            self.clone_id,
                            pages=len(self.pages),
                            assets=len(self.asset_store.records),
                            bytes_count=self.asset_store.total_bytes,
                            endpoints=len(self.sniffer.endpoints) if self.sniffer else 0,
                            tables=0,
                        )
                        self.emitter.log(self.clone_id, "info", "crawl", f"Page capturée : {norm_url} ({status_code})")

                    # Découverte des liens <a href> si depth < max_depth
                    if depth < self.options.max_depth:
                        discovered = self._extract_links(dom_html, norm_url)
                        for link_url in discovered:
                            if link_url not in queued_urls and len(queued_urls) < self.options.max_pages * 3:
                                queued_urls.add(link_url)
                                queue.append((link_url, depth + 1))

                except Exception as exc:
                    warn_msg = f"Erreur non fatale sur {norm_url} : {exc}"
                    self.warnings.append(warn_msg)
                    if self.emitter:
                        self.emitter.log(self.clone_id, "warn", "crawl", warn_msg)

        # Post-traitement : réécriture de toutes les feuilles CSS et de toutes les pages HTML capturées
        if not self.cancel_event.is_set():
            self._post_process_assets_and_pages()

        return self.pages

    def _perform_progressive_scroll(self, page, steps: int) -> None:
        for _ in range(max(1, steps)):
            if self._check_pause_or_cancel():
                break
            try:
                page.evaluate("window.scrollBy(0, Math.max(400, window.innerHeight * 0.85));")
                page.wait_for_timeout(250)
            except Exception:
                break
        try:
            page.evaluate("window.scrollTo(0, 0);")
        except Exception:
            pass

    def _extract_links(self, html_text: str, current_url: str) -> List[str]:
        links: List[str] = []
        try:
            soup = BeautifulSoup(html_text, "lxml")
        except Exception:
            soup = BeautifulSoup(html_text, "html.parser")

        base_tag = soup.find("base")
        base_href = base_tag.get("href") if base_tag else None
        effective_base = urljoin(current_url, base_href) if base_href else current_url

        for a_tag in soup.find_all("a", href=True):
            raw_href = (a_tag["href"] or "").strip()
            if not raw_href or raw_href.startswith(("#", "javascript:", "mailto:", "tel:")):
                continue
            resolved = urljoin(effective_base, raw_href)
            parsed = urlparse(resolved)
            if parsed.scheme not in ("http", "https"):
                continue
            if self.options.same_domain_only and not self.rewriter.is_same_site(resolved):
                continue
            # Ignorer les fichiers binaires évidents dans la file de pages HTML
            lower_path = (parsed.path or "").lower()
            if lower_path.endswith((".jpg", ".jpeg", ".png", ".gif", ".svg", ".pdf", ".zip", ".css", ".js", ".mp4")):
                continue
            norm = normalize_page_url(resolved)
            links.append(norm)

        return links

    def _post_process_assets_and_pages(self) -> None:
        # 1. Traitement de toutes les feuilles CSS enregistrées dans AssetStore
        css_proc = CssProcessor(
            site_dir=self.site_dir,
            rewriter=self.rewriter,
            asset_saver=self.asset_store.save_asset,
        )
        for rec in list(self.asset_store.records):
            if rec.category == "css" or rec.local_path.endswith(".css"):
                abs_css = os.path.join(self.site_dir, *rec.local_path.split("/"))
                if os.path.isfile(abs_css):
                    try:
                        with open(abs_css, "r", encoding="utf-8", errors="replace") as f:
                            raw_css = f.read()
                        new_css = css_proc.process_css_text(
                            raw_css,
                            css_source_url=rec.url,
                            css_local_relpath=rec.local_path,
                            allow_network_fetch=True,
                        )
                        with open(abs_css, "w", encoding="utf-8") as f:
                            f.write(new_css)
                    except Exception as exc:
                        self.warnings.append(f"Erreur réécriture CSS ({rec.local_path}) : {exc}")

        # 2. Génération du shim JS et réécriture de toutes les pages HTML
        html_proc = HtmlProcessor(
            site_dir=self.site_dir,
            rewriter=self.rewriter,
            sanitizer=self.sanitizer,
        )
        captured_origins = set()
        captured_prefixes = {"/api"}
        if self.sniffer:
            for ep in self.sniffer.endpoints.values():
                parsed_ep = urlparse(ep.sample_url)
                if parsed_ep.scheme and parsed_ep.netloc:
                    captured_origins.add(f"{parsed_ep.scheme}://{parsed_ep.netloc}")
                parts = [p for p in ep.normalized_path.split("/") if p]
                if parts:
                    captured_prefixes.add("/" + parts[0])

        html_proc.write_shim_file(captured_origins=captured_origins, captured_prefixes=captured_prefixes)

        for norm_url, (dom_html, local_rel, _status, _title, _depth) in self.raw_html_by_url.items():
            _, removed = html_proc.process_and_save_html(
                html_content=dom_html,
                page_url=norm_url,
                page_local_relpath=local_rel,
            )
            if removed and self.emitter:
                self.emitter.log(
                    self.clone_id,
                    "info",
                    "crawl",
                    f"{len(removed)} tracker(s) retiré(s) sur {local_rel}",
                    {"removed": removed[:10]},
                )

        self.warnings.extend(html_proc.uncloned_warnings)
