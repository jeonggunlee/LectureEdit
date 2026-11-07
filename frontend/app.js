'use strict';
/* LectureEdit 프론트엔드 - 가위(razor) 방식 클립 편집 + 대본·챕터
 *
 * 모델: clips = [{id, start, end, deleted}] 가 영상 전체 [0, duration] 를 빈틈없이 덮는다.
 *  - 자르기(split): 시점 t 를 포함하는 클립을 둘로 나눈다.
 *  - 삭제: 클립의 deleted 플래그를 켠다 (재생 시 건너뛰고, 내보내기에서 제외).
 *  - 합치기(merge): 경계를 없애 두 클립을 하나로.
 *  - 내보내기: deleted 가 아닌 클립들을 이어 붙인 구간 목록을 서버로 보낸다.
 * transcript = [{start, end, text}] (Whisper 결과, 원본 시각 기준)
 * chapters   = [{id, time, title}]  (원본 시각 기준; 내보낼 때 결과물 시각으로 재계산)
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const ids = [
  'video', 'subtitleOverlay', 'videoNotice', 'videoSelect', 'refreshBtn', 'uploadInput', 'uploadStatus', 'videoInfo',
  'playBtn', 'curTime', 'durTime', 'speed', 'skipCuts', 'showSubs',
  'toolGroup', 'splitBtn', 'deleteBtn', 'restoreBtn', 'undoBtn', 'chapterBtn', 'zoom', 'zoomLabel',
  'timelineScroll', 'timeline', 'ruler', 'chapLayer', 'thumbs', 'clipLayer', 'cutLayer', 'rangeSel', 'hoverLine', 'playhead',
  'tabs', 'badgeClips', 'badgeTranscript', 'badgeChapters',
  'clipList', 'clipSummary', 'restoreAll', 'clearCuts', 'exportJson', 'importJson',
  'trGenPanel', 'trDevice', 'trModel', 'trLang', 'trPrompt', 'trStart', 'trCancel', 'trProgress', 'trNote',
  'trPanel', 'trSummary', 'trSearch', 'trFollow', 'trCutBtn', 'trKeepBtn', 'trSrtLink', 'trRedo', 'trList',
  'chSummary', 'chAddBtn', 'chClear', 'chList', 'chText', 'chCopy',
  'outName', 'encodeOpts', 'crf', 'preset', 'optLoudnorm', 'optSrt', 'optSrtNote', 'optEmbedSrt', 'optChapters', 'optChNote',
  'exportBtn', 'cancelExport', 'exportProgress', 'exportResult', 'outputs',
];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const state = {
  name: null, info: null, duration: 0, fps: 30,
  clips: [],                 // {id, start, end, deleted}
  selected: new Set(),       // 선택된 클립 id
  tool: 'select',            // 'select' | 'razor'
  undo: [],
  zoom: 1,
  thumbCount: 60, thumbsReady: new Set(), thumbTimer: null,
  transcript: null, trMeta: null, trSelected: new Set(), trCurrent: -1, trQuery: '', trForce: false,
  chapters: [], chSelected: null,
  sttInfo: null,
  jobs: { export: null, transcribe: null },
  nextId: 1,
};
const MIN_CLIP = 0.04; // 이보다 짧은 조각은 만들지 않음 (초)

/* ------------------------------------------------------------- utils */
async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) { /* ignore */ }
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return res.status === 204 ? null : res.json();
}
const postJson = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const putJson = (url, body) => api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function fmt(t, withMs = true) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return withMs ? `${base}.${String(ms).padStart(3, '0')}` : base;
}
function fmtShort(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function parseTime(str) {
  str = String(str).trim();
  if (!str) return NaN;
  const parts = str.split(':').map(Number);
  if (parts.some((p) => isNaN(p))) return NaN;
  let t = 0;
  for (const p of parts) t = t * 60 + p;
  return t;
}
const fmtSize = (b) => b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snapFrame = (t) => clamp(Math.round(t * state.fps) / state.fps, 0, state.duration);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = () => encodeURIComponent(state.name);

/* --------------------------------------------------------------- tabs */
function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
}
els.tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
const activeTab = () => ($('#tabs button.active') || {}).dataset?.tab;

/* ------------------------------------------------------ video loading */
async function loadVideos(selectName) {
  const list = await api('/api/videos');
  els.videoSelect.innerHTML = '<option value="">영상 선택…</option>' +
    list.map((v) => `<option value="${encodeURIComponent(v.name)}">${esc(v.name)} (${fmtSize(v.size)})</option>`).join('');
  if (selectName) {
    els.videoSelect.value = encodeURIComponent(selectName);
    await selectVideo(selectName);
  } else if (state.name) {
    els.videoSelect.value = encodeURIComponent(state.name);
  }
}

async function selectVideo(name) {
  stopThumbPolling();
  state.name = name;
  state.clips = []; state.selected.clear(); state.undo = [];
  state.chapters = []; state.chSelected = null;
  state.transcript = null; state.trMeta = null; state.trSelected.clear(); state.trCurrent = -1; state.trForce = false;
  state.thumbsReady = new Set();
  els.videoNotice.classList.add('hidden');
  els.exportResult.textContent = '';
  els.subtitleOverlay.classList.add('hidden');
  try {
    state.info = await api(`/api/videos/${enc()}/info`);
  } catch (e) {
    els.videoInfo.textContent = `정보 읽기 실패: ${e.message}`;
    return;
  }
  const i = state.info;
  state.duration = i.duration; state.fps = i.fps || 30;
  els.videoInfo.textContent = `${i.width}×${i.height} · ${i.fps ? i.fps.toFixed(2) + 'fps' : ''} · ${i.vcodec}/${i.acodec || '무음'} · ${fmt(i.duration, false)} · ${fmtSize(i.size)}`;
  els.durTime.textContent = fmt(i.duration);

  if (i.browser_playable) {
    els.video.src = `/api/videos/${enc()}/stream`;
  } else if (i.proxy_ready) {
    els.video.src = `/api/videos/${enc()}/proxy`;
    showNotice('원본 형식은 브라우저에서 재생되지 않아 미리보기용 프록시로 표시 중입니다. 내보내기는 원본 기준으로 처리됩니다.');
  } else {
    els.video.removeAttribute('src');
    offerProxy();
  }
  loadProject();
  renderAll();
  startThumbnails();
  loadOutputs();
  loadTranscript();
}

function showNotice(html, button) {
  els.videoNotice.innerHTML = `<span>${html}</span>`;
  if (button) els.videoNotice.appendChild(button);
  els.videoNotice.classList.remove('hidden');
}

