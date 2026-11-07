"""간단한 스레드 기반 백그라운드 작업 관리자 (로컬 단일 사용자용)."""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .ffmpeg_tools import Cancelled


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"  # queued | running | done | error | cancelled
    progress: float = 0.0
    message: str = ""
    result: Any = None
    error: Optional[str] = None
    created: float = field(default_factory=time.time)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(self.progress, 4),
            "message": self.message,
            "result": self.result,
            "error": self.error,
        }


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def start(self, kind: str, fn: Callable[[Job], Any]) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind)
        with self._lock:
            self._jobs[job.id] = job

        def runner() -> None:
            job.status = "running"
            try:
                job.result = fn(job)
                job.progress = 1.0
                job.status = "done"
            except Cancelled:
                job.status = "cancelled"
                job.message = "취소됨"
            except Exception as exc:  # noqa: BLE001
                job.status = "error"
                job.error = str(exc) or exc.__class__.__name__
                traceback.print_exc()

        threading.Thread(target=runner, daemon=True).start()
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status not in ("queued", "running"):
            return False
        job.cancel_event.set()
        return True

    def list(self) -> list[dict]:
        return [j.to_dict() for j in sorted(self._jobs.values(), key=lambda j: -j.created)]
