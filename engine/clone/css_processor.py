"""
CssProcessor (engine/clone/css_processor.py) :
Parse les feuilles de style avec tinycss2, réécrit url(...) et @import (téléchargés
récursivement), @font-face, et gère les cycles de dépendances CSS.
"""
from __future__ import annotations

import os
from typing import Callable, Optional, Set
from urllib.parse import urljoin
import urllib.request
import tinycss2

from clone.url_rewriter import UrlRewriter, compute_relative_link


class CssProcessor:
    def __init__(
        self,
        site_dir: str,
        rewriter: UrlRewriter,
        asset_saver: Callable[[str, bytes, str], Optional[str]],
        user_agent: str = "Mozilla/5.0",
    ) -> None:
        self.site_dir = os.path.abspath(site_dir)
        self.rewriter = rewriter
        self.asset_saver = asset_saver
        self.user_agent = user_agent
        self._processed_urls: Set[str] = set()

    def process_css_text(
        self,
        css_text: str,
        css_source_url: str,
        css_local_relpath: str,
        allow_network_fetch: bool = True,
    ) -> str:
        """
        Analyse le texte CSS avec tinycss2, télécharge si nécessaire les ressources référencées
        par @import / url() (dont les polices @font-face) et réécrit leurs chemins en relatif
        par rapport à css_local_relpath.
        """
        if not css_text:
            return css_text

        tokens = tinycss2.parse_component_value_list(css_text)
        rewritten_tokens = self._walk_tokens(
            tokens,
            css_source_url=css_source_url,
            css_local_relpath=css_local_relpath,
            allow_network_fetch=allow_network_fetch,
        )
        return tinycss2.serialize(rewritten_tokens)

    def _walk_tokens(
        self,
        tokens: list,
        css_source_url: str,
        css_local_relpath: str,
        allow_network_fetch: bool,
    ) -> list:
        out = []
        i = 0
        n = len(tokens)

        while i < n:
            tok = tokens[i]

            # Gestion de @import "autre.css" ou @import url("autre.css")
            if tok.type == "at-keyword" and tok.lower_value == "import":
                out.append(tok)
                i += 1
                # Avancer sur les espaces
                while i < n and tokens[i].type == "whitespace":
                    out.append(tokens[i])
                    i += 1
                if i < n:
                    target_tok = tokens[i]
                    if target_tok.type == "string":
                        new_rel = self._resolve_and_fetch_css_ref(
                            target_tok.value,
                            css_source_url,
                            css_local_relpath,
                            is_import=True,
                            allow_network_fetch=allow_network_fetch,
                        )
                        target_tok.value = new_rel
                        target_tok.representation = f'"{new_rel}"'
                        out.append(target_tok)
                        i += 1
                        continue
                    elif target_tok.type == "url":
                        new_rel = self._resolve_and_fetch_css_ref(
                            target_tok.value,
                            css_source_url,
                            css_local_relpath,
                            is_import=True,
                            allow_network_fetch=allow_network_fetch,
                        )
                        target_tok.value = new_rel
                        target_tok.representation = f"url({new_rel})"
                        out.append(target_tok)
                        i += 1
                        continue

            # Gestion des jetons url(...)
            if tok.type == "url":
                new_rel = self._resolve_and_fetch_css_ref(
                    tok.value,
                    css_source_url,
                    css_local_relpath,
                    is_import=False,
                    allow_network_fetch=allow_network_fetch,
                )
                tok.value = new_rel
                tok.representation = f"url({new_rel})"
                out.append(tok)
                i += 1
                continue

            # Gestion de function url("...") lorsque tinycss2 émet FunctionBlock
            if tok.type == "function" and tok.lower_name == "url":
                inner_vals = [
                    t for t in tok.arguments if t.type in ("string", "ident")
                ]
                if inner_vals:
                    raw_val = inner_vals[0].value
                    new_rel = self._resolve_and_fetch_css_ref(
                        raw_val,
                        css_source_url,
                        css_local_relpath,
                        is_import=False,
                        allow_network_fetch=allow_network_fetch,
                    )
                    inner_vals[0].value = new_rel
                    if inner_vals[0].type == "string":
                        inner_vals[0].representation = f'"{new_rel}"'
                out.append(tok)
                i += 1
                continue

            # Blocs imbriqués ({...}, (...), [...])
            if hasattr(tok, "content") and tok.content is not None:
                tok.content = self._walk_tokens(
                    tok.content,
                    css_source_url=css_source_url,
                    css_local_relpath=css_local_relpath,
                    allow_network_fetch=allow_network_fetch,
                )
            out.append(tok)
            i += 1

        return out

    def _resolve_and_fetch_css_ref(
        self,
        raw_ref: str,
        css_source_url: str,
        css_local_relpath: str,
        is_import: bool,
        allow_network_fetch: bool,
    ) -> str:
        ref = (raw_ref or "").strip()
        if not ref or ref.lower().startswith(("data:", "blob:", "#", "about:")):
            return ref

        abs_url = urljoin(css_source_url, ref)
        existing_rel = self.rewriter.asset_lookup(abs_url)

        if not existing_rel and allow_network_fetch:
            existing_rel = self._download_missing_asset(abs_url, is_import=is_import)

        if existing_rel:
            # Si c'est un @import CSS et qu'il n'a pas encore été traité (gestion des cycles)
            if is_import and abs_url not in self._processed_urls:
                self._processed_urls.add(abs_url)
                abs_file = os.path.join(self.site_dir, *existing_rel.split("/"))
                if os.path.isfile(abs_file):
                    try:
                        with open(abs_file, "r", encoding="utf-8", errors="replace") as f:
                            sub_css = f.read()
                        rewritten_sub = self.process_css_text(
                            sub_css,
                            css_source_url=abs_url,
                            css_local_relpath=existing_rel,
                            allow_network_fetch=allow_network_fetch,
                        )
                        with open(abs_file, "w", encoding="utf-8") as f:
                            f.write(rewritten_sub)
                    except Exception:
                        pass

            return compute_relative_link(css_local_relpath, existing_rel)

        return ref

    def _download_missing_asset(self, abs_url: str, is_import: bool = False) -> Optional[str]:
        try:
            req = urllib.request.Request(abs_url, headers={"User-Agent": self.user_agent})
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    body = resp.read()
                    ctype = resp.headers.get("Content-Type", "text/css" if is_import else "")
                    return self.asset_saver(abs_url, body, ctype)
        except Exception:
            return None
        return None
