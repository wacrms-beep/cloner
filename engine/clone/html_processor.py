"""
HtmlProcessor (engine/clone/html_processor.py) :
Parse le DOM HTML avec BeautifulSoup / lxml :
- Extrait le <base href> éventuel puis retire la balise <base>
- Retire les attributs integrity et crossorigin cassants hors-ligne
- Désactive/retire les enregistrements de Service Workers inline
- Applique Sanitizer (retrait des trackers si strip_trackers=True)
- Réécrit tous les attributs d'URL (href, src, srcset, data-src, data-srcset, poster, action,
  meta og:image / twitter:image, style inline, <style>) en chemins relatifs via UrlRewriter
- Génère et injecte le script `clone-shim.js` (§8) dans chaque page clonée
- Sauvegarde la page dans `site/<chemin>/index.html` (et `site/index.html` pour l'accueil).
"""
from __future__ import annotations

import json
import os
from typing import List, Optional, Set
from urllib.parse import urlparse
from bs4 import BeautifulSoup

from clone.url_rewriter import UrlRewriter, compute_relative_link
from clone.sanitizer import Sanitizer


CLONE_SHIM_TEMPLATE = """/**
 * clone-shim.js : intercepteur léger généré par Universal Clone (§8).
 * Redirige les appels window.fetch et XMLHttpRequest ciblant les origines/chemins API capturés
 * vers ./backend/index.php (ou window.__CLONE_API_BASE__).
 * Désactivable en ajoutant data-clone-shim="off" sur <html> ou <script>.
 */
(function () {
  if (typeof document !== 'undefined') {
    var root = document.documentElement;
    if (root && root.getAttribute('data-clone-shim') === 'off') return;
    var currentScript = document.currentScript;
    if (currentScript && currentScript.getAttribute('data-clone-shim') === 'off') return;
  }

  var CAPTURED_ORIGINS = __CAPTURED_ORIGINS_JSON__;
  var CAPTURED_PREFIXES = __CAPTURED_PREFIXES_JSON__;
  var DEFAULT_BACKEND = currentScriptRelBase();

  function currentScriptRelBase() {
    if (typeof window !== 'undefined' && window.__CLONE_API_BASE__) {
      return window.__CLONE_API_BASE__;
    }
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].getAttribute('src') || '';
      if (src.indexOf('clone-shim.js') !== -1) {
        var relRoot = src.replace(/assets\\/js\\/clone-shim\\.js.*$/, '');
        return relRoot + '../backend/index.php';
      }
    }
    return './backend/index.php';
  }

  function shouldIntercept(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
      var parsed = new URL(rawUrl, window.location.href);
      var pathAndQuery = parsed.pathname + (parsed.search || '');
      for (var i = 0; i < CAPTURED_PREFIXES.length; i++) {
        var pref = CAPTURED_PREFIXES[i];
        if (parsed.pathname === pref || parsed.pathname.indexOf(pref + '/') === 0 || parsed.pathname.indexOf('/api/') === 0) {
          return pathAndQuery;
        }
      }
      for (var j = 0; j < CAPTURED_ORIGINS.length; j++) {
        if (parsed.origin === CAPTURED_ORIGINS[j] && parsed.pathname.indexOf('/api') === 0) {
          return pathAndQuery;
        }
      }
    } catch (e) {}
    return null;
  }

  function buildTargetUrl(routeWithQuery) {
    var base = (typeof window !== 'undefined' && window.__CLONE_API_BASE__) ? window.__CLONE_API_BASE__ : DEFAULT_BACKEND;
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return routeWithQuery;
    }
    var sep = base.indexOf('?') === -1 ? '?' : '&';
    return base + sep + '__route=' + encodeURIComponent(routeWithQuery);
  }

  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var rawUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      var route = shouldIntercept(rawUrl);
      if (route) {
        var redirected = buildTargetUrl(route);
        return origFetch(redirected, init);
      }
      return origFetch(input, init);
    };
  }

  if (typeof window !== 'undefined' && typeof window.XMLHttpRequest === 'function') {
    var OrigXHR = window.XMLHttpRequest;
    var origOpen = OrigXHR.prototype.open;
    OrigXHR.prototype.open = function (method, url) {
      var route = shouldIntercept(String(url || ''));
      if (route) {
        arguments[1] = buildTargetUrl(route);
      }
      return origOpen.apply(this, arguments);
    };
  }
})();
"""


