"""Propagation endpoint — background job with SAM2 video predictor."""
from __future__ import annotations

import threading

from fastapi import APIRouter, HTTPException

from app.config import PROJECTS_DIR
from app.models.schemas import (
    JobProgress,
    JobResponse,
    JobStatus,
    PropagateRequest,
    PropagateResponse,
)
from app.services import job_service, project_service, sam2_service

router = APIRouter()

# Store reference prompts per project for propagation
# key: project_id -> {positive_points, negative_points, reference_frame}
_prompt_cache: dict[str, dict] = {}
_prompt_cache_lock = threading.Lock()


_job_update_lock = threading.Lock()


@router.post("/projects/{project_id}/propagate", response_model=PropagateResponse)
def start_propagation(project_id: str, body: PropagateRequest) -> PropagateResponse:
    meta = project_service.get_project(project_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check reference mask or cache exists
    with _prompt_cache_lock:
        cached = _prompt_cache.get(project_id)

    ref_mask = project_service.get_mask_path(project_id, body.reference_frame)
    if ref_mask is None and cached is None:
        raise HTTPException(
            status_code=400,
            detail="No reference mask and no cached prompt. Run /prompt on reference_frame first.",
        )

    total = body.end_frame - body.start_frame + 1
    job = job_service.create_job(total=total)

    frames_dir = str(PROJECTS_DIR / project_id / "frames")
    pos_pts = cached["positive_points"] if cached else []
    neg_pts = cached["negative_points"] if cached else []
    ref_frame = cached.get("reference_frame", body.reference_frame) if cached else body.reference_frame
    direction = body.direction.value
    start_frame = body.start_frame
    end_frame = body.end_frame

    def _propagate(j: job_service.Job) -> None:
        def on_frame(frame_index: int, mask) -> None:
            project_service.save_mask_array(project_id, frame_index, mask)
            with _job_update_lock:
                j.done += 1
                j.last_frame = frame_index

        sam2_service.propagate(
            project_id=project_id,
            frames_dir=frames_dir,
            reference_frame=ref_frame,
            positive_points=pos_pts,
            negative_points=neg_pts,
            start_frame=start_frame,
            end_frame=end_frame,
            direction=direction,
            on_frame=on_frame,
        )

    job_service.run_job_in_background(job, _propagate)
    return PropagateResponse(job_id=job.job_id)


@router.post("/projects/{project_id}/frames/{frame_index}/cache_prompt")
def cache_prompt(project_id: str, frame_index: int, body: dict) -> dict:
    """Cache prompt points for propagation without running inference."""
    with _prompt_cache_lock:
        _prompt_cache[project_id] = {
            "positive_points": body.get("positive_points", []),
            "negative_points": body.get("negative_points", []),
            "reference_frame": frame_index,
        }
    return {"cached": True}


@router.get("/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: str) -> JobResponse:
    job = job_service.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobResponse(
        job_id=job.job_id,
        status=JobStatus(job.status),
        progress=JobProgress(done=job.done, total=job.total),
        last_frame=job.last_frame,
        error=job.error,
    )
