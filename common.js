// 設定與格式化工具。sw.js 與 popup.js 共用。

export const DEFAULT_SETTINGS = {
  segmentMinutes: 30, // 0 = 不分段
  folder: 'ScreenRecorder', // 存在「下載」資料夾底下的子資料夾
  audio: true,
  codec: 'auto', // auto | h264 | vp8 | vp9
  bitrateMbps: 6,
  fps: 30,
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

const pad = (n) => String(n).padStart(2, '0');

export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// 工具列徽章最多放約 4 個字：10 分鐘內顯示 m:ss，之後顯示分鐘，超過 1 小時顯示 1h05。
export function fmtBadge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 600) return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  return h >= 10 ? `${h}h` : `${h}h${pad(Math.floor((s % 3600) / 60))}`;
}

export function safeName(s, fallback = 'tab') {
  const cleaned = (s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  return cleaned || fallback;
}

// OPFS 暫存檔名：「分頁名_這段開始時間_錄影ID前6碼p段數.webm」。
// 結尾的 ID 和段數只是避免暫存檔撞名，下載時會拿掉，存成「分頁名_這段開始時間.webm」。
const TEMP_SUFFIX = /_[0-9a-f]{6}p\d{2,}\.webm$/;

export function tempFileName(title, segStart, recId, part) {
  return `${safeName(title)}_${stamp(segStart)}_${recId.slice(0, 6)}p${String(part).padStart(2, '0')}.webm`;
}

export function downloadFileName(tempName) {
  return tempName.replace(TEMP_SUFFIX, '.webm');
}

export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
