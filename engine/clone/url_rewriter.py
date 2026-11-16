"""
UrlRewriter (engine/clone/url_rewriter.py) :
Convertit toute URL (absolue, relative, protocol-relative //, avec ../) en chemin relatif
depuis le fichier local qui la référence (page HTML ou feuille CSS).
Traite href, src, srcset, data-src, data-srcset, poster, action, <link>,
<meta property="og:image" / name="twitter:image">, style inline, attributs CSS url(), <base>.
"""
from __future__ import annotations

import posixpath
import re
from typing import Callable, Dict, Optional
from urllib.parse import urlparse, urljoin, urlunparse, parse_qsl, urlencode, unquote


SKIP_SCHEMES = ("data:", "blob:", "mailto:", "tel:", "javascript:", "about:", "#")


def normalize_page_url(url: str) -> str:
    """
    Normalise une URL de page :
    - Hôte et schéma en minuscules
    - Suppression du fragment (#...)
    - Suppression des ports par défaut (:80 en http, :443 en https)
    - Tri des paramètres de query string
    - Chemin vide remplacé par '/'
    """
    if not url:
        return ""
    parsed = urlparse(url.strip())
    scheme = (parsed.scheme or "https").lower()
    hostname = (parsed.hostname or "").lower()
    port = parsed.port
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None
    netloc = f"{hostname}:{port}" if port else hostname

    path = parsed.path or "/"
    # Résolution des segments . et ..
    norm_path = posixpath.normpath(path)
    if path.endswith("/") and not norm_path.endswith("/"):
        norm_path += "/"
    if not norm_path.startswith("/"):
        norm_path = "/" + norm_path

    query_pairs = parse_qsl(parsed.query, keep_blank_values=True)
    query_pairs.sort(key=lambda kv: (kv[0], kv[1]))
    sorted_query = urlencode(query_pairs, doseq=True)

    return urlunparse((scheme, netloc, norm_path, "", sorted_query, ""))


def page_url_to_local_relpath(url: str) -> str:
    """
    Convertit l'URL d'une page en chemin relatif dans site/ :
    - https://quotes.toscrape.com/ -> 'index.html'
    - https://quotes.toscrape.com/page/2/ -> 'page/2/index.html'
    - https://example.com/about.html -> 'about.html'
    - https://example.com/search?q=1 -> 'search_q_1/index.html'
    """
    parsed = urlparse(url)
    raw_path = unquote(parsed.path or "/").strip("/")

    if not raw_path:
        base_rel = "index.html"
    else:
        segments = [
            re.sub(r"[^a-zA-Z0-9._-]+", "_", seg).strip("_") or "item"
            for seg in raw_path.split("/")
            if seg and seg != "."
        ]
        if not segments:
            base_rel = "index.html"
        else:
            last = segments[-1]
            if last.lower().endswith((".html", ".htm")):
                if last.lower() in ("index.html", "index.htm"):
                    base_rel = posixpath.join(*segments[:-1], "index.html") if len(segments) > 1 else "index.html"
                else:
                    base_rel = posixpath.join(*segments)
            else:
                base_rel = posixpath.join(*segments, "index.html")

    if parsed.query:
        safe_q = re.sub(r"[^a-zA-Z0-9]+", "_", parsed.query).strip("_")[:40]
        if safe_q:
            if base_rel == "index.html":
                base_rel = posixpath.join(f"q_{safe_q}", "index.html")
            elif base_rel.endswith("/index.html"):
                prefix = base_rel[: -len("/index.html")]
                base_rel = f"{prefix}_{safe_q}/index.html"
            else:
                stem, ext = posixpath.splitext(base_rel)
                base_rel = f"{stem}_{safe_q}{ext}"

    return base_rel


def compute_relative_link(from_local_relpath: str, to_local_relpath: str) -> str:
    """
    Calcule le chemin relatif POSIX depuis un fichier source (ex: 'page/2/index.html')
    vers un fichier cible (ex: 'assets/css/main.css' -> '../../assets/css/main.css').
    """
    from_dir = posixpath.dirname(from_local_relpath.lstrip("/")) or "."
    to_clean = to_local_relpath.lstrip("/")
    rel = posixpath.relpath(to_clean, start=from_dir)
    return rel


