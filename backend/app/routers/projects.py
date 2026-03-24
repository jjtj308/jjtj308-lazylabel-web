"""Projects and frames endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from app.models.schemas import (
    ClassAlias,
    ClassAliasesRequest,
    FrameInfo,
    FrameLabelRequest,
    ImportVideoRequest,
    ImportVideoResponse,
    ProjectMeta,
    ProjectSummary,
)
from app.services import project_service

router = APIRouter()


# ── Projects ─────────────────────────────────────────────────────────────────


@router.get("/projects", response_model=list[ProjectSummary])
def list_projects() -> list[ProjectSummary]:
    return project_service.list_projects()


@router.post("/projects/import_video", response_model=ImportVideoResponse)
def import_video(body: ImportVideoRequest) -> ImportVideoResponse:
    try:
        project_id = project_service.import_video(body.video_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return ImportVideoResponse(project_id=project_id)


@router.get("/projects/{project_id}", response_model=ProjectMeta)
def get_project(project_id: str) -> ProjectMeta:
    meta = project_service.get_project(project_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return meta


# ── Frames ────────────────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/frames", response_model=list[FrameInfo])
def list_frames(project_id: str) -> list[FrameInfo]:
    if project_service.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project_service.list_frames(project_id)


@router.get("/projects/{project_id}/frames/{frame_index}/image")
def get_frame_image(project_id: str, frame_index: int) -> FileResponse:
    try:
        path = project_service.get_frame_image_path(project_id, frame_index)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    # Frames are immutable once extracted, so they can be cached indefinitely.
    return FileResponse(
        str(path),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/projects/{project_id}/frames/{frame_index}/mask")
def get_frame_mask(project_id: str, frame_index: int) -> FileResponse:
    path = project_service.get_mask_path(project_id, frame_index)
    if path is None:
        raise HTTPException(status_code=404, detail="Mask not found")
    return FileResponse(str(path), media_type="image/png")


@router.delete("/projects/{project_id}/frames/{frame_index}/mask")
def delete_frame_mask(project_id: str, frame_index: int) -> dict:
    deleted = project_service.delete_mask(project_id, frame_index)
    if not deleted:
        raise HTTPException(status_code=404, detail="Mask not found")
    return {"deleted": True}


@router.delete("/projects/{project_id}/masks")
def clear_all_masks(project_id: str) -> dict:
    if project_service.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    count = project_service.clear_all_masks(project_id)
    return {"deleted": count}


@router.get("/projects/{project_id}/export")
def export_project(project_id: str) -> Response:
    meta = project_service.get_project(project_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Project not found")
    data = project_service.export_masks_zip(project_id)
    safe_name = meta.source_filename.replace('"', '_')
    filename = f"{safe_name}_masks.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Class aliases ──────────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/classes", response_model=list[ClassAlias])
def get_classes(project_id: str) -> list[ClassAlias]:
    if project_service.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project_service.get_classes(project_id)


@router.put("/projects/{project_id}/classes")
def save_classes(project_id: str, body: ClassAliasesRequest) -> dict:
    if project_service.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    project_service.save_classes(project_id, body.classes)
    return {"saved": len(body.classes)}


# ── Frame labels ───────────────────────────────────────────────────────────────


@router.put("/projects/{project_id}/frames/{frame_index}/label")
def set_frame_label(project_id: str, frame_index: int, body: FrameLabelRequest) -> dict:
    if project_service.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    project_service.set_frame_label(project_id, frame_index, body.class_id)
    return {"frame_index": frame_index, "class_id": body.class_id}
