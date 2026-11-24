import { DEFAULT_SETTINGS, getSettings, fmtClock, fmtSize, recordedMs } from './common.js';
import { overlayMain } from './overlay.js';
import { runVideoTracker, findFrameSites } from './video-tracker.js';

const AUTO_VIDEO = '__video__'; // 範圍選單裡「自動框住影片」的值

const $ = (s) => document.querySelector(s);
let tab = null;
let state = { recordings: [], busyFiles: [] };
let presets = [];
let structureKey = '';
let lastError = '';

// 建立元素的小工具。網頁標題等外部文字一律用 textContent，不用 innerHTML。
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage({ target: 'sw', ...msg });
  if (!res?.ok) throw new Error(res?.error || '沒有回應');
  return res;
}

async function refreshState() {
  try {
    state = (await send({ type: 'getState' })).state;
  } catch (e) {
    lastError = e.message;
  }
}

async function loadPresets() {
  presets = (await chrome.storage.local.get('presets')).presets || [];
}

// ---- 目前分頁 ----

function currentRec() {
  return state.recordings.find((r) => r.tabId === tab?.id);
}

function renderCurrent() {
  const box = $('#current');
  box.replaceChildren();
  if (!tab) {
    box.append(el('div', { class: 'muted', textContent: '找不到目前的分頁' }));
    return;
  }
  box.append(el('div', { class: 'title', textContent: tab.title || tab.url || '' }));
  const rec = currentRec();
  if (rec) {
    box.append(
      el('div', { class: 'row' },
        el('div', { class: 'clock', dataset: { clock: rec.id } }),
        el('span', { class: 'spacer' }),
        monitorButton(rec),
        el('button', { class: 'primary', textContent: '停止錄影', onclick: () => stop(rec.id) })),
      el('div', { class: 'muted', dataset: { seg: rec.id } }),
      el('div', { class: 'muted', dataset: { src: rec.id } }),
    );
  } else {
    const sel = el('select', { id: 'crop-sel' },
      el('option', { value: '', textContent: '整個分頁' }),
      el('option', { value: AUTO_VIDEO, textContent: '自動框住影片' }));
    for (const p of presets) sel.append(el('option', { value: p.id, textContent: p.name }));
    sel.value = localStorage.getItem('lastPreset') || '';
    if (sel.selectedIndex < 0) sel.value = '';
    sel.addEventListener('change', () => {
      localStorage.setItem('lastPreset', sel.value);
      renderPresetWarning();
    });
    box.append(
      el('div', { class: 'row wrap', style: 'margin-top:8px' },
        el('span', { textContent: '範圍' }),
        sel,
        el('button', { textContent: '在網頁上框選…', onclick: pickOnPage }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'primary', textContent: '開始錄影', onclick: startSelected })),
      el('div', { id: 'preset-warn' }),
    );
    renderPresetWarning();
  }
  if (lastError) box.append(el('div', { class: 'error', textContent: lastError }));
  for (const e of (state.errors || []).slice(0, 3)) {
    box.append(el('div', {
      class: 'error',
      textContent: `${new Date(e.time).toLocaleTimeString()} ${e.title ? `「${e.title}」` : ''}${e.message}`,
    }));
  }
}

function selectedPreset() {
  const id = $('#crop-sel')?.value;
  return presets.find((p) => p.id === id) || null;
}

function sizeMismatch(p) {
  return p && tab?.width && (Math.abs(p.refW - tab.width) > 2 || Math.abs(p.refH - tab.height) > 2);
}

function renderPresetWarning() {
  const box = $('#preset-warn');
  if (!box) return;
  box.replaceChildren();
  const hint = frameHint();
  if (hint) box.append(hint);
  const p = selectedPreset();
  if (!sizeMismatch(p)) return;
  box.append(el('div', { class: 'warn' },
    `這組範圍是在 ${p.refW}×${p.refH} 的分頁大小下存的，現在分頁是 ${tab.width}×${tab.height}，框到的位置可能會偏掉。建議按「在網頁上框選…」確認一下。`));
}

// 在分頁裡量一次影片位置（給「在網頁上框選…」當起始位置）
async function measureVideo() {
  return runVideoTracker(tab.id, null);
}

// ---- 別的網域框架裡的影片 ----
// 擴充功能平常只能讀目前分頁的主頁面（activeTab）。影片放在別的網域的內嵌框架裡時（例如 jkface 的直播），
// 要使用者允許讀取那個網站一次（optional_host_permissions），之後「自動框住影片」才找得到。

let frameSites = []; // 需要使用者允許的框架網站：[{ pattern, host }]

// 打開彈出視窗時、開始失敗後各檢查一次：沒有讀得到的影片、有別的網域的大框架、而且還沒允許過
async function scanFrames() {
  try {
    frameSites = await findFrameSites(tab.id);
  } catch {
    frameSites = []; // 瀏覽器內建頁面等不能讀的分頁：不用提示
  }
  renderPresetWarning();
}

