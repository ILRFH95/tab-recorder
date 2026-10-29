import { DEFAULT_SETTINGS, getSettings, fmtClock, fmtSize } from './common.js';
import { overlayMain } from './overlay.js';

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
    );
  } else {
    const sel = el('select', { id: 'crop-sel' }, el('option', { value: '', textContent: '整個分頁' }));
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
  const p = selectedPreset();
  if (!sizeMismatch(p)) return;
  box.append(el('div', { class: 'warn' },
    `這組範圍是在 ${p.refW}×${p.refH} 的分頁大小下存的，現在分頁是 ${tab.width}×${tab.height}，框到的位置可能會偏掉。建議按「在網頁上框選…」確認一下。`));
}

async function startSelected() {
  const p = selectedPreset();
  lastError = '';
  try {
    await send({
      type: 'start',
      tabId: tab.id,
      crop: p ? p.crop : null,
      cropLabel: p ? p.name : '整個分頁',
      screenDpr: devicePixelRatio,
    });
  } catch (e) {
    lastError = `無法開始錄影：${e.message}`;
  }
  await refreshState();
  renderAll(true);
}

async function pickOnPage() {
  const p = selectedPreset();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: overlayMain, args: [p ? p.crop : null] });
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
        r.error ? el('div', { class: 'error', textContent: r.error }) : null),
    ),
  );
}

function updateClocks() {
  const now = Date.now();
  for (const r of state.recordings) {
    for (const node of document.querySelectorAll(`[data-clock="${r.id}"]`)) node.textContent = fmtClock(now - r.startedAt);
    const seg = `第 ${r.part} 段 ${fmtClock(now - r.segStartedAt)} · ${r.cropLabel}${r.size ? ` ${r.size}` : ''}`;
    for (const node of document.querySelectorAll(`[data-seg="${r.id}"]`)) node.textContent = seg;
  }
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
  const fields = ['segmentMinutes', 'folder', 'audio', 'codec', 'bitrateMbps', 'fps'];
  for (const key of fields) {
    const input = $(`#${key}`);
    if (input.type === 'checkbox') input.checked = s[key];
    else input.value = String(s[key]);
    input.addEventListener('change', async () => {
      const cur = await getSettings();
      let v;
      if (input.type === 'checkbox') v = input.checked;
      else if (key === 'folder') v = input.value.trim() || DEFAULT_SETTINGS.folder;
      else v = Number(input.value);
      await chrome.storage.local.set({ settings: { ...cur, [key]: v } });
    });
  }
}

// ---- 主流程 ----

function renderAll(force = false) {
  // 只有錄影清單或目前分頁狀態變了才重建畫面，避免按鈕在點擊時被換掉
  const key = `${state.recordings.map((r) => `${r.id}:${r.part}:${r.error || ''}:${r.monitorMuted}`).join(',')}|${currentRec()?.id || ''}|${state.errors?.[0]?.time || ''}`;
  if (force || key !== structureKey) {
    structureKey = key;
    renderCurrent();
    renderRecordings();
  }
  updateClocks();
}

async function main() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await Promise.all([refreshState(), loadPresets(), initSettings()]);
  renderAll(true);
  renderPresets();
  renderOrphans();
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
