// 「自動框住影片」：找出網頁裡最大、正在顯示的影片，回傳它實際畫面（扣掉黑邊）在可視區的位置比例。
// videoTrackerMain 會被 chrome.scripting.executeScript 注入到分頁的每個框架裡執行（allFrames），
// 所以必須自給自足，不能引用外部變數。
//
// 影片可能放在別的網域的內嵌框架（iframe）裡（例如 jkface 的直播）。每個框架各自找自己的影片；
// 外層框架用 postMessage 向內層框架要結果（poll → report），換算成自己的座標，最上層再挑最大的一支。
// 只有擴充功能有權限的框架會被注入（沒權限的框架會被略過，不會出錯）：主頁面靠 activeTab，
// 其他網域要使用者在彈出視窗允許過（optional_host_permissions，見 popup.js 的 askFramePermission）。
//
// recId 是 null 時只量一次就回傳；有 recId 時會持續追蹤，位置改變或影片停止／不見時通知錄影程序。
// nonce 是這次注入的代號，同一次注入的各框架之間才互相回應。
// 換頁後這段程式會消失，錄影會停在最後的位置繼續錄。
export async function videoTrackerMain(recId, nonce) {
  const KEY = '__tabRecVT';
  const isTop = window === window.top;
  const STALE_MS = 2000; // 內層框架超過這麼久沒回報，就當成它沒有影片
  const px = (v) => parseFloat(v) || 0;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  let running = true;

  // object-position 的一個軸：百分比依剩餘空間計算，px 直接位移，其他當置中
  function axisOffset(token, free) {
    if (!token) return free / 2;
    if (token.endsWith('%')) return (free * parseFloat(token)) / 100;
    if (token.endsWith('px')) return parseFloat(token);
    return free / 2;
  }

  function hidden(el) {
    const cs = getComputedStyle(el);
    return cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0;
  }

  // 元素的內容框（扣掉邊框和內距）。元素可能被 transform 縮放：sx、sy 是縮放比例
  function contentBox(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || !el.offsetWidth || !el.offsetHeight) return null;
    const sx = r.width / el.offsetWidth, sy = r.height / el.offsetHeight;
    const cs = getComputedStyle(el);
    const left = px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const top = px(cs.borderTopWidth) + px(cs.paddingTop);
    const boxW = el.offsetWidth - left - px(cs.borderRightWidth) - px(cs.paddingRight);
    const boxH = el.offsetHeight - top - px(cs.borderBottomWidth) - px(cs.paddingBottom);
    if (boxW < 2 || boxH < 2) return null;
    return { r, sx, sy, cs, left, top, boxW, boxH };
  }

  // 可視區座標的矩形，只留在可視區裡、而且沒被 el 的外層容器裁掉的部分
  function clipToVisible(el, x1, y1, x2, y2) {
    x1 = Math.max(0, x1);
    y1 = Math.max(0, y1);
    x2 = Math.min(innerWidth, x2);
    y2 = Math.min(innerHeight, y2);
    // 外層容器設了 overflow 裁切時，元素只有容器範圍內看得到（元素本身可能大得多）
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX === 'visible' && ps.overflowY === 'visible' && ps.clipPath === 'none') continue;
      const pr = p.getBoundingClientRect();
      if (ps.overflowX !== 'visible' || ps.clipPath !== 'none') { x1 = Math.max(x1, pr.left); x2 = Math.min(x2, pr.right); }
      if (ps.overflowY !== 'visible' || ps.clipPath !== 'none') { y1 = Math.max(y1, pr.top); y2 = Math.min(y2, pr.bottom); }
    }
    if (!(x2 - x1 >= 2 && y2 - y1 >= 2)) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // 影片實際畫面（扣掉黑邊）在可視區的位置，單位是 px
  function contentRect(v) {
    const b = contentBox(v);
    if (!b) return null;
    const { r, sx, sy, cs, left, top, boxW, boxH } = b;
    let cw = boxW, ch = boxH;
    const vw = v.videoWidth, vh = v.videoHeight, fit = cs.objectFit;
    if (vw && vh && fit !== 'fill') {
      let scale;
      if (fit === 'cover') scale = Math.max(boxW / vw, boxH / vh);
      else if (fit === 'none') scale = 1;
      else if (fit === 'scale-down') scale = Math.min(boxW / vw, boxH / vh, 1);
      else scale = Math.min(boxW / vw, boxH / vh); // contain（影片預設）
      cw = vw * scale;
      ch = vh * scale;
    }
    // object-position 決定畫面在元素裡的位置（預設置中）；超出元素的部分會被裁掉
    const [posX, posY] = cs.objectPosition.split(/\s+/);
    let x = axisOffset(posX, boxW - cw), y = axisOffset(posY, boxH - ch);
    const x2 = Math.min(boxW, x + cw), y2 = Math.min(boxH, y + ch);
    x = Math.max(0, x);
    y = Math.max(0, y);
    if (x2 - x < 2 || y2 - y < 2) return null;
    return clipToVisible(v, r.left + (left + x) * sx, r.top + (top + y) * sy, r.left + (left + x2) * sx, r.top + (top + y2) * sy);
  }

  // 影片在畫面上是不是被另一支影片蓋住（例如鋪滿整頁、當背景用的模糊影片）。
  // 只看影片：直播畫面上常疊著透明的按鈕、留言層，那些不算擋住。
  // 網頁常把影片設成 pointer-events: none，那樣 elementsFromPoint 會找不到，所以檢查時暫時打開
  function coveredByOtherVideo(v, r, videos) {
    const saved = videos.map((el) => [el, el.style.getPropertyValue('pointer-events'), el.style.getPropertyPriority('pointer-events')]);
    for (const [el] of saved) el.style.setProperty('pointer-events', 'auto', 'important');
    try {
      const stack = document.elementsFromPoint(r.x + r.w / 2, r.y + r.h / 2);
      const topVideo = stack.find((el) => el.tagName === 'VIDEO');
      return Boolean(topVideo) && topVideo !== v;
    } finally {
      for (const [el, value, prio] of saved) {
        if (value) el.style.setProperty('pointer-events', value, prio);
        else el.style.removeProperty('pointer-events');
      }
    }
  }

  // 這個框架裡最大、正在顯示、沒被其他影片蓋住的影片元素和它的畫面位置（px）；沒有影片時是 null
  function findVideo() {
    const videos = [...document.querySelectorAll('video')];
    const shown = [];
    for (const v of videos) {
      if (hidden(v)) continue;
      const r = contentRect(v);
      if (r) shown.push({ v, r });
    }
    // 優先選沒被蓋住的；萬一全部都判斷成被蓋住，退回選最大的
    const visible = shown.filter(({ v, r }) => !coveredByOtherVideo(v, r, videos));
    let best = null, bestEl = null;
    for (const { v, r } of visible.length ? visible : shown) {
      if (!best || r.w * r.h > best.w * best.h) { best = r; bestEl = v; }
    }
    return best ? { el: bestEl, rect: best } : null;
  }

  // 用 requestVideoFrameCallback 記錄每支影片最後一次真的出新畫面的時間。
  // 直播斷線時 currentTime 有時還會繼續走，看有沒有新畫面比較準
  const frames = new WeakMap();
  function watchFrames(v) {
    if (frames.has(v) || !v.requestVideoFrameCallback) return;
    const info = { lastFrameAt: performance.now() };
    frames.set(v, info);
    const onFrame = () => {
      info.lastFrameAt = performance.now();
      if (running) v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  // 影片狀態（給自動暫停用）：stopped＝暫停、結束或 3 秒沒有新畫面，playing＝正常播放（沒有影片時另外算 missing）
  let lastTime = -1, lastTimeChangedAt = performance.now(), lastEl = null;
  function videoState(v) {
    const now = performance.now();
    if (v.paused || v.ended || v.readyState < 2) return 'stopped';
    watchFrames(v);
    const f = frames.get(v);
    if (f) return now - f.lastFrameAt > 3000 ? 'stopped' : 'playing';
    // 不支援 requestVideoFrameCallback 時改看 currentTime 有沒有前進
    if (v !== lastEl || v.currentTime !== lastTime) {
      lastEl = v;
      lastTime = v.currentTime;
      lastTimeChangedAt = now;
    }
    return now - lastTimeChangedAt > 3000 ? 'stopped' : 'playing';
  }

  // 來源位元率：Chromium 的 webkitVideoDecodedByteCount 是送進解碼器的壓縮資料總量，
  // 每 5 秒以上算一次平均。不支援時是 null（不受網站的跨網域限制影響）
  let meter = null, srcKbps = null;
  function measureBitrate(v) {
    if (!v || typeof v.webkitVideoDecodedByteCount !== 'number') return;
    const now = performance.now(), bytes = v.webkitVideoDecodedByteCount;
    if (!meter || meter.el !== v || bytes < meter.bytes) {
      meter = { el: v, bytes, at: now };
      return;
    }
    if (now - meter.at < 5000) return;
    if (bytes > meter.bytes) srcKbps = Math.round(((bytes - meter.bytes) * 8) / (now - meter.at));
    meter = { el: v, bytes, at: now };
  }

  // 「回報」：一支影片在某個框架可視區裡的位置（px）、那個可視區的大小、來源規格與狀態
  function ownReport() {
    const found = findVideo();
    if (!found) return null;
    const v = found.el;
    measureBitrate(v);
    return {
      ...found.rect,
      innerW: innerWidth,
      innerH: innerHeight,
      srcW: v.videoWidth || 0,
      srcH: v.videoHeight || 0,
      state: videoState(v),
      kbps: srcKbps,
      measurable: typeof v.webkitVideoDecodedByteCount === 'number',
    };
  }

  // 內層框架的回報來自別的網頁，只取用得到的欄位並檢查型別
  function cleanReport(r) {
    if (!r || typeof r !== 'object') return null;
    if (![r.x, r.y, r.w, r.h, r.innerW, r.innerH].every(num) || r.innerW < 2 || r.innerH < 2) return null;
    return {
      x: r.x, y: r.y, w: r.w, h: r.h, innerW: r.innerW, innerH: r.innerH,
      srcW: num(r.srcW) ? r.srcW : 0,
      srcH: num(r.srcH) ? r.srcH : 0,
      state: r.state === 'playing' ? 'playing' : 'stopped',
      kbps: num(r.kbps) ? r.kbps : null,
      measurable: r.measurable === true,
    };
  }

  const childReports = new Map(); // 內層框架的 window → { report, at }

  function frameElementOf(win) {
    for (const f of document.querySelectorAll('iframe, frame')) if (f.contentWindow === win) return f;
    return null;
  }

  // 把內層框架的回報換算成這個框架的可視區座標；框架不見了或被藏起來時是 null
  function fromChild(win, rep) {
    const f = frameElementOf(win);
    if (!f || hidden(f)) return null;
    const b = contentBox(f);
    if (!b) return null;
    const ox = b.r.left + b.left * b.sx, oy = b.r.top + b.top * b.sy;
    const kx = (b.boxW * b.sx) / rep.innerW, ky = (b.boxH * b.sy) / rep.innerH;
    // 先限制在內層框架的可視區裡，再裁成這一層看得到的部分
    const rect = clipToVisible(f,
      ox + Math.max(0, rep.x) * kx, oy + Math.max(0, rep.y) * ky,
      ox + Math.min(rep.innerW, rep.x + rep.w) * kx, oy + Math.min(rep.innerH, rep.y + rep.h) * ky);
    return rect && { ...rep, ...rect, innerW: innerWidth, innerH: innerHeight };
  }

  // 這個框架和它裡面所有框架中，畫面上最大的那支影片；都沒有時是 null
  function bestReport() {
    let best = ownReport();
    const now = performance.now();
    for (const [win, { report, at }] of childReports) {
      if (now - at > STALE_MS) {
        childReports.delete(win);
        continue;
      }
      const r = fromChild(win, report);
      if (r && (!best || r.w * r.h > best.w * best.h)) best = r;
    }
    return best;
  }

  function pollChildren() {
    for (const f of document.querySelectorAll('iframe, frame')) {
      try {
        f.contentWindow?.postMessage({ [KEY]: nonce, type: 'poll' }, '*');
      } catch {
        // 框架正在換頁等情況，下一輪再問
      }
    }
  }

  let lastPollAt = performance.now();
  function onMessage(e) {
    const d = e.data;
    if (!d || typeof d !== 'object' || d[KEY] !== nonce || !e.source) return;
    if (d.type === 'report') {
      const report = cleanReport(d.report);
      if (report) childReports.set(e.source, { report, at: performance.now() });
      else childReports.delete(e.source);
    } else if (d.type === 'poll' && !isTop && e.source === parent) {
      // 外層來要結果：順便問自己裡面的框架（結果下一輪才會反映出來），再回報目前知道的最大影片
      lastPollAt = performance.now();
      pollChildren();
      parent.postMessage({ [KEY]: nonce, type: 'report', report: bestReport() }, '*');
    }
  }
  addEventListener('message', onMessage);

  const toRatio = (r) => ({ x: r.x / innerWidth, y: r.y / innerHeight, w: r.w / innerWidth, h: r.h / innerHeight });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hasFrames = () => Boolean(document.querySelector('iframe, frame'));

  // 內層框架：只回應外層的詢問。外層太久沒來問（量測結束、錄影停止、外層換頁）就自己停掉
  if (!isTop) {
    const slots = (window.__tabRecVTFrames ||= {});
    const idleMs = recId ? 15000 : 3000;
    const timer = setInterval(() => {
      if (performance.now() - lastPollAt > idleMs) stopChild();
    }, 1000);
    const stopChild = () => {
      running = false;
      clearInterval(timer);
      removeEventListener('message', onMessage);
      delete slots[nonce];
    };
    slots[nonce] = stopChild;
    return null;
  }

  // 只量一次：回傳位置，加上來源解析度（srcW、srcH，讓錄影尺寸不超過來源）。
  // 有內層框架時問三輪（框架注入的先後順序不一定，多層框架也要一輪一輪往上傳）
  if (!recId) {
    try {
      if (hasFrames()) {
        for (const wait of [200, 200, 300]) {
          pollChildren();
          await sleep(wait);
        }
      }
      const best = bestReport();
      return best ? { ...toRatio(best), srcW: best.srcW, srcH: best.srcH } : null;
    } finally {
      running = false;
      removeEventListener('message', onMessage);
    }
  }

  window.__tabRecVideoTracker?.stop();
  let timer = null;
  let synced = null; // 錄影程序目前用的位置
  let syncedState = null;
  const changed = (a, b) => !a || !b || ['x', 'y', 'w', 'h'].some((k) => Math.abs(a[k] - b[k]) > 0.002);

  let lastReportAt = 0, syncedSource = '';
  async function check() {
    pollChildren(); // 內層框架的結果下一輪用（每 0.5 秒一輪）
    const best = bestReport();
    const rect = best ? toRatio(best) : null;
    const state = best ? best.state : 'missing';
    const source = best ? { w: best.srcW, h: best.srcH, kbps: best.kbps, measurable: best.measurable } : null;
    const sourceKey = source ? `${source.w}x${source.h}` : '';
    const moved = rect && changed(rect, synced); // 影片暫時不見時沿用最後的位置
    // 沒有變化時每 10 秒回報一次（順便更新來源位元率），也確認錄影還在，結束了就停止追蹤
    const sourceChanged = sourceKey && sourceKey !== syncedSource;
    if (!moved && state === syncedState && !sourceChanged && performance.now() - lastReportAt < 10000) return;
    lastReportAt = performance.now();
    try {
      const res = await chrome.runtime.sendMessage({
        target: 'sw', type: 'videoUpdate', recId, crop: moved ? rect : null, videoState: state, source,
      });
      if (!res?.ok) return stop();
      if (moved) synced = rect; // 確定送到了才算同步
      syncedState = state;
      if (sourceKey) syncedSource = sourceKey;
    } catch {
      stop();
    }
  }

  function stop() {
    running = false;
    clearInterval(timer);
    removeEventListener('resize', check);
    removeEventListener('scroll', check, true);
    removeEventListener('message', onMessage);
    if (window.__tabRecVideoTracker?.recId === recId) delete window.__tabRecVideoTracker;
  }

  timer = setInterval(check, 500);
  addEventListener('resize', check);
  addEventListener('scroll', check, true);
  window.__tabRecVideoTracker = { recId, stop };
  // 開始時馬上回報一次目前位置，以防從量測到開始錄影之間影片移動過。
  // 有內層框架時先問一輪再回報，免得第一次回報把框架裡的影片當成不見了
  if (hasFrames()) {
    pollChildren();
    setTimeout(check, 250);
  } else {
    check();
  }
  const best = bestReport();
  return best ? toRatio(best) : null;
}

// 在分頁的每個有權限的框架裡執行 videoTrackerMain，回傳最上層的結果。
// recId 是 null 時只量一次影片位置；有 recId 時開始追蹤
export async function runVideoTracker(tabId, recId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: videoTrackerMain,
    args: [recId, crypto.randomUUID()],
  });
  return results.find((r) => r.frameId === 0)?.result || null;
}