function offerProxy() {
  const btn = document.createElement('button');
  btn.className = 'primary'; btn.textContent = '미리보기용 프록시 생성';
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await postJson(`/api/videos/${enc()}/proxy`, {});
      if (r.ready) return selectVideo(state.name);
      await trackJob(r.job.id, (j) => showNotice(`프록시 생성 중… ${(j.progress * 100).toFixed(0)}% <span class="muted">(${j.message || ''})</span>`));
      await selectVideo(state.name);
    } catch (e) { showNotice(`프록시 생성 실패: ${e.message}`); }
  };
  showNotice(`이 형식(${state.info.vcodec}/${state.info.acodec}, ${state.info.format})은 브라우저에서 직접 재생되지 않습니다. 저해상도 미리보기용 프록시를 만들면 편집할 수 있습니다(내보내기는 원본 품질 유지).`, btn);
}

els.video.addEventListener('error', () => {
  if (!state.name || !els.video.getAttribute('src')) return;
  if (els.video.getAttribute('src').endsWith('/proxy')) return;
  offerProxy();
});

/* ------------------------------------------------------- thumbnails */
async function startThumbnails() {
  els.thumbs.innerHTML = '';
  renderThumbs();
  try {
    const r = await postJson(`/api/videos/${enc()}/thumbnails?count=${state.thumbCount}`, {});
    if (r.complete) { state.thumbsReady = new Set([...Array(r.count).keys()]); renderThumbs(); return; }
  } catch (e) { console.warn('thumbnails', e); return; }
  const name = state.name;
  const poll = async () => {
    if (state.name !== name) return;
    try {
      const st = await api(`/api/videos/${enc()}/thumbnails?count=${state.thumbCount}`);
      state.thumbsReady = new Set(st.ready);
      renderThumbs();
      if (!st.complete) state.thumbTimer = setTimeout(poll, 1500);
    } catch (_) { /* ignore */ }
  };
  state.thumbTimer = setTimeout(poll, 1200);
}
function stopThumbPolling() { if (state.thumbTimer) clearTimeout(state.thumbTimer); state.thumbTimer = null; }

function renderThumbs() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < state.thumbCount; i++) {
    const existing = els.thumbs.children[i];
    if (state.thumbsReady.has(i)) {
      if (existing && existing.tagName === 'IMG') continue;
      const img = document.createElement('img');
      img.src = `/api/videos/${enc()}/thumbnails/${i}.jpg?count=${state.thumbCount}`;
      img.loading = 'lazy';
      if (existing) els.thumbs.replaceChild(img, existing); else frag.appendChild(img);
    } else if (!existing) {
      const ph = document.createElement('div'); ph.className = 'ph'; frag.appendChild(ph);
    }
  }
  if (frag.childNodes.length) els.thumbs.appendChild(frag);
}

/* --------------------------------------------------------- clip model */
function resetClips() {
  state.clips = [{ id: state.nextId++, start: 0, end: state.duration, deleted: false }];
  state.selected.clear();
}
function pushUndo() {
  state.undo.push(JSON.stringify(state.clips));
  if (state.undo.length > 100) state.undo.shift();
  els.undoBtn.disabled = false;
}
function undo() {
  if (!state.undo.length) return;
  state.clips = JSON.parse(state.undo.pop());
  state.selected = new Set([...state.selected].filter((id) => state.clips.some((c) => c.id === id)));
  els.undoBtn.disabled = !state.undo.length;
  commit();
}
function commit() {
  // 유효성 보정: 정렬·연속성
  state.clips.sort((a, b) => a.start - b.start);
  if (state.clips.length) { state.clips[0].start = 0; state.clips[state.clips.length - 1].end = state.duration; }
  for (let i = 1; i < state.clips.length; i++) state.clips[i].start = state.clips[i - 1].end;
  saveProject(); renderAll(); renderTranscriptList(); renderChapters();
}
const clipAt = (t) => state.clips.find((c) => t >= c.start && t < c.end) || state.clips[state.clips.length - 1];

/** t 지점에서 자르기. 새로 만들어진 뒤쪽 클립을 반환 (이미 경계이면 null). */
function splitAt(t, record = true) {
  t = snapFrame(t);
  const c = clipAt(t);
  if (!c || t - c.start < MIN_CLIP || c.end - t < MIN_CLIP) return null;
  if (record) pushUndo();
  const right = { id: state.nextId++, start: t, end: c.end, deleted: c.deleted };
  c.end = t;
  state.clips.splice(state.clips.indexOf(c) + 1, 0, right);
  return right;
}
/** 두 시점 사이를 별도 클립으로 분리하고 선택 */
function isolateRange(a, b) {
  if (b < a) [a, b] = [b, a];
  a = snapFrame(a); b = snapFrame(b);
  if (b - a < MIN_CLIP) return;
  pushUndo();
  splitAt(a, false); splitAt(b, false);
  state.selected = new Set(state.clips.filter((c) => c.start >= a - 1e-6 && c.end <= b + 1e-6).map((c) => c.id));
  commit();
}
/** 여러 [a,b] 범위를 잘라내어 삭제/복원 표시 (대본 문장 삭제용) */
function markRanges(ranges, deleted) {
  if (!ranges.length) return;
  pushUndo();
  const ids = new Set();
  for (const r of ranges) {
    const a = snapFrame(r.start), b = snapFrame(r.end);
    if (b - a < MIN_CLIP) continue;
    splitAt(a, false); splitAt(b, false);
    state.clips.filter((c) => c.start >= a - 1e-6 && c.end <= b + 1e-6).forEach((c) => { c.deleted = deleted; ids.add(c.id); });
  }
  state.selected = ids;
  commit();
}
function setDeleted(ids, deleted) {
  const targets = state.clips.filter((c) => ids.has(c.id) && c.deleted !== deleted);
  if (!targets.length) return;
  pushUndo();
  targets.forEach((c) => (c.deleted = deleted));
  commit();
}
/** i 번째 경계(클립 i 의 시작)를 없애 클립 i-1 과 합친다 */
function mergeBoundary(i) {
  if (i <= 0 || i >= state.clips.length) return;
  pushUndo();
  const a = state.clips[i - 1], b = state.clips[i];
  a.end = b.end; a.deleted = a.deleted && b.deleted;
  state.selected.delete(b.id);
  state.clips.splice(i, 1);
  commit();
}
function moveBoundary(i, t, record) {
  if (i <= 0 || i >= state.clips.length) return;
  const a = state.clips[i - 1], b = state.clips[i];
  t = clamp(snapFrame(t), a.start + MIN_CLIP, b.end - MIN_CLIP);
  if (record) pushUndo();
  a.end = t; b.start = t;
}
/** 내보낼(유지) 구간: 삭제되지 않은 인접 클립을 병합 */
function keepIntervals() {
  const out = [];
  for (const c of state.clips) {
    if (c.deleted) continue;
    if (out.length && Math.abs(out[out.length - 1].end - c.start) < 1e-6) out[out.length - 1].end = c.end;
    else out.push({ start: c.start, end: c.end });
  }
  return out.filter((k) => k.end - k.start >= MIN_CLIP);
}
/** 재생 시 건너뛸 구간: 인접한 삭제 클립을 병합 */
function removedIntervals() {
  const out = [];
  for (const c of state.clips) {
    if (!c.deleted) continue;
    if (out.length && Math.abs(out[out.length - 1].end - c.start) < 1e-6) out[out.length - 1].end = c.end;
    else out.push({ start: c.start, end: c.end });
  }
  return out;
}
/** 원본 시각 → 편집 결과물 시각 (삭제 구간이면 다음 유지 구간 시작, 뒤에 없으면 null) */
function toOutputTime(t, keep = keepIntervals()) {
  let offset = 0;
  for (const k of keep) {
    if (t < k.start) return offset;
    if (t < k.end) return offset + (t - k.start);
    offset += k.end - k.start;
  }
  return null;
}

