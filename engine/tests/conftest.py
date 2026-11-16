"""
Configuration pytest pour le moteur Python : ajoute engine/ à sys.path.
"""
import os
import sys

ENGINE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ENGINE_ROOT not in sys.path:
    sys.path.insert(0, ENGINE_ROOT)
