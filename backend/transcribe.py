"""Whisper(openai-whisper) 기반 음성 인식.

- GPU(CUDA)가 있으면 fp16으로 실행, 없으면 CPU.
- 한 번에 하나의 전사만 실행(락), 끝나면 모델을 내려 GPU 메모리를 반환.
- whisper 내부의 tqdm 진행 막대를 가로채 작업 진행률로 보고.
"""
from __future__ import annotations

import threading
import types
from pathlib import Path
from typing import Callable, Optional

from .ffmpeg_tools import Cancelled

ProgressCB = Callable[[float, str], None]

MODELS = [
    {"id": "large-v3", "label": "large-v3 (가장 정확, 3GB)"},
    {"id": "large-v3-turbo", "label": "large-v3-turbo (빠름, 1.6GB)"},
    {"id": "medium", "label": "medium (1.5GB)"},
    {"id": "small", "label": "small (가벼움, 0.5GB)"},
    {"id": "base", "label": "base (빠른 확인용, 0.15GB, 정확도 낮음)"},
]
_lock = threading.Lock()


def info() -> dict:
    try:
        import torch  # noqa: WPS433
        import whisper  # noqa: F401, WPS433
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": f"openai-whisper 가 설치되지 않았습니다 ({exc}). pip install openai-whisper"}
    cuda = torch.cuda.is_available()
    return {
        "available": True,
        "cuda": cuda,
        "device": torch.cuda.get_device_name(0) if cuda else "CPU",
        "models": MODELS,
        "default_model": "large-v3" if cuda else "small",
        "busy": _lock.locked(),
    }


def transcribe(
    media: Path,
    model_name: str = "large-v3",
    language: Optional[str] = "ko",
    initial_prompt: Optional[str] = None,
    progress: Optional[ProgressCB] = None,
    cancel: Optional[threading.Event] = None,
) -> dict:
    import importlib

    import torch
    import whisper

    # whisper 패키지는 `transcribe` 이름을 함수로 덮어쓰므로 모듈은 importlib 로 얻는다
    wt = importlib.import_module("whisper.transcribe")

    def report(frac: float, msg: str) -> None:
        if progress:
            progress(max(0.0, min(1.0, frac)), msg)

    if not _lock.acquire(timeout=1):
        raise RuntimeError("다른 전사 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.")
    model = None
    original_tqdm = wt.tqdm
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        report(0.01, f"모델 불러오는 중 ({model_name}, {device}) — 처음이면 다운로드에 시간이 걸립니다")
        model = whisper.load_model(model_name, device=device)
        report(0.08, "음성 인식 중")

        class _Bar:  # whisper 가 쓰는 tqdm 인터페이스만 흉내낸다
            def __init__(self, total=None, **_):
                self.total = total or 1
                self.n = 0

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def update(self, n):
                if cancel is not None and cancel.is_set():
                    raise Cancelled("cancelled")
                self.n += n
                report(0.08 + 0.9 * self.n / self.total, "음성 인식 중")

            def close(self):
                pass

        wt.tqdm = types.SimpleNamespace(tqdm=_Bar)
        result = model.transcribe(
            str(media),
            language=None if (language in (None, "", "auto")) else language,
            fp16=(device == "cuda"),
            verbose=None,
            condition_on_previous_text=False,   # 긴 녹화에서 같은 문장 반복(환각) 완화
            initial_prompt=(initial_prompt or None),
        )
        segments = []
        for i, s in enumerate(result.get("segments", [])):
            text = (s.get("text") or "").strip()
            if not text:
                continue
            segments.append({"id": i, "start": round(float(s["start"]), 3),
                             "end": round(float(s["end"]), 3), "text": text})
        report(1.0, "완료")
        return {"model": model_name, "language": result.get("language"), "device": device, "segments": segments}
    finally:
        wt.tqdm = original_tqdm
        if model is not None:
            del model
        try:
            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        _lock.release()