/* ------------------------------------------------------- rendering */
function renderAll() { layoutTimeline(); renderClips(); renderClipList(); renderChapterMarks(); updatePlayhead(); updateButtons(); }

function timelineWidth() { return Math.max(els.timelineScroll.clientWidth, 10) * state.zoom; }
const xToTime = (x) => clamp(x / timelineWidth() * state.duration, 0, state.duration);
const timeToPct = (t) => `${(t / (state.duration || 1)) * 100}%`;

function layoutTimeline() {
  const w = timelineWidth();
  els.timeline.style.width = `${w}px`;
  const pxPerSec = w / (state.duration || 1);
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = candidates.find((c) => c * pxPerSec >= 90) || 3600;
  const minor = step / (step >= 60 ? 4 : 5);
  let html = '';
  for (let t = 0; t <= state.duration; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    html += `<div class="tick ${major ? '' : 'minor'}" style="left:${timeToPct(t)}">${major ? fmtShort(t) : ''}</div>`;
    if (html.length > 400000) break;
  }
  els.ruler.innerHTML = html;
}

function renderClips() {
  els.clipLayer.innerHTML = '';
  els.cutLayer.innerHTML = '';
  state.clips.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = `clip ${c.deleted ? 'deleted' : 'kept'}${state.selected.has(c.id) ? ' selected' : ''}`;
    d.style.left = timeToPct(c.start); d.style.width = timeToPct(c.end - c.start);
    d.dataset.id = c.id;
    d.innerHTML = `<span class="lbl">${i + 1}</span>`;
    els.clipLayer.appendChild(d);
    if (i > 0) {
      const m = document.createElement('div');
      m.className = 'cutmark'; m.style.left = timeToPct(c.start); m.dataset.i = i;
      m.title = `자른 지점 ${fmt(c.start)} — 끌어서 이동, 더블클릭으로 합치기`;
      els.cutLayer.appendChild(m);
    }
  });
}

function renderClipList() {
  const clips = state.clips;
  if (clips.length <= 1 && !clips.some((c) => c.deleted)) {
    els.clipList.innerHTML = '<div class="muted empty">아직 자른 곳이 없습니다. ✂ 자르기 도구로 타임라인을 클릭하거나, 재생 위치에서 S 키를 누르세요.</div>';
  } else {
    els.clipList.innerHTML = clips.map((c, i) => `
      <div class="clip-row${state.selected.has(c.id) ? ' selected' : ''}${c.deleted ? ' deleted' : ''}" data-id="${c.id}" data-i="${i}">
        <span class="idx">#${i + 1} <span class="tag ${c.deleted ? 'cut' : 'keep'}">${c.deleted ? '삭제' : '유지'}</span></span>
        <input class="time" data-f="start" value="${fmt(c.start)}" title="시작 (앞 클립과의 경계, 편집 후 Enter)" ${i === 0 ? 'disabled' : ''}>
        <input class="time" data-f="end" value="${fmt(c.end)}" title="끝 (뒤 클립과의 경계, 편집 후 Enter)" ${i === clips.length - 1 ? 'disabled' : ''}>
        <span class="dur">길이 ${fmt(c.end - c.start)}</span>
        <div class="acts">
          <button class="small" data-a="play" title="이 클립 재생">▶</button>
          <button class="small ${c.deleted ? '' : 'danger'}" data-a="toggle" title="${c.deleted ? '복원' : '삭제'}">${c.deleted ? '↩ 복원' : '🗑 삭제'}</button>
          <button class="small" data-a="merge" title="앞 클립과 합치기" ${i === 0 ? 'disabled' : ''}>⟵ 합치기</button>
        </div>
      </div>`).join('');
  }
  const del = clips.filter((c) => c.deleted);
  const delLen = del.reduce((a, c) => a + c.end - c.start, 0);
  const keepLen = keepIntervals().reduce((a, k) => a + k.end - k.start, 0);
  els.clipSummary.textContent = clips.length > 1 || del.length
    ? `${clips.length}개 · 삭제 ${del.length}개(${fmt(delLen, false)}) → 결과 ${fmt(keepLen, false)}`
    : '';
  els.badgeClips.textContent = clips.length > 1 ? clips.length : '';
}

function updateButtons() {
  const sel = state.clips.filter((c) => state.selected.has(c.id));
  els.deleteBtn.disabled = !sel.some((c) => !c.deleted);
  els.restoreBtn.disabled = !sel.some((c) => c.deleted);
  els.undoBtn.disabled = !state.undo.length;
}

function updatePlayhead() {
  const t = els.video.currentTime || 0;
  els.playhead.style.left = timeToPct(t);
  els.curTime.textContent = fmt(t);
}

