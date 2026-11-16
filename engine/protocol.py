"""
Protocole de communication JSON Lines (engine/protocol.py).
La classe Emitter garantit une écriture atomique sur stdout protégée par un verrou thread
et suivie d'un flush() immédiat.
"""
from __future__ import annotations

import json
import sys
import threading
from typing import Any, Dict, Optional
from config import ENGINE_VERSION


class Emitter:
    """
    Émetteur thread-safe de messages JSON Lines vers Node.js via stdout.
    """

    def __init__(self, stream: Any = None) -> None:
        self._stream = stream or sys.stdout
        self._lock = threading.Lock()

    def _emit(self, payload: Dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with self._lock:
            self._stream.write(line)
            self._stream.flush()

    def ready(self, version: str = ENGINE_VERSION) -> None:
        self._emit({"type": "ready", "version": version})

    def ack(self, cmd_id: str, status: str = "ok", error: Optional[str] = None) -> None:
        msg: Dict[str, Any] = {"type": "ack", "id": cmd_id, "status": status}
        if error:
            msg["error"] = error
        self._emit(msg)

    def log(
        self,
        clone_id: int,
        level: str,
        phase: str,
        message: str,
        data: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._emit({
            "type": "log",
            "cloneId": clone_id,
            "level": level,
            "phase": phase,
            "message": message,
            "data": data,
        })

    def progress(self, clone_id: int, phase: str, percent: float, detail: str = "") -> None:
        self._emit({
            "type": "progress",
            "cloneId": clone_id,
            "phase": phase,
            "percent": round(float(percent), 2),
            "detail": detail,
        })

    def stat(
        self,
        clone_id: int,
        pages: int,
        assets: int,
        bytes_count: int,
        endpoints: int,
        tables: int,
    ) -> None:
        self._emit({
            "type": "stat",
            "cloneId": clone_id,
            "pages": int(pages),
            "assets": int(assets),
            "bytes": int(bytes_count),
            "endpoints": int(endpoints),
            "tables": int(tables),
        })

    def page(
        self,
        clone_id: int,
        url: str,
        local_path: str,
        status: int,
        title: str,
        depth: int,
    ) -> None:
        self._emit({
            "type": "page",
            "cloneId": clone_id,
            "url": url,
            "localPath": local_path,
            "status": int(status),
            "title": title,
            "depth": int(depth),
        })

    def endpoint(self, clone_id: int, endpoint_dict: Dict[str, Any]) -> None:
        payload = {"type": "endpoint", "cloneId": clone_id}
        payload.update(endpoint_dict)
        self._emit(payload)

    def result(
        self,
        clone_id: int,
        output_dir: str,
        zip_path: str,
        summary: Dict[str, Any],
    ) -> None:
        self._emit({
            "type": "result",
            "cloneId": clone_id,
            "outputDir": output_dir,
            "zipPath": zip_path,
            "summary": summary,
        })

    def error(
        self,
        clone_id: Optional[int],
        code: str,
        message: str,
        fatal: bool = False,
        phase: str = "error",
    ) -> None:
        self._emit({
            "type": "error",
            "cloneId": clone_id,
            "code": code,
            "message": message,
            "fatal": bool(fatal),
            "phase": phase,
        })

    # ====================================================================
    # ÉVÉNEMENTS MODULE 1B / 1C : ACQUISITION DE SESSION & AUTH (§4)
    # ====================================================================

    def auth_need_verification(
        self,
        clone_id: int,
        from_domain: str,
        alias: str,
        since_ts: int,
        timeout_ms: int = 120000,
    ) -> None:
        self._emit({
            "type": "auth.need_verification",
            "cloneId": int(clone_id),
            "fromDomain": str(from_domain),
            "alias": str(alias),
            "sinceTs": int(since_ts),
            "timeoutMs": int(timeout_ms),
        })

    def auth_human_needed(
        self,
        clone_id: int,
        reason: str,
        screenshot_path: Optional[str] = None,
        detail: str = "",
    ) -> None:
        self._emit({
            "type": "auth.human_needed",
            "cloneId": int(clone_id),
            "reason": str(reason),
            "screenshotPath": screenshot_path,
            "detail": str(detail or reason),
        })

    def auth_progress(
        self,
        clone_id: int,
        step: str,
        detail: str = "",
        percent: float = 0.0,
    ) -> None:
        self._emit({
            "type": "auth.progress",
            "cloneId": int(clone_id),
            "step": str(step),
            "detail": str(detail),
            "percent": round(float(percent), 2),
        })

    def auth_state(
        self,
        clone_id: int,
        domain: str,
        strategy: str,
        storage_state: Dict[str, Any],
        verified: bool = True,
        account: Optional[Dict[str, Any]] = None,
    ) -> None:
        payload: Dict[str, Any] = {
            "type": "auth.state",
            "cloneId": int(clone_id),
            "domain": str(domain),
            "strategy": str(strategy),
            "storageState": storage_state,
            "verified": bool(verified),
        }
        if account:
            payload["account"] = account
        self._emit(payload)

    def auth_failed(
        self,
        clone_id: int,
        reason: str,
        detail: str = "",
    ) -> None:
        self._emit({
            "type": "auth.failed",
            "cloneId": int(clone_id),
            "reason": str(reason),
            "detail": str(detail or reason),
        })