// 給彈出視窗用：找出影片可能在哪個還沒允許讀取的網站的框架裡。回傳 [{ pattern, host }]，不需要時是空陣列。
// 每個讀得到的框架各自回報「自己有沒有影片」和「自己裡面最大的別的網域框架」；
// 多層框架（主頁 → B → 播放器 C）時，允許 B 之後再檢查一次才會看到 C，所以每次打開彈出視窗、開始失敗後都要重新檢查。
export async function findFrameSites(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: frameScanMain });
  const scans = results.map((r) => r.result).filter(Boolean);
  if (!scans.length || scans.some((s) => s.hasVideo)) return [];
  const topHost = results.find((r) => r.frameId === 0)?.result?.host;
  const sites = [];
  for (const { frame } of scans) {
    if (!frame || frame.hostname === topHost) continue; // 跟主頁面同網站的框架，activeTab 就讀得到
    const pattern = `${frame.protocol}//${frame.hostname}/*`;
    if (sites.some((s) => s.pattern === pattern)) continue;
    if (await chrome.permissions.contains({ origins: [pattern] })) continue;
    sites.push({ pattern, host: frame.hostname });
  }
  return sites;
}

// 注入到每個框架執行（必須自給自足）：這個框架有沒有顯示中的影片，以及畫面上最大的別的網域框架
// （protocol 和 hostname；太小的不算）
export function frameScanMain() {
  const area = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return 0;
    return r.width >= 2 && r.height >= 2 ? r.width * r.height : 0;
  };
  const hasVideo = [...document.querySelectorAll('video')].some((v) => area(v) > 0);
  let best = null, bestArea = 160 * 90; // 比這小的框架（廣告追蹤像素之類）不算
  for (const f of document.querySelectorAll('iframe, frame')) {
    let u;
    try {
      u = new URL(f.src, location.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || u.origin === location.origin) continue;
    const a = area(f);
    if (a >= bestArea) {
      bestArea = a;
      best = { protocol: u.protocol, hostname: u.hostname };
    }
  }
  return { hasVideo, frame: best, host: location.hostname };
}
