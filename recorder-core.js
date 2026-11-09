// 錄影核心：裁切、編碼格式選擇、OPFS 寫檔。offscreen.js 與 test/harness.js 共用。

export function pickMimeType(codec, withAudio) {
  const order = { h264: ['h264'], vp8: ['vp8'], vp9: ['vp9'] }[codec] || ['h264', 'vp8', 'vp9'];
  const audio = withAudio ? ',opus' : '';
  for (const v of order) {
    const type = `video/webm;codecs=${v}${audio}`;
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

// 算出要從擷取畫面中裁出的矩形（顯示座標）。
// crop 是相對於分頁可視區的比例 {x,y,w,h}；null 代表整個分頁。
// aspect 是分頁的寬高比，用來扣掉擷取畫面可能出現的黑邊。
export function computeRect(fw, fh, aspect, crop) {
  let cw = fw, ch = fh;
  if (aspect && Math.abs(fw / fh - aspect) / aspect > 0.02) {
    ch = fw / aspect;
    if (ch > fh) { ch = fh; cw = fh * aspect; }
  }
  const ox = (fw - cw) / 2, oy = (fh - ch) / 2;
  const c = crop || { x: 0, y: 0, w: 1, h: 1 };
  const x = Math.max(0, even(ox + c.x * cw));
  const y = Math.max(0, even(oy + c.y * ch));
  const width = Math.max(2, even(Math.min(fw - x, c.w * cw)));
  const height = Math.max(2, even(Math.min(fh - y, c.h * ch)));
  return { x, y, width, height };
}

function even(n) {
  return Math.floor(n / 2) * 2;
}

// 把來源影像軌逐格裁切，回傳新的影像軌。輸出尺寸在第一格決定後固定不變，
// 之後若來源尺寸改變，就等比縮放放進原本的輸出尺寸（比例不同時補黑邊，不會拉長或壓扁），
// 避免編碼器中途換解析度。
// 注意：不能用 new VideoFrame(frame, { visibleRect }) 裁切，實測 MediaRecorder 會忽略
// visibleRect，錄出全黑畫面，所以一律畫到 OffscreenCanvas 上再產生新影格。
// rectFor(fw, fh) 在來源尺寸改變或 refresh() 後呼叫；onError 在處理失敗時呼叫（使用者停止時不會呼叫）。
export function createCroppedTrack(srcTrack, rectFor, onError) {
  const processor = new MediaStreamTrackProcessor({ track: srcTrack });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();
  // dark：最近一次檢查時畫面是不是幾乎全黑（給「自動暫停」用）
  const info = { outW: 0, outH: 0, dark: false };
  let lastKey = '', rect = null, dest = null, canvas = null, ctx = null, stopped = false;
  // 每秒檢查畫布上最新的一格是否全黑。用計時器而不是等新影格：
  // 畫面靜止時分頁不會送新影格，等影格的話最後一格可能永遠沒被檢查到
  const darkTimer = setInterval(() => {
    if (canvas) info.dark = isDark(canvas);
  }, 1000);

  (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        let next;
        try {
          const fw = frame.displayWidth, fh = frame.displayHeight;
          const key = `${fw}x${fh}`;
          if (key !== lastKey) {
            lastKey = key;
            rect = rectFor(fw, fh);
            if (!canvas) {
              info.outW = rect.width;
              info.outH = rect.height;
              canvas = new OffscreenCanvas(info.outW, info.outH);
              ctx = canvas.getContext('2d', { alpha: false });
            }
            dest = fitRect(rect.width, rect.height, info.outW, info.outH);
          }
          if (dest.width < info.outW || dest.height < info.outH) {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, info.outW, info.outH);
          }
          ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height, dest.x, dest.y, dest.width, dest.height);
          next = new VideoFrame(canvas, { timestamp: frame.timestamp });
        } finally {
          frame.close();
        }
        await writer.write(next); // generator 會自己關閉寫入的影格
      }
    } catch (err) {
      if (!stopped) onError?.(err);
    } finally {
      clearInterval(darkTimer);
      reader.cancel().catch(() => {});
      writer.close().catch(() => {});
      generator.stop();
    }
  })();

  return {
    track: generator,
    info,
    // 範圍改了：下一格重新呼叫 rectFor
    refresh() {
      lastKey = '';
    },
    stop() {
      stopped = true;
      clearInterval(darkTimer);
      reader.cancel().catch(() => {});
      generator.stop();
    },
  };
}

// 自動暫停的判斷（每秒呼叫一次）：
// 錄影中「沒畫面也沒聲音」連續 pauseMs 就回傳 'pause'；暫停中「有畫面或有聲音」連續 resumeMs 就回傳 'resume'。
// 會更新 s.quietSince／s.activeSince 記錄狀態開始的時間；s.paused 由呼叫端維護。
export function autoPauseStep(s, active, now, pauseMs, resumeMs) {
  if (!s.paused) {
    s.activeSince = null;
    if (active) {
      s.quietSince = null;
      return null;
    }
    s.quietSince ??= now;
    return now - s.quietSince >= pauseMs ? 'pause' : null;
  }
  s.quietSince = null;
  if (!active) {
    s.activeSince = null;
    return null;
  }
  s.activeSince ??= now;
  return now - s.activeSince >= resumeMs ? 'resume' : null;
}

// 把 sw×sh 的畫面等比縮放放進 ow×oh 裡、置中；比例差不到 1% 時直接填滿，避免多出一條細黑邊
export function fitRect(sw, sh, ow, oh) {
  if (Math.abs(sw / sh - ow / oh) / (ow / oh) < 0.01) return { x: 0, y: 0, width: ow, height: oh };
  const scale = Math.min(ow / sw, oh / sh);
  const width = Math.round(sw * scale), height = Math.round(sh * scale);
  return { x: Math.round((ow - width) / 2), y: Math.round((oh - height) / 2), width, height };
}

const darkProbe = new OffscreenCanvas(16, 16);
const darkCtx = darkProbe.getContext('2d', { willReadFrequently: true });

// 亮度超過 32（0～255）的點不到 2% 就算全黑，容許一點雜訊或小字
export function isDark(source) {
  darkCtx.drawImage(source, 0, 0, 16, 16);
  const d = darkCtx.getImageData(0, 0, 16, 16).data;
  let bright = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 32) bright++;
  }
  return bright / 256 < 0.02;
}

// 透過 worker 用 SyncAccessHandle 直接寫進 OPFS 檔案。
// 每次寫完都 flush，瀏覽器當掉時已寫入的部分會留在檔案裡。
// worker 掛掉時，所有等待中與之後的操作都會直接失敗，不會卡住。
export class OpfsWriter {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl);
    this.seq = 0;
    this.pending = new Map();
    this.dead = null;
    this.worker.onmessage = (e) => {
      const { id, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve();
    };
    const die = (e) => {
      this.dead = new Error(`寫檔程序停止了：${e.message || e.type}`);
      for (const p of this.pending.values()) p.reject(this.dead);
      this.pending.clear();
    };
    this.worker.onerror = die;
    this.worker.onmessageerror = die;
  }

  call(op, name, buf) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, name, buf }, buf ? [buf] : []);
    });
  }

  open(name) { return this.call('open', name); }
  write(name, buf) { return this.call('write', name, buf); }
  close(name) { return this.call('close', name); }
}