/* ---------------------------------------------------- playback loop */
let seekLock = false;
function tick() {
  updatePlayhead();
  const v = els.video;
  if (!v.paused && els.skipCuts.checked && !seekLock) {
    const t = v.currentTime;
    for (const r of removedIntervals()) {
      if (t >= r.start && t < r.end - 0.04) {
        if (r.end >= state.duration - 0.05) { v.pause(); v.currentTime = r.start; }
        else { seekLock = true; v.currentTime = r.end; setTimeout(() => (seekLock = false), 150); }
        break;
      }
    }
    if (state.zoom > 1) keepPlayheadVisible();
  }
  updateCurrentSegment(v.currentTime);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function keepPlayheadVisible(center = false) {
  const x = (els.video.currentTime / (state.duration || 1)) * timelineWidth();
  const sc = els.timelineScroll, left = sc.scrollLeft, w = sc.clientWidth;
  if (center) sc.scrollLeft = x - w / 2;
  else if (x < left + 20 || x > left + w - 20) sc.scrollLeft = x - w * 0.2;
}

function seekTo(t) { els.video.currentTime = clamp(t, 0, state.duration); updatePlayhead(); }
function togglePlay() { if (els.video.paused) els.video.play(); else els.video.pause(); }
els.video.addEventListener('play', () => (els.playBtn.textContent = '❚❚'));
els.video.addEventListener('pause', () => (els.playBtn.textContent = '▶'));
els.video.addEventListener('loadedmetadata', () => {
  if (!state.duration) { state.duration = els.video.duration; if (!state.clips.length) resetClips(); renderAll(); }
});

/* --------------------------------------------------- UI: transport */
els.playBtn.onclick = togglePlay;
$$('[data-seek]').forEach((b) => (b.onclick = () => seekTo(els.video.currentTime + Number(b.dataset.seek))));
$$('[data-frame]').forEach((b) => (b.onclick = () => { els.video.pause(); seekTo(els.video.currentTime + Number(b.dataset.frame) / state.fps); }));
els.speed.onchange = () => (els.video.playbackRate = Number(els.speed.value));
els.showSubs.onchange = () => { state.trCurrent = -2; };

/* ------------------------------------------------------- UI: tools */
function setTool(tool) {
  state.tool = tool;
  els.timeline.dataset.tool = tool;
  $$('#toolGroup button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  if (tool !== 'razor') els.hoverLine.classList.add('hidden');
}
els.toolGroup.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); });
els.splitBtn.onclick = () => { const r = splitAt(els.video.currentTime); if (r) { state.selected = new Set([r.id]); commit(); } };
els.deleteBtn.onclick = () => setDeleted(state.selected, true);
els.restoreBtn.onclick = () => setDeleted(state.selected, false);
els.undoBtn.onclick = undo;
els.restoreAll.onclick = () => setDeleted(new Set(state.clips.map((c) => c.id)), false);
els.clearCuts.onclick = () => { if (confirm('자른 지점과 삭제 표시를 모두 지우고 처음 상태로 되돌릴까요?')) { pushUndo(); resetClips(); commit(); } };

els.zoom.oninput = () => {
  state.zoom = Number(els.zoom.value);
  els.zoomLabel.textContent = `${state.zoom}x`;
  renderAll(); keepPlayheadVisible(true);
};
window.addEventListener('resize', renderAll);

/* ----------------------------------------------- UI: timeline mouse */
let drag = null; // {type:'scrub'|'boundary'|'razor'|'chapter', ...}
let lastCutClick = null; // 자른 선 더블클릭 판정용 {i, at}
const tlX = (e) => e.clientX - els.timeline.getBoundingClientRect().left;

els.timeline.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.clips.length) return;
  const t = xToTime(tlX(e));
  const chap = e.target.closest('.chapmark');
  const cut = e.target.closest('.cutmark');
  const clipEl = e.target.closest('.clip');
  if (chap) {
    const id = Number(chap.dataset.id);
    const c = state.chapters.find((x) => x.id === id);
    state.chSelected = id; if (c) seekTo(c.time);
    drag = { type: 'chapter', id, moved: false };
    renderChapters();
  } else if (e.target.closest('.ruler')) {
    drag = { type: 'scrub' }; seekTo(t);
  } else if (cut && state.tool === 'select') {
    // 포인터 캡처 중에는 dblclick 이벤트가 타임라인으로 재지정되므로 더블클릭을 직접 판정
    const i = Number(cut.dataset.i), now = performance.now();
    if (lastCutClick && lastCutClick.i === i && now - lastCutClick.at < 400) { lastCutClick = null; mergeBoundary(i); return; }
    lastCutClick = { i, at: now };
    drag = { type: 'boundary', i, recorded: false };
  } else if (state.tool === 'razor') {
    drag = { type: 'razor', startT: t, startX: tlX(e), moved: false };
    els.hoverLine.classList.add('hidden');
  } else if (clipEl) {
    const id = Number(clipEl.dataset.id);
    if (e.ctrlKey || e.metaKey) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); }
    else if (e.shiftKey && state.selected.size) {
      const idx = state.clips.findIndex((c) => c.id === id);
      const sel = state.clips.map((c, i) => (state.selected.has(c.id) ? i : -1)).filter((i) => i >= 0);
      const lo = Math.min(idx, ...sel), hi = Math.max(idx, ...sel);
      state.selected = new Set(state.clips.slice(lo, hi + 1).map((c) => c.id));
    } else state.selected = new Set([id]);
    seekTo(t);
    drag = { type: 'scrub' };
    renderClips(); renderClipList(); updateButtons();
  }
  if (drag) els.timeline.setPointerCapture(e.pointerId);
});

els.timeline.addEventListener('pointermove', (e) => {
  const x = tlX(e), t = xToTime(x);
  if (!drag) {
    if (state.tool === 'razor' && !e.target.closest('.ruler') && !e.target.closest('.chapmark')) {
      els.hoverLine.classList.remove('hidden');
      els.hoverLine.style.left = timeToPct(snapFrame(t));
      els.hoverLine.querySelector('span').textContent = `✂ ${fmt(snapFrame(t))}`;
    } else els.hoverLine.classList.add('hidden');
    return;
  }
  if (drag.type === 'scrub') seekTo(t);
  else if (drag.type === 'boundary') {
    moveBoundary(drag.i, t, !drag.recorded); drag.recorded = true;
    seekTo(state.clips[drag.i].start); renderClips(); renderClipList();
  } else if (drag.type === 'razor') {
    if (Math.abs(x - drag.startX) > 3) drag.moved = true;
    if (drag.moved) {
      const a = Math.min(drag.startT, t), b = Math.max(drag.startT, t);
      els.rangeSel.classList.remove('hidden');
      els.rangeSel.style.left = timeToPct(a); els.rangeSel.style.width = timeToPct(b - a);
    }
    seekTo(t);
  } else if (drag.type === 'chapter') {
    const c = state.chapters.find((x) => x.id === drag.id);
    if (c) { c.time = snapFrame(t); drag.moved = true; seekTo(c.time); renderChapterMarks(); }
  }
});

