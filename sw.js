// Service worker：取得分頁擷取權限、更新工具列徽章、處理下載。
// 真正的錄影在 offscreen 文件裡進行（它會一直存在，service worker 可能被暫停）。
import { getSettings, fmtBadge, safeName, downloadFileName, recordedMs } from './common.js';
import { videoTrackerMain } from './video-tracker.js';

const EMPTY = { recordings: [], busyFiles: [], errors: [] };
let lastState = EMPTY;
let lastTick = 0;
let creating = null;
const badgedTabs = new Set();

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: '錄製分頁畫面' })
    .finally(() => { creating = null; });
  await creating;
}

async function toOffscreen(msg) {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (!res?.ok) throw new Error(res?.error || '錄影程序沒有回應');
  return res;
}

// 在分頁裡執行 videoTrackerMain：recId 為 null 時只量一次影片位置
async function runVideoTracker(tabId, recId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: videoTrackerMain, args: [recId] });
  return res?.result || null;
}

let activeOps = 0; // 進行中、會用到錄影程序的操作數；這段期間不關閉錄影程序

async function withOp(fn) {
  activeOps++;
  try {
    return await fn();
  } finally {
    activeOps--;
  }
}

const startRecording = (args) => withOp(() => doStartRecording(args));

// 整個開始流程都在 service worker 完成（包含「自動框住影片」的追蹤），彈出視窗中途關掉也不影響
async function doStartRecording({ tabId, crop, cropLabel, screenDpr, pageDpr, autoVideo }) {
  if (lastState.recordings.some((r) => r.tabId === tabId)) throw new Error('這個分頁已經在錄影了');
  const tab = await chrome.tabs.get(tabId);
  let source = null;
  if (autoVideo) {
    const found = await runVideoTracker(tabId, null).catch(() => null);
    if (!found) throw new Error('這個頁面找不到正在顯示的影片');
    crop = { x: found.x, y: found.y, w: found.w, h: found.h };
    if (found.srcW && found.srcH) source = { w: found.srcW, h: found.srcH, kbps: null };
    cropLabel = '自動框住影片';
  }
  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  if (!screenDpr && pageDpr) {
    // 網頁的 devicePixelRatio 含網頁縮放比例，要除掉才是螢幕本身的倍率
    const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
    screenDpr = pageDpr / zoom;
  }
  const res = await toOffscreen({
    type: 'start',
    streamId,
    tabId,
    title: tab.title,
    tabW: tab.width || 1280,
    tabH: tab.height || 720,
    screenDpr,
    crop: crop || null,
    source,
    cropLabel: cropLabel || (crop ? '自訂範圍' : '整個分頁'),
    settings: await getSettings(),
  });
  applyState(res.state);
  if (autoVideo) {
    const rec = res.state.recordings.find((r) => r.tabId === tabId);
    // 追蹤失敗時錄影照常進行，只是範圍固定在開始時的位置
    if (rec) {
      try {
        await runVideoTracker(tabId, rec.id);
      } catch (e) {
        return { warning: `影片位置追蹤沒有啟動，範圍會固定在開始時的位置：${e.message}` };
      }
    }
  }
  return {};
}

async function stopRecording(id) {
  const res = await toOffscreen({ type: 'stop', id });
  applyState(res.state);
  return {};
}

function applyState(state) {
  lastState = state || EMPTY;
  lastTick = Date.now();
  updateBadges();
}

