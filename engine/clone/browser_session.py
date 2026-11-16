"""
BrowserSession (engine/clone/browser_session.py) :
Context manager Playwright lançant Chromium headless avec un contexte propre
(viewport, user_agent, locale fr-FR, émulation mobile optionnelle) et garantissant
la fermeture sans processus Chromium orphelin en cas de crash, timeout ou annulation.
"""
from __future__ import annotations

from typing import Optional
from playwright.sync_api import sync_playwright, Playwright, Browser, BrowserContext
from models import CloneOptions
from config import DEFAULT_USER_AGENT, MOBILE_USER_AGENT


class BrowserSession:
    def __init__(self, options: CloneOptions, headless: bool = True) -> None:
        self.options = options
        self.headless = bool(headless)
        self._playwright: Optional[Playwright] = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None

    def __enter__(self) -> "BrowserSession":
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()

    def start(self) -> None:
        self._playwright = sync_playwright().start()
        self.browser = self._playwright.chromium.launch(
            headless=self.headless,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
            ],
        )

        width, height = self._parse_viewport(self.options.viewport)
        if self.options.mobile_emulation:
            width, height = 390, 844

        ua = self.options.user_agent or (
            MOBILE_USER_AGENT if self.options.mobile_emulation else DEFAULT_USER_AGENT
        )

        context_kwargs = {
            "viewport": {"width": width, "height": height},
            "user_agent": ua,
            "locale": "fr-FR",
            "is_mobile": bool(self.options.mobile_emulation),
            "has_touch": bool(self.options.mobile_emulation),
            "ignore_https_errors": True,
        }
        if self.options.storage_state and isinstance(self.options.storage_state, dict):
            context_kwargs["storage_state"] = self.options.storage_state

        self.context = self.browser.new_context(**context_kwargs)
        self.context.set_default_timeout(int(self.options.timeout_s * 1000))

    def close(self) -> None:
        try:
            if self.context:
                self.context.close()
        except Exception:
            pass
        finally:
            self.context = None

        try:
            if self.browser:
                self.browser.close()
        except Exception:
            pass
        finally:
            self.browser = None

        try:
            if self._playwright:
                self._playwright.stop()
        except Exception:
            pass
        finally:
            self._playwright = None

    @staticmethod
    def _parse_viewport(vp_str: str) -> tuple[int, int]:
        try:
            parts = str(vp_str or "1440x900").lower().split("x")
            return max(320, int(parts[0])), max(320, int(parts[1]))
        except Exception:
            return 1440, 900
