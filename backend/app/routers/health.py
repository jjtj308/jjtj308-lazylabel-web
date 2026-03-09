"""Health check endpoint."""
from __future__ import annotations

from fastapi import APIRouter

from app.config import DEVICE
from app.models.schemas import HealthResponse

router = APIRouter()

_VERSION = "0.1.0"


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    cuda_available = False
    torch_version: str | None = None
    try:
        import torch  # type: ignore

        torch_version = torch.__version__
        cuda_available = torch.cuda.is_available()
    except ImportError:
        pass

    return HealthResponse(
        version=_VERSION,
        cuda_available=cuda_available,
        torch_version=torch_version,
        device=DEVICE,
    )