const siteNames = (sites) => sites.map((s) => s.host).join('、');

// 選「自動框住影片」而且有需要時，請使用者允許讀取框架的網站。
// 瀏覽器只在使用者剛點擊時允許詢問，所以這必須是點擊後第一個 await。回傳被拒絕的網站名稱（沒問或允許了是空字串）
async function askFramePermission(autoVideo) {
  if (!autoVideo || !frameSites.length) return '';
  const sites = frameSites;
  const granted = await chrome.permissions.request({ origins: sites.map((s) => s.pattern) }).catch(() => false);
  if (!granted) return siteNames(sites);
  frameSites = [];
  return '';
}

function frameHint() {
  if (!frameSites.length || $('#crop-sel')?.value !== AUTO_VIDEO) return null;
  return el('div', { class: 'muted' },
    `影片放在 ${siteNames(frameSites)} 的框架裡。開始錄影或框選時，瀏覽器會請你允許讀取這個網站（只需要一次）。`);
}

const deniedNote = (host) => (host ? `（影片在 ${host} 的框架裡，要允許讀取這個網站才找得到）` : '');

async function startSelected() {
  const autoVideo = $('#crop-sel')?.value === AUTO_VIDEO;
  const denied = await askFramePermission(autoVideo);
  const p = selectedPreset();
  lastError = '';
  try {
    // 「自動框住影片」的量測和追蹤都由背景程式處理，彈出視窗關掉也不影響
    const res = await send({
      type: 'start',
      tabId: tab.id,
      crop: autoVideo ? null : p ? p.crop : null,
      cropLabel: autoVideo ? '' : p ? p.name : '整個分頁',
      autoVideo,
      screenDpr: devicePixelRatio,
    });
    if (res.warning) lastError = res.warning;
  } catch (e) {
    lastError = `無法開始錄影：${e.message}${deniedNote(denied)}`;
  }
  await refreshState();
  renderAll(true);
  // 多層框架時，剛允許的框架裡可能還有下一層要允許：重新檢查，再按一次開始時會再問
  if (autoVideo && !currentRec()) await scanFrames();
}

async function pickOnPage() {
  const autoVideo = $('#crop-sel')?.value === AUTO_VIDEO;
  await askFramePermission(autoVideo); // 被拒絕時照樣框選，只是框不會先放在影片上
  const p = selectedPreset();
  let initial = p ? p.crop : null;
  // 選「自動框住影片」時，先把框放在影片上，方便微調
  if (autoVideo) initial = await measureVideo().catch(() => null);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: overlayMain, args: [initial] });
    window.close();
  } catch (e) {
    lastError = `這個頁面不能框選（瀏覽器內建頁面或擴充功能商店等），只能錄整個分頁或用已存的範圍組。（${e.message}）`;
    renderCurrent();
  }
}

async function stop(id) {
  try {
    await send({ type: 'stop', id });
  } catch (e) {
    lastError = `停止失敗：${e.message}`;
  }
  await refreshState();
  renderAll(true);
  renderOrphans();
}

// 「靜音播放」只是不把聲音播出來給你聽，錄進檔案的聲音不受影響
function monitorButton(rec, cls = '') {
  if (!rec.hasAudio) return null;
  return el('button', {
    class: cls,
    textContent: rec.monitorMuted ? '🔇 已靜音' : '🔊 靜音播放',
    title: rec.monitorMuted ? '目前聽不到這個分頁的聲音（仍會錄進檔案）。按一下恢復播放' : '不播出這個分頁的聲音，但仍會錄進檔案',
    onclick: () => setMonitorMuted(rec.id, !rec.monitorMuted),
  });
}

async function setMonitorMuted(id, muted) {
  try {
    state = (await send({ type: 'setMonitorMuted', id, muted })).state;
  } catch (e) {
    lastError = `切換失敗：${e.message}`;
  }
  renderAll(true);
}

// ---- 錄影清單 ----

function renderRecordings() {
  const recs = state.recordings;
  $('#recordings-wrap').hidden = recs.length === 0;
  $('#rec-count').textContent = recs.length ? `（${recs.length}）` : '';
  const list = $('#recordings');
  list.replaceChildren(
    ...recs.map((r) =>
      el('li', {},
        el('div', { class: 'row' },
          el('span', {
            class: 'title link spacer',
            textContent: r.title || '(無標題)',
            title: '切換到這個分頁',
            onclick: () => chrome.tabs.update(r.tabId, { active: true }),
          }),
          monitorButton(r, 'small'),
          el('button', { class: 'small', textContent: '停止', onclick: () => stop(r.id) })),
        el('div', { class: 'row' },
          el('span', { class: 'rec-clock', dataset: { clock: r.id } }),
          el('span', { class: 'muted', dataset: { seg: r.id } })),
        el('div', { class: 'muted', dataset: { src: r.id } }),
        r.error ? el('div', { class: 'error', textContent: r.error }) : null),
    ),
  );
}

