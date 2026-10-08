/* TubeSnap — client-side YouTube to MP3/MP4 converter.
   Stream metadata: free public Piped API instances (no key, no signup).
   Conversion: ffmpeg.wasm runs inside the browser. No backend. */

const INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru',
  'https://pipedapi-libre.kavin.rocks',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.owo.si',
  'https://pipedapi.ducks.party',
  'https://piped-api.codespace.cz',
  'https://pipedapi.reallyaweso.me',
  'https://api.piped.private.coffee',
  'https://pipedapi.darkness.services',
  'https://pipedapi.orangenet.cc',
];

/* ffmpeg.wasm is vendored same-origin (vendor/ffmpeg/) so its Web Worker is
   same-origin too — a cross-origin Worker from a CDN is blocked by the browser.
   The heavy core (.js/.wasm) still loads from the jsDelivr CDN via importScripts,
   which is CORS-enabled. */
const FFMPEG_JS = '/vendor/ffmpeg/index.js';
const FFMPEG_CORE_JS = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js';
const FFMPEG_CORE_WASM = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm';

const MP3_BITRATES = [320, 192, 128];
const MP4_QUALITIES = ['1080p', '720p', '480p', '360p'];
const FETCH_TIMEOUT_MS = 15000;

let state = {
  format: 'mp3',
  videoId: null,
  info: null,       // Piped /streams response
  workingInstance: 0,
  busy: false,
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const form = $('convert-form'), urlInput = $('url-input'), goBtn = $('go-btn');
const errorBox = $('error-box');
const resultSec = $('result'), rThumb = $('r-thumb'), rTitle = $('r-title'), rMeta = $('r-meta');
const qualitySelect = $('quality-select'), dlBtn = $('dl-btn');
const progressWrap = $('progress-wrap'), progressFill = $('progress-fill'), progressText = $('progress-text');

/* ---------- helpers ---------- */
function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}
function clearError() {
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}
function setProgress(pct, text) {
  progressWrap.classList.remove('hidden');
  progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  progressText.textContent = text || '';
}
function resetProgress() {
  progressWrap.classList.add('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '';
}
function setBusy(b, label) {
  state.busy = b;
  goBtn.disabled = b;
  dlBtn.disabled = b;
  goBtn.textContent = b ? (label || 'Working…') : 'Convert';
  dlBtn.textContent = b ? (label || 'Working…') : 'Download';
}
function sanitizeFilename(name) {
  return (name || 'download').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 90) || 'download';
}
function formatDuration(sec) {
  if (!sec && sec !== 0) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function extractVideoId(url) {
  url = (url || '').trim();
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/(?:shorts|embed|live|v)\/|music\.youtube\.com\/watch\?.*v=)([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}
function fetchWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

/* ---------- Piped API ---------- */
async function fetchStreams(videoId) {
  // start from last working instance, then rotate through the rest
  const order = [];
  for (let i = 0; i < INSTANCES.length; i++) order.push(INSTANCES[(state.workingInstance + i) % INSTANCES.length]);
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const base = order[i];
    try {
      setProgress(4 + (i / order.length) * 10, `Contacting server ${i + 1}/${order.length}…`);
      const res = await fetchWithTimeout(`${base}/streams/${videoId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && (data.audioStreams?.length || data.videoStreams?.length)) {
        state.workingInstance = INSTANCES.indexOf(base);
        return data;
      }
      throw new Error('Empty response');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All servers unreachable');
}

function pickAudioStream(info) {
  const list = (info.audioStreams || []).filter(s => s.url);
  if (!list.length) return null;
  return list.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}
function qualityRank(q) {
  const m = /(\d+)p/.exec(q || '');
  return m ? parseInt(m[1], 10) : 0;
}
function pickVideoStreams(info, targetQuality) {
  const target = qualityRank(targetQuality);
  const vids = (info.videoStreams || []).filter(s => s.url && /mp4/i.test(s.mimeType || s.codec || ''));
  // 1) muxed (video+audio) mp4 at or below target — direct download, no conversion
  const muxed = vids.filter(s => !s.videoOnly).sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  const muxedPick = muxed.find(s => qualityRank(s.quality) <= target) || muxed[0];
  if (muxedPick && qualityRank(muxedPick.quality) >= Math.min(target, 360)) return { mode: 'direct', video: muxedPick, audio: null };
  // 2) adaptive: best video-only at/below target + best audio, mux in browser
  const vOnly = vids.filter(s => s.videoOnly).sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  const vPick = vOnly.find(s => qualityRank(s.quality) <= target) || vOnly[0];
  const aPick = pickAudioStream(info);
  if (vPick && aPick) return { mode: 'mux', video: vPick, audio: aPick };
  if (muxedPick) return { mode: 'direct', video: muxedPick, audio: null };
  return null;
}

/* ---------- result rendering ---------- */
function renderResult(info) {
  rThumb.src = info.thumbnailUrl || '';
  rTitle.textContent = info.title || 'Untitled';
  const dur = formatDuration(info.duration);
  rMeta.textContent = [info.uploader, dur].filter(Boolean).join(' • ');
  qualitySelect.innerHTML = '';
  if (state.format === 'mp3') {
    for (const b of MP3_BITRATES) {
      const o = document.createElement('option');
      o.value = b; o.textContent = `${b} kbps`;
      qualitySelect.appendChild(o);
    }
  } else {
    for (const q of MP4_QUALITIES) {
      const o = document.createElement('option');
      o.value = q; o.textContent = q;
      if (q === '720p') o.selected = true;
      qualitySelect.appendChild(o);
    }
  }
  resultSec.classList.remove('hidden');
  resetProgress();
  dlBtn.disabled = false;
  resultSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  saveHistory(info);
}

/* ---------- ffmpeg.wasm (lazy) ---------- */
let ffmpegPromise = null;
async function getFFmpeg(statusCb) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      statusCb?.('Loading converter engine…');
      const { FFmpeg } = await import(FFMPEG_JS);
      const ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress }) => {
        setProgress(55 + progress * 40, `Converting… ${Math.round(progress * 100)}%`);
      });
      const ok = await ffmpeg.load({ coreURL: FFMPEG_CORE_JS, wasmURL: FFMPEG_CORE_WASM });
      if (ok === false) throw new Error('Engine failed to load');
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

/* ---------- fetch a stream URL with progress ---------- */
async function fetchBytes(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) setProgress(8 + (received / total) * 44, `${label}… ${Math.round((received / total) * 100)}%`);
    else setProgress(20, `${label}… ${(received / 1048576).toFixed(1)} MB`);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

/* ---------- MP3 flow ---------- */
async function downloadMP3() {
  const info = state.info;
  const bitrate = qualitySelect.value || '192';
  const name = sanitizeFilename(info.title);
  if (info.duration > 3600) throw new Error('Video is longer than 60 minutes — too heavy for in-browser conversion.');

  // Prefer a dedicated audio stream; fall back to ripping audio out of the best
  // muxed mp4 (some Piped instances return no audio-only streams).
  const audio = pickAudioStream(info);
  const muxed = !audio
    ? (info.videoStreams || []).filter(s => s.url && !s.videoOnly)
        .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0]
    : null;
  const src = audio || muxed;
  if (!src) throw new Error('No audio stream found for this video. Try the MP4 tab instead.');

  let bytes;
  try {
    bytes = await fetchBytes(src.url, audio ? 'Fetching audio' : 'Fetching video (audio fallback)');
  } catch (e) {
    // CORS-blocked fetch: fall back to a plain navigation download of the raw audio file
    setProgress(100, 'Starting direct download…');
    const a = document.createElement('a');
    a.href = audio.url;
    a.download = `${name}.m4a`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 4000);
    setProgress(100, 'Download started — note: this is the raw audio file, not an MP3.');
    return;
  }

  const ffmpeg = await getFFmpeg((t) => setProgress(52, t));
  const inName = 'in.audio', outName = 'out.mp3';
  await ffmpeg.writeFile(inName, bytes);
  setProgress(55, 'Converting… 0%');
  await ffmpeg.exec(['-i', inName, '-vn', '-b:a', `${bitrate}k`, '-y', outName]);
  const data = await ffmpeg.readFile(outName);
  await ffmpeg.deleteFile(inName); await ffmpeg.deleteFile(outName);
  setProgress(100, 'Done');
  triggerDownload(new Blob([data.buffer], { type: 'audio/mpeg' }), `${name}.mp3`);
}

/* ---------- MP4 flow ---------- */
async function downloadMP4() {
  const info = state.info;
  const target = qualitySelect.value || '720p';
  const pick = pickVideoStreams(info, target);
  if (!pick) throw new Error('No downloadable video stream found.');
  const name = sanitizeFilename(info.title);

  if (pick.mode === 'direct') {
    // muxed mp4 — plain download, no conversion needed
    setProgress(30, 'Starting download…');
    const a = document.createElement('a');
    a.href = pick.video.url;
    a.download = `${name}.mp4`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 4000);
    setProgress(100, 'Download started — check your downloads folder.');
    return;
  }

  if (info.duration > 1800) throw new Error('Video is longer than 30 minutes — merging in the browser would be too heavy.');

  const [vBytes, aBytes] = await Promise.all([
    fetchBytes(pick.video.url, 'Fetching video').catch(() => { throw new Error('Video fetch blocked. Try a lower quality.'); }),
    fetchBytes(pick.audio.url, 'Fetching audio').catch(() => { throw new Error('Audio fetch blocked. Try again.'); }),
  ]);

  const ffmpeg = await getFFmpeg((t) => setProgress(52, t));
  await ffmpeg.writeFile('v.mp4', vBytes);
  await ffmpeg.writeFile('a.m4a', aBytes);
  setProgress(55, 'Merging… 0%');
  await ffmpeg.exec(['-i', 'v.mp4', '-i', 'a.m4a', '-c', 'copy', '-shortest', '-y', 'out.mp4']);
  const data = await ffmpeg.readFile('out.mp4');
  for (const f of ['v.mp4', 'a.m4a', 'out.mp4']) await ffmpeg.deleteFile(f).catch(() => {});
  setProgress(100, 'Done');
  triggerDownload(new Blob([data.buffer], { type: 'video/mp4' }), `${name}.mp4`);
}

/* ---------- history ---------- */
function saveHistory(info) {
  try {
    const key = 'tubesnap_history';
    const h = JSON.parse(localStorage.getItem(key) || '[]');
    const entry = { id: state.videoId, title: info.title, thumb: info.thumbnailUrl, at: Date.now() };
    const next = [entry, ...h.filter(x => x.id !== entry.id)].slice(0, 12);
    localStorage.setItem(key, JSON.stringify(next));
    renderHistory();
  } catch { /* storage unavailable — ignore */ }
}
function renderHistory() {
  let h = [];
  try { h = JSON.parse(localStorage.getItem('tubesnap_history') || '[]'); } catch { /* ignore */ }
  const wrap = $('history-wrap'), list = $('history-list');
  if (!h.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  list.innerHTML = '';
  for (const item of h) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '';
    const img = document.createElement('img');
    img.src = item.thumb || ''; img.alt = '';
    const span = document.createElement('span');
    span.className = 'h-title'; span.textContent = item.title || item.id;
    b.append(img, span);
    b.addEventListener('click', () => { urlInput.value = `https://www.youtube.com/watch?v=${item.id}`; form.requestSubmit(); });
    li.appendChild(b);
    list.appendChild(li);
  }
}

/* ---------- events ---------- */
document.querySelectorAll('.fmt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fmt').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    state.format = btn.dataset.format;
    if (state.info) renderResult(state.info); // refresh quality options
  });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  if (state.busy) return;
  const id = extractVideoId(urlInput.value);
  if (!id) { showError('That does not look like a valid YouTube link. Paste a full video URL.'); return; }
  state.videoId = id;
  setBusy(true, 'Fetching…');
  resetProgress();
  try {
    const info = await fetchStreams(id);
    state.info = info;
    renderResult(info);
  } catch (err) {
    console.error(err);
    showError('Could not reach any conversion server right now. These public servers go up and down — please retry in a little while.');
  } finally {
    setBusy(false);
    resetProgress();
  }
});

dlBtn.addEventListener('click', async () => {
  clearError();
  if (state.busy || !state.info) return;
  setBusy(true, 'Preparing…');
  try {
    if (state.format === 'mp3') await downloadMP3();
    else await downloadMP4();
  } catch (err) {
    console.error(err);
    showError(err.message || 'Conversion failed. Please try again.');
  } finally {
    setBusy(false);
    setTimeout(resetProgress, 2500);
  }
});

$('history-clear').addEventListener('click', () => {
  try { localStorage.removeItem('tubesnap_history'); } catch { /* ignore */ }
  renderHistory();
});

renderHistory();
