# LectureEdit — 강의 녹화 영상 편집 웹 앱

대학 수업 녹화 영상을 브라우저에서 빠르게 잘라내기 위한 로컬 실행용 도구입니다.
브라우저는 편집 UI만 담당하고, 실제 자르기/인코딩은 서버(본인 PC)의 FFmpeg가 수행합니다.

## 실행

```bash
# 요구 사항: Python 3.9+, ffmpeg/ffprobe (sudo apt install ffmpeg)
# 자동 자막(Whisper)은 NVIDIA GPU + CUDA 용 PyTorch 가 있으면 GPU 로, 없으면 CPU 로 실행됩니다.
pip install -r requirements.txt
./run.sh                 # http://127.0.0.1:8000
PORT=9000 ./run.sh       # 포트 변경
```

편집할 영상은 `videos/` 폴더에 넣거나(권장, 대용량에 유리) 화면 상단의 **업로드** 버튼으로 올립니다.
결과물은 `output/` 폴더에 저장됩니다.

## 기능

| 기능 | 설명 |
|---|---|
| 가위 방식 자르기 | **✂ 자르기** 도구(`C`)로 타임라인을 클릭하면 그 지점에서 영상이 조각(클립)으로 나뉨. 범위를 드래그하면 그 부분만 따로 분리. 재생 위치에서 `S` |
| 클립 삭제 / 복원 | **↖ 선택** 도구(`V`)로 조각을 클릭하고 `Delete` → 빗금 표시로 삭제. `R` 또는 복원 버튼으로 되살림. Ctrl+클릭 다중 선택, `Ctrl+Z` 되돌리기 |
| 자른 위치 조정 | 자른 선(✂)을 드래그해 이동, 더블클릭 또는 "⟵ 합치기"로 두 조각을 다시 합침. 클립 목록에서 시간 직접 입력 가능 |
| 타임라인 | 썸네일 스트립, 확대(Ctrl+휠, 최대 80배), 눈금자 드래그로 탐색 |
| 프레임 단위 이동 | `←` `→` 1프레임, `Shift` 1초, `Ctrl` 10초 |
| 편집 결과 미리보기 | 재생 중 삭제 구간을 자동으로 건너뛰어 최종 결과를 확인 |
| 빠른 무손실 내보내기 | 스트림 복사(`-c copy`). 재인코딩 없이 수 초~수십 초. 각 구간 시작점이 바로 앞 키프레임에 맞춰짐 |
| 정밀 내보내기 | libx264/aac 재인코딩으로 프레임 단위 정확. CRF/preset 조절 |
| 미리보기 프록시 | mkv/avi/wmv 등 브라우저 재생 불가 형식은 480p 프록시를 만들어 편집, 내보내기는 원본 기준 |
| 자동 자막 생성 | Whisper(large-v3 / turbo / medium / small)로 한국어·영어 음성을 받아써 SRT 로 내려받기. 전문 용어 힌트 입력 가능. 결과는 영상별로 캐시 |
| 대본 기반 편집 | 대본 문장 클릭 = 해당 시점 이동, 검색, 더블클릭으로 오타 수정(서버 저장), 문장을 선택해 **그 구간만 잘라내어 삭제**. 재생 중 현재 문장 강조와 화면 자막 표시 |
| 챕터 마커 | `M` 또는 🔖 버튼으로 재생 위치에 챕터 추가, 타임라인 마커 드래그로 이동. 내보낼 때 MP4/MKV 챕터로 삽입하고 YouTube 설명란용 타임스탬프 텍스트 생성(삭제 구간 반영) |
| 음량 정규화 | 내보내기 옵션. FFmpeg loudnorm 2-pass 로 -16 LUFS / -1.5 dBTP 에 맞춤. 오디오만 재인코딩하고 영상은 그대로 복사 |
| 자막 동기 내보내기 | 편집으로 잘려 나간 부분을 반영해 SRT 시각을 재계산하고, 선택 시 영상 파일에 자막 트랙(mov_text)으로 포함 |
| 프로젝트 저장 | 클립·챕터 상태는 영상별로 브라우저에 자동 저장되며 JSON 파일로 내보내기/불러오기 가능 |
| 2차 편집 | 출력 파일을 `videos/` 로 다시 가져와 추가 편집 |

## 구조

```
backend/
  main.py          FastAPI 라우트 (영상 목록/스트리밍/썸네일/자막/내보내기/작업 상태)
  ffmpeg_tools.py  ffprobe/ffmpeg 래퍼 (자르기, 음량 정규화, 자막·챕터 삽입, 진행률 보고, 취소 지원)
  transcribe.py    Whisper 음성 인식 (GPU 자동 사용, 진행률 보고)
  subtitles.py     SRT 생성, 자막·챕터 시각을 편집 결과 기준으로 재계산
  jobs.py          스레드 기반 백그라운드 작업 관리자
frontend/
  index.html, style.css, app.js   (프레임워크 없는 순수 HTML/JS)
videos/   입력 영상        output/  결과물        .cache/  썸네일·프록시·자막 캐시
```

## API 요약

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/videos` | 입력 영상 목록 |
| POST | `/api/videos/upload` | 업로드 (multipart) |
| GET | `/api/videos/{name}/info` | ffprobe 메타데이터 |
| GET | `/api/videos/{name}/stream` | Range 지원 스트리밍 |
| POST/GET | `/api/videos/{name}/thumbnails` | 썸네일 생성 시작 / 상태 |
| POST/GET | `/api/videos/{name}/proxy` | 프록시 생성 / 스트리밍 |
| GET | `/api/transcribe/info` | Whisper 사용 가능 여부, GPU, 모델 목록 |
| POST | `/api/videos/{name}/transcribe` | `{model, language, initial_prompt, force}` 자막 생성 작업 시작 |
| GET/PUT/DELETE | `/api/videos/{name}/transcript` | 대본 JSON 조회 / 수정 저장 / 삭제 |
| GET | `/api/videos/{name}/transcript.srt` | 원본 기준 SRT 다운로드 |
| POST | `/api/export` | `{source, segments:[{start,end}], mode:"copy"|"encode", crf, preset, output_name, loudnorm, subtitles, embed_subtitles, chapters:[{time,title}], embed_chapters}` — segments 는 **유지**할 구간(삭제되지 않은 클립), chapters 는 원본 기준 시각 |
| GET | `/api/jobs/{id}` · POST `/api/jobs/{id}/cancel` | 작업 진행률 / 취소 |
| GET/DELETE | `/api/outputs[/{name}]` | 결과물 목록 / 다운로드 / 삭제 |

## 참고

- 무손실 모드의 정확도는 원본의 키프레임 간격에 따릅니다. Zoom/OBS 기본 설정은 보통 2~10초 간격이며, 프레임 단위 정확도가 필요하면 정밀 모드를 사용하세요.
- Whisper 모델은 처음 사용할 때 `~/.cache/whisper/` 에 내려받습니다(large-v3 약 3GB). 1시간 강의 기준 RTX 3090 급 GPU 에서 large-v3 는 3~6분, large-v3-turbo 는 1분 안팎입니다.
- 챕터는 영상 파일 안(MP4/MKV 챕터)과 YouTube 설명란 텍스트 두 가지로 제공됩니다. 삭제한 클립 안에 있던 챕터는 다음 남은 구간의 시작으로 옮겨집니다.
- 로컬 전용(127.0.0.1 바인딩)이며 인증이 없습니다. 교내 서버에 올려 여러 사용자가 쓰려면 로그인·사용자별 저장공간·작업 큐가 추가로 필요합니다.
