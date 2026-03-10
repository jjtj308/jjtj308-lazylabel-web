"""Project service — create, list, and read project metadata."""
from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2

from app.config import PROJECTS_DIR
from app.models.schemas import ClassAlias, FrameInfo, ProjectMeta, ProjectSummary


def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def list_projects() -> list[ProjectSummary]:
    summaries: list[ProjectSummary] = []
    if not PROJECTS_DIR.exists():
        return summaries
    for p in sorted(PROJECTS_DIR.iterdir()):
        meta_path = p / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = _read_meta(p.name)
            summaries.append(
                ProjectSummary(
                    project_id=meta.project_id,
                    source_filename=meta.source_filename,
                    frame_count=meta.frame_count,
                    fps=meta.fps,
                    created_at=meta.created_at,
                )
            )
        except Exception:
            pass
    return summaries


def get_project(project_id: str) -> ProjectMeta | None:
    try:
        return _read_meta(project_id)
    except FileNotFoundError:
        return None


def import_video(video_path: str) -> str:
    """Copy video into storage, extract frames, write meta.json. Returns project_id."""
    src = Path(video_path)
    if not src.exists():
        raise FileNotFoundError(f"Video file not found: {video_path}")

    project_id = uuid.uuid4().hex
    proj_dir = _project_dir(project_id)
    source_dir = proj_dir / "source"
    frames_dir = proj_dir / "frames"
    masks_dir = proj_dir / "masks"
    jobs_dir = proj_dir / "jobs"
    exports_dir = proj_dir / "exports"

    for d in (source_dir, frames_dir, masks_dir, jobs_dir, exports_dir):
        d.mkdir(parents=True, exist_ok=True)

    # Copy video
    dest_video = source_dir / ("video" + src.suffix)
    shutil.copy2(src, dest_video)

    # Extract frames
    cap = cv2.VideoCapture(str(dest_video))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {dest_video}")

    fps: float = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_ext = "jpg"
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        out_path = frames_dir / f"{idx:06d}.{frame_ext}"
        cv2.imwrite(str(out_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        idx += 1
    cap.release()

    frame_count = idx
    meta: dict[str, Any] = {
        "project_id": project_id,
        "fps": fps,
        "frame_count": frame_count,
        "width": width,
        "height": height,
        "frame_ext": frame_ext,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_filename": src.name,
        "model_config_": {},
    }
    (proj_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    return project_id


def list_frames(project_id: str) -> list[FrameInfo]:
    meta = _read_meta(project_id)
    proj_dir = _project_dir(project_id)
    masks_dir = proj_dir / "masks"
    labels = get_labels(project_id)
    result = []
    for i in range(meta.frame_count):
        mask_path = masks_dir / f"{i:06d}.png"
        result.append(FrameInfo(frame_index=i, has_mask=mask_path.exists(), class_id=labels.get(i)))
    return result


def get_frame_image_path(project_id: str, frame_index: int) -> Path:
    meta = _read_meta(project_id)
    path = _project_dir(project_id) / "frames" / f"{frame_index:06d}.{meta.frame_ext}"
    if not path.exists():
        raise FileNotFoundError(f"Frame {frame_index} not found")
    return path


def get_mask_path(project_id: str, frame_index: int) -> Path | None:
    path = _project_dir(project_id) / "masks" / f"{frame_index:06d}.png"
    return path if path.exists() else None


def delete_mask(project_id: str, frame_index: int) -> bool:
    path = _project_dir(project_id) / "masks" / f"{frame_index:06d}.png"
    if path.exists():
        path.unlink()
        return True
    return False


def clear_all_masks(project_id: str) -> int:
    """Delete all mask PNGs for a project. Returns the number of deleted files."""
    masks_dir = _project_dir(project_id) / "masks"
    count = 0
    if masks_dir.exists():
        for mask_file in masks_dir.glob("*.png"):
            mask_file.unlink()
            count += 1
    return count


# ── Class aliases ─────────────────────────────────────────────────────────────


def get_classes(project_id: str) -> list[ClassAlias]:
    """Return the list of class aliases for a project."""
    path = _project_dir(project_id) / "classes.json"
    if not path.exists():
        return []
    return [ClassAlias(**c) for c in json.loads(path.read_text())]


def save_classes(project_id: str, classes: list[ClassAlias]) -> None:
    """Persist the class alias list for a project."""
    path = _project_dir(project_id) / "classes.json"
    path.write_text(json.dumps([c.model_dump() for c in classes], indent=2))


# ── Frame labels ──────────────────────────────────────────────────────────────


def get_labels(project_id: str) -> dict[int, int]:
    """Return a dict mapping frame_index -> class_id for all labelled frames."""
    path = _project_dir(project_id) / "labels.json"
    if not path.exists():
        return {}
    try:
        return {int(k): v for k, v in json.loads(path.read_text()).items()}
    except (ValueError, KeyError) as exc:
        raise RuntimeError(f"Failed to parse labels.json for project {project_id}: {exc}") from exc


def set_frame_label(project_id: str, frame_index: int, class_id: int | None) -> None:
    """Assign (or clear) the class label for a single frame."""
    labels = get_labels(project_id)
    if class_id is None:
        labels.pop(frame_index, None)
    else:
        labels[frame_index] = class_id
    path = _project_dir(project_id) / "labels.json"
    path.write_text(json.dumps(labels, indent=2))


def export_masks_zip(project_id: str) -> bytes:
    """Return a ZIP archive containing all mask PNGs, meta.json, classes.json, and labels.json."""
    import io
    import zipfile

    proj_dir = _project_dir(project_id)
    masks_dir = proj_dir / "masks"
    meta_path = proj_dir / "meta.json"
    classes_path = proj_dir / "classes.json"
    labels_path = proj_dir / "labels.json"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if meta_path.exists():
            zf.write(meta_path, "meta.json")
        if classes_path.exists():
            zf.write(classes_path, "classes.json")
        if labels_path.exists():
            zf.write(labels_path, "labels.json")
        if masks_dir.exists():
            for mask_file in sorted(masks_dir.glob("*.png")):
                zf.write(mask_file, f"masks/{mask_file.name}")
    return buf.getvalue()


def save_mask_array(project_id: str, frame_index: int, mask_array: Any) -> Path:
    """Save a numpy boolean/uint8 mask as an RGBA PNG.

    The mask value is stored in the alpha channel so that non-mask pixels are
    fully transparent (alpha=0) and mask pixels are fully opaque (alpha=255).
    This allows the frontend to use canvas ``source-in`` compositing to tint
    only the masked region without bleeding the colour into the background.
    """
    from PIL import Image
    import numpy as np

    masks_dir = _project_dir(project_id) / "masks"
    masks_dir.mkdir(parents=True, exist_ok=True)
    out_path = masks_dir / f"{frame_index:06d}.png"
    alpha = (np.asarray(mask_array, dtype=bool).astype(np.uint8) * 255)
    rgba = np.zeros(alpha.shape + (4,), dtype=np.uint8)
    rgba[..., 3] = alpha
    Image.fromarray(rgba, mode="RGBA").save(str(out_path))
    return out_path


def _read_meta(project_id: str) -> ProjectMeta:
    meta_path = _project_dir(project_id) / "meta.json"
    if not meta_path.exists():
        raise FileNotFoundError(f"Project not found: {project_id}")
    data = json.loads(meta_path.read_text())
    return ProjectMeta(**data)