function endDrag(e) {
  if (!drag) return;
  if (drag.type === 'boundary') { if (drag.recorded) commit(); }
  else if (drag.type === 'razor') {
    els.rangeSel.classList.add('hidden');
    const t = xToTime(tlX(e));
    if (drag.moved) isolateRange(drag.startT, t);
    else { const r = splitAt(drag.startT); if (r) { state.selected = new Set([r.id]); commit(); } }
  } else if (drag.type === 'chapter') {
    if (drag.moved) { state.chapters.sort((a, b) => a.time - b.time); saveProject(); renderChapters(); }
  }
  drag = null;
}
els.timeline.addEventListener('pointerup', endDrag);
els.timeline.addEventListener('pointercancel', endDrag);
els.timeline.addEventListener('pointerleave', () => els.hoverLine.classList.add('hidden'));
els.timeline.addEventListener('dblclick', (e) => {
  const cut = e.target.closest('.cutmark');
  if (cut) mergeBoundary(Number(cut.dataset.i));
});
els.timelineScroll.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  els.zoom.value = clamp(state.zoom + (e.deltaY < 0 ? 2 : -2), 1, 80);
  els.zoom.oninput();
}, { passive: false });

/* ---------------------------------------------------- UI: clip list */
els.clipList.addEventListener('click', (e) => {
  const row = e.target.closest('.clip-row'); if (!row) return;
  const id = Number(row.dataset.id), i = Number(row.dataset.i);
  const c = state.clips.find((x) => x.id === id); if (!c) return;
  const a = e.target.dataset.a;
  if (a === 'toggle') return setDeleted(new Set([id]), !c.deleted);
  if (a === 'merge') return mergeBoundary(i);
  if (a === 'play') { state.selected = new Set([id]); seekTo(c.start); els.video.play(); renderAll(); return; }
  if (e.target.matches('input')) return;
  if (e.ctrlKey || e.metaKey) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); }
  else state.selected = new Set([id]);
  seekTo(c.start); renderClips(); renderClipList(); updateButtons();
});
els.clipList.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input.time')) e.target.blur(); });
els.clipList.addEventListener('focusout', (e) => {
  if (!e.target.matches('input.time')) return;
  const row = e.target.closest('.clip-row'); const i = Number(row.dataset.i);
  const t = parseTime(e.target.value);
  if (isNaN(t)) return renderClipList();
  if (e.target.dataset.f === 'start') moveBoundary(i, t, true); else moveBoundary(i + 1, t, true);
  commit();
});

