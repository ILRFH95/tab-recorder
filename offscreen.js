// 錄影程序（隱藏的 offscreen 文件）。可同時錄多個分頁，每個分頁一組 MediaRecorder。
//
// 每個 OPFS 檔案的生命週期：busy（寫入中）→ downloading（交給瀏覽器下載）→ 下載完成後由 sw.js 刪除。
// 兩個集合之間不留空檔，所以檔案在任何時刻都不會被誤認成「未存的錄影」。
import { OpfsWriter, pickMimeType, createCroppedTrack, computeRect } from './recorder-core.js';
import { tempFileName } from './common.js';

const MAX_QUEUED_BYTES = 256 * 1024 * 1024; // 還沒寫進硬碟的資料超過這個量就停止錄影
const writer = new OpfsWriter('opfs-worker.js');
const recs = new Map(); // id -> 錄影
const busy = new Set(); // 正在寫入的 OPFS 檔名
const downloading = new Map(); // 檔名 -> blob URL（下載中；null 代表正在準備）
const recentErrors = [];
let queuedBytes = 0;
let wasRecording = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  handle(msg).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'start':
      await start(msg);
      return { state: snapshot() };
    case 'stop':
      await stop(msg.id);
      return { state: snapshot() };
    case 'state':
      return { state: snapshot() };
    case 'setMonitorMuted': {
      const rec = recs.get(msg.id);
      if (!rec?.monitor) throw new Error('這個錄影沒有錄聲音');
      rec.monitor.gain.value = msg.muted ? 0 : 1;
      return { state: snapshot() };
    }
    case 'saveFile':
      await saveFile(msg.name);
      return {};
    case 'deleteFile':
      if (busy.has(msg.name) || downloading.has(msg.name)) throw new Error('這個檔案正在使用中，不能刪除');
      await (await navigator.storage.getDirectory()).removeEntry(msg.name);
      return {};
    case 'downloadDone': {
      const url = downloading.get(msg.name);
      if (url) URL.revokeObjectURL(url);
      downloading.delete(msg.name);
      return {};
    }
    default:
      throw new Error(`未知的指令：${msg.type}`);
  }
}

function noteError(title, message) {
  console.error(title, message);
  recentErrors.unshift({ time: Date.now(), title, message });
  recentErrors.length = Math.min(recentErrors.length, 5);
}

function snapshot() {
  return {
    recordings: [...recs.values()].map((r) => ({
      id: r.id,
      tabId: r.tabId,
      title: r.title,
      startedAt: r.startedAt,
      segStartedAt: r.current.startedAt,
      part: r.part,
      cropLabel: r.cropLabel,
      size: r.cropper.info.outW ? `${r.cropper.info.outW}×${r.cropper.info.outH}` : '',
      error: r.error || null,
      hasAudio: Boolean(r.monitor),
      monitorMuted: r.monitor ? r.monitor.gain.value === 0 : false,
    })),
    busyFiles: [...busy, ...downloading.keys()],
    errors: recentErrors,
  };
}

async function start(msg) {
  const { streamId, tabId, title, tabW, tabH, crop, cropLabel, settings } = msg;
  const dpr = msg.screenDpr || window.devicePixelRatio || 1;
  const rec = {
    id: crypto.randomUUID(),
    tabId,
    title: title || '',
    cropLabel,
    settings,
    startedAt: Date.now(),
    part: 0,
    current: null,
    stopping: false,
    rotating: false,
    error: null,
  };

  try {
    rec.media = await navigator.mediaDevices.getUserMedia({
      audio: settings.audio ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } : false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: Math.round(tabW * dpr),
          maxHeight: Math.round(tabH * dpr),
          maxFrameRate: settings.fps,
        },
      },
    });
    const src = rec.media.getVideoTracks()[0];
    const audioTracks = rec.media.getAudioTracks();

    // 擷取分頁聲音時，分頁本身會被靜音，要自己再播出來。
    // 中間接一個音量節點，「靜音播放」只把它調成 0，錄進檔案的聲音不受影響。
    if (audioTracks.length) {
      rec.audioCtx = new AudioContext();
      rec.monitor = rec.audioCtx.createGain();
      rec.audioCtx.createMediaStreamSource(new MediaStream(audioTracks)).connect(rec.monitor);
      rec.monitor.connect(rec.audioCtx.destination);
      rec.audioCtx.resume().catch(() => {});
    }

    // 整個分頁也走裁切流程，順便去掉擷取畫面可能出現的黑邊。
    // 只有第一格用分頁寬高比判斷黑邊；之後尺寸改變時直接對整個畫面套用比例。
    rec.cropper = createCroppedTrack(
      src,
      (fw, fh, isFirst) => computeRect(fw, fh, isFirst ? tabW / tabH : null, crop),
      (err) => endWithError(rec, `畫面處理失敗：${err.message}`),
    );
    rec.stream = new MediaStream([rec.cropper.track, ...audioTracks]);
    rec.mime = pickMimeType(settings.codec, audioTracks.length > 0);
    await startSegment(rec);
    src.addEventListener('ended', () => stop(rec.id)); // 分頁被關掉
  } catch (err) {
    releaseCapture(rec);
    throw err;
  }
  recs.set(rec.id, rec);
  sendTick();
}

