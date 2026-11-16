"""
Modèles de données (dataclasses) et interface d'extensibilité (Module / ModuleRegistry)
pour le moteur Python Universal Clone (§7 et §11).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional
import threading


@dataclass
class CloneOptions:
    max_depth: int = 2
    max_pages: int = 50
    same_domain_only: bool = True
    include_subdomains: bool = False
    viewport: str = "1440x900"
    mobile_emulation: bool = False
    user_agent: Optional[str] = None
    wait_strategy: str = "networkidle"
    extra_wait_ms: int = 1500
    scroll_to_bottom: bool = True
    scroll_steps: int = 8
    respect_robots: bool = True
    request_delay_ms: int = 300
    concurrency: int = 4
    max_asset_mb: int = 50
    max_total_mb: int = 1500
    strip_trackers: bool = True
    sniff_api: bool = True
    generate_backend: bool = True
    sample_limit_per_endpoint: int = 20
    timeout_s: int = 45
    acquire_strategy: str = "none"
    storage_state: Optional[Dict[str, Any]] = None
    signup_alias: Optional[str] = None
    signup_username: Optional[str] = None
    signup_password: Optional[str] = None
    debug_dir: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Optional[Dict[str, Any]] = None) -> "CloneOptions":
        if not raw or not isinstance(raw, dict):
            return cls()
        valid_keys = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in raw.items() if k in valid_keys and v is not None}
        return cls(**filtered)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PageRecord:
    url: str
    local_path: str
    status_code: int = 200
    title: str = ""
    depth: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class AssetRecord:
    url: str
    local_path: str
    category: str
    content_type: str
    size_bytes: int
    sha256: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class EndpointRecord:
    method: str
    normalized_path: str
    sample_url: str
    status_code: int = 200
    content_type: str = "application/json"
    hits: int = 1
    request_samples: List[Any] = field(default_factory=list)
    response_samples: List[Any] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "method": self.method,
            "normalizedPath": self.normalized_path,
            "sampleUrl": self.sample_url,
            "statusCode": self.status_code,
            "contentType": self.content_type,
            "hits": self.hits,
            "requestExample": self.request_samples[0] if self.request_samples else None,
            "responseExample": self.response_samples[0] if self.response_samples else None,
        }


@dataclass
class ColumnSpec:
    name: str
    sql_type: str
    nullable: bool = True
    unique: bool = False
    primary: bool = False
    references: Optional[str] = None  # Format "table(col)"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class TableSpec:
    name: str
    columns: List[ColumnSpec] = field(default_factory=list)
    sample_rows: List[Dict[str, Any]] = field(default_factory=list)
    source_endpoint: Optional[str] = None
    envelope_key: Optional[str] = None
    supports_pagination: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "table_name": self.name,
            "columns": [c.to_dict() for c in self.columns],
            "rows_count": len(self.sample_rows),
            "source_endpoint": self.source_endpoint,
            "envelope_key": self.envelope_key,
            "supports_pagination": self.supports_pagination,
        }


class Module(ABC):
    """
    Interface abstraite commune à tous les modules d'analyse/clonage (§11 : Web, futurs APK/EXE).
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Identifiant unique du module (ex: 'web_clone')."""

    @property
    @abstractmethod
    def supported_inputs(self) -> List[str]:
        """Types d'entrées supportés (ex: ['http', 'https'])."""

    @abstractmethod
    def run(
        self,
        params: Dict[str, Any],
        emitter: Any,
        cancel_event: threading.Event,
        pause_event: threading.Event,
    ) -> Dict[str, Any]:
        """Exécute la tâche et retourne le dictionnaire de résultat."""


class ModuleRegistry:
    """
    Registre central des modules du moteur Python.
    """

    def __init__(self) -> None:
        self._modules: Dict[str, Module] = {}

    def register(self, module: Module) -> None:
        self._modules[module.name] = module

    def get(self, name: str) -> Module:
        if name not in self._modules:
            raise KeyError(f"Module '{name}' non enregistré.")
        return self._modules[name]

    def list_modules(self) -> List[Dict[str, Any]]:
        return [
            {"name": m.name, "supported_inputs": m.supported_inputs}
            for m in self._modules.values()
        ]