/* ------------------------------------------------- project persist */
const projKey = () => `lectureedit:v2:${state.name}`;
function saveProject() {
  if (!state.name) return;
  try { localStorage.setItem(projKey(), JSON.stringify(projectData())); } catch (_) { /* ignore */ }
}
function projectData() {
  return { app: 'LectureEdit', version: 3, source: state.name, duration: state.duration,
           clips: state.clips.map((c) => ({ start: c.start, end: c.end, deleted: !!c.deleted })),
           chapters: state.chapters.map((c) => ({ time: c.time, title: c.title })) };
}
function applyProject(p) {
  const clips = (p && Array.isArray(p.clips) ? p.clips : [])
    .filter((c) => isFinite(c.start) && isFinite(c.end) && c.end > c.start)
    .map((c) => ({ id: state.nextId++, start: Number(c.start), end: Number(c.end), deleted: !!c.deleted }));
  state.chapters = (p && Array.isArray(p.chapters) ? p.chapters : [])
    .filter((c) => isFinite(c.time))
    .map((c) => ({ id: state.nextId++, time: Number(c.time), title: String(c.title || '') }))
    .sort((a, b) => a.time - b.time);
  state.selected.clear();
  if (!clips.length) resetClips(); else state.clips = clips;
  commit();
}
function loadProject() {
  try { const raw = localStorage.getItem(projKey()); applyProject(raw ? JSON.parse(raw) : null); }
  catch (_) { resetClips(); commit(); }
}
els.exportJson.onclick = () => {
  if (!state.name) return;
  const blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${state.name.replace(/\.[^.]+$/, '')}.lectureedit.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
els.importJson.onchange = async () => {
  const f = els.importJson.files[0]; if (!f || !state.name) return;
  try {
    const p = JSON.parse(await f.text());
    if (p.source && p.source !== state.name && !confirm(`다른 영상(${p.source})의 프로젝트입니다. 그래도 불러올까요?`)) return;
    pushUndo(); applyProject(p);
  } catch (e) { alert(`불러오기 실패: ${e.message}`); }
  els.importJson.value = '';
};

/* ------------------------------------------------------- job helper */
async function trackJob(id, onProgress, pollMs = 700) {
  for (;;) {
    const j = await api(`/api/jobs/${id}`);
    onProgress(j);
    if (j.status === 'done') return j;
    if (j.status === 'error') throw new Error(j.error || '작업 실패');
    if (j.status === 'cancelled') throw new Error('취소되었습니다');
    await sleep(pollMs);
  }
}
function setProgress(el, frac, label) {
  el.classList.remove('hidden');
  el.querySelector('.bar').style.width = `${Math.round(frac * 100)}%`;
  el.querySelector('.label').textContent = label;
}

/* ------------------------------------------------- transcript (STT) */
async function loadSttInfo() {
  try { state.sttInfo = await api('/api/transcribe/info'); } catch (e) { state.sttInfo = { available: false, reason: e.message }; }
  const s = state.sttInfo;
  if (!s.available) {
    els.trDevice.textContent = '사용 불가';
    els.trNote.textContent = s.reason || '';
    els.trStart.disabled = true;
    return;
  }
  els.trDevice.textContent = s.cuda ? `GPU: ${s.device}` : 'CPU (느림)';
  els.trModel.innerHTML = s.models.map((m) => `<option value="${m.id}" ${m.id === s.default_model ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  els.trNote.textContent = s.cuda
    ? '1시간 강의 기준 large-v3 약 3~6분, turbo 약 1분. 모델은 처음 한 번만 다운로드합니다.'
    : 'GPU가 없어 CPU로 실행됩니다. small 모델도 영상 길이의 1~2배 시간이 걸릴 수 있습니다.';
}

async function loadTranscript() {
  const name = state.name;
  try {
    const t = await api(`/api/videos/${enc()}/transcript`);
    if (state.name !== name) return;
    state.trMeta = t; state.transcript = t.segments || [];
  } catch (_) { state.transcript = null; state.trMeta = null; }
  state.trSelected.clear(); state.trCurrent = -2;
  renderTranscriptPanel();
}

function renderTranscriptPanel() {
  const has = !!state.transcript && !state.trForce;
  els.trGenPanel.classList.toggle('hidden', has);
  els.trPanel.classList.toggle('hidden', !state.transcript);
  els.badgeTranscript.textContent = state.transcript ? state.transcript.length : '';
  els.trSrtLink.href = state.transcript ? `/api/videos/${enc()}/transcript.srt` : '#';
  els.optSrt.disabled = els.optEmbedSrt.disabled = !state.transcript;
  els.optSrtNote.textContent = state.transcript ? '편집 결과에 맞춰 시간 재계산' : '대본·자막 탭에서 먼저 자막을 생성하세요';
  if (state.transcript) {
    const m = state.trMeta || {};
    els.trSummary.textContent = `${state.transcript.length}문장 · ${m.model || ''}${m.language ? ' · ' + m.language : ''}`;
    renderTranscriptList();
  }
}

function segIsDeleted(s, removed) {
  const len = s.end - s.start;
  if (len <= 0) return false;
  let covered = 0;
  for (const r of removed) covered += Math.max(0, Math.min(s.end, r.end) - Math.max(s.start, r.start));
  return covered >= len * 0.5;
}

function renderTranscriptList() {
  if (!state.transcript) return;
  const q = state.trQuery.trim().toLowerCase();
  const removed = removedIntervals();
  const rows = [];
  state.transcript.forEach((s, i) => {
    if (q && !s.text.toLowerCase().includes(q)) return;
    let text = esc(s.text);
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
      text = text.replace(re, (m) => `<mark>${m}</mark>`);
    }
    rows.push(`<div class="tr-row${state.trSelected.has(i) ? ' selected' : ''}${segIsDeleted(s, removed) ? ' deleted' : ''}${i === state.trCurrent ? ' current' : ''}" data-i="${i}">
      <span class="tr-time">${fmtShort(s.start)}</span><span class="tr-text">${text}</span></div>`);
  });
  els.trList.innerHTML = rows.join('') || '<div class="muted empty">검색 결과가 없습니다.</div>';
  updateTrButtons();
}
function updateTrButtons() {
  const n = state.trSelected.size;
  els.trCutBtn.disabled = els.trKeepBtn.disabled = !n;
  els.trCutBtn.textContent = n ? `🗑 선택 문장 삭제 (${n})` : '🗑 선택 문장 삭제';
}

function findSegIndex(t) {
  const segs = state.transcript; if (!segs || !segs.length) return -1;
  let lo = 0, hi = segs.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 && t < segs[ans].end + 0.15 ? ans : -1;
}
function updateCurrentSegment(t) {
  if (!state.transcript) { els.subtitleOverlay.classList.add('hidden'); return; }
  const idx = findSegIndex(t);
  if (idx === state.trCurrent) return;
  const prev = els.trList.querySelector('.tr-row.current'); if (prev) prev.classList.remove('current');
  state.trCurrent = idx;
  if (idx >= 0) {
    const row = els.trList.querySelector(`.tr-row[data-i="${idx}"]`);
    if (row) {
      row.classList.add('current');
      if (els.trFollow.checked && activeTab() === 'transcript' && !els.video.paused) row.scrollIntoView({ block: 'nearest' });
    }
  }
  const show = idx >= 0 && els.showSubs.checked;
  els.subtitleOverlay.classList.toggle('hidden', !show);
  if (show) els.subtitleOverlay.innerHTML = `<span>${esc(state.transcript[idx].text)}</span>`;
}

els.trStart.onclick = async () => {
  if (!state.name) return alert('먼저 영상을 선택하세요.');
  const body = { model: els.trModel.value, language: els.trLang.value, initial_prompt: els.trPrompt.value.trim() || null, force: state.trForce };
  els.trStart.disabled = true; els.trCancel.classList.remove('hidden');
  try {
    const r = await postJson(`/api/videos/${enc()}/transcribe`, body);
    if (!r.ready) {
      state.jobs.transcribe = r.job.id;
      await trackJob(r.job.id, (j) => setProgress(els.trProgress, j.progress, `${j.message || '처리 중'} ${(j.progress * 100).toFixed(0)}%`), 1000);
    }
    state.trForce = false;
    setProgress(els.trProgress, 1, '완료');
    await loadTranscript();
  } catch (e) {
    setProgress(els.trProgress, 0, `실패: ${e.message}`);
  } finally {
    els.trStart.disabled = false; els.trCancel.classList.add('hidden'); state.jobs.transcribe = null;
  }
};
els.trCancel.onclick = () => state.jobs.transcribe && postJson(`/api/jobs/${state.jobs.transcribe}/cancel`, {});
els.trRedo.onclick = () => { state.trForce = true; renderTranscriptPanel(); els.trProgress.classList.add('hidden'); };
els.trSearch.oninput = () => { state.trQuery = els.trSearch.value; renderTranscriptList(); };

els.trList.addEventListener('click', (e) => {
  const row = e.target.closest('.tr-row'); if (!row) return;
  if (e.target.matches('.tr-text[contenteditable=true]')) return;
  const i = Number(row.dataset.i); const s = state.transcript[i];
  if (e.ctrlKey || e.metaKey) { if (state.trSelected.has(i)) state.trSelected.delete(i); else state.trSelected.add(i); }
  else if (e.shiftKey && state.trSelected.size) {
    const lo = Math.min(i, ...state.trSelected), hi = Math.max(i, ...state.trSelected);
    for (let k = lo; k <= hi; k++) state.trSelected.add(k);
  } else state.trSelected = new Set([i]);
  seekTo(s.start);
  $$('.tr-row', els.trList).forEach((r) => r.classList.toggle('selected', state.trSelected.has(Number(r.dataset.i))));
  updateTrButtons();
});
els.trList.addEventListener('dblclick', (e) => {
  const txt = e.target.closest('.tr-text'); if (!txt) return;
  const row = txt.closest('.tr-row'); const i = Number(row.dataset.i);
  txt.textContent = state.transcript[i].text;   // 검색 하이라이트 제거
  txt.contentEditable = 'true'; txt.focus();
  document.getSelection().selectAllChildren(txt);
});
els.trList.addEventListener('keydown', (e) => {
  if (!e.target.matches('.tr-text[contenteditable=true]')) return;
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape') { e.target.dataset.cancel = '1'; e.target.blur(); }
  e.stopPropagation();
});
els.trList.addEventListener('focusout', (e) => {
  const txt = e.target; if (!txt.matches || !txt.matches('.tr-text[contenteditable=true]')) return;
  txt.contentEditable = 'false';
  const i = Number(txt.closest('.tr-row').dataset.i);
  if (txt.dataset.cancel) { delete txt.dataset.cancel; txt.textContent = state.transcript[i].text; return; }
  const v = txt.textContent.trim();
  if (v && v !== state.transcript[i].text) { state.transcript[i].text = v; saveTranscriptSoon(); }
  txt.textContent = state.transcript[i].text;
});
let trSaveTimer = null;
function saveTranscriptSoon() {
  clearTimeout(trSaveTimer);
  trSaveTimer = setTimeout(async () => {
    try { await putJson(`/api/videos/${enc()}/transcript`, { segments: state.transcript.map((s) => ({ start: s.start, end: s.end, text: s.text })) }); }
    catch (e) { alert(`대본 저장 실패: ${e.message}`); }
  }, 800);
}
function selectedSegRanges() {
  const idx = [...state.trSelected].sort((a, b) => a - b);
  const ranges = [];
  for (const i of idx) {
    const s = state.transcript[i];
    if (ranges.length && s.start <= ranges[ranges.length - 1].end + 0.3) ranges[ranges.length - 1].end = Math.max(ranges[ranges.length - 1].end, s.end);
    else ranges.push({ start: s.start, end: s.end });
  }
  return ranges;
}
els.trCutBtn.onclick = () => { markRanges(selectedSegRanges(), true); };
els.trKeepBtn.onclick = () => { markRanges(selectedSegRanges(), false); };

/* ---------------------------------------------------------- chapters */
function addChapter(time, title) {
  const n = state.chapters.length + 1;
  const c = { id: state.nextId++, time: snapFrame(time), title: title || `챕터 ${n}` };
  state.chapters.push(c); state.chapters.sort((a, b) => a.time - b.time);
  state.chSelected = c.id;
  saveProject(); renderChapters();
  return c;
}
function removeChapter(id) {
  state.chapters = state.chapters.filter((c) => c.id !== id);
  if (state.chSelected === id) state.chSelected = null;
  saveProject(); renderChapters();
}
function renderChapterMarks() {
  els.chapLayer.innerHTML = state.chapters.map((c) => `
    <div class="chapmark${c.id === state.chSelected ? ' selected' : ''}" data-id="${c.id}" style="left:${timeToPct(c.time)}" title="${esc(c.title)} (${fmt(c.time, false)}) — 끌어서 이동">
      <span>${esc(c.title)}</span></div>`).join('');
}
function outputChaptersText() {
  const keep = keepIntervals();
  const seen = new Set(); const out = [];
  for (const c of state.chapters) {
    const t = toOutputTime(c.time, keep);
    if (t == null) continue;
    const key = Math.round(t * 1000); if (seen.has(key)) continue; seen.add(key);
    out.push({ time: t, title: c.title || `챕터 ${out.length + 1}` });
  }
  if (!out.length) return '';
  if (out[0].time > 0.5) out.unshift({ time: 0, title: '시작' });
  const useH = out[out.length - 1].time >= 3600;
  return out.map((c) => {
    const t = Math.floor(c.time), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const stamp = useH ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${stamp} ${c.title}`;
  }).join('\n');
}
function renderChapters() {
  renderChapterMarks();
  const keep = keepIntervals();
  els.chList.innerHTML = state.chapters.length ? state.chapters.map((c, i) => {
    const ot = toOutputTime(c.time, keep);
    return `<div class="ch-row${c.id === state.chSelected ? ' selected' : ''}" data-id="${c.id}">
      <span class="idx">${i + 1}</span>
      <input class="time" data-f="time" value="${fmt(c.time, false)}" title="원본 기준 시각 (편집 후 Enter)${ot == null ? ' · 삭제 구간' : ' · 결과 기준 ' + fmt(ot, false)}">
      <input class="title" data-f="title" value="${esc(c.title)}" placeholder="챕터 제목">
      <div class="acts"><button class="small" data-a="play" title="이동">▶</button><button class="small danger" data-a="del" title="삭제">✕</button></div>
    </div>`;
  }).join('') : '<div class="muted empty">아직 챕터가 없습니다. 재생 위치에서 M 키를 누르거나 위 버튼을 누르세요.</div>';
  els.chText.value = outputChaptersText();
  els.chSummary.textContent = state.chapters.length ? `${state.chapters.length}개` : '';
  els.badgeChapters.textContent = state.chapters.length || '';
  els.optChapters.disabled = !state.chapters.length;
  els.optChNote.textContent = state.chapters.length ? `${state.chapters.length}개, MP4/MKV 챕터 메뉴에 표시` : '챕터 탭에서 먼저 추가하세요';
}
function addChapterHere() {
  if (!state.name) return;
  addChapter(els.video.currentTime);
  showTab('chapters');
  const row = els.chList.querySelector(`.ch-row[data-id="${state.chSelected}"] input.title`);
  if (row) { row.focus(); row.select(); }
}
els.chapterBtn.onclick = addChapterHere;
els.chAddBtn.onclick = addChapterHere;
els.chClear.onclick = () => { if (state.chapters.length && confirm('챕터를 모두 삭제할까요?')) { state.chapters = []; state.chSelected = null; saveProject(); renderChapters(); } };
els.chCopy.onclick = async () => {
  if (!els.chText.value) return;
  try { await navigator.clipboard.writeText(els.chText.value); els.chCopy.textContent = '복사됨 ✔'; }
  catch (_) { els.chText.select(); document.execCommand('copy'); els.chCopy.textContent = '복사됨 ✔'; }
  setTimeout(() => (els.chCopy.textContent = '복사'), 1500);
};
els.chList.addEventListener('click', (e) => {
  const row = e.target.closest('.ch-row'); if (!row) return;
  const id = Number(row.dataset.id); const c = state.chapters.find((x) => x.id === id); if (!c) return;
  const a = e.target.dataset.a;
  if (a === 'del') return removeChapter(id);
  state.chSelected = id;
  if (a === 'play' || !e.target.matches('input')) seekTo(c.time);
  $$('.ch-row', els.chList).forEach((r) => r.classList.toggle('selected', Number(r.dataset.id) === id));
  renderChapterMarks();
});
els.chList.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) e.target.blur(); });
els.chList.addEventListener('focusout', (e) => {
  if (!e.target.matches('input')) return;
  const id = Number(e.target.closest('.ch-row').dataset.id); const c = state.chapters.find((x) => x.id === id); if (!c) return;
  if (e.target.dataset.f === 'title') c.title = e.target.value.trim();
  else { const t = parseTime(e.target.value); if (!isNaN(t)) c.time = clamp(t, 0, state.duration); }
  state.chapters.sort((a, b) => a.time - b.time);
  saveProject(); renderChapters();
});

