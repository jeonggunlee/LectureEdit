"""FFmpeg / ffprobe 래퍼.

모든 무거운 작업(자르기, 썸네일, 프록시 생성)은 이 모듈을 통해
서브프로세스로 실행되며, progress 콜백과 cancel 이벤트를 지원한다.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Callable, Iterable, Optional

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

ProgressCB = Callable[[float, str], None]  # (0.0~1.0, message)


class FFmpegError(RuntimeError):
    pass


class Cancelled(RuntimeError):
    pass


# ---------------------------------------------------------------- probe
def probe(path: Path) -> dict:
    cmd = [
        FFPROBE, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise FFmpegError(out.stderr.strip() or "ffprobe failed")
    data = json.loads(out.stdout)
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)

    fps = None
    if v:
        for key in ("avg_frame_rate", "r_frame_rate"):
            val = v.get(key)
            if val and val != "0/0":
                num, _, den = val.partition("/")
                try:
                    fps = float(num) / float(den or 1)
                    if fps > 0:
                        break
                except ZeroDivisionError:
                    continue

    duration = float(fmt.get("duration") or (v or {}).get("duration") or 0)
    return {
        "name": path.name,
        "size": int(fmt.get("size") or path.stat().st_size),
        "duration": duration,
        "format": fmt.get("format_name"),
        "width": (v or {}).get("width"),
        "height": (v or {}).get("height"),
        "fps": fps,
        "vcodec": (v or {}).get("codec_name"),
        "acodec": (a or {}).get("codec_name"),
        "has_audio": a is not None,
        "has_video": v is not None,
        # 크롬/파이어폭스에서 바로 재생 가능할 가능성이 높은 조합
        "browser_playable": bool(
            v and v.get("codec_name") in ("h264", "vp8", "vp9", "av1")
            and (a is None or a.get("codec_name") in ("aac", "mp3", "opus", "vorbis"))
            and any(x in (fmt.get("format_name") or "") for x in ("mp4", "webm", "matroska"))
        ),
    }


# ------------------------------------------------------------- utilities
_TIME_RE = re.compile(r"out_time_ms=(\d+)")


def _run_with_progress(
    cmd: list[str],
    total_seconds: float,
    progress: Optional[ProgressCB],
    cancel: Optional[threading.Event],
    base: float = 0.0,
    span: float = 1.0,
    message: str = "",
) -> None:
    """-progress pipe:1 출력을 읽어 진행률을 보고하며 ffmpeg를 실행한다.

    base/span: 전체 작업 중 이 명령이 차지하는 구간 (예: 0.3~0.6 → base=0.3, span=0.3)
    """
    full = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-nostats", "-progress", "pipe:1"] + cmd
    proc = subprocess.Popen(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            if cancel is not None and cancel.is_set():
                proc.kill()
                raise Cancelled("cancelled")
            m = _TIME_RE.search(line)
            if m and progress and total_seconds > 0:
                cur = int(m.group(1)) / 1_000_000.0
                frac = max(0.0, min(1.0, cur / total_seconds))
                progress(base + span * frac, message)
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
    if proc.returncode != 0:
        err = (proc.stderr.read() if proc.stderr else "").strip()
        raise FFmpegError(err or f"ffmpeg exited with {proc.returncode}")
    if progress:
        progress(base + span, message)


def _ffconcat_escape(p: Path) -> str:
    return str(p).replace("'", "'\\''")


# ---------------------------------------------------------------- export
def export_segments(
    src: Path,
    segments: Iterable[tuple[float, float]],
    out: Path,
    mode: str = "copy",
    crf: int = 23,
    preset: str = "veryfast",
    progress: Optional[ProgressCB] = None,
    cancel: Optional[threading.Event] = None,
    base: float = 0.0,
    span: float = 1.0,
) -> Path:
    """keep 구간 목록을 잘라 하나의 파일로 이어붙인다.

    mode="copy"  : 스트림 복사 (무손실, 매우 빠름, 키프레임 단위로 시작점이 약간 앞당겨질 수 있음)
    mode="encode": libx264/aac 재인코딩 (프레임 단위 정밀, 느림)
    base/span    : 전체 작업 중 이 단계가 차지하는 진행률 구간
    """
    segs = [(float(s), float(e)) for s, e in segments if float(e) > float(s)]
    if not segs:
        raise FFmpegError("유효한 구간이 없습니다.")
    total = sum(e - s for s, e in segs)

    work = out.parent / f".tmp_{out.stem}"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    ext = out.suffix or (".mp4" if mode == "encode" else src.suffix)
    parts: list[Path] = []
    done = 0.0
    try:
        for i, (s, e) in enumerate(segs):
            d = e - s
            part = work / f"seg_{i:03d}{ext}"
            if mode == "copy":
                cmd = ["-ss", f"{s:.3f}", "-i", str(src), "-t", f"{d:.3f}",
                       "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
                       "-c", "copy", "-avoid_negative_ts", "make_zero", str(part)]
            else:
                cmd = ["-ss", f"{s:.3f}", "-i", str(src), "-t", f"{d:.3f}",
                       "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
                       "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
                       "-pix_fmt", "yuv420p",
                       "-c:a", "aac", "-b:a", "160k",
                       "-movflags", "+faststart", str(part)]
            _run_with_progress(
                cmd, d, progress, cancel,
                base=base + span * (done / total), span=span * (d / total) * 0.95,
                message=f"구간 {i + 1}/{len(segs)} 처리 중",
            )
            parts.append(part)
            done += d

        if len(parts) == 1:
            shutil.move(str(parts[0]), str(out))
        else:
            listfile = work / "list.txt"
            listfile.write_text(
                "".join(f"file '{_ffconcat_escape(p)}'\n" for p in parts), encoding="utf-8"
            )
            cmd = ["-f", "concat", "-safe", "0", "-i", str(listfile),
                   "-c", "copy", "-movflags", "+faststart", str(out)]
            _run_with_progress(cmd, total, progress, cancel,
                               base=base + span * 0.95, span=span * 0.05, message="구간 이어붙이는 중")
        if progress:
            progress(base + span, "구간 처리 완료")
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ------------------------------------------------------ post-processing
_LOUDNORM_TARGET = "I=-16:TP=-1.5:LRA=11"


def measure_loudness(src: Path, duration: float, progress: Optional[ProgressCB] = None,
                     cancel: Optional[threading.Event] = None, base: float = 0.0, span: float = 1.0) -> dict:
    """loudnorm 1차 패스: 측정값(JSON)을 얻는다."""
    cmd = [FFMPEG, "-hide_banner", "-nostats", "-progress", "pipe:1", "-i", str(src), "-vn",
           "-af", f"loudnorm={_LOUDNORM_TARGET}:print_format=json", "-f", "null", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout is not None and proc.stderr is not None
    err: list[str] = []
    t = threading.Thread(target=lambda: err.extend(proc.stderr.readlines()), daemon=True)  # type: ignore[union-attr]
    t.start()
    try:
        for line in proc.stdout:
            if cancel is not None and cancel.is_set():
                proc.kill()
                raise Cancelled("cancelled")
            m = _TIME_RE.search(line)
            if m and progress and duration > 0:
                progress(base + span * min(1.0, int(m.group(1)) / 1e6 / duration), "음량 측정 중 (1/2)")
        proc.wait()
        t.join(timeout=5)
    finally:
        if proc.poll() is None:
            proc.kill()
    if proc.returncode != 0:
        raise FFmpegError("".join(err[-10:]).strip() or "loudnorm measure failed")
    text = "".join(err)
    start = text.rfind("{")
    end = text.rfind("}")
    if start < 0 or end < 0:
        raise FFmpegError("loudnorm 측정값을 읽지 못했습니다.")
    return json.loads(text[start:end + 1])


def _ffmeta_escape(s: str) -> str:
    return re.sub(r"([=;#\\\n])", r"\\\1", s)


def write_ffmetadata_chapters(chapters: list[dict], duration: float, out: Path) -> Path:
    """[{time, title}] → FFMETADATA 챕터 파일."""
    chs = sorted((c for c in chapters if 0 <= float(c["time"]) < duration), key=lambda c: float(c["time"]))
    lines = [";FFMETADATA1"]
    for i, c in enumerate(chs):
        start = int(float(c["time"]) * 1000)
        end = int((float(chs[i + 1]["time"]) if i + 1 < len(chs) else duration) * 1000)
        if end <= start:
            continue
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}",
                  f"title={_ffmeta_escape(str(c.get('title') or f'챕터 {i + 1}'))}"]
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out


def finalize(
    src: Path, out: Path, duration: float,
    loudnorm: bool = False, srt: Optional[Path] = None, ffmeta: Optional[Path] = None,
    progress: Optional[ProgressCB] = None, cancel: Optional[threading.Event] = None,
    base: float = 0.0, span: float = 1.0,
) -> Path:
    """음량 정규화(2차 패스) / 자막 트랙 / 챕터를 한 번의 ffmpeg 실행으로 적용한다. 영상은 스트림 복사."""
    ext = out.suffix.lower()
    sub_codec = "mov_text" if ext in (".mp4", ".m4v", ".mov") else "srt" if ext == ".mkv" else None
    if srt is not None and sub_codec is None:
        srt = None  # 이 컨테이너에는 자막 트랙을 넣을 수 없음(사이드카 파일만 제공)

    cmd: list[str] = ["-i", str(src)]
    idx = 1
    srt_idx = meta_idx = None
    if srt is not None:
        cmd += ["-i", str(srt)]
        srt_idx = idx
        idx += 1
    if ffmeta is not None:
        cmd += ["-i", str(ffmeta)]
        meta_idx = idx
        idx += 1

    cmd += ["-map", "0:v:0?", "-map", "0:a:0?"]
    if srt_idx is not None:
        cmd += ["-map", str(srt_idx), "-c:s", sub_codec, "-metadata:s:s:0", "language=kor"]
    if meta_idx is not None:
        cmd += ["-map_chapters", str(meta_idx)]
    cmd += ["-c:v", "copy"]

    measure_span = 0.0
    if loudnorm:
        measure_span = span * 0.4
        m = measure_loudness(src, duration, progress, cancel, base=base, span=measure_span)
        af = (f"loudnorm={_LOUDNORM_TARGET}:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
              f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
              f":offset={m['target_offset']}:linear=true")
        cmd += ["-af", af, "-ar", "48000", "-c:a", "aac", "-b:a", "160k"]
    else:
        cmd += ["-c:a", "copy"]
    if ext in (".mp4", ".m4v", ".mov"):
        cmd += ["-movflags", "+faststart"]
    cmd.append(str(out))
    _run_with_progress(cmd, duration, progress, cancel, base=base + measure_span, span=span - measure_span,
                       message="음량 정규화 적용 중 (2/2)" if loudnorm else "자막/챕터 넣는 중")
    return out


# -------------------------------------------------------------- thumbnails
def thumbnail(src: Path, t: float, out: Path, width: int = 160) -> None:
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
           "-ss", f"{max(0.0, t):.3f}", "-i", str(src),
           "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "5", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise FFmpegError(r.stderr.strip())


# ------------------------------------------------------------------ proxy
def make_proxy(
    src: Path, out: Path, duration: float, height: int = 480,
    progress: Optional[ProgressCB] = None, cancel: Optional[threading.Event] = None,
) -> Path:
    """브라우저에서 재생되지 않는 형식(mkv/avi/wmv 등)을 위한 저해상도 미리보기용 mp4."""
    cmd = ["-i", str(src), "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
           "-vf", f"scale=-2:{height}", "-c:v", "libx264", "-preset", "veryfast",
           "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
           "-movflags", "+faststart", str(out)]
    _run_with_progress(cmd, duration, progress, cancel, message="미리보기용 프록시 생성 중")
    return out