class UrlRewriter:
    """
    Réécrit les URLs de pages et d'assets en chemins relatifs hors-ligne.
    """

    def __init__(
        self,
        root_url: str,
        asset_lookup: Callable[[str], Optional[str]],
        known_pages: Optional[Dict[str, str]] = None,
        same_domain_only: bool = True,
        include_subdomains: bool = False,
    ) -> None:
        self.root_url = normalize_page_url(root_url)
        root_parsed = urlparse(self.root_url)
        self.root_scheme = root_parsed.scheme or "https"
        self.root_host = (root_parsed.hostname or "").lower()
        self.asset_lookup = asset_lookup
        self.known_pages: Dict[str, str] = known_pages if known_pages is not None else {}
        self.same_domain_only = same_domain_only
        self.include_subdomains = include_subdomains

    def is_same_site(self, target_url: str) -> bool:
        parsed = urlparse(target_url)
        host = (parsed.hostname or "").lower()
        if not host:
            return True
        if host == self.root_host:
            return True
        if self.include_subdomains and host.endswith("." + self.root_host):
            return True
        return False

    def resolve_url(self, raw_ref: str, page_url: str, base_href: Optional[str] = None) -> str:
        """
        Résout une référence (absolue, relative, //protocol-relative) par rapport à page_url (ou <base href>).
        """
        ref = (raw_ref or "").strip()
        if not ref:
            return ""
        for prefix in SKIP_SCHEMES:
            if ref.lower().startswith(prefix):
                return ref

        effective_base = urljoin(page_url, base_href) if base_href else page_url
        if ref.startswith("//"):
            base_scheme = urlparse(effective_base).scheme or self.root_scheme
            return f"{base_scheme}:{ref}"
        return urljoin(effective_base, ref)

    def rewrite_reference(
        self,
        raw_ref: str,
        source_url: str,
        source_local_relpath: str,
        is_page_link: bool = False,
        base_href: Optional[str] = None,
    ) -> str:
        """
        Convertit une référence URL en chemin relatif depuis source_local_relpath.
        Conserve le fragment (#anchor) s'il est présent sur un lien de page.
        """
        if not raw_ref:
            return raw_ref

        stripped = raw_ref.strip()
        if not stripped:
            return raw_ref

        lower = stripped.lower()
        for prefix in SKIP_SCHEMES:
            if lower.startswith(prefix):
                return stripped

        resolved = self.resolve_url(stripped, source_url, base_href=base_href)
        parsed = urlparse(resolved)
        if parsed.scheme not in ("http", "https"):
            return stripped

        fragment = f"#{parsed.fragment}" if parsed.fragment else ""
        no_frag_url = parsed._replace(fragment="").geturl()

        # 1. Vérifier d'abord si l'URL correspond à un asset téléchargé dans AssetStore
        asset_rel = self.asset_lookup(no_frag_url)
        if asset_rel:
            return compute_relative_link(source_local_relpath, asset_rel) + fragment

        # 2. Si c'est un lien de navigation (<a>, <form action>) sur le même domaine
        if is_page_link and self.is_same_site(no_frag_url):
            norm_page = normalize_page_url(no_frag_url)
            target_page_rel = self.known_pages.get(norm_page) or page_url_to_local_relpath(norm_page)
            rel_link = compute_relative_link(source_local_relpath, target_page_rel)
            return rel_link + fragment

        return stripped

    def rewrite_srcset(
        self,
        srcset_value: str,
        source_url: str,
        source_local_relpath: str,
        base_href: Optional[str] = None,
    ) -> str:
        """
        Réécrit toutes les entrées d'un attribut srcset / data-srcset :
        "img-1x.jpg 1x, https://example.com/img-2x.jpg 2x"
        """
        if not srcset_value or not srcset_value.strip():
            return srcset_value

        parts = [p.strip() for p in srcset_value.split(",") if p.strip()]
        rewritten_parts = []
        for part in parts:
            tokens = part.split()
            if not tokens:
                continue
            url_token = tokens[0]
            descriptor = " ".join(tokens[1:])
            new_url = self.rewrite_reference(
                url_token,
                source_url=source_url,
                source_local_relpath=source_local_relpath,
                is_page_link=False,
                base_href=base_href,
            )
            rewritten_parts.append(f"{new_url} {descriptor}".strip())

        return ", ".join(rewritten_parts)

    def rewrite_inline_style(
        self,
        style_text: str,
        source_url: str,
        source_local_relpath: str,
        base_href: Optional[str] = None,
    ) -> str:
        """
        Réécrit les expressions url(...) présentes dans un attribut style="" ou une balise <style>.
        """
        if not style_text or "url(" not in style_text.lower():
            return style_text

        pattern = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)

        def _repl(match: re.Match) -> str:
            quote = match.group(1) or ""
            inner_url = match.group(2).strip()
            new_url = self.rewrite_reference(
                inner_url,
                source_url=source_url,
                source_local_relpath=source_local_relpath,
                is_page_link=False,
                base_href=base_href,
            )
            return f"url({quote}{new_url}{quote})"

        return pattern.sub(_repl, style_text)