/* ---------------------------------------------------------- export */
$$('input[name=expMode]').forEach((r) => (r.onchange = () => els.encodeOpts.classList.toggle('hidden', r.value !== 'encode' || !r.checked)));
els.exportBtn.onclick = async () => {
  if (!state.name) return alert('먼저 영상을 선택하세요.');
  const keep = keepIntervals();
  if (!keep.length) return alert('남는 클립이 없습니다. 삭제 표시를 확인하세요.');
  if (!state.clips.some((c) => c.deleted) && !confirm('삭제한 클립이 없습니다. 원본 전체를 그대로 내보낼까요?')) return;
  const mode = $('input[name=expMode]:checked').value;
  const hasTr = !!state.transcript;
  const body = {
    source: state.name, segments: keep, mode, crf: Number(els.crf.value), preset: els.preset.value,
    output_name: els.outName.value.trim() || null,
    loudnorm: els.optLoudnorm.checked,
    subtitles: hasTr && els.optSrt.checked,
    embed_subtitles: hasTr && els.optSrt.checked && els.optEmbedSrt.checked,
    chapters: state.chapters.map((c) => ({ time: c.time, title: c.title })),
    embed_chapters: state.chapters.length > 0 && els.optChapters.checked,
  };
  els.exportBtn.disabled = true; els.cancelExport.classList.remove('hidden'); els.exportResult.textContent = '';
  const t0 = Date.now();
  try {
    const job = await postJson('/api/export', body);
    state.jobs.export = job.id;
    const done = await trackJob(job.id, (j) => setProgress(els.exportProgress, j.progress, `${j.message || '처리 중'} ${(j.progress * 100).toFixed(0)}%`));
    const r = done.result;
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    let html = `<span class="ok">✔ 완료 (${sec}초, ${keep.length}개 조각, 결과 ${fmt(r.duration, false)})</span><br>`;
    html += `🎞 <a href="/api/outputs/${encodeURIComponent(r.output)}">${esc(r.output)}</a> (${fmtSize(r.size)})`;
    if (r.srt) html += `<br>💬 <a href="/api/outputs/${encodeURIComponent(r.srt)}">${esc(r.srt)}</a> (자막 ${r.cues}개)`;
    if (r.chapters_text) html += `<br>🔖 챕터 ${r.chapters_text.split('\n').length}개 <button class="small" id="copyChaptersResult">YouTube 타임스탬프 복사</button>`;
    els.exportResult.innerHTML = html;
    const cb = $('#copyChaptersResult');
    if (cb) cb.onclick = async () => { try { await navigator.clipboard.writeText(r.chapters_text); cb.textContent = '복사됨 ✔'; } catch (_) { alert(r.chapters_text); } };
    loadOutputs();
  } catch (e) {
    els.exportResult.innerHTML = `<span class="err">✖ ${esc(e.message)}</span>`;
    setProgress(els.exportProgress, 0, '');
  } finally {
    els.exportBtn.disabled = false; els.cancelExport.classList.add('hidden'); state.jobs.export = null;
  }
};
els.cancelExport.onclick = () => state.jobs.export && postJson(`/api/jobs/${state.jobs.export}/cancel`, {});

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|mts|m2ts|mpg|mpeg)$/i;
async function loadOutputs() {
  try {
    const list = await api('/api/outputs');
    if (!list.length) { els.outputs.innerHTML = '<span class="muted">없음</span>'; return; }
    els.outputs.innerHTML = list.map((o) => `
      <div class="out" data-name="${encodeURIComponent(o.name)}">
        <a class="name" href="/api/outputs/${encodeURIComponent(o.name)}" title="${esc(o.name)}">${VIDEO_EXT.test(o.name) ? '🎞' : '💬'} ${esc(o.name)}</a>
        <span class="muted">${fmtSize(o.size)}</span>
        ${VIDEO_EXT.test(o.name) ? '<button class="small" data-a="import" title="videos/ 폴더로 복사해 다시 편집">편집</button>' : ''}
        <button class="small danger" data-a="del" title="삭제">✕</button>
      </div>`).join('');
  } catch (_) { /* ignore */ }
}
els.outputs.addEventListener('click', async (e) => {
  const row = e.target.closest('.out'); const a = e.target.dataset.a; if (!row || !a) return;
  const name = row.dataset.name;
  if (a === 'del') { if (confirm('출력 파일을 삭제할까요?')) { await api(`/api/outputs/${name}`, { method: 'DELETE' }); loadOutputs(); } }
  if (a === 'import') { const r = await postJson(`/api/outputs/${name}/to-videos`, {}); await loadVideos(r.name); }
});

