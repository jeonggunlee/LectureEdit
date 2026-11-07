"""자막(SRT)·챕터 변환 유틸.

편집 결과물은 원본에서 일부 구간(keep)만 이어 붙인 것이므로, 원본 시각을
결과물 시각으로 다시 계산해야 한다.
"""
from __future__ import annotations

from typing import Iterable

Interval = tuple[float, float]

MIN_CUE = 0.2  # 이보다 짧게 남는 자막 조각은 버림 (초)


def _srt_time(t: float) -> str:
    t = max(0.0, t)
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(segments: Iterable[dict]) -> str:
    lines = []
    n = 0
    for seg in segments:
        text = str(seg.get("text", "")).strip()
        if not text or float(seg["end"]) <= float(seg["start"]):
            continue
        n += 1
        lines += [str(n), f"{_srt_time(float(seg['start']))} --> {_srt_time(float(seg['end']))}", text, ""]
    return "\n".join(lines)


def remap_segments(segments: Iterable[dict], keep: list[Interval]) -> list[dict]:
    """원본 시각의 자막을 keep 구간만 이어 붙인 결과물 시각으로 변환."""
    segs = sorted(segments, key=lambda s: float(s["start"]))
    out: list[dict] = []
    offset = 0.0
    for ks, ke in keep:
        for seg in segs:
            s = max(float(seg["start"]), ks)
            e = min(float(seg["end"]), ke)
            if e - s >= MIN_CUE:
                out.append({"start": s - ks + offset, "end": e - ks + offset, "text": seg.get("text", "")})
        offset += ke - ks
    return out


def remap_time(t: float, keep: list[Interval]) -> float | None:
    """원본 시각 t → 결과물 시각. 삭제된 구간 안이면 다음 유지 구간의 시작으로, 뒤에 아무것도 없으면 None."""
    offset = 0.0
    for ks, ke in keep:
        if t < ks:
            return offset
        if t < ke:
            return offset + (t - ks)
        offset += ke - ks
    return None


def remap_chapters(chapters: Iterable[dict], keep: list[Interval]) -> list[dict]:
    out: list[dict] = []
    seen: set[int] = set()
    for c in sorted(chapters, key=lambda c: float(c["time"])):
        t = remap_time(float(c["time"]), keep)
        if t is None:
            continue
        key = int(round(t * 1000))
        if key in seen:
            continue
        seen.add(key)
        out.append({"time": round(t, 3), "title": str(c.get("title") or "").strip() or f"챕터 {len(out) + 1}"})
    return out


def youtube_chapters_text(chapters: list[dict]) -> str:
    """YouTube 설명란용 타임스탬프 목록. 첫 항목은 반드시 00:00 이어야 하므로 없으면 추가."""
    chs = sorted(chapters, key=lambda c: float(c["time"]))
    if not chs or float(chs[0]["time"]) > 0.5:
        chs = [{"time": 0.0, "title": "시작"}] + chs
    lines = []
    use_hours = float(chs[-1]["time"]) >= 3600
    for c in chs:
        t = int(float(c["time"]))
        h, m, s = t // 3600, (t % 3600) // 60, t % 60
        stamp = f"{h}:{m:02d}:{s:02d}" if use_hours else f"{m:02d}:{s:02d}"
        lines.append(f"{stamp} {c['title']}")
    return "\n".join(lines)