function updateClocks() {
  const now = Date.now();
  for (const r of state.recordings) {
    for (const node of document.querySelectorAll(`[data-clock="${r.id}"]`)) node.textContent = fmtClock(recordedMs(r, now));
    const where = `${r.cropLabel}${r.size ? ` ${r.size}` : ''}`;
    const seg = r.paused
      ? `沒畫面也沒聲音，自動暫停中 ${fmtClock(now - r.pausedAt)} · ${where}`
      : `第 ${r.part} 段 ${fmtClock(now - r.segStartedAt)} · ${where}`;
    for (const node of document.querySelectorAll(`[data-seg="${r.id}"]`)) node.textContent = seg;
    for (const node of document.querySelectorAll(`[data-src="${r.id}"]`)) node.textContent = sourceLine(r);
  }
}

// 「來源 720×1280 · 約 1.8 Mbps → 錄影 682×1214 · 6 Mbps」：比較來源規格跟錄影設定
function sourceLine(r) {
  let rec = `錄影 ${r.size || '—'}${r.bitrateMbps ? ` · ${r.bitrateMbps} Mbps` : ''}`;
  // 有要求高解析擷取時，顯示要求了幾倍。瀏覽器有沒有照做看不出來，不能寫成「實際」倍率
  if (r.captureScale > 1) rec += ` · 已要求 ${r.captureScale}× 擷取`;
  if (!r.source?.w) return rec;
  let kbps = ' · 位元率量測中';
  if (r.source.kbps) kbps = ` · 約 ${(r.source.kbps / 1000).toFixed(1)} Mbps`;
  else if (r.source.measurable === false) kbps = ' · 量不到位元率';
  return `來源 ${r.source.w}×${r.source.h}${kbps} → ${rec}`;
}

// ---- 未存的錄影 ----

async function renderOrphans() {
  const busy = new Set(state.busyFiles);
  const items = [];
  const root = await navigator.storage.getDirectory();
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'file' || busy.has(name)) continue;
    try {
      const f = await handle.getFile();
      items.push({ name, size: f.size, mtime: f.lastModified });
    } catch {
      // 檔案正被寫入時會讀不到，略過
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  $('#orphans-wrap').hidden = items.length === 0;
  $('#orphans').replaceChildren(
    ...items.map((it) =>
      el('li', {},
        el('div', { class: 'title', textContent: it.name, title: it.name }),
        el('div', { class: 'row' },
          el('span', { class: 'muted spacer', textContent: `${fmtSize(it.size)} · ${new Date(it.mtime).toLocaleString()}` }),
          el('button', { class: 'small primary', textContent: '存檔', onclick: () => saveOrphan(it.name) }),
          el('button', { class: 'small', textContent: '刪除', onclick: () => deleteOrphan(it.name) })))),
  );
}

async function saveOrphan(name) {
  try {
    await send({ type: 'saveOrphan', name });
  } catch (e) {
    alert(`存檔失敗：${e.message}`);
  }
  await refreshState();
  renderOrphans();
}

async function deleteOrphan(name) {
  if (!confirm(`確定要刪除「${name}」？刪除後無法復原。`)) return;
  try {
    // 交給背景程式刪，它會先確認這個檔案沒有正在寫入或下載
    await send({ type: 'deleteFile', name });
  } catch (e) {
    alert(`刪除失敗：${e.message}`);
  }
  await refreshState();
  renderOrphans();
}

// ---- 範圍組 ----

function renderPresets() {
  $('#presets-empty').hidden = presets.length > 0;
  $('#presets').replaceChildren(
    ...presets.map((p) =>
      el('li', { class: 'row' },
        el('span', { class: 'spacer' },
          el('div', { class: 'title', textContent: p.name }),
          el('div', {
            class: 'muted',
            textContent: `存檔時分頁 ${p.refW}×${p.refH}，範圍 ${Math.round(p.crop.w * 100)}%×${Math.round(p.crop.h * 100)}%`,
          })),
        el('button', { class: 'small', textContent: '改名', onclick: () => renamePreset(p.id) }),
        el('button', { class: 'small', textContent: '刪除', onclick: () => deletePreset(p.id) }))),
  );
}

async function savePresets() {
  await chrome.storage.local.set({ presets });
  renderPresets();
  renderCurrent();
}

async function renamePreset(id) {
  const p = presets.find((x) => x.id === id);
  const name = prompt('新的名稱：', p.name)?.trim();
  if (!name) return;
  p.name = name;
  await savePresets();
}

