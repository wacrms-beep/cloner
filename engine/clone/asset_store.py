"""
AssetStore (engine/clone/asset_store.py) :
Enregistre et déduplique par hash SHA-256 toutes les ressources téléchargées
(css, js, img, fonts, media, other) dans site/assets/{css,js,img,fonts,media,other}/.
Maintient une table déterministe URL normalisée → chemin relatif dans site/
et respecte max_asset_mb et max_total_mb.
"""
from __future__ import annotations

import hashlib
import os
import posixpath
import re
from typing import Dict, List, Optional
from urllib.parse import urlparse, unquote

from models import AssetRecord


EXTENSION_BY_MIME = {
    "text/css": ".css",
    "application/javascript": ".js",
    "text/javascript": ".js",
    "application/x-javascript": ".js",
    "application/json": ".json",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "application/font-woff": ".woff",
    "application/font-woff2": ".woff2",
    "font/ttf": ".ttf",
    "font/otf": ".otf",
    "application/vnd.ms-fontobject": ".eot",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
}

CATEGORY_BY_EXT = {
    ".css": "css",
    ".js": "js",
    ".mjs": "js",
    ".png": "img",
    ".jpg": "img",
    ".jpeg": "img",
    ".gif": "img",
    ".svg": "img",
    ".webp": "img",
    ".avif": "img",
    ".ico": "img",
    ".woff": "fonts",
    ".woff2": "fonts",
    ".ttf": "fonts",
    ".otf": "fonts",
    ".eot": "fonts",
    ".mp4": "media",
    ".webm": "media",
    ".mp3": "media",
    ".ogg": "media",
    ".wav": "media",
}


def normalize_asset_url(url: str) -> str:
    """Supprime le fragment # d'une URL d'asset pour servir de clé stable."""
    if not url:
        return ""
    parsed = urlparse(url.strip())
    return parsed._replace(fragment="").geturl()


class AssetStore:
    def __init__(
        self,
        site_dir: str,
        max_asset_mb: int = 50,
        max_total_mb: int = 1500,
    ) -> None:
        self.site_dir = os.path.abspath(site_dir)
        self.max_asset_bytes = int(max_asset_mb) * 1024 * 1024
        self.max_total_bytes = int(max_total_mb) * 1024 * 1024

        self.url_to_relpath: Dict[str, str] = {}
        self.hash_to_relpath: Dict[str, str] = {}
        self.used_relpaths: set[str] = set()
        self.records: List[AssetRecord] = []
        self.total_bytes: int = 0
        self.skipped_warnings: List[str] = []

        for sub in ("css", "js", "img", "fonts", "media", "other"):
            os.makedirs(os.path.join(self.site_dir, "assets", sub), exist_ok=True)

    def get_local_relpath(self, url: str) -> Optional[str]:
        norm = normalize_asset_url(url)
        return self.url_to_relpath.get(norm)

    def save_asset(
        self,
        url: str,
        body: bytes,
        content_type: str = "",
    ) -> Optional[str]:
        """
        Enregistre le corps binaire d'un asset et retourne son chemin relatif à site/
        (ex: 'assets/css/bootstrap.min.css').
        """
        norm_url = normalize_asset_url(url)
        if not norm_url or body is None:
            return None

        if norm_url in self.url_to_relpath:
            return self.url_to_relpath[norm_url]

        size = len(body)
        if size > self.max_asset_bytes:
            self.skipped_warnings.append(f"Asset ignoré (> {self.max_asset_bytes} octets) : {norm_url}")
            return None

        if self.total_bytes + size > self.max_total_bytes:
            self.skipped_warnings.append(f"Limite totale d'assets atteinte ({self.max_total_bytes} octets)")
            return None

        sha256 = hashlib.sha256(body).hexdigest()
        # Déduplication par hash de contenu
        if sha256 in self.hash_to_relpath:
            existing_rel = self.hash_to_relpath[sha256]
            self.url_to_relpath[norm_url] = existing_rel
            return existing_rel

        mime = (content_type or "").split(";")[0].strip().lower()
        ext, category = self._determine_ext_and_category(norm_url, mime)
        filename = self._build_deterministic_filename(norm_url, ext, category, sha256)
        rel_path = posixpath.join("assets", category, filename)

        abs_path = os.path.join(self.site_dir, *rel_path.split("/"))
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        with open(abs_path, "wb") as f:
            f.write(body)

        self.used_relpaths.add(rel_path)
        self.url_to_relpath[norm_url] = rel_path
        self.hash_to_relpath[sha256] = rel_path
        self.total_bytes += size

        self.records.append(
            AssetRecord(
                url=norm_url,
                local_path=rel_path,
                category=category,
                content_type=mime or "application/octet-stream",
                size_bytes=size,
                sha256=sha256,
            )
        )
        return rel_path

    def _determine_ext_and_category(self, url: str, mime: str) -> tuple[str, str]:
        parsed = urlparse(url)
        raw_path = unquote(parsed.path or "")
        _, ext = os.path.splitext(raw_path)
        ext = ext.lower()

        if len(ext) > 8 or not re.match(r"^\.[a-z0-9]+$", ext):
            ext = ""

        if not ext and mime in EXTENSION_BY_MIME:
            ext = EXTENSION_BY_MIME[mime]

        if not ext:
            ext = ".bin"

        category = CATEGORY_BY_EXT.get(ext, "other")
        if category == "other":
            if "css" in mime:
                category = "css"
                if ext == ".bin":
                    ext = ".css"
            elif "javascript" in mime or "ecmascript" in mime:
                category = "js"
                if ext == ".bin":
                    ext = ".js"
            elif mime.startswith("image/"):
                category = "img"
            elif mime.startswith("font/") or "font" in mime:
                category = "fonts"
            elif mime.startswith("video/") or mime.startswith("audio/"):
                category = "media"

        return ext, category

    def _build_deterministic_filename(
        self,
        url: str,
        ext: str,
        category: str,
        sha256: str,
    ) -> str:
        parsed = urlparse(url)
        base = posixpath.basename(unquote(parsed.path or "")).strip()
        if base:
            stem, _ = os.path.splitext(base)
        else:
            stem = "asset"

        clean_stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", stem).strip("._-")
        if not clean_stem:
            clean_stem = "asset"
        clean_stem = clean_stem[:70]

        short_hash = hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]

        if parsed.query:
            candidate = f"{clean_stem}_{short_hash}{ext}"
        else:
            candidate = f"{clean_stem}{ext}"

        rel_candidate = posixpath.join("assets", category, candidate)
        if rel_candidate in self.used_relpaths:
            candidate = f"{clean_stem}_{sha256[:8]}{ext}"

        return candidate
