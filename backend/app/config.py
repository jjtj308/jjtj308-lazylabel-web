"""LazyLabel Web — FastAPI backend."""
from __future__ import annotations

import os
import platform
from pathlib import Path


def _default_storage() -> Path:
    system = platform.system()
    if system == "Windows":
        base = Path(os.environ.get("APPDATA", Path.home()))
    elif system == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "lazylabel-web"


# Storage root — override with env var LAZYLABEL_WEB_DATA_DIR
DATA_DIR: Path = Path(os.environ.get("LAZYLABEL_WEB_DATA_DIR", str(_default_storage())))

# Models directory — default location for SAM2 config yaml and weights file.
# Override with env var LAZYLABEL_WEB_MODELS_DIR.
MODELS_DIR: Path = Path(os.environ.get("LAZYLABEL_WEB_MODELS_DIR", str(DATA_DIR / "models")))

# SAM2 weights — defaults to MODELS_DIR/sam2.1_hiera_large.pt.
# Override with env var LAZYLABEL_WEB_SAM2_WEIGHTS.
SAM2_WEIGHTS: str = os.environ.get(
    "LAZYLABEL_WEB_SAM2_WEIGHTS", str(MODELS_DIR / "sam2.1_hiera_large.pt")
)

# SAM2 config yaml — defaults to MODELS_DIR/sam2.1_hiera_large.yaml.
# Override with env var LAZYLABEL_WEB_SAM2_CONFIG.
SAM2_CONFIG: str = os.environ.get(
    "LAZYLABEL_WEB_SAM2_CONFIG", str(MODELS_DIR / "sam2.1_hiera_large.yaml")
)

# Device: cuda / cpu / mps
DEVICE: str = os.environ.get("LAZYLABEL_WEB_DEVICE", "cuda")

PROJECTS_DIR: Path = DATA_DIR / "projects"
