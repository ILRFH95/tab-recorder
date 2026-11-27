// Service worker：取得分頁擷取權限、更新工具列徽章、處理下載。
// 真正的錄影在 offscreen 文件裡進行（它會一直存在，service worker 可能被暫停）。
import { getSettings, fmtBadge, safeName, downloadFileName, recordedMs } from './common.js';
import { runVideoTracker } from './video-tracker.js';
import { runCursorHider } from './cursor-hider.js';

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

let activeOps = 0; // 進行中、會用到錄影程序的操作數；這段期間不關閉錄影程序
let opsStarted = 0; // 開始過的操作總數，用來確認一段非同步等待期間有沒有新操作開始（見 reloadIfScheduled）

async function withOp(fn) {
  activeOps++;
  opsStarted++;
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
  const settings = await getSettings();
  await ensureOffscreen();
  if (!screenDpr && pageDpr) {
    // 網頁的 devicePixelRatio 含網頁縮放比例，要除掉才是螢幕本身的倍率
    const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
    screenDpr = pageDpr / zoom;
  }
  const warnings = [];
  let res;
  try {
    // 開始寫入之前先把游標藏好（見 cursor-hider.js）。錄影程序還沒回報這個錄影時，
    // 隱藏程式靠 pendingCursor 知道錄影正要開始。失敗（例如內建頁面、沒有權限）或框架太久沒反應時錄影照常進行
    if (settings.hideCursor) {
      pendingCursor.set(tabId, crop || null);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('逾時')), 3000));
      await Promise.race([runCursorHider(tabId, crop), timeout])
        .catch(() => warnings.push('這個頁面不能隱藏滑鼠游標，這次錄影會錄到游標'));
    }
    // 串流 ID 只有幾秒有效，準備工作都做完才取得，馬上交給錄影程序
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    res = await toOffscreen({
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
      autoVideo: Boolean(autoVideo),
      settings,
    });
  } finally {
    pendingCursor.delete(tabId);
  }
  applyState(res.state);
  const rec = res.state.recordings.find((r) => r.tabId === tabId);
  if (autoVideo && rec) {
    // 追蹤失敗時錄影照常進行，只是範圍固定在開始時的位置
    try {
      await runVideoTracker(tabId, rec.id);
    } catch (e) {
      warnings.push(`影片位置追蹤沒有啟動，範圍會固定在開始時的位置：${e.message}`);
    }
  }
  return warnings.length ? { warning: warnings.join('。') } : {};
}

// 正要開始錄影、而且要隱藏游標的分頁 → 範圍（錄影程序回報之前用）
const pendingCursor = new Map();

// 隱藏游標的程式問：這個分頁還在錄影嗎？目前範圍是什麼？
// 直接問錄影程序，「自動框住影片」移動範圍後才能馬上跟上（每秒的狀態回報會慢一點）
async function cursorState(tabId) {
  if (pendingCursor.has(tabId)) return { alive: true, crop: pendingCursor.get(tabId) };
  const state = (await hasOffscreen()) ? (await toOffscreen({ type: 'state' })).state : EMPTY;
  const rec = state.recordings.find((r) => r.tabId === tabId);
  // 只看這次錄影開始時的設定：錄影中改設定，下一次錄影才生效
  return { alive: Boolean(rec?.hideCursor), crop: rec?.crop || null };
}

