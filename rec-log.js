// 錄影紀錄：把每一段錄影檔的起訖時間與錄影參數記在 IndexedDB（資料庫 recLog），彈出視窗可匯出 CSV。
// 只記時間和設定，不記分頁標題、網址、檔名、範圍組名稱。
//
// 錄影程序（offscreen.js）只會呼叫 logStart / logBeat / logEnd / logWriteError：它們一律「不等待、不拋錯」，
// 寫入失敗只 console.warn，絕不影響錄影。寫入全部排進同一個佇列依序執行，每個操作是一個交易，在交易內讀出舊列、合併再寫回。

const DB_NAME = 'recLog';
const DB_VERSION = 1;
const STORE = 'segments';

export const MAX_ROWS = 2000; // 超過就刪最舊的（依 start）
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // 清理時：沒結束而且 10 分鐘內有心跳的列視為進行中，不刪
export const BEAT_INTERVAL_MS = 60 * 1000; // 錄影程序每隔多久送一次心跳
export const RECORDING_WINDOW_MS = 3 * 60 * 1000; // 匯出時：沒結束的列，心跳距現在不到這麼久標 recording，否則標 unknown
const QUEUE_LIMIT = 200; // 待辦超過這個數量就丟掉心跳（開始、結束不丟）

// ---- 開庫 ----

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    let settled = false;
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      settled = true;
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('start', 'start');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { // 已經被當成失敗（例如 blocked），晚到的連線直接關掉
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => { // 別的地方要升級資料庫：關掉連線讓路，下次用時重新開
        db.close();
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(req.error || new Error('開啟錄影紀錄資料庫失敗'));
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error('錄影紀錄資料庫被擋住'));
    };
  });
  dbPromise = p;
  p.catch(() => { if (dbPromise === p) dbPromise = null; }); // 失敗不快取，下次重試
  return p;
}

// 開一個交易，body(store, setResult) 裡只能發 IDB 請求（不能 await）
function run(mode, body) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(STORE, mode);
    } catch (err) {
      if (dbPromise) dbPromise = null; // 連線可能已經被關掉，下次重開
      reject(err);
      return;
    }
    let result;
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(t.error || new Error('錄影紀錄交易中止'));
    try {
      body(t.objectStore(STORE), (v) => { result = v; });
    } catch (err) {
      reject(err);
      try { t.abort(); } catch { /* 已經結束 */ }
    }
  }));
}

// ---- 寫入佇列 ----

let chain = Promise.resolve();
let pending = 0;

function enqueue(fn, droppable = false) {
  if (droppable && pending >= QUEUE_LIMIT) return;
  pending++;
  chain = chain
    .then(fn)
    .catch((err) => console.warn('[recLog] 寫入失敗：', err?.message || err))
    .then(() => { pending--; });
}

// 測試用：等目前排隊的寫入全部做完（永遠不會拒絕）
export const flush = () => chain;

function safe(fn) {
  try {
    fn();
  } catch (err) {
    console.warn('[recLog]', err?.message || err);
  }
}

// 新增一列，並在同一個交易裡清理：超過 maxRows 就依 start 由舊到新刪，跳過進行中的列
function insertRow(store, row, maxRows, now) {
  store.put(row);
  store.count().onsuccess = (e) => {
    let excess = e.target.result - maxRows;
    if (excess <= 0) return;
    store.index('start').openCursor().onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur || excess <= 0) return;
      const r = cur.value;
      const active = r.end == null && (r.lastSeen ?? r.start) > now - ACTIVE_WINDOW_MS;
      if (r.key !== row.key && !active) {
        cur.delete();
        excess--;
      }
      cur.continue();
    };
  };
}

// entry：{ key, recId, part, start, concurrent, cropKind, ... }（見 segmentStartEntry）
export function logStart(entry, opts = {}) {
  safe(() => {
    const maxRows = opts.maxRows ?? MAX_ROWS;
    const now = opts.now ?? Date.now();
    enqueue(() => run('readwrite', (store) => {
      store.get(entry.key).onsuccess = (e) => {
        const row = { end: null, endReason: null, lastSeen: entry.start, ...entry, ...(e.target.result || {}) };
        insertRow(store, row, maxRows, now);
      };
    }));
  });
}

// 每分鐘更新進行中各段的 lastSeen。已經有 end 的列不動
export function logBeat(keys, now = Date.now()) {
  safe(() => {
    const list = [...keys];
    if (!list.length) return;
    enqueue(() => run('readwrite', (store) => {
      for (const key of list) {
        store.get(key).onsuccess = (e) => {
          const row = e.target.result;
          if (!row || row.end != null) return;
          store.put({ ...row, lastSeen: Math.max(row.lastSeen ?? 0, now) });
        };
      }
    }), true);
  });
}

// fields：{ end, endReason, outW, outH, srcW, srcH, srcKbps }。
// base：開始時那筆資料；找不到原列（開始那筆沒寫成功）時，用它加上 fields 另寫一列
export function logEnd(key, fields, base = null, opts = {}) {
  safe(() => {
    const maxRows = opts.maxRows ?? MAX_ROWS;
    const now = opts.now ?? Date.now();
    enqueue(() => run('readwrite', (store) => {
      store.get(key).onsuccess = (e) => {
        const old = e.target.result;
        if (old) {
          if (old.end != null) return; // 已經結束過，不再改
          store.put({ ...old, ...fields, lastSeen: Math.max(old.lastSeen ?? 0, fields.end ?? 0) });
          return;
        }
        const i = key.lastIndexOf(':');
        const row = {
          key,
          recId: key.slice(0, i),
          part: Number(key.slice(i + 1)),
          start: fields.end,
          ...(base || {}),
          ...fields,
          lastSeen: fields.end,
        };
        insertRow(store, row, maxRows, now);
      };
    }));
  });
}

