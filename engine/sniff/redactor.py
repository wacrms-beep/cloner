"""
Redactor (engine/sniff/redactor.py) :
Masque les valeurs de clés sensibles (password, token, authorization, cookie, secret,
api_key, card, iban, ssn…) ainsi que les adresses email et numéros de téléphone réels
dans les exemples JSON capturés, en les remplaçant par des valeurs factices cohérentes.
Ne conserve jamais les en-têtes Authorization / Cookie.
"""
from __future__ import annotations

import re
from typing import Any, Dict


SENSITIVE_KEYS_RE = re.compile(
    r"(?:^|[_\-\s])(password|passwd|pwd|token|access_token|refresh_token|id_token|auth_token|"
    r"authorization|cookie|set-cookie|secret|client_secret|api_key|apikey|private_key|"
    r"card_number|credit_card|cvv|cvc|iban|bic|ssn)(?:$|[_\-\s])",
    re.IGNORECASE,
)

EMAIL_RE = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")
PHONE_RE = re.compile(r"^\+?[0-9][0-9\s.-]{7,16}[0-9]$")


class Redactor:
    # Ensemble dynamique de valeurs sensibles issues de l'acquisition (alias Gmail, pseudo test, mot de passe)
    _custom_replacements: Dict[str, str] = {}

    @classmethod
    def register_custom_redactions(
        cls,
        alias: str = "",
        username: str = "",
        password: str = "",
    ) -> None:
        if alias and alias.strip():
            cls._custom_replacements[alias.strip()] = "utilisateur@exemple.local"
        if username and username.strip():
            cls._custom_replacements[username.strip()] = "utilisateur_fictif"
        if password and password.strip():
            cls._custom_replacements[password.strip()] = "REDACTED_VALUE"

    @classmethod
    def clear_custom_redactions(cls) -> None:
        cls._custom_replacements.clear()

    @classmethod
    def redact_text(cls, text: str) -> str:
        if not text:
            return text
        out = text
        for secret_val, replacement in cls._custom_replacements.items():
            if secret_val and secret_val in out:
                out = out.replace(secret_val, replacement)
        return out

    @classmethod
    def redact_headers(cls, headers: Dict[str, Any]) -> Dict[str, str]:
        clean: Dict[str, str] = {}
        for k, v in (headers or {}).items():
            lower_k = k.lower()
            if lower_k in ("authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"):
                continue
            if SENSITIVE_KEYS_RE.search(lower_k):
                clean[k] = "[REDACTED]"
            else:
                clean[k] = str(v)
        return clean

    @classmethod
    def redact_data(cls, data: Any, key_hint: str = "") -> Any:
        if data is None:
            return None

        if key_hint and SENSITIVE_KEYS_RE.search(key_hint):
            return cls._fake_for_key(key_hint)

        if isinstance(data, dict):
            return {k: cls.redact_data(v, key_hint=str(k)) for k, v in data.items()}

        if isinstance(data, list):
            return [cls.redact_data(item, key_hint=key_hint) for item in data]

        if isinstance(data, str):
            cleaned_str = cls.redact_text(data)
            stripped = cleaned_str.strip()
            if EMAIL_RE.match(stripped):
                return "utilisateur@exemple.local"
            if PHONE_RE.match(stripped) and sum(c.isdigit() for c in stripped) >= 9:
                return "+33100000000"
            return cleaned_str

        return data

    @staticmethod
    def _fake_for_key(key: str) -> str:
        lk = key.lower()
        if "email" in lk:
            return "utilisateur@exemple.local"
        if "iban" in lk:
            return "FR7600000000000000000000000"
        if "card" in lk:
            return "0000-0000-0000-0000"
        return "REDACTED_VALUE"