// 錄影中的分頁有新文件（換頁、重新整理、之後才出現的框架）時重新放一次隱藏游標的程式。
// 換到別的網站時可能已經沒有權限（activeTab 只到換站為止），那就算了
async function reinjectCursorHider(tabId) {
  const state = (await hasOffscreen()) ? (await toOffscreen({ type: 'state' })).state : EMPTY;
  const rec = state.recordings.find((r) => r.tabId === tabId);
  if (rec?.hideCursor) await runCursorHider(tabId, rec.crop).catch(() => {});
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

// 下載檔名的優先權：好幾個擴充功能都監聽 onDeterminingFilename 時，瀏覽器以「最後安裝或更新」的那個為準，
// 而且那個擴充功能就算沒指定檔名（例如 IDM 對 blob 網址的下載什麼都不做），也會把我們指定的名字蓋回預設檔名。
// 2026-11-19 Plucker、2026-11-24 IDM Integration Module 自動更新後都發生過（在無頭 Edge 157、158 重現過）。
//
// 所以分兩層：
// 1. 預設檔名本身就要對：由錄影程序用 <a download="檔名"> 下載，不用 downloads.download。
//    downloads.download 的 filename 被蓋掉後會退回 blob 網址的亂碼；download 屬性的檔名才是瀏覽器的預設檔名，
//    被蓋掉時檔名仍然正確，只是存在下載資料夾最外層（download 屬性不能帶資料夾）。
// 2. 資料夾由 onDeterminingFilename 指定。被蓋掉時，擴充功能重新載入會讓我們重新變成「最後更新」的那個，
//    所以瀏覽器啟動時先重新載入一次；錄影途中才被蓋掉的話，等沒有錄影和存檔時再重新載入。
//    只對「載入未封裝」的安裝有效（重新載入會更新安裝時間），從商店裝的版本不這樣做。
const RELOAD_KEY = 'reloadForFilename';

async function canReloadForPriority() {
  const self = await chrome.management.getSelf().catch(() => null);
  return self?.installType === 'development';
}

// 檔名被蓋掉時呼叫：記下來，等錄影程序閒置關閉時重新載入。回傳之後會不會自動修正
async function scheduleReloadForFilename() {
  if (!(await canReloadForPriority())) return false;
  await chrome.storage.local.set({ [RELOAD_KEY]: Date.now() });
  return true;
}

// 只在錄影程序已經關掉（沒有錄影、寫入、下載）時呼叫。opsAtCheck 是確認閒置當時的 opsStarted：
// 之後的非同步等待期間若有新操作開始（開始錄影、補存檔），就不重新載入，免得中斷它
// 回傳有沒有真的重新載入
async function reloadIfScheduled(opsAtCheck) {
  if (!(await chrome.storage.local.get(RELOAD_KEY))[RELOAD_KEY]) return false;
  if (await hasOffscreen()) return false;
  // 最後一次等待之後同步確認，中間沒有空檔讓新操作插進來
  if (activeOps !== 0 || opsStarted !== opsAtCheck) return false;
  chrome.runtime.reload(); // 重新載入後 onInstalled 會清掉這個記號
  return true;
}

// 別的擴充功能在錄影機之後安裝或更新，它就排到錄影機前面，之後的錄影會存錯資料夾。
// 記下它是誰（通知要點名），能重新載入的話趁錄影程序不在時馬上重新載入，不等到存錯一次才處理。
// 只看有下載權限的：沒有的不能改下載位置。API 看不出誰真的在改檔名，所以這份名單只是「之後裝過的」。
const RIVALS_KEY = 'priorityRivals';
const RIVAL_RELOADS_KEY = 'priorityReloads'; // 因為這個原因馬上重新載入的時間
const RIVAL_RELOAD_LIMIT = 3; // 10 分鐘內最多馬上重新載入 3 次，避免和別的擴充功能互相觸發、一直重新載入
const RIVAL_RELOAD_WINDOW_MS = 10 * 60000;

// 好幾個擴充功能同時更新時事件會一起來，排隊處理，名單才不會互相覆蓋
let rivalQueue = Promise.resolve();
function queueRival(fn) {
  rivalQueue = rivalQueue.then(fn).catch((e) => console.warn('[priority]', e));
  return rivalQueue;
}

async function onOtherInstalled(info) {
  if (info.id === chrome.runtime.id || !info.enabled || !info.permissions?.includes('downloads')) return;
  const { [RIVALS_KEY]: rivals = [] } = await chrome.storage.local.get(RIVALS_KEY);
  const next = [...rivals.filter((r) => r.id !== info.id), { id: info.id, name: info.name, time: Date.now() }].slice(-10);
  await chrome.storage.local.set({ [RIVALS_KEY]: next });
  if (await scheduleReloadForFilename()) await reloadNowIfIdle();
}

// 錄影程序不在、也沒有進行中的操作時馬上重新載入；錄影程序開著（錄影、存檔中，或剛結束還沒關）就交給閒置流程
async function reloadNowIfIdle() {
  const opsAtCheck = opsStarted;
  if (await hasOffscreen()) return;
  // 沒有錄影程序時，短暫的操作（例如刪除未存的錄影）結束後不會有閒置通知，一分鐘後再檢查
  if (activeOps !== 0) {
    chrome.alarms.create(RIVAL_RETRY_ALARM, { when: Date.now() + 60000 });
    return;
  }
  const now = Date.now();
  const { [RIVAL_RELOADS_KEY]: times = [] } = await chrome.storage.local.get(RIVAL_RELOADS_KEY);
  const recent = times.filter((t) => now - t < RIVAL_RELOAD_WINDOW_MS);
  if (recent.length >= RIVAL_RELOAD_LIMIT) {
    // 次數到上限：等最早那次滿 10 分鐘再檢查一次（期間有錄影的話，錄完的閒置流程也會處理）
    chrome.alarms.create(RIVAL_RETRY_ALARM, { when: recent[0] + RIVAL_RELOAD_WINDOW_MS + 1000 });
    return;
  }
  // 先記下這次，重新載入後就沒機會記了；沒有真的重新載入（等待期間有新操作開始）就拿掉，不算進上限
  await chrome.storage.local.set({ [RIVAL_RELOADS_KEY]: [...recent, now] });
  if (await reloadIfScheduled(opsAtCheck)) return;
  await chrome.storage.local.set({ [RIVAL_RELOADS_KEY]: recent });
  // 稍後再檢查；記號已被清掉的話，鬧鐘響了什麼都不做
  chrome.alarms.create(RIVAL_RETRY_ALARM, { when: Date.now() + 60000 });
}

const RIVAL_RETRY_ALARM = 'priorityRetry';

// 更新程式後、瀏覽器還沒重新載入錄影機前，可能還沒有 management 權限，這時 onInstalled 不存在，跳過不能讓整個背景程式出錯
chrome.management.onInstalled?.addListener((info) => {
  queueRival(() => onOtherInstalled(info));
});

// 存錯位置時，通知裡說明是誰造成的。startedAt：這筆下載開始的時間，之後才安裝或更新的不可能影響它
async function describeRivals(startedAt) {
  try {
    return await findRivals(startedAt);
  } catch (err) {
    console.warn('[priority]', err); // 這段失敗不能擋住存檔的收尾
    return '是其他擴充功能造成的';
  }
}

async function findRivals(startedAt) {
  const { [RIVALS_KEY]: rivals = [] } = await chrome.storage.local.get(RIVALS_KEY).catch(() => ({}));
  const all = await chrome.management.getAll().catch(() => null);
  const active = (all || []).filter(
    (e) => e.id !== chrome.runtime.id && e.enabled && e.type === 'extension' && e.permissions?.includes('downloads'),
  );
  // 記下之後被停用或移除的不算；查不到目前的清單時照紀錄寫
  const live = (all ? rivals.filter((r) => active.some((e) => e.id === r.id)) : rivals)
    .filter((r) => !(startedAt <= r.time));
  if (live.length) {
    return `很可能是「${live.map((r) => r.name).join('」或「')}」造成的：在錄影機之後安裝或更新過`;
  }
  const names = active.map((e) => e.name);
  return names.length ? `是其他擴充功能造成的，可能是這些有下載權限的擴充功能之一：${names.join('、')}` : '是其他擴充功能造成的';
}

const wantedNames = new Map(); // blob URL -> 要存的路徑
const OUR_BLOB = `blob:chrome-extension://${chrome.runtime.id}/`;

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // 不是我們的下載，不插手。要同步判斷：對別人的下載就算只回空的 suggest()，我們較晚更新時也會蓋掉別人的檔名
  if (!item.url.startsWith(OUR_BLOB)) return;
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

// 等某個網址的下載出現，回傳下載編號；逾時回傳 null
function waitForCreated(url, ms) {
  return new Promise((resolve) => {
    const done = (id) => {
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      resolve(id);
    };
    const onCreated = (item) => {
      if (item.url === url) done(item.id);
    };
    const timer = setTimeout(() => done(null), ms);
    chrome.downloads.onCreated.addListener(onCreated);
  });
}

// 每個下載各存一個 key（dl:<id>），同時有多個下載也不會互相覆蓋。
async function startDownload({ url, name }) {
  const { folder } = await getSettings();
  const file = downloadFileName(name);
  const filename = `${safeName(folder, 'ScreenRecorder')}/${file}`; // 同名時瀏覽器會自動加 (1)
  wantedNames.set(url, filename);
  await chrome.storage.session.set({ [`name:${url}`]: filename });
  let id;
  try {
    // 先開始等，再請錄影程序點下載連結（見上方「下載檔名的優先權」）
    const created = waitForCreated(url, 30000);
    await toOffscreen({ type: 'clickDownload', url, file });
    id = await created;
    if (id == null) throw new Error('瀏覽器沒有開始下載');
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
      // 檔名或位置還是被改掉了（見上方「下載檔名的優先權」），檔案有存到，但要讓使用者知道在哪
      if (item?.filename && wanted && !sameSavedName(item.filename, wanted)) {
        const willFix = await scheduleReloadForFilename();
        const folder = wanted.split('/')[0];
        const inFolder = item.filename.split(/[\\/]/).at(-2) === folder;
        notify(
          (inFolder
            ? `檔名被改掉了，實際存在：${item.filename}`
            : `檔案沒有存進「${folder}」資料夾，實際存在：${item.filename}`) +
            `。${await describeRivals(Date.parse(item.startTime))}` +
            (willFix ? '。等錄影和存檔都結束後，錄影機會自動重新載入，之後的檔案就會照原本的檔名存進「' + folder + '」' : ''),
        );
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
        const opsAtCheck = opsStarted;
        const { state } = await toOffscreen({ type: 'state' });
        if (activeOps === 0 && !state.recordings.length && !state.busyFiles.length) {
          await chrome.offscreen.closeDocument().catch(() => {});
          applyState(EMPTY);
          await reloadIfScheduled(opsAtCheck);
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
    case 'cursorState':
      return sender.tab ? cursorState(sender.tab.id) : { alive: false };
    case 'cursorReinject': // 隱藏游標的程式發現有之後才出現的框架
      if (sender.tab) await reinjectCursorHider(sender.tab.id);
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

// 錄影中的分頁換頁或重新整理後，隱藏游標的程式會消失，載入完成時再放一次
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete' || !lastState.recordings.some((r) => r.tabId === tabId)) return;
  reinjectCursorHider(tabId).catch(() => {});
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

chrome.runtime.onStartup.addListener(async () => {
  // 其他擴充功能的更新多半在瀏覽器啟動時套用，先重新載入一次，讓下載檔名由我們決定（見「下載檔名的優先權」）。
  // 重新載入後 onInstalled 會接著把沒存到的檔案存出來
  if (await canReloadForPriority()) {
    chrome.runtime.reload();
    return;
  }
  withOp(recoverLeftovers);
});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  // 錄影機自己安裝、更新或重新載入後就排在最前面，之前記下的名單不再適用（瀏覽器更新不影響順序）。
  // 和別的擴充功能的更新事件排同一個隊，清除時不會吃掉之後才進來的那筆
  queueRival(() => chrome.storage.local.remove(reason === 'chrome_update' ? RELOAD_KEY : [RELOAD_KEY, RIVALS_KEY]));
  withOp(recoverLeftovers);
});

// 錄影程序每秒會回報一次；超過 5 秒沒消息代表它不在了，清掉徽章
chrome.alarms.create('watchdog', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  // service worker 重啟後 lastState 是空的，但舊徽章可能還在，所以不判斷 recordings.length
  if (alarm.name === 'watchdog' && Date.now() - lastTick > 5000) applyState(EMPTY);
  if (alarm.name === RIVAL_RETRY_ALARM) {
    queueRival(async () => {
      if ((await chrome.storage.local.get(RELOAD_KEY))[RELOAD_KEY]) await reloadNowIfIdle();
    });
  }
});