function releaseCapture(rec) {
  rec.cropper?.stop();
  rec.media?.getTracks().forEach((t) => t.stop());
  rec.audioCtx?.close().catch(() => {});
}

async function startSegment(rec) {
  const part = rec.part + 1;
  const segStart = new Date();
  // 暫存檔名含錄影 ID，同一秒錄兩個同名分頁也不會撞名
  const name = tempFileName(rec.title, segStart, rec.id, part);
  busy.add(name);
  try {
    await writer.open(name);
  } catch (err) {
    busy.delete(name);
    throw err;
  }

  let mr;
  try {
    if (rec.stopping) throw new Error('stopping');
    mr = new MediaRecorder(rec.stream, {
      mimeType: rec.mime,
      videoBitsPerSecond: rec.settings.bitrateMbps * 1e6,
      audioBitsPerSecond: 128000,
    });
  } catch (err) {
    // 建立失敗或開檔期間使用者按了停止：關檔並刪掉這個空檔
    await writer.close(name).catch(() => {});
    busy.delete(name);
    (await navigator.storage.getDirectory()).removeEntry(name).catch(() => {});
    if (rec.stopping) return;
    throw err;
  }

  const seg = { name, mr, startedAt: Date.now(), chain: Promise.resolve(), failed: false };
  seg.stopped = new Promise((resolve) => { mr.onstop = resolve; });
  mr.ondataavailable = (e) => {
    if (!e.data.size || seg.failed) return;
    if (queuedBytes > MAX_QUEUED_BYTES) {
      failSegment(rec, seg, '硬碟寫入速度跟不上，已停止錄影');
      return;
    }
    const size = e.data.size;
    queuedBytes += size;
    seg.chain = seg.chain
      .then(async () => {
        if (seg.failed) return;
        await writer.write(name, await e.data.arrayBuffer());
      })
      .catch((err) => failSegment(rec, seg, `寫檔失敗：${err.message}`))
      .finally(() => { queuedBytes -= size; });
  };
  mr.onerror = (e) => endWithError(rec, `錄影錯誤：${e.error?.message || e.error || '未知'}`);
  mr.start(1000); // 每秒產生一段資料並寫進硬碟

  rec.part = part;
  const prev = rec.current;
  rec.current = seg;
  // 新的一段先開始再結束舊的，兩段之間不會有空檔
  if (prev) finishSegment(rec, prev);
}

// 寫檔失敗：之後的資料不再接上去（避免檔案中間缺一塊），
// 已寫入的部分留在「未存的錄影」清單讓使用者手動存。
function failSegment(rec, seg, message) {
  if (seg.failed) return;
  seg.failed = true;
  endWithError(rec, message);
}

function endWithError(rec, message) {
  rec.error = message;
  noteError(rec.title, message);
  stop(rec.id);
}

async function finishSegment(rec, seg) {
  try {
    if (seg.mr.state !== 'inactive') seg.mr.stop();
    await seg.stopped;
    await seg.chain; // 最後一段資料在 stop 事件之前就會送出
    await writer.close(seg.name);
    if (!seg.failed) await saveFile(seg.name);
  } catch (err) {
    noteError(rec.title, `存檔失敗，檔案保留在「未存的錄影」：${err.message}`);
  } finally {
    busy.delete(seg.name); // saveFile 已經先把檔案登記到 downloading，中間不會有空檔
  }
}

async function stop(id) {
  const rec = recs.get(id);
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  recs.delete(id);
  sendTick();
  const seg = rec.current;
  const done = finishSegment(rec, seg);
  await seg.stopped;
  releaseCapture(rec);
  await done;
}

// 把 OPFS 裡的檔案交給瀏覽器下載。下載完成後由 service worker 刪掉暫存。
async function saveFile(name) {
  if (downloading.has(name)) throw new Error('這個檔案已經在存檔中');
  downloading.set(name, null); // 先佔位，再做任何非同步動作
  let url = null;
  try {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(name)).getFile();
    if (!file.size) {
      await root.removeEntry(name).catch(() => {});
      downloading.delete(name);
      return;
    }
    url = URL.createObjectURL(file);
    downloading.set(name, url);
    const res = await chrome.runtime.sendMessage({ target: 'sw', type: 'download', url, name });
    if (!res?.ok) throw new Error(res?.error || '下載失敗');
  } catch (err) {
    // 下載沒開始：釋放 URL，檔案留在 OPFS，之後會出現在「未存的錄影」
    if (url) URL.revokeObjectURL(url);
    downloading.delete(name);
    throw err;
  }
}

function sendTick() {
  chrome.runtime.sendMessage({ target: 'sw', type: 'tick', state: snapshot() }).catch(() => {});
}

// 每秒：檢查是否該分段、回報狀態給 service worker 更新徽章
setInterval(() => {
  const now = Date.now();
  for (const rec of recs.values()) {
    const segMs = rec.settings.segmentMinutes * 60000;
    if (segMs > 0 && !rec.stopping && !rec.rotating && now - rec.current.startedAt >= segMs) {
      rec.rotating = true;
      startSegment(rec)
        .catch((err) => noteError(rec.title, `分段失敗，繼續錄在同一個檔案：${err.message}`))
        .finally(() => { rec.rotating = false; });
    }
  }
  if (recs.size || wasRecording) sendTick();
  wasRecording = recs.size > 0;
}, 1000);