function updateBadges() {
  const recs = lastState.recordings;
  const now = Date.now();
  if (!recs.length) {
    chrome.action.setBadgeText({ text: '' });
    for (const tabId of badgedTabs) chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    badgedTabs.clear();
    setTooltip('分頁錄影機');
    return;
  }
  // 沒在錄的分頁顯示最早開始的那個錄影；在錄的分頁顯示自己的時間
  const oldest = recs.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
  const badge = (r) => (r.paused ? '暫停' : fmtBadge(recordedMs(r, now)));
  const globalText = badge(oldest);
  chrome.action.setBadgeBackgroundColor({ color: '#1f3a5f' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  chrome.action.setBadgeText({ text: globalText });
  const recording = new Set();
  for (const r of recs) {
    recording.add(r.tabId);
    badgedTabs.add(r.tabId);
    chrome.action.setBadgeText({ tabId: r.tabId, text: badge(r) }).catch(() => {});
  }
  for (const tabId of badgedTabs) {
    if (recording.has(tabId)) continue;
    chrome.action.setBadgeText({ tabId, text: globalText }).catch(() => badgedTabs.delete(tabId));
  }
  // 提示文字只精確到分鐘：每秒改一次文字會讓滑鼠停著時提示框一直被刷新、很快消失
  const lines = recs.map((r) => {
    const title = r.title.length > 24 ? `${r.title.slice(0, 24)}…` : r.title;
    const seg = r.part > 1 ? `，第 ${r.part} 段` : '';
    const pause = r.paused ? '，自動暫停中' : '';
    return `● ${fmtMinutes(recordedMs(r, now))}${seg}${pause}　${title}`;
  });
  setTooltip(`錄影中 ${recs.length} 個（點圖示看精確時間）\n${lines.join('\n')}`);
}

let lastTooltip = '';
function setTooltip(title) {
  if (title === lastTooltip) return;
  lastTooltip = title;
  chrome.action.setTitle({ title });
}

function fmtMinutes(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不到 1 分鐘';
  if (m < 60) return `${m} 分鐘`;
  return `${Math.floor(m / 60)} 小時 ${m % 60} 分鐘`;
}

async function flashError() {
  chrome.action.setBadgeBackgroundColor({ color: '#f29900' });
  chrome.action.setBadgeText({ text: 'ERR' });
  setTimeout(updateBadges, 3000);
}

// ---- 下載 ----

// 只要有其他擴充功能在管理下載檔名，downloads.download 指定的 filename 就會被忽略，
// 檔案會變成 blob 網址裡的亂碼名稱。所以我們自己也在 onDeterminingFilename 指定一次。
const wantedNames = new Map(); // blob URL -> 要存的路徑

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id) return; // 不是我們的下載，不插手
  const key = `name:${item.url}`;
  const filename = wantedNames.get(item.url);
  if (filename) {
    suggest({ filename, conflictAction: 'uniquify' });
    return;
  }
  // service worker 重啟過，記憶體裡沒有，改從 session storage 找
  chrome.storage.session.get(key).then((r) => {
    if (r[key]) suggest({ filename: r[key], conflictAction: 'uniquify' });
    else suggest();
  });
  return true;
});

// 每個下載各存一個 key（dl:<id>），同時有多個下載也不會互相覆蓋。
async function startDownload({ url, name }) {
  const { folder } = await getSettings();
  const filename = `${safeName(folder, 'ScreenRecorder')}/${downloadFileName(name)}`; // 同名時瀏覽器會自動加 (1)
  wantedNames.set(url, filename);
  await chrome.storage.session.set({ [`name:${url}`]: filename });
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } catch (err) {
    wantedNames.delete(url);
    chrome.storage.session.remove(`name:${url}`);
    throw err;
  }
  await chrome.storage.session.set({ [`dl:${id}`]: name });
  // 小檔案可能在登記之前就下載完了，那時 onChanged 找不到名稱，這裡補處理
  const [item] = await chrome.downloads.search({ id });
  if (item && (item.state === 'complete' || item.state === 'interrupted')) await finishDownload(id, item.state);
  return {};
}

// onChanged 和 startDownload 的補查可能同時呼叫，同一個下載只處理一次
const finishing = new Set();

async function finishDownload(id, state) {
  if (finishing.has(id)) return;
  finishing.add(id);
  try {
    const key = `dl:${id}`;
    const name = (await chrome.storage.session.get(key))[key];
    if (!name) return; // 已經處理過
    await chrome.storage.session.remove(key);
    const [item] = await chrome.downloads.search({ id });
    let wanted = null;
    if (item) {
      const nameKey = `name:${item.url}`;
      wanted = wantedNames.get(item.url) || (await chrome.storage.session.get(nameKey))[nameKey];
      wantedNames.delete(item.url);
      await chrome.storage.session.remove(nameKey);
    }
    if (state === 'complete') {
      // 已經存到下載資料夾，刪掉 OPFS 裡的暫存
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name).catch(() => {});
      // 其他下載工具（例如 IDM）可能還是改掉了檔名或位置，檔案有存到，但要讓使用者知道在哪
      if (item?.filename && wanted && !sameSavedName(item.filename, wanted)) {
        notify(`檔名或位置被其他擴充功能改掉了，實際存在：${item.filename}`);
      }
    }
    // 失敗的話保留 OPFS 檔案，之後會出現在「未存的錄影」清單。
    // 帶上 URL，錄影程序只釋放這一次下載用的網址（同一個檔案可能已經在重試）
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'downloadDone', name, url: item?.url }).catch(() => {});
  } finally {
    finishing.delete(id);
  }
}

// 實際存檔路徑是否就是我們要的「資料夾/檔名」（瀏覽器遇到同名會加 (1)，也算符合）
function sameSavedName(actual, wanted) {
  const parts = actual.split(/[\\/]/);
  const [folder, file] = wanted.split('/');
  const base = file.replace(/\.webm$/, '');
  return parts.at(-2) === folder && parts.at(-1).startsWith(base);
}

