"""SAM2 service — wraps SAM2 video predictor with lazy loading and per-project session cache."""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np

from app.config import DEVICE, MODELS_DIR, SAM2_CONFIG, SAM2_WEIGHTS


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

        weights_path = Path(SAM2_WEIGHTS)
        if not weights_path.exists():
            raise SAM2NotAvailable(
                f"SAM2 weights not found at '{SAM2_WEIGHTS}'. "
                f"Place the weights file in {MODELS_DIR} or set "
                "LAZYLABEL_WEB_SAM2_WEIGHTS=/path/to/sam2.1_hiera_large.pt"
            )

        import torch  # type: ignore

        device = DEVICE
        if device == "cuda" and not torch.cuda.is_available():
            raise SAM2NotAvailable(
                "CUDA requested but not available. "
                "Set LAZYLABEL_WEB_DEVICE=cpu (will be very slow) or ensure CUDA drivers are installed."
            )

        # Initialize Hydra so SAM2 can locate the config file.
        # Clear any pre-existing global Hydra instance to avoid conflicts.
        from hydra.core.global_hydra import GlobalHydra  # type: ignore

        GlobalHydra.instance().clear()

        config_path = Path(SAM2_CONFIG)
        resolved_config = config_path.resolve()

        if resolved_config.exists():
            # Config file found on disk — initialize Hydra to its parent directory.
            from hydra import initialize_config_dir  # type: ignore

            initialize_config_dir(config_dir=str(resolved_config.parent), version_base="1.2")
            config_name = resolved_config.stem
        else:
            # Config not found on disk; treat it as a name relative to the working
            # directory so SAM2 can resolve it via its own search paths.
            from hydra import initialize  # type: ignore

            initialize(config_path=".", version_base="1.2")
            config_name = SAM2_CONFIG

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
