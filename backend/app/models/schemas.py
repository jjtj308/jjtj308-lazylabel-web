"""Pydantic schemas for request/response models."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel


# ── Health ──────────────────────────────────────────────────────────────────


class HealthResponse(BaseModel):
    version: str
    cuda_available: bool
    torch_version: str | None
    device: str


# ── Projects ────────────────────────────────────────────────────────────────


class ProjectMeta(BaseModel):
    project_id: str
    fps: float
    frame_count: int
    width: int
    height: int
    frame_ext: str
    created_at: str
    source_filename: str
    model_config_: dict[str, Any] = {}

    model_config = {"populate_by_name": True}


class ProjectSummary(BaseModel):
    project_id: str
    source_filename: str
    frame_count: int
    fps: float
    created_at: str


class ImportVideoRequest(BaseModel):
    video_path: str


class ImportVideoResponse(BaseModel):
    project_id: str


# ── Frames ───────────────────────────────────────────────────────────────────


class FrameInfo(BaseModel):
    frame_index: int
    has_mask: bool
    class_id: int | None = None


# ── Prompt ───────────────────────────────────────────────────────────────────


class Point(BaseModel):
    x: float
    y: float


class PromptRequest(BaseModel):
    positive_points: list[Point] = []
    negative_points: list[Point] = []
    box: list[float] | None = None  # [x1, y1, x2, y2] in image pixel coordinates
    save: bool = True


class PromptResponse(BaseModel):
    mask_url: str
    area_px: int


# ── Classes / Labels ──────────────────────────────────────────────────────────


class ClassAlias(BaseModel):
    id: int
    name: str
    color: str = "#22c55e"


class ClassAliasesRequest(BaseModel):
    classes: list[ClassAlias]


class FrameLabelRequest(BaseModel):
    class_id: int | None = None


# ── Propagation ──────────────────────────────────────────────────────────────


class PropagationDirection(str, Enum):
    forward = "forward"
    backward = "backward"
    both = "both"


class PropagateRequest(BaseModel):
    start_frame: int
    end_frame: int
    direction: PropagationDirection = PropagationDirection.forward
    reference_frame: int


class PropagateResponse(BaseModel):
    job_id: str


class JobProgress(BaseModel):
    done: int
    total: int


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    completed = "completed"
    failed = "failed"


class JobResponse(BaseModel):
    job_id: str
    status: JobStatus
    progress: JobProgress
    last_frame: int | None = None
    error: str | None = None
