"""Make ``turbo_voice`` importable however pytest is invoked.

Running ``pytest`` from this folder works via ``[tool.pytest.ini_options]`` in
pyproject.toml; this also covers running ``pytest voice_service/tests`` from the
parent repo root, where that config is not picked up.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
