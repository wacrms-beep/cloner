"""
PathNormalizer (engine/sniff/path_normalizer.py) :
Normalise les chemins d'API dynamiques pour regrouper les variantes :
- /users/42 -> /users/{id}
- /orders/550e8400-e29b-41d4-a716-446655440000 -> /orders/{uuid}
- /commits/a3f5e8d91c0b2e4f6a8d0c2e4b6f8a0c -> /commits/{hash}
"""
from __future__ import annotations

import re
from urllib.parse import urlparse


UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
NUMERIC_RE = re.compile(r"^\d+$")
HEX_HASH_RE = re.compile(r"^[0-9a-f]{16,64}$", re.IGNORECASE)
ALNUM_TOKEN_RE = re.compile(r"^(?=.*\d)(?=.*[a-zA-Z])[a-zA-Z0-9_-]{20,}$")


class PathNormalizer:
    @staticmethod
    def normalize_path(url_or_path: str) -> str:
        if not url_or_path:
            return "/"
        parsed = urlparse(url_or_path)
        raw_path = parsed.path if parsed.scheme or parsed.netloc else url_or_path.split("?")[0]
        raw_path = raw_path.strip()
        if not raw_path or raw_path == "/":
            return "/"

        segments = [seg for seg in raw_path.split("/") if seg]
        normalized_segments = []

        for seg in segments:
            if UUID_RE.match(seg):
                normalized_segments.append("{uuid}")
            elif NUMERIC_RE.match(seg):
                normalized_segments.append("{id}")
            elif HEX_HASH_RE.match(seg) or ALNUM_TOKEN_RE.match(seg):
                normalized_segments.append("{hash}")
            else:
                normalized_segments.append(seg)

        return "/" + "/".join(normalized_segments)
