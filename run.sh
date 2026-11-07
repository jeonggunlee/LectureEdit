#!/usr/bin/env bash
# LectureEdit 로컬 서버 실행 스크립트
set -e
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null || { echo "ffmpeg가 설치되어 있지 않습니다. (sudo apt install ffmpeg)"; exit 1; }
PORT="${PORT:-8000}"
echo "LectureEdit: http://127.0.0.1:${PORT}  (종료: Ctrl+C)"
exec python3 -m uvicorn backend.main:app --host 127.0.0.1 --port "$PORT" "$@"
