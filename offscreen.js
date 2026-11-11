// 錄影程序（隱藏的 offscreen 文件）。可同時錄多個分頁，每個分頁一組 MediaRecorder。
//
// 每個 OPFS 檔案的生命週期：busy（寫入中）→ downloading（交給瀏覽器下載）→ 下載完成後由 sw.js 刪除。
// 兩個集合之間不留空檔，所以檔案在任何時刻都不會被誤認成「未存的錄影」。
import { OpfsWriter, pickMimeType, createCroppedTrack, computeRect, autoPauseStep, chooseBitrate, limitSize, captureScale } from './recorder-core.js';
import { tempFileName } from './common.js';

const MAX_QUEUED_BYTES = 256 * 1024 * 1024; // 還沒寫進硬碟的資料超過這個量就停止錄影
// 自動暫停：沒畫面也沒聲音持續 30 秒就暫停（這段存檔），畫面或聲音恢復持續 3 秒就開新檔案繼續錄
const PAUSE_AFTER_MS = 30000;
const RESUME_AFTER_MS = 3000;
const SOUND_RMS = 0.004; // 約 -48 dBFS，低於這個音量算沒聲音
const writer = new OpfsWriter('opfs-worker.js');
const recs = new Map(); // id -> 錄影
const busy = new Set(); // 正在寫入的 OPFS 檔名
const downloading = new Map(); // 檔名 -> blob URL（下載中；null 代表正在準備）
const recentErrors = [];
let queuedBytes = 0;
let wasRecording = false;
let idleSince = null;

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
    case 'updateCrop': {
      const rec = recs.get(msg.id);
      if (!rec || rec.stopping) throw new Error('錄影已經結束');
      if (msg.crop) {
        rec.crop = msg.crop;
        rec.cropper.refresh(); // 下一格起套用新範圍，縮放到固定的輸出尺寸
      }
      // 「自動框住影片」回報影片停止或不見了，自動暫停時算作沒畫面
      // 影片來源規格：解析度隨時更新，位元率還沒量到時沿用上次的
      if (msg.source?.w) rec.source = { ...msg.source, kbps: msg.source.kbps ?? rec.source?.kbps ?? null };
      if (msg.videoState) {
        rec.videoGone = msg.videoState !== 'playing';
        rec.videoStateAt = Date.now();
      }
      return {};
    }
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
      // 只處理這一次下載：同一個檔案若已在重試，網址會不同，不能動到
      if (msg.url && url !== msg.url) return {};
      if (url) URL.revokeObjectURL(url);
      downloading.delete(msg.name);
      return {};
    }
    case 'note':
      noteError('', msg.message);
      return {};
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
      segStartedAt: r.current?.startedAt ?? null,
      paused: r.paused,
      pausedAt: r.pausedAt,
      pausedMs: r.pausedMs,
      part: r.part,
      cropLabel: r.cropLabel,
      size: r.cropper.info.outW ? `${r.cropper.info.outW}×${r.cropper.info.outH}` : '',
      error: r.error || null,
      source: r.source,
      bitrateMbps: r.bitrateMbps,
      captureScale: r.captureScale,
      // 實際擷取倍率：第一格的寬度跟分頁像素寬度比較；還沒有畫面時是 0
      actualScale: r.cropper.info.frameW ? Math.round((r.cropper.info.frameW / r.tabPxW) * 100) / 100 : 0,
      hasAudio: Boolean(r.monitor),
      monitorMuted: r.monitor ? r.monitor.gain.value === 0 : false,
    })),
    busyFiles: [...busy, ...downloading.keys()],
    errors: recentErrors,
  };
}

