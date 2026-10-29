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
// 之後若來源尺寸改變，就縮放到原本的輸出尺寸，避免編碼器中途換解析度。
// 注意：不能用 new VideoFrame(frame, { visibleRect }) 裁切，實測 MediaRecorder 會忽略
// visibleRect，錄出全黑畫面，所以一律畫到 OffscreenCanvas 上再產生新影格。
// rectFor(fw, fh, isFirst) 在來源尺寸改變時呼叫；onError 在處理失敗時呼叫（使用者停止時不會呼叫）。
export function createCroppedTrack(srcTrack, rectFor, onError) {
  const processor = new MediaStreamTrackProcessor({ track: srcTrack });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();
  const info = { outW: 0, outH: 0 };
  let lastKey = '', rect = null, canvas = null, ctx = null, stopped = false;

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
            rect = rectFor(fw, fh, !canvas);
            if (!canvas) {
              info.outW = rect.width;
              info.outH = rect.height;
              canvas = new OffscreenCanvas(info.outW, info.outH);
              ctx = canvas.getContext('2d', { alpha: false });
            }
          }
          ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, info.outW, info.outH);
          next = new VideoFrame(canvas, { timestamp: frame.timestamp });
        } finally {
          frame.close();
        }
        await writer.write(next); // generator 會自己關閉寫入的影格
      }
    } catch (err) {
      if (!stopped) onError?.(err);
    } finally {
      reader.cancel().catch(() => {});
      writer.close().catch(() => {});
      generator.stop();
    }
  })();

  return {
    track: generator,
    info,
    stop() {
      stopped = true;
      reader.cancel().catch(() => {});
      generator.stop();
    },
  };
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
