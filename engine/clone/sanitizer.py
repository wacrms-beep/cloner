"""
Sanitizer (engine/clone/sanitizer.py) :
Si strip_trackers est activé, retire les scripts externes et inline associés aux trackers
(Google Analytics, GTM, Facebook Pixel, Hotjar, Clarity, etc.) ainsi que les pixels <img>/<iframe>
de suivi, et retourne la liste des éléments retirés pour journalisation.
"""
from __future__ import annotations

from typing import List
from urllib.parse import urlparse
from bs4 import BeautifulSoup
from config import TRACKER_DOMAINS, TRACKER_INLINE_PATTERNS


class Sanitizer:
    def __init__(self, strip_trackers: bool = True) -> None:
        self.strip_trackers = strip_trackers
        self.removed_items: List[str] = []

    def is_tracker_url(self, url: str) -> bool:
        if not self.strip_trackers or not url:
            return False
        try:
            parsed = urlparse(url)
            host = (parsed.hostname or "").lower()
            if not host:
                return False
            if host in TRACKER_DOMAINS:
                return True
            for domain in TRACKER_DOMAINS:
                if host.endswith("." + domain):
                    return True
        except Exception:
            return False
        return False

    def clean_soup(self, soup: BeautifulSoup) -> List[str]:
        """
        Nettoie un objet BeautifulSoup en place et retourne la liste des éléments supprimés.
        """
        removed_now: List[str] = []
        if not self.strip_trackers:
            return removed_now

        # 1. Balises <script> externes ou inline de tracking
        for script in list(soup.find_all("script")):
            src = script.get("src")
            if src and self.is_tracker_url(src):
                desc = f"script[src={src[:100]}]"
                removed_now.append(desc)
                self.removed_items.append(desc)
                script.decompose()
                continue

            inline_code = script.string or script.get_text() or ""
            if inline_code:
                for pattern in TRACKER_INLINE_PATTERNS:
                    if pattern in inline_code:
                        desc = f"script[inline:{pattern}]"
                        removed_now.append(desc)
                        self.removed_items.append(desc)
                        script.decompose()
                        break

        # 2. Balises <noscript> et <iframe> pointant vers des domaines de tracking
        for tag in list(soup.find_all(["iframe", "img", "link"])):
            target = tag.get("src") or tag.get("href") or ""
            if target and self.is_tracker_url(target):
                desc = f"{tag.name}[{target[:100]}]"
                removed_now.append(desc)
                self.removed_items.append(desc)
                tag.decompose()

        return removed_now