function notify(message) {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'note', message }).catch(() => {});
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') finishDownload(delta.id, state);
});

async function deleteFile(name) {
  if (await hasOffscreen()) {
    // 錄影程序知道哪些檔案還在寫入或下載中，交給它檢查
    await toOffscreen({ type: 'deleteFile', name });
  } else {
    await (await navigator.storage.getDirectory()).removeEntry(name);
  }
  return {};
}

// ---- 範圍組 ----

async function savePreset({ name, crop, tabId }, sender) {
  const tab = sender.tab || (await chrome.tabs.get(tabId));
  const { presets = [] } = await chrome.storage.local.get('presets');
  const clean = (name || '').trim() || `範圍 ${presets.length + 1}`;
  const preset = { id: crypto.randomUUID(), name: clean, crop, refW: tab.width, refH: tab.height, created: Date.now() };
  const i = presets.findIndex((p) => p.name === clean);
  if (i >= 0) presets[i] = { ...preset, id: presets[i].id };
  else presets.push(preset);
  await chrome.storage.local.set({ presets });
  return { name: clean, replaced: i >= 0 };
}

// ---- 訊息 ----

async function handle(msg, sender) {
  switch (msg.type) {
    case 'start':
      return startRecording({ ...msg, tabId: msg.tabId ?? sender.tab?.id });
    case 'stop':
      return stopRecording(msg.id);
    case 'tick':
      applyState(msg.state);
      return {};
    case 'getState':
      if (!(await hasOffscreen())) {
        applyState(EMPTY);
        return { state: EMPTY };
      }
      applyState((await toOffscreen({ type: 'state' })).state);
      return { state: lastState };
    case 'download':
      return startDownload(msg);
    case 'saveOrphan':
      return withOp(async () => {
        await ensureOffscreen();
        await toOffscreen({ type: 'saveFile', name: msg.name });
        return {};
      });
    case 'idle': // 錄影程序閒置一分鐘：沒有錄影、寫入和下載時就關掉它，釋放資源
      if (activeOps === 0) {
        const { state } = await toOffscreen({ type: 'state' });
        if (activeOps === 0 && !state.recordings.length && !state.busyFiles.length) {
          await chrome.offscreen.closeDocument().catch(() => {});
          applyState(EMPTY);
        }
      }
      return {};
    case 'setMonitorMuted': {
      const res = await toOffscreen({ type: 'setMonitorMuted', id: msg.id, muted: msg.muted });
      applyState(res.state);
      return { state: lastState };
    }
    case 'videoUpdate': // 「自動框住影片」回報新位置或影片狀態，也用來確認錄影還在
      if (!(await hasOffscreen())) throw new Error('錄影已經結束');
      await toOffscreen({ type: 'updateCrop', id: msg.recId, crop: msg.crop, videoState: msg.videoState, source: msg.source });
      return {};
    case 'deleteFile':
      return withOp(() => deleteFile(msg.name));
    case 'savePreset':
      return savePreset(msg, sender);
    default:
      throw new Error(`未知的指令：${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'sw') return;
  handle(msg, sender).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-recording' || !tab?.id) return;
  try {
    const rec = lastState.recordings.find((r) => r.tabId === tab.id);
    if (rec) await stopRecording(rec.id);
    else await startRecording({ tabId: tab.id, crop: null });
  } catch (e) {
    console.error(e);
    flashError();
  }
});

// 瀏覽器重開或擴充功能重新載入時，錄影程序一定不在，OPFS 裡剩下的檔案都是上次沒存到的，自動存出來
async function recoverLeftovers() {
  if (await hasOffscreen()) return;
  const root = await navigator.storage.getDirectory();
  const names = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === 'file') names.push(name);
  }
  if (!names.length) return;
  await ensureOffscreen();
  for (const name of names) {
    // 失敗的檔案會留著，彈出視窗的「未存的錄影」還能手動存
    await toOffscreen({ type: 'saveFile', name }).catch((e) => console.error('自動存檔失敗', name, e));
  }
}

chrome.runtime.onStartup.addListener(() => { withOp(recoverLeftovers); });
chrome.runtime.onInstalled.addListener(() => { withOp(recoverLeftovers); });

// 錄影程序每秒會回報一次；超過 5 秒沒消息代表它不在了，清掉徽章
chrome.alarms.create('watchdog', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  // service worker 重啟後 lastState 是空的，但舊徽章可能還在，所以不判斷 recordings.length
  if (alarm.name === 'watchdog' && Date.now() - lastTick > 5000) applyState(EMPTY);
});
