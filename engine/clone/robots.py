"""
Lecteur et évaluateur de fichier robots.txt (engine/clone/robots.py).
Supporte can_fetch(url) et crawl-delay.
"""
from __future__ import annotations

from urllib.parse import urlparse, urlunparse
from urllib.robotparser import RobotFileParser
import urllib.request
from typing import Optional


class RobotsChecker:
    def __init__(self, base_url: str, user_agent: str, respect_robots: bool = True) -> None:
        self.base_url = base_url
        self.user_agent = user_agent or "*"
        self.respect_robots = respect_robots
        self.parser = RobotFileParser()
        self.loaded = False
        self.crawl_delay_s: Optional[float] = None

    def load(self, timeout_s: float = 8.0) -> None:
        if not self.respect_robots:
            self.loaded = True
            return

        parsed = urlparse(self.base_url)
        robots_url = urlunparse((parsed.scheme, parsed.netloc, "/robots.txt", "", "", ""))
        try:
            req = urllib.request.Request(
                robots_url,
                headers={"User-Agent": self.user_agent},
            )
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                if resp.status == 200:
                    raw_text = resp.read().decode("utf-8", errors="replace")
                    self.parser.parse(raw_text.splitlines())
                    self.loaded = True
                    delay = self.parser.crawl_delay(self.user_agent) or self.parser.crawl_delay("*")
                    if delay is not None:
                        try:
                            self.crawl_delay_s = float(delay)
                        except ValueError:
                            self.crawl_delay_s = None
                else:
                    # Pas de robots.txt restrictif
                    self.parser.allow_all = True
                    self.loaded = True
        except Exception:
            # Si robots.txt est inaccessible ou inexistant, autoriser par défaut
            self.parser.allow_all = True
            self.loaded = True

    def can_fetch(self, url: str) -> bool:
        if not self.respect_robots:
            return True
        if not self.loaded:
            self.load()
        try:
            return bool(self.parser.can_fetch(self.user_agent, url))
        except Exception:
            return True