async function deletePreset(id) {
  const p = presets.find((x) => x.id === id);
  if (!confirm(`刪除範圍組「${p.name}」？`)) return;
  presets = presets.filter((x) => x.id !== id);
  await savePresets();
}

// ---- 設定 ----

async function initSettings() {
  const s = await getSettings();
  const fields = ['segmentMinutes', 'folder', 'audio', 'codec', 'bitrateMbps', 'fps', 'autoPause', 'hideCursor'];
  for (const key of fields) {
    const input = $(`#${key}`);
    if (input.type === 'checkbox') input.checked = s[key];
    else input.value = String(s[key]);
    input.addEventListener('change', async () => {
      const cur = await getSettings();
      let v;
      if (input.type === 'checkbox') v = input.checked;
      else if (key === 'folder') v = input.value.trim() || DEFAULT_SETTINGS.folder;
      else if (key === 'codec') v = input.value;
      else v = Number(input.value);
      await chrome.storage.local.set({ settings: { ...cur, [key]: v } });
    });
  }
}

// ---- 錄影紀錄 ----
// 打開「錄影紀錄」才載入 rec-log.js 並讀資料庫，不拖慢彈出視窗；讀不到也不影響其他功能

let reclogLoad = 0; // 只採用最後一次讀取的結果

async function loadReclog() {
  const n = ++reclogLoad;
  const status = $('#reclog-status');
  const btn = $('#reclog-export');
  // canRetry：讀取失敗，或還沒有紀錄（彈出視窗開著時錄完第一段，按一下就能更新）
  const show = (text, isError, canExport, canRetry = isError) => {
    if (n !== reclogLoad) return;
    status.textContent = text;
    status.classList.toggle('error', isError);
    btn.hidden = !canExport;
    $('#reclog-retry').hidden = !canRetry;
  };
  show('讀取中…', false, false);
  try {
    const { readAll, fmtDate } = await import('./rec-log.js');
    const rows = await readAll();
    if (!rows.length) {
      show('還沒有紀錄。之後每段錄影的開始、結束時間會記在這裡。', false, false, true);
      return;
    }
    const first = Math.min(...rows.map((r) => r.start).filter(Number.isFinite));
    show(`共 ${rows.length} 段，最早 ${fmtDate(first)}`, false, true);
  } catch (e) {
    console.warn('[recLog]', e);
    show('讀不到錄影紀錄，按「重新讀取」再試一次。錄影不受影響。', true, false);
  }
}

async function exportReclog() {
  const btn = $('#reclog-export');
  btn.disabled = true; // 匯出期間停用，避免連點
  try {
    const { readAll, toCsv, fmtStamp } = await import('./rec-log.js');
    const now = Date.now();
    const csv = toCsv(await readAll(), now);
    // 用 data 網址：彈出視窗關掉 blob 網址就失效，而且 sw.js 只管 blob:chrome-extension 開頭的下載，不會干擾
    const a = el('a', { href: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`, download: `錄影紀錄_${fmtStamp(now)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    loadReclog(); // 重新顯示筆數，順便清掉上一次匯出失敗的訊息
  } catch (e) {
    console.warn('[recLog]', e);
    $('#reclog-status').textContent = '匯出失敗，請再按一次「匯出 CSV」。';
    $('#reclog-status').classList.add('error');
  } finally {
    btn.disabled = false;
  }
}

function initReclog() {
  $('#reclog-wrap').addEventListener('toggle', (ev) => {
    if (ev.target.open) loadReclog();
  });
  $('#reclog-export').addEventListener('click', exportReclog);
  $('#reclog-retry').addEventListener('click', loadReclog);
}

// ---- 主流程 ----

function renderAll(force = false) {
  // 只有錄影清單或目前分頁狀態變了才重建畫面，避免按鈕在點擊時被換掉
  const key = `${state.recordings.map((r) => `${r.id}:${r.part}:${r.error || ''}:${r.monitorMuted}:${r.paused}`).join(',')}|${currentRec()?.id || ''}|${state.errors?.[0]?.time || ''}`;
  if (force || key !== structureKey) {
    structureKey = key;
    renderCurrent();
    renderRecordings();
  }
  updateClocks();
}

async function main() {
  initReclog(); // 第一個 await 之前就接上，彈出視窗還在載入時展開也讀得到
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await Promise.all([refreshState(), loadPresets(), initSettings()]);
  renderAll(true);
  renderPresets();
  renderOrphans();
  if (tab) scanFrames(); // 不等它：結果出來後才補上提示
  setInterval(updateClocks, 250);
  setInterval(async () => {
    await refreshState();
    renderAll();
  }, 1000);
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.presets) {
      presets = changes.presets.newValue || [];
      renderPresets();
      renderAll(true);
    }
  });
}

main();
