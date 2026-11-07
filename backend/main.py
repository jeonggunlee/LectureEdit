"""LectureEdit - 강의 영상 편집 웹 앱 (로컬 실행용) FastAPI 백엔드."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Iterator, Optional

from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ffmpeg_tools as ff
from . import transcribe as stt
from .jobs import Job, JobManager
from .subtitles import remap_chapters, remap_segments, to_srt, youtube_chapters_text

ROOT = Path(__file__).resolve().parent.parent
VIDEO_DIR = ROOT / "videos"
OUTPUT_DIR = ROOT / "output"
CACHE_DIR = ROOT / ".cache"
THUMB_DIR = CACHE_DIR / "thumbs"
PROXY_DIR = CACHE_DIR / "proxy"
TRANSCRIPT_DIR = CACHE_DIR / "transcripts"
FRONTEND_DIR = ROOT / "frontend"
for d in (VIDEO_DIR, OUTPUT_DIR, THUMB_DIR, PROXY_DIR, TRANSCRIPT_DIR):
    d.mkdir(parents=True, exist_ok=True)

VIDEO_EXT = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".wmv", ".flv", ".ts", ".mts", ".m2ts", ".mpg", ".mpeg"}

app = FastAPI(title="LectureEdit", version="0.1.0")
jobs = JobManager()


# ---------------------------------------------------------------- helpers
def _safe_name(name: str) -> str:
    if not name or name != Path(name).name or name.startswith("."):
        raise HTTPException(400, "잘못된 파일 이름입니다.")
    return name


def _video_path(name: str) -> Path:
    p = VIDEO_DIR / _safe_name(name)
    if not p.is_file():
        raise HTTPException(404, f"영상을 찾을 수 없습니다: {name}")
    return p


def _file_key(p: Path) -> str:
    st = p.stat()
    return hashlib.sha1(f"{p.name}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:16]


def _unique_path(directory: Path, filename: str) -> Path:
    p = directory / filename
    if not p.exists():
        return p
    stem, suffix = p.stem, p.suffix
    for i in range(1, 1000):
        cand = directory / f"{stem}_{i}{suffix}"
        if not cand.exists():
            return cand
    raise HTTPException(500, "출력 파일 이름을 만들 수 없습니다.")


_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def _range_response(path: Path, request: Request, media_type: str = "video/mp4") -> StreamingResponse | FileResponse:
    """HTTP Range 요청을 지원하는 파일 응답 (영상 탐색에 필수)."""
    size = path.stat().st_size
    rng = request.headers.get("range")
    if not rng:
        return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})
    m = _RANGE_RE.match(rng)
    if not m:
        raise HTTPException(416, "Invalid range")
    start = int(m.group(1)) if m.group(1) else 0
    end = int(m.group(2)) if m.group(2) else size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        raise HTTPException(416, "Range not satisfiable", headers={"Content-Range": f"bytes */{size}"})
    length = end - start + 1

    def iterator(chunk: int = 1024 * 1024) -> Iterator[bytes]:
        with path.open("rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                data = f.read(min(chunk, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    }
    return StreamingResponse(iterator(), status_code=206, media_type=media_type, headers=headers)


def _media_type(p: Path) -> str:
    return {
        ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
        ".webm": "video/webm", ".mkv": "video/x-matroska",
    }.get(p.suffix.lower(), "application/octet-stream")


# ----------------------------------------------------------------- videos
@app.get("/api/videos")
def list_videos() -> list[dict]:
    items = []
    for p in sorted(VIDEO_DIR.iterdir(), key=lambda x: x.name.lower()):
        if p.is_file() and p.suffix.lower() in VIDEO_EXT and not p.name.startswith("."):
            st = p.stat()
            items.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
    return items


@app.post("/api/videos/upload")
async def upload_video(file: UploadFile) -> dict:
    name = _safe_name(Path(file.filename or "upload.mp4").name)
    if Path(name).suffix.lower() not in VIDEO_EXT:
        raise HTTPException(400, "지원하지 않는 확장자입니다.")
    dest = _unique_path(VIDEO_DIR, name)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with tmp.open("wb") as f:
            while chunk := await file.read(4 * 1024 * 1024):
                f.write(chunk)
        tmp.rename(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return {"name": dest.name, "size": dest.stat().st_size}


@app.get("/api/videos/{name}/info")
def video_info(name: str) -> dict:
    p = _video_path(name)
    try:
        info = ff.probe(p)
    except ff.FFmpegError as e:
        raise HTTPException(500, f"ffprobe 실패: {e}")
    proxy = PROXY_DIR / f"{_file_key(p)}.mp4"
    info["proxy_ready"] = proxy.is_file()
    return info


@app.get("/api/videos/{name}/stream")
def video_stream(name: str, request: Request):
    p = _video_path(name)
    return _range_response(p, request, _media_type(p))


# --------------------------------------------------------------- proxy
@app.post("/api/videos/{name}/proxy")
def create_proxy(name: str) -> dict:
    p = _video_path(name)
    proxy = PROXY_DIR / f"{_file_key(p)}.mp4"
    if proxy.is_file():
        return {"ready": True}
    info = ff.probe(p)

    def work(job: Job):
        tmp = proxy.with_suffix(".part.mp4")
        try:
            ff.make_proxy(p, tmp, info["duration"],
                          progress=lambda f, m: _set(job, f, m), cancel=job.cancel_event)
            tmp.rename(proxy)
        finally:
            tmp.unlink(missing_ok=True)
        return {"ready": True}

    job = jobs.start("proxy", work)
    return {"ready": False, "job": job.to_dict()}


@app.get("/api/videos/{name}/proxy")
def proxy_stream(name: str, request: Request):
    p = _video_path(name)
    proxy = PROXY_DIR / f"{_file_key(p)}.mp4"
    if not proxy.is_file():
        raise HTTPException(404, "프록시가 아직 없습니다.")
    return _range_response(proxy, request, "video/mp4")


# ------------------------------------------------------------- thumbnails
_THUMB_COUNT = 60


@app.post("/api/videos/{name}/thumbnails")
def create_thumbnails(name: str, count: int = _THUMB_COUNT) -> dict:
    p = _video_path(name)
    count = max(5, min(count, 300))
    tdir = THUMB_DIR / f"{_file_key(p)}_{count}"
    tdir.mkdir(parents=True, exist_ok=True)
    meta_path = tdir / "meta.json"
    if meta_path.is_file():
        return json.loads(meta_path.read_text())
    info = ff.probe(p)
    duration = info["duration"]
    interval = duration / count if count else duration
    times = [interval * (i + 0.5) for i in range(count)]

    def work(job: Job):
        for i, t in enumerate(times):
            if job.cancel_event.is_set():
                raise ff.Cancelled()
            out = tdir / f"{i:03d}.jpg"
            if not out.is_file():
                try:
                    ff.thumbnail(p, t, out)
                except ff.FFmpegError:
                    pass  # 일부 프레임 실패는 무시
            _set(job, (i + 1) / count, "썸네일 생성 중")
        meta = {"count": count, "interval": interval, "duration": duration, "complete": True}
        meta_path.write_text(json.dumps(meta))
        return meta

    job = jobs.start("thumbnails", work)
    return {"count": count, "interval": interval, "duration": duration, "complete": False, "job": job.to_dict()}


@app.get("/api/videos/{name}/thumbnails")
def thumbnails_status(name: str, count: int = _THUMB_COUNT) -> dict:
    p = _video_path(name)
    tdir = THUMB_DIR / f"{_file_key(p)}_{count}"
    ready = sorted(int(f.stem) for f in tdir.glob("*.jpg")) if tdir.is_dir() else []
    return {"count": count, "ready": ready, "complete": (tdir / "meta.json").is_file()}


@app.get("/api/videos/{name}/thumbnails/{idx}.jpg")
def thumbnail_image(name: str, idx: int, count: int = _THUMB_COUNT):
    p = _video_path(name)
    f = THUMB_DIR / f"{_file_key(p)}_{count}" / f"{idx:03d}.jpg"
    if not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


# ------------------------------------------------------------- transcript
def _transcript_path(p: Path) -> Path:
    return TRANSCRIPT_DIR / f"{_file_key(p)}.json"


def _load_transcript(p: Path) -> Optional[dict]:
    tp = _transcript_path(p)
    return json.loads(tp.read_text(encoding="utf-8")) if tp.is_file() else None


class TranscribeRequest(BaseModel):
    model: str = "large-v3"
    language: str = "ko"
    initial_prompt: Optional[str] = Field(None, max_length=1000, description="전문 용어 힌트")
    force: bool = False


@app.get("/api/transcribe/info")
def transcribe_info() -> dict:
    return stt.info()


@app.post("/api/videos/{name}/transcribe")
def start_transcribe(name: str, req: TranscribeRequest) -> dict:
    p = _video_path(name)
    if req.model not in {m["id"] for m in stt.MODELS}:
        raise HTTPException(400, "지원하지 않는 모델입니다.")
    if not req.force and _transcript_path(p).is_file():
        return {"ready": True}
    info = stt.info()
    if not info.get("available"):
        raise HTTPException(503, info.get("reason", "Whisper 를 사용할 수 없습니다."))
    if not ff.probe(p)["has_audio"]:
        raise HTTPException(400, "오디오 트랙이 없는 영상입니다.")

    def work(job: Job):
        res = stt.transcribe(p, req.model, req.language, req.initial_prompt,
                             progress=lambda f, m: _set(job, f, m), cancel=job.cancel_event)
        res["source"] = p.name
        _transcript_path(p).write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
        return {"segments": len(res["segments"]), "language": res.get("language")}

    return {"ready": False, "job": jobs.start("transcribe", work).to_dict()}


@app.get("/api/videos/{name}/transcript")
def get_transcript(name: str) -> dict:
    t = _load_transcript(_video_path(name))
    if t is None:
        raise HTTPException(404, "아직 자막이 없습니다.")
    return t


class TranscriptSegment(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str = Field(max_length=2000)


class TranscriptUpdate(BaseModel):
    segments: list[TranscriptSegment]


@app.put("/api/videos/{name}/transcript")
def update_transcript(name: str, req: TranscriptUpdate) -> dict:
    p = _video_path(name)
    t = _load_transcript(p) or {"model": "manual", "language": "ko"}
    t["segments"] = [{"id": i, "start": s.start, "end": s.end, "text": s.text.strip()}
                     for i, s in enumerate(req.segments) if s.text.strip() and s.end > s.start]
    t["source"] = p.name
    _transcript_path(p).write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
    return {"segments": len(t["segments"])}


@app.delete("/api/videos/{name}/transcript")
def delete_transcript(name: str) -> dict:
    tp = _transcript_path(_video_path(name))
    if tp.is_file():
        tp.unlink()
    return {"deleted": True}


@app.get("/api/videos/{name}/transcript.srt")
def transcript_srt(name: str):
    p = _video_path(name)
    t = _load_transcript(p)
    if t is None:
        raise HTTPException(404, "아직 자막이 없습니다.")
    body = to_srt(t["segments"])
    return Response(body, media_type="application/x-subrip; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(p.stem)}.srt"})


# ----------------------------------------------------------------- export
class Segment(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)


class Chapter(BaseModel):
    time: float = Field(ge=0)
    title: str = Field("", max_length=200)


class ExportRequest(BaseModel):
    source: str
    segments: list[Segment] = Field(min_length=1, description="유지(keep)할 구간 목록")
    mode: str = Field("copy", pattern="^(copy|encode)$")
    crf: int = Field(23, ge=14, le=35)
    preset: str = Field("veryfast", pattern="^(ultrafast|superfast|veryfast|faster|fast|medium|slow)$")
    output_name: Optional[str] = None
    loudnorm: bool = False
    subtitles: bool = False            # 편집 결과 기준으로 시간 재계산한 SRT 파일 저장
    embed_subtitles: bool = False      # 영상 파일 안에 자막 트랙 포함
    chapters: list[Chapter] = Field(default_factory=list)   # 원본 기준 시각
    embed_chapters: bool = False


@app.post("/api/export")
def export(req: ExportRequest) -> dict:
    src = _video_path(req.source)
    segs = sorted(((s.start, s.end) for s in req.segments if s.end > s.start), key=lambda x: x[0])
    if not segs:
        raise HTTPException(400, "유효한 구간이 없습니다.")
    # 겹치는 구간 병합
    merged: list[list[float]] = []
    for s, e in segs:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    keep = [(float(a), float(b)) for a, b in merged]
    out_duration = sum(b - a for a, b in keep)

    ext = ".mp4" if req.mode == "encode" else src.suffix
    base = _safe_name(req.output_name) if req.output_name else f"{src.stem}_edited"
    base = Path(base).stem + ext
    out = _unique_path(OUTPUT_DIR, base)

    transcript = _load_transcript(src) if (req.subtitles or req.embed_subtitles) else None
    if (req.subtitles or req.embed_subtitles) and transcript is None:
        raise HTTPException(400, "자막을 먼저 생성하세요.")
    chapters = [{"time": c.time, "title": c.title} for c in req.chapters]
    need_finalize = req.loudnorm or (req.embed_subtitles and transcript) or (req.embed_chapters and chapters)

    def work(job: Job):
        prog = lambda f, m: _set(job, f, m)  # noqa: E731
        result: dict = {}
        # 1) 자막/챕터를 결과물 시간축으로 재계산
        srt_path = None
        if transcript is not None:
            cues = remap_segments(transcript["segments"], keep)
            srt_path = out.with_suffix(".srt")
            srt_path.write_text(to_srt(cues), encoding="utf-8")
            result["srt"] = srt_path.name
            result["cues"] = len(cues)
        out_chapters = remap_chapters(chapters, keep)
        if out_chapters:
            result["chapters_text"] = youtube_chapters_text(out_chapters)
        # 2) 자르기 + 이어붙이기
        stage1 = out if not need_finalize else out.parent / f".stage_{out.name}"
        try:
            ff.export_segments(src, keep, stage1, mode=req.mode, crf=req.crf, preset=req.preset,
                               progress=prog, cancel=job.cancel_event, base=0.0, span=0.75 if need_finalize else 1.0)
            # 3) 음량 정규화 / 자막 트랙 / 챕터
            if need_finalize:
                meta = None
                if req.embed_chapters and out_chapters:
                    meta = ff.write_ffmetadata_chapters(out_chapters, out_duration, out.parent / f".chapters_{out.stem}.txt")
                try:
                    ff.finalize(stage1, out, out_duration, loudnorm=req.loudnorm,
                                srt=srt_path if req.embed_subtitles else None, ffmeta=meta,
                                progress=prog, cancel=job.cancel_event, base=0.75, span=0.25)
                finally:
                    if meta is not None:
                        meta.unlink(missing_ok=True)
        finally:
            if stage1 != out:
                stage1.unlink(missing_ok=True)
        if srt_path is not None and not req.subtitles:
            srt_path.unlink(missing_ok=True)
            result.pop("srt", None)
        _set(job, 1.0, "완료")
        result.update({"output": out.name, "size": out.stat().st_size, "duration": out_duration})
        return result

    job = jobs.start("export", work)
    return job.to_dict()


@app.get("/api/outputs")
def list_outputs() -> list[dict]:
    items = []
    for p in sorted(OUTPUT_DIR.iterdir(), key=lambda x: -x.stat().st_mtime):
        if p.is_file() and not p.name.startswith("."):
            st = p.stat()
            items.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
    return items


@app.get("/api/outputs/{name}")
def download_output(name: str):
    p = OUTPUT_DIR / _safe_name(name)
    if not p.is_file():
        raise HTTPException(404)
    return FileResponse(p, media_type="application/octet-stream", filename=p.name)


@app.delete("/api/outputs/{name}")
def delete_output(name: str) -> dict:
    p = OUTPUT_DIR / _safe_name(name)
    if not p.is_file():
        raise HTTPException(404)
    p.unlink()
    return {"deleted": name}


@app.post("/api/outputs/{name}/to-videos")
def output_to_videos(name: str) -> dict:
    """내보낸 결과를 다시 편집 소스로 가져오기 (2차 편집용)."""
    p = OUTPUT_DIR / _safe_name(name)
    if not p.is_file():
        raise HTTPException(404)
    dest = _unique_path(VIDEO_DIR, p.name)
    shutil.copy2(p, dest)
    return {"name": dest.name}


# ------------------------------------------------------------------- jobs
def _set(job: Job, frac: float, msg: str) -> None:
    job.progress = frac
    if msg:
        job.message = msg


@app.get("/api/jobs")
def list_jobs() -> list[dict]:
    return jobs.list()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return job.to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    return {"cancelled": jobs.cancel(job_id)}


# --------------------------------------------------------------- frontend
@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.exception_handler(ff.FFmpegError)
def _ffmpeg_error(_: Request, exc: ff.FFmpegError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})