/* ---------------------------------------------------------- upload */
els.uploadInput.onchange = async () => {
  const f = els.uploadInput.files[0]; if (!f) return;
  els.uploadStatus.textContent = `업로드 중… ${f.name}`;
  const fd = new FormData(); fd.append('file', f);
  try {
    const xhr = new XMLHttpRequest();
    const done = new Promise((res, rej) => {
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) els.uploadStatus.textContent = `업로드 중… ${Math.round(ev.loaded / ev.total * 100)}%`; };
      xhr.onload = () => (xhr.status < 300 ? res(JSON.parse(xhr.responseText)) : rej(new Error(xhr.responseText)));
      xhr.onerror = () => rej(new Error('네트워크 오류'));
    });
    xhr.open('POST', '/api/videos/upload'); xhr.send(fd);
    const r = await done;
    els.uploadStatus.textContent = '';
    await loadVideos(r.name);
  } catch (e) { els.uploadStatus.textContent = `업로드 실패: ${e.message}`; }
  els.uploadInput.value = '';
};
els.videoSelect.onchange = () => { if (els.videoSelect.value) selectVideo(decodeURIComponent(els.videoSelect.value)); };
els.refreshBtn.onclick = () => loadVideos();

/* ------------------------------------------------------- shortcuts */
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea, [contenteditable=true]')) return;
  if (!state.name) return;
  const v = els.video;
  const step = e.ctrlKey || e.metaKey ? 10 : e.shiftKey ? 1 : 1 / state.fps;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); if (step < 1) v.pause(); seekTo(v.currentTime - step); break;
    case 'ArrowRight': e.preventDefault(); if (step < 1) v.pause(); seekTo(v.currentTime + step); break;
    case 's': case 'S': e.preventDefault(); els.splitBtn.onclick(); break;
    case 'c': case 'C': e.preventDefault(); setTool('razor'); break;
    case 'v': case 'V': e.preventDefault(); setTool('select'); break;
    case 'r': case 'R': e.preventDefault(); els.restoreBtn.onclick(); break;
    case 'm': case 'M': e.preventDefault(); addChapterHere(); break;
    case 'Delete': case 'Backspace':
      e.preventDefault();
      if (activeTab() === 'transcript' && state.trSelected.size) markRanges(selectedSegRanges(), true);
      else setDeleted(state.selected, true);
      break;
    case 'Home': seekTo(0); break;
    case 'End': seekTo(state.duration); break;
    case 'Escape': state.selected.clear(); state.trSelected.clear(); state.chSelected = null; setTool('select'); renderAll(); renderTranscriptList(); renderChapters(); break;
    default: return;
  }
});

/* ------------------------------------------------------------ init */
loadSttInfo();
loadVideos().then(loadOutputs).catch((e) => (els.videoInfo.textContent = `서버 연결 실패: ${e.message}`));
