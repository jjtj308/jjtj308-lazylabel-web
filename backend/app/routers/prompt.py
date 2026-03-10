"""Prompt endpoint — single-frame SAM2 inference."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.config import PROJECTS_DIR
from app.models.schemas import PromptRequest, PromptResponse
from app.services import project_service, sam2_service

router = APIRouter()


@router.post("/projects/{project_id}/frames/{frame_index}/prompt", response_model=PromptResponse)
def run_prompt(project_id: str, frame_index: int, body: PromptRequest) -> PromptResponse:
    meta = project_service.get_project(project_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Project not found")

    frames_dir = str(PROJECTS_DIR / project_id / "frames")

    try:
        mask = sam2_service.run_prompt(
            project_id=project_id,
            frames_dir=frames_dir,
            frame_index=frame_index,
            positive_points=[p.model_dump() for p in body.positive_points],
            negative_points=[p.model_dump() for p in body.negative_points],
            box=body.box,
        )
    except sam2_service.SAM2NotAvailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if body.save:
        project_service.save_mask_array(project_id, frame_index, mask)

    area_px = int(mask.sum())
    mask_url = f"/api/projects/{project_id}/frames/{frame_index}/mask"
    return PromptResponse(mask_url=mask_url, area_px=area_px)
