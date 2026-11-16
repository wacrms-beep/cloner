"""
Point d'entrée principal du moteur Python (engine/engine.py).
Lit les commandes JSON Lines sur stdin, les route via Dispatcher,
exécute WebCloneModule (CloneJob) dans un thread dédié pour ne jamais bloquer
les commandes ping / pause / resume / cancel / shutdown, et émet {"type":"ready"} au démarrage.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from typing import Any, Dict, Optional

# Assurer que le dossier engine/ est dans sys.path
ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)

from config import ENGINE_VERSION
from models import ModuleRegistry
from protocol import Emitter
from clone.job import WebCloneModule


class Dispatcher:
    def __init__(self, emitter: Optional[Emitter] = None) -> None:
        self.emitter = emitter or Emitter()
        self.registry = ModuleRegistry()
        self.registry.register(WebCloneModule())

        self._worker_thread: Optional[threading.Thread] = None
        self._cancel_event = threading.Event()
        self._pause_event = threading.Event()
        self._shutdown_requested = False

    def handle_command(self, message: Dict[str, Any]) -> None:
        cmd_id = str(message.get("id") or "")
        cmd = str(message.get("cmd") or "")
        params = message.get("params") or {}

        if cmd == "ping":
            self.emitter.ack(cmd_id, status="pong")
            return

        if cmd == "clone.start":
            if self._worker_thread and self._worker_thread.is_alive():
                self.emitter.ack(cmd_id, status="error", error="Une tâche de clonage est déjà en cours.")
                return

            self._cancel_event.clear()
            self._pause_event.clear()
            self.emitter.ack(cmd_id, status="started")

            module = self.registry.get("web_clone")
            self._worker_thread = threading.Thread(
                target=module.run,
                args=(params, self.emitter, self._cancel_event, self._pause_event),
                daemon=True,
            )
            self._worker_thread.start()
            return

        if cmd == "clone.pause":
            self._pause_event.set()
            self.emitter.ack(cmd_id, status="paused")
            return

        if cmd == "clone.resume":
            self._pause_event.clear()
            self.emitter.ack(cmd_id, status="resumed")
            return

        if cmd == "clone.cancel":
            self._cancel_event.set()
            self._pause_event.clear()
            self.emitter.ack(cmd_id, status="cancelled")
            return

        if cmd == "shutdown":
            self._cancel_event.set()
            self._pause_event.clear()
            self._shutdown_requested = True
            self.emitter.ack(cmd_id, status="shutting_down")
            return

        self.emitter.ack(cmd_id, status="error", error=f"Commande inconnue : {cmd}")

    def run_forever(self) -> None:
        self.emitter.ready(version=ENGINE_VERSION)
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                if isinstance(msg, dict):
                    self.handle_command(msg)
            except Exception as exc:
                sys.stderr.write(f"[Dispatcher] Erreur JSON sur stdin : {exc}\n")
                sys.stderr.flush()

            if self._shutdown_requested:
                break


def main() -> None:
    dispatcher = Dispatcher()
    dispatcher.run_forever()


if __name__ == "__main__":
    main()
