"""
NetworkSniffer (engine/sniff/network_sniffer.py) :
Écoute page.on('response') ; ne retient que les échanges XHR/Fetch (resource_type in ['xhr','fetch']) ;
enregistre méthode, URL, query, corps de requête (JSON/form), code HTTP, content-type et corps de
réponse JSON (tronqué à 512 Ko) anonymisé via Redactor ; limite à sample_limit_per_endpoint
échantillons par endpoint normalisé ; émet 'endpoint' vers Electron.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional
from urllib.parse import urlparse, parse_qs

from config import MAX_SNIFF_BODY_BYTES
from models import EndpointRecord
from protocol import Emitter
from sniff.path_normalizer import PathNormalizer
from sniff.redactor import Redactor


class NetworkSniffer:
    def __init__(
        self,
        clone_id: int,
        sample_limit_per_endpoint: int = 20,
        emitter: Optional[Emitter] = None,
    ) -> None:
        self.clone_id = clone_id
        self.sample_limit = max(1, int(sample_limit_per_endpoint))
        self.emitter = emitter
        self.endpoints: Dict[str, EndpointRecord] = {}  # "METHOD /norm/path" -> EndpointRecord

    def record_exchange(self, request, response) -> Optional[EndpointRecord]:
        res_type = getattr(request, "resource_type", "")
        if res_type not in ("xhr", "fetch"):
            return None

        url = response.url
        method = (request.method or "GET").upper()
        status_code = int(response.status or 200)
        headers = response.headers or {}
        content_type = headers.get("content-type", "")

        # Lire et parser le corps de réponse JSON (tronqué à 512 Ko)
        raw_body = b""
        try:
            raw_body = response.body() or b""
        except Exception:
            return None

        if len(raw_body) > MAX_SNIFF_BODY_BYTES:
            raw_body = raw_body[:MAX_SNIFF_BODY_BYTES]

        parsed_response = self._try_parse_json(raw_body, content_type)
        if parsed_response is None:
            return None

        redacted_response = Redactor.redact_data(parsed_response)
        request_example = self._extract_request_sample(request)

        norm_path = PathNormalizer.normalize_path(url)
        key = f"{method} {norm_path}"

        if key in self.endpoints:
            ep = self.endpoints[key]
            ep.hits += 1
            ep.status_code = status_code
            if len(ep.response_samples) < self.sample_limit:
                ep.response_samples.append(redacted_response)
            if request_example and len(ep.request_samples) < self.sample_limit:
                ep.request_samples.append(request_example)
        else:
            ep = EndpointRecord(
                method=method,
                normalized_path=norm_path,
                sample_url=url,
                status_code=status_code,
                content_type=content_type.split(";")[0].strip() or "application/json",
                hits=1,
                request_samples=[request_example] if request_example else [],
                response_samples=[redacted_response],
            )
            self.endpoints[key] = ep

        if self.emitter:
            self.emitter.endpoint(self.clone_id, ep.to_dict())

        return ep

    def _extract_request_sample(self, request) -> Dict[str, Any]:
        parsed_url = urlparse(request.url)
        query_params = Redactor.redact_data(parse_qs(parsed_url.query))
        post_body = None
        try:
            raw_post = request.post_data
            if raw_post:
                try:
                    post_body = Redactor.redact_data(json.loads(raw_post))
                except Exception:
                    post_body = Redactor.redact_data(parse_qs(raw_post))
        except Exception:
            post_body = None

        return {"query": query_params, "body": post_body}

    @staticmethod
    def _try_parse_json(raw_bytes: bytes, content_type: str) -> Optional[Any]:
        if not raw_bytes:
            return None
        text = raw_bytes.decode("utf-8", errors="replace").strip()
        if not text:
            return None
        if "json" not in (content_type or "").lower() and not (
            text.startswith("{") or text.startswith("[")
        ):
            return None
        try:
            return json.loads(text)
        except Exception:
            return None