class HtmlProcessor:
    def __init__(
        self,
        site_dir: str,
        rewriter: UrlRewriter,
        sanitizer: Sanitizer,
    ) -> None:
        self.site_dir = os.path.abspath(site_dir)
        self.rewriter = rewriter
        self.sanitizer = sanitizer
        self.shim_relpath = "assets/js/clone-shim.js"
        self.uncloned_warnings: List[str] = []

    def write_shim_file(
        self,
        captured_origins: Optional[Set[str]] = None,
        captured_prefixes: Optional[Set[str]] = None,
    ) -> str:
        origins_list = sorted(captured_origins or set())
        prefixes_list = sorted(captured_prefixes or {"/api"})
        content = (
            CLONE_SHIM_TEMPLATE
            .replace("__CAPTURED_ORIGINS_JSON__", json.dumps(origins_list))
            .replace("__CAPTURED_PREFIXES_JSON__", json.dumps(prefixes_list))
        )
        abs_shim = os.path.join(self.site_dir, "assets", "js", "clone-shim.js")
        os.makedirs(os.path.dirname(abs_shim), exist_ok=True)
        with open(abs_shim, "w", encoding="utf-8") as f:
            f.write(content)
        return self.shim_relpath

    def process_and_save_html(
        self,
        html_content: str,
        page_url: str,
        page_local_relpath: str,
    ) -> tuple[str, List[str]]:
        """
        Nettoie, réécrit tous les liens et assets d'une page HTML, injecte clone-shim.js
        et écrit le fichier dans site/<page_local_relpath>.
        Retourne (html_final, liste_des_trackers_retirés).
        """
        try:
            soup = BeautifulSoup(html_content, "lxml")
        except Exception:
            soup = BeautifulSoup(html_content, "html.parser")

        # 1. Extraction de <base href> puis retrait de la balise <base>
        base_href: Optional[str] = None
        base_tag = soup.find("base")
        if base_tag:
            base_href = base_tag.get("href")
            base_tag.decompose()

        # 2. Nettoyage des trackers (Sanitizer)
        removed_trackers = self.sanitizer.clean_soup(soup)

        # 3. Retrait des attributs integrity, crossorigin et neutralisation ServiceWorker
        for tag in soup.find_all(True):
            if tag.has_attr("integrity"):
                del tag["integrity"]
            if tag.has_attr("crossorigin"):
                del tag["crossorigin"]
            if tag.has_attr("nonce"):
                del tag["nonce"]

        for script in soup.find_all("script"):
            txt = script.string or ""
            if "serviceWorker" in txt and ".register" in txt:
                script.string = "/* ServiceWorker registration disabled by Universal Clone */"

        # 4. Détection des iframes tierces pour le rapport
        for iframe in soup.find_all("iframe"):
            src = iframe.get("src")
            if src and not self.rewriter.is_same_site(src):
                self.uncloned_warnings.append(f"Iframe tierce conservée telle quelle : {src[:120]}")

        # 5. Réécriture des liens de navigation (<a href>, <form action>)
        for a_tag in soup.find_all(["a", "area"]):
            if a_tag.has_attr("href"):
                a_tag["href"] = self.rewriter.rewrite_reference(
                    a_tag["href"],
                    source_url=page_url,
                    source_local_relpath=page_local_relpath,
                    is_page_link=True,
                    base_href=base_href,
                )

        for form_tag in soup.find_all("form"):
            if form_tag.has_attr("action"):
                form_tag["action"] = self.rewriter.rewrite_reference(
                    form_tag["action"],
                    source_url=page_url,
                    source_local_relpath=page_local_relpath,
                    is_page_link=True,
                    base_href=base_href,
                )

        # 6. Réécriture des balises <link href>
        for link_tag in soup.find_all("link"):
            if link_tag.has_attr("href"):
                rels = [r.lower() for r in (link_tag.get("rel") or [])]
                is_canonical = "canonical" in rels or "alternate" in rels
                if not is_canonical:
                    link_tag["href"] = self.rewriter.rewrite_reference(
                        link_tag["href"],
                        source_url=page_url,
                        source_local_relpath=page_local_relpath,
                        is_page_link=False,
                        base_href=base_href,
                    )

        # 7. Réécriture des attributs d'assets (src, data-src, poster, srcset, data-srcset)
        for tag in soup.find_all(True):
            for attr in ("src", "data-src", "poster"):
                if tag.has_attr(attr):
                    tag[attr] = self.rewriter.rewrite_reference(
                        tag[attr],
                        source_url=page_url,
                        source_local_relpath=page_local_relpath,
                        is_page_link=False,
                        base_href=base_href,
                    )
            for srcset_attr in ("srcset", "data-srcset"):
                if tag.has_attr(srcset_attr):
                    tag[srcset_attr] = self.rewriter.rewrite_srcset(
                        tag[srcset_attr],
                        source_url=page_url,
                        source_local_relpath=page_local_relpath,
                        base_href=base_href,
                    )
            if tag.has_attr("style"):
                tag["style"] = self.rewriter.rewrite_inline_style(
                    tag["style"],
                    source_url=page_url,
                    source_local_relpath=page_local_relpath,
                    base_href=base_href,
                )

        # 8. Réécriture des images OpenGraph / Twitter (<meta property="og:image" content="...">)
        for meta in soup.find_all("meta"):
            prop = (meta.get("property") or meta.get("name") or "").lower()
            if prop in ("og:image", "twitter:image", "twitter:image:src") and meta.has_attr("content"):
                meta["content"] = self.rewriter.rewrite_reference(
                    meta["content"],
                    source_url=page_url,
                    source_local_relpath=page_local_relpath,
                    is_page_link=False,
                    base_href=base_href,
                )

        # 9. Réécriture des balises <style> inline
        for style_tag in soup.find_all("style"):
            if style_tag.string:
                style_tag.string = self.rewriter.rewrite_inline_style(
                    style_tag.string,
                    source_url=page_url,
                    source_local_relpath=page_local_relpath,
                    base_href=base_href,
                )

        # 10. Injection de clone-shim.js en tête de <head> (ou <body>)
        shim_rel_from_page = compute_relative_link(page_local_relpath, self.shim_relpath)
        shim_tag = soup.new_tag("script", src=shim_rel_from_page)
        shim_tag["data-clone-shim"] = "on"
        if soup.head:
            soup.head.insert(0, shim_tag)
        elif soup.body:
            soup.body.insert(0, shim_tag)
        else:
            soup.insert(0, shim_tag)

        final_html = str(soup)
        abs_out = os.path.join(self.site_dir, *page_local_relpath.split("/"))
        os.makedirs(os.path.dirname(abs_out), exist_ok=True)
        with open(abs_out, "w", encoding="utf-8") as f:
            f.write(final_html)

        return final_html, removed_trackers
