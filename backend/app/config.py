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


# Storage root — override with LAZYLABEL_WEB_DATA_DIR
DATA_DIR: Path = Path(os.environ.get("LAZYLABEL_WEB_DATA_DIR", str(_default_storage())))

# Path to the SAM2 checkpoint (.pt) file — required.
# Set LAZYLABEL_WEB_SAM2_CHECKPOINT=/path/to/sam2.1_hiera_large.pt
SAM2_CHECKPOINT: str = os.environ.get("LAZYLABEL_WEB_SAM2_CHECKPOINT", "")

# SAM2 config — a bundled config name (e.g. "configs/sam2.1/sam2.1_hiera_large.yaml")
# or an absolute path to a custom YAML file.
# Set LAZYLABEL_WEB_SAM2_CONFIG to override.
SAM2_CONFIG: str = os.environ.get(
    "LAZYLABEL_WEB_SAM2_CONFIG", "configs/sam2.1/sam2.1_hiera_large.yaml"
)

# Device: cuda / cpu / mps
DEVICE: str = os.environ.get("LAZYLABEL_WEB_DEVICE", "cuda")

PROJECTS_DIR: Path = DATA_DIR / "projects"