async function start(msg) {
  const { streamId, tabId, title, tabW, tabH, crop, cropLabel, settings, source } = msg;
  const dpr = msg.screenDpr || window.devicePixelRatio || 1;
  const tabPxW = Math.round(tabW * dpr), tabPxH = Math.round(tabH * dpr);
  // 影片在畫面上比來源小時，要求更大的擷取尺寸，讓瀏覽器用更高倍率重畫分頁
  const scale = captureScale(tabPxW, tabPxH, crop, source);
  const rec = {
    id: crypto.randomUUID(),
    tabId,
    title: title || '',
    cropLabel,
    crop, // 「自動框住影片」時會在錄影途中被更新
    source: source || null, // 影片來源規格 {w, h, kbps}，只有「自動框住影片」才有
    settings,
    startedAt: Date.now(),
    part: 0,
    current: null,
    stopping: false,
    rotating: false,
    error: null,
    paused: false, // 自動暫停中：沒有正在寫的檔案（current 是 null）
    pausedAt: null,
    pausedMs: 0, // 累計暫停時間，不算進錄影時間
    quietSince: null,
    activeSince: null,
    lastSoundAt: Date.now(),
    videoGone: false,
    videoStateAt: 0,
    tabPxW,
    captureScale: scale, // 要求的擷取倍率；實際倍率看第一格的尺寸
  };

  try {
    rec.media = await navigator.mediaDevices.getUserMedia({
      audio: settings.audio ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } : false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: Math.round(tabPxW * scale),
          maxHeight: Math.round(tabPxH * scale),
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
      const source = rec.audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
      source.connect(rec.monitor);
      rec.monitor.connect(rec.audioCtx.destination);
      // 量音量給自動暫停用；接在「靜音播放」之前，靜音播放時一樣量得到
      rec.analyser = rec.audioCtx.createAnalyser();
      rec.analyser.fftSize = 2048;
      source.connect(rec.analyser);
      rec.audioCtx.resume().catch(() => {});
    }

    // 整個分頁也走裁切流程，順便去掉擷取畫面可能出現的黑邊。
    // 來源尺寸跟第一格相同時，用開始錄影時的分頁寬高比判斷黑邊（範圍更新後也一樣）；
    // 尺寸變了代表分頁大小變了，舊的寬高比不準，直接對整個畫面套用比例。
    let firstSize = null;
    rec.cropper = createCroppedTrack(
      src,
      (fw, fh) => {
        firstSize ??= `${fw}x${fh}`;
        return computeRect(fw, fh, firstSize === `${fw}x${fh}` ? tabW / tabH : null, rec.crop);
      },
      (err) => endWithError(rec, `畫面處理失敗：${err.message}`),
      () => (rec.source?.w ? { w: rec.source.w, h: rec.source.h } : null), // 錄影尺寸不超過來源解析度
    );
    // 第一格出來前就要開始錄，先估一個輸出尺寸給「自動」畫質用
    const c = crop || { w: 1, h: 1 };
    rec.estOut = limitSize(Math.round(tabPxW * scale * c.w), Math.round(tabPxH * scale * c.h), rec.source);
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

  let seg;
  try {
    if (rec.stopping) throw new Error('stopping');
    const info = rec.cropper.info;
    // 畫質選「自動」時，每一段開始時依當下的來源規格重新決定位元率
    rec.bitrateMbps = chooseBitrate(
      rec.settings.bitrateMbps, info.outW || rec.estOut.w, info.outH || rec.estOut.h, rec.settings.fps, rec.source?.kbps,
    );
    const mr = new MediaRecorder(rec.stream, {
      mimeType: rec.mime,
      videoBitsPerSecond: rec.bitrateMbps * 1e6,
      audioBitsPerSecond: 128000,
    });
    seg = { name, mr, startedAt: Date.now(), chain: Promise.resolve(), failed: false };
    seg.stopped = new Promise((resolve) => { mr.onstop = resolve; });
    mr.ondataavailable = (e) => {
      if (!e.data.size || seg.failed) return;
      const size = e.data.size;
      // 連同這一塊一起算，超過上限就停止，避免記憶體被塞爆
      if (queuedBytes + size > MAX_QUEUED_BYTES) {
        failSegment(rec, seg, '硬碟寫入速度跟不上，已停止錄影');
        return;
      }
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
  } catch (err) {
    // 建立或開始失敗、或開檔期間使用者按了停止：關檔並刪掉這個空檔
    await writer.close(name).catch(() => {});
    busy.delete(name);
    (await navigator.storage.getDirectory()).removeEntry(name).catch(() => {});
    if (rec.stopping) return;
    throw err;
  }

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
  if (!seg) {
    releaseCapture(rec); // 暫停中：目前沒有正在寫的檔案
    return;
  }
  const done = finishSegment(rec, seg);
  await seg.stopped;
  releaseCapture(rec);
  await done;
}

// 自動暫停：結束並存下目前這段，之後恢復時開新檔案
function pauseRecording(rec) {
  if (rec.paused || !rec.current) return;
  const seg = rec.current;
  rec.current = null;
  rec.paused = true;
  rec.pausedAt = Date.now();
  rec.activeSince = null;
  finishSegment(rec, seg);
  sendTick();
}

function resumeRecording(rec) {
  if (!rec.paused) return;
  rec.paused = false;
  rec.pausedMs += Date.now() - rec.pausedAt;
  rec.pausedAt = null;
  rec.quietSince = null;
  rec.rotating = true;
  startSegment(rec)
    .catch((err) => endWithError(rec, `恢復錄影失敗：${err.message}`))
    .finally(() => { rec.rotating = false; sendTick(); });
}

function checkAutoPause(rec, now) {
  if (!rec.settings.autoPause || rec.stopping || rec.rotating) return;
  // 追蹤程式每 10 秒至少回報一次；超過 25 秒沒消息（例如換頁）就不採用舊的影片狀態，只看畫面
  const videoGone = rec.videoGone && now - rec.videoStateAt < 25000;
  const hasPicture = !rec.cropper.info.dark && !videoGone;
  const hasSound = Boolean(rec.analyser) && now - rec.lastSoundAt < 1500;
  const action = autoPauseStep(rec, hasPicture || hasSound, now, PAUSE_AFTER_MS, RESUME_AFTER_MS);
  if (action === 'pause') pauseRecording(rec);
  else if (action === 'resume') resumeRecording(rec);
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
    checkAutoPause(rec, now);
    const segMs = rec.settings.segmentMinutes * 60000;
    if (segMs > 0 && rec.current && !rec.stopping && !rec.rotating && now - rec.current.startedAt >= segMs) {
      rec.rotating = true;
      startSegment(rec)
        .catch((err) => noteError(rec.title, `分段失敗，繼續錄在同一個檔案：${err.message}`))
        .finally(() => { rec.rotating = false; });
    }
  }
  if (recs.size || wasRecording) sendTick();
  wasRecording = recs.size > 0;
  // 沒有錄影、寫入和下載持續一分鐘，就請背景程式把這個錄影程序關掉（下次要用時再開）
  if (recs.size || busy.size || downloading.size) {
    idleSince = null;
  } else {
    idleSince ??= now;
    if (now - idleSince >= 60000) {
      idleSince = now; // 背景程式沒關的話，一分鐘後再問一次
      chrome.runtime.sendMessage({ target: 'sw', type: 'idle' }).catch(() => {});
    }
  }
}, 1000);

// 每 0.25 秒量一次各錄影的音量，有聲音就記下時間
setInterval(() => {
  const now = Date.now();
  for (const rec of recs.values()) {
    if (!rec.analyser) continue;
    // 聲音處理沒在運作（被暫停或裝置出錯）時，量到的是舊資料，不能拿來判斷；
    // 當作有聲音，寧可不自動暫停，並試著恢復
    const t = rec.audioCtx.currentTime;
    if (rec.audioCtx.state !== 'running' || t === rec.lastAudioTime) {
      rec.lastSoundAt = now;
      if (rec.audioCtx.state === 'suspended') rec.audioCtx.resume().catch(() => {});
      rec.lastAudioTime = t;
      continue;
    }
    rec.lastAudioTime = t;
    rec.soundBuf ??= new Float32Array(rec.analyser.fftSize);
    rec.analyser.getFloatTimeDomainData(rec.soundBuf);
    let sum = 0;
    for (const v of rec.soundBuf) sum += v * v;
    if (Math.sqrt(sum / rec.soundBuf.length) > SOUND_RMS) rec.lastSoundAt = now;
  }
}, 250);