// 這段寫檔失敗。只記有失敗，不存錯誤訊息
export function logWriteError(key) {
  safe(() => {
    enqueue(() => run('readwrite', (store) => {
      store.get(key).onsuccess = (e) => {
        const row = e.target.result;
        if (row) store.put({ ...row, writeError: 1 });
      };
    }));
  });
}

// 彈出視窗用：讀出全部（最多 MAX_ROWS 筆）。失敗會拒絕，由呼叫端顯示原因
export async function readAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('讀取失敗'));
  });
}

// ---- 錄影程序用的純函式 ----

// 範圍種類：tab 整個分頁 / custom 自訂範圍或範圍組 / auto 自動框住影片。不存範圍組名稱
export function cropKind(rec) {
  if (rec.autoVideo) return 'auto';
  return rec.crop ? 'custom' : 'tab';
}

// 這段開始時正在寫檔的錄影數（含自己，同一個錄影只算一次）。
// recs：目前所有錄影；selfId：開始這段的錄影 id（第一段開始時自己還不在 recs 裡）
export function countConcurrent(recs, selfId) {
  let n = 0;
  let selfCounted = false;
  for (const r of recs) {
    if (!r.current || r.paused || r.stopping) continue;
    n++;
    if (r.id === selfId) selfCounted = true;
  }
  return selfCounted ? n : n + 1;
}

const orNull = (v) => (v == null ? null : v);

export function segmentStartEntry(rec, seg, part, concurrent) {
  const info = rec.cropper?.info;
  return {
    key: `${rec.id}:${part}`,
    recId: rec.id,
    part,
    start: seg.startedAt,
    lastSeen: seg.startedAt,
    end: null,
    endReason: null,
    concurrent,
    cropKind: cropKind(rec),
    captureScale: orNull(rec.captureScale),
    outW: info?.outW || rec.estOut?.w || null, // 開始時還沒有第一格，先用估計值，結束時會換成實際值
    outH: info?.outH || rec.estOut?.h || null,
    srcW: orNull(rec.source?.w),
    srcH: orNull(rec.source?.h),
    srcKbps: orNull(rec.source?.kbps),
    fps: orNull(rec.settings?.fps),
    bitrateMbps: orNull(rec.bitrateMbps),
    mime: rec.mime || null,
    audio: Boolean(rec.monitor),
    hideCursor: Boolean(rec.settings?.hideCursor),
    autoPause: Boolean(rec.settings?.autoPause),
  };
}

// reason：rotate / pause / stop。錄影有錯誤時一律記 error
export function segmentEndFields(rec, reason, now = Date.now()) {
  const info = rec.cropper?.info;
  return {
    end: now,
    endReason: rec.error ? 'error' : reason,
    outW: info?.outW || null,
    outH: info?.outH || null,
    srcW: orNull(rec.source?.w),
    srcH: orNull(rec.source?.h),
    srcKbps: orNull(rec.source?.kbps),
  };
}

// ---- CSV ----

const BOM = String.fromCharCode(0xFEFF);
const pad = (n) => String(n).padStart(2, '0');

export function fmtLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 該時刻的時區偏移，例如 +08:00
export function fmtOffset(ms) {
  const m = -new Date(ms).getTimezoneOffset();
  const a = Math.abs(m);
  return `${m < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function fmtDate(ms) {
  return fmtLocal(ms).slice(0, 10);
}

export function fmtStamp(ms) { // YYYYMMDD-HHmmss，給檔名用
  return fmtLocal(ms).replace(/-/g, '').replace(' ', '-').replace(/:/g, '');
}

function cell(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const msOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const CSV_COLUMNS = [
  'rec_id', 'part',
  'start_local', 'end_local', 'last_seen_local', 'tz_offset',
  'start_ms', 'end_ms', 'last_seen_ms',
  'end_reason', 'concurrent', 'crop_kind', 'capture_scale',
  'out_w', 'out_h', 'src_w', 'src_h', 'src_kbps',
  'fps', 'bitrate_mbps', 'mime', 'audio', 'hide_cursor', 'auto_pause', 'write_error',
];

export function toCsv(rows, now = Date.now()) {
  const sorted = [...rows].sort((a, b) => (a.start - b.start) || String(a.key).localeCompare(String(b.key)));
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of sorted) {
    const start = msOrNull(r.start);
    const end = msOrNull(r.end);
    const last = msOrNull(r.lastSeen);
    let reason = r.endReason ?? '';
    if (end == null) reason = last != null && now - last < RECORDING_WINDOW_MS ? 'recording' : 'unknown';
    const local = (v) => (v == null ? '' : fmtLocal(v));
    lines.push([
      String(r.recId ?? '').slice(0, 8), r.part,
      local(start), local(end), local(last), start == null ? '' : fmtOffset(start),
      start, end, last,
      reason, r.concurrent, r.cropKind, r.captureScale,
      r.outW || null, r.outH || null, r.srcW, r.srcH, r.srcKbps,
      r.fps, r.bitrateMbps, r.mime, r.audio, r.hideCursor, r.autoPause, r.writeError ? 1 : 0,
    ].map(cell).join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}
