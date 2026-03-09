"""Background job manager for propagation tasks."""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Job:
    job_id: str
    status: str = "queued"  # queued | running | completed | failed
    done: int = 0
    total: int = 0
    last_frame: int | None = None
    error: str | None = None


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def create_job(total: int) -> Job:
    job_id = uuid.uuid4().hex
    job = Job(job_id=job_id, total=total)
    with _lock:
        _jobs[job_id] = job
    return job


def get_job(job_id: str) -> Job | None:
    with _lock:
        return _jobs.get(job_id)


def run_job_in_background(job: Job, fn: Callable[[Job], None]) -> None:
    """Run *fn* in a daemon thread; fn receives the Job and updates it."""

    def _run() -> None:
        with _lock:
            job.status = "running"
        try:
            fn(job)
            with _lock:
                job.status = "completed"
        except Exception as exc:
            with _lock:
                job.status = "failed"
                job.error = str(exc)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
