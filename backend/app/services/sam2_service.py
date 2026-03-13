"""SAM2 service — wraps SAM2 video predictor with lazy loading and per-project session cache."""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np

from app.config import DEVICE, SAM2_CHECKPOINT, SAM2_CONFIG


class SAM2NotAvailable(RuntimeError):
    pass


_model_lock = threading.Lock()
_predictor: Any = None  # SAM2VideoPredictor singleton
_inference_states: dict[str, Any] = {}  # project_id -> inference_state
_state_lock = threading.Lock()


def _load_predictor() -> Any:
    global _predictor
    if _predictor is not None:
        return _predictor
    with _model_lock:
        if _predictor is not None:
            return _predictor
        try:
            from sam2.build_sam import build_sam2_video_predictor  # type: ignore
        except ImportError as exc:
            raise SAM2NotAvailable(
                "SAM2 is not installed. Install with: "
                "pip install git+https://github.com/facebookresearch/sam2.git"
            ) from exc

        weights_path = Path(SAM2_CHECKPOINT)
        if not SAM2_CHECKPOINT or not weights_path.exists():
            raise SAM2NotAvailable(
                f"SAM2 checkpoint not found at '{SAM2_CHECKPOINT}'. "
                "Set LAZYLABEL_WEB_SAM2_CHECKPOINT=/path/to/sam2.1_hiera_large.pt"
            )

        import torch  # type: ignore

        device = DEVICE
        if device == "cuda" and not torch.cuda.is_available():
            raise SAM2NotAvailable(
                "CUDA requested but not available. "
                "Set LAZYLABEL_WEB_DEVICE=cpu (will be very slow) or ensure CUDA drivers are installed."
            )




        # Ensure Hydra is initialised so SAM2 can locate its config.
        # Clear any prior instance first to avoid "already initialised" errors.
        from hydra.core.global_hydra import GlobalHydra  # type: ignore

        GlobalHydra.instance().clear()

        config_path = Path(SAM2_CONFIG)

        if config_path.exists():
            print("is absolute")
        
        if config_path.is_absolute() and config_path.exists():
            # Absolute path to a YAML file on disk (e.g. a custom config).
            from hydra import initialize_config_dir  # type: ignore

            initialize_config_dir(config_dir=str(config_path.parent), version_base="1.2")
            config_name = config_path.stem
        else:
            # Bundled SAM2 config name (e.g. "configs/sam2.1/sam2.1_hiera_large.yaml").
            # Initialise Hydra from the installed SAM2 package so its configs are on
            # the search path.
            from hydra import initialize_config_module  # type: ignore

            initialize_config_module("sam2", version_base="1.2")
            config_name = SAM2_CONFIG
            print(config_name)

        _predictor = build_sam2_video_predictor(config_name, str(weights_path), device=device)
        return _predictor


def is_available() -> bool:
    try:
        import torch  # type: ignore  # noqa: F401
        from sam2.build_sam import build_sam2_video_predictor  # type: ignore  # noqa: F401
        return True
    except ImportError:
        return False


def _get_or_init_state(project_id: str, frames_dir: str) -> Any:
    """Return cached inference state for a project, or create a new one."""
    with _state_lock:
        if project_id in _inference_states:
            return _inference_states[project_id]

    predictor = _load_predictor()
    import torch  # type: ignore

    with torch.inference_mode():
        state = predictor.init_state(video_path=frames_dir)

    with _state_lock:
        _inference_states[project_id] = state
    return state


def invalidate_state(project_id: str) -> None:
    """Remove cached inference state so it will be re-created on next use."""
    with _state_lock:
        _inference_states.pop(project_id, None)


def run_prompt(
    project_id: str,
    frames_dir: str,
    frame_index: int,
    positive_points: list[dict[str, float]],
    negative_points: list[dict[str, float]],
    box: list[float] | None = None,
) -> np.ndarray:
    """Run SAM2 prompt on a single frame. Returns boolean mask array (H, W)."""
    predictor = _load_predictor()

    state = _get_or_init_state(project_id, frames_dir)

    points: list[list[float]] = []
    labels: list[int] = []
    for p in positive_points:
        points.append([p["x"], p["y"]])
        labels.append(1)
    for p in negative_points:
        points.append([p["x"], p["y"]])
        labels.append(0)

    np_points = np.array(points, dtype=np.float32) if points else None
    np_labels = np.array(labels, dtype=np.int32) if labels else None
    np_box = np.array(box, dtype=np.float32) if box is not None else None
    # SAM2's add_new_points_or_box accepts None for points/labels when using a box,
    # and None for box when using points only.  Passing empty arrays instead of None
    # can cause shape-mismatch errors inside SAM2.

    import torch  # type: ignore

    with torch.inference_mode():
        # Reset state for this object id
        predictor.reset_state(state)
        _, _, masks_logits = predictor.add_new_points_or_box(
            inference_state=state,
            frame_idx=frame_index,
            obj_id=1,
            points=np_points,
            labels=np_labels,
            box=np_box,
        )

    mask: np.ndarray = (masks_logits[0, 0].cpu().numpy() > 0.0)
    return mask


def propagate(
    project_id: str,
    frames_dir: str,
    reference_frame: int,
    positive_points: list[dict[str, float]],
    negative_points: list[dict[str, float]],
    start_frame: int,
    end_frame: int,
    direction: str,
    on_frame: Any,
    box: list[float] | None = None,
) -> None:
    """
    Propagate from reference_frame outward.
    on_frame(frame_index, mask_array) is called for each propagated frame.
    """
    predictor = _load_predictor()
    state = _get_or_init_state(project_id, frames_dir)

    points: list[list[float]] = []
    labels: list[int] = []
    for p in positive_points:
        points.append([p["x"], p["y"]])
        labels.append(1)
    for p in negative_points:
        points.append([p["x"], p["y"]])
        labels.append(0)

    np_points = np.array(points, dtype=np.float32) if points else None
    np_labels = np.array(labels, dtype=np.int32) if labels else None
    np_box = np.array(box, dtype=np.float32) if box is not None else None

    import torch  # type: ignore

    with torch.inference_mode():
        predictor.reset_state(state)
        predictor.add_new_points_or_box(
            inference_state=state,
            frame_idx=reference_frame,
            obj_id=1,
            points=np_points,
            labels=np_labels,
            box=np_box,
        )

        # Propagate
        directions_to_run: list[tuple[int, int, bool]] = []
        if direction in ("forward", "both"):
            directions_to_run.append((reference_frame, end_frame, False))
        if direction in ("backward", "both"):
            directions_to_run.append((reference_frame, start_frame, True))

        for _, _, reverse in directions_to_run:
            for frame_idx, obj_ids, mask_logits in predictor.propagate_in_video(
                state, reverse=reverse
            ):
                if not (start_frame <= frame_idx <= end_frame):
                    continue
                mask = (mask_logits[0, 0].cpu().numpy() > 0.0)
                on_frame(frame_idx, mask)
