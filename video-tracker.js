// 「自動框住影片」：找出網頁裡最大、正在顯示的影片，回傳它實際畫面（扣掉黑邊）在可視區的位置比例。
// 這個函式會被 chrome.scripting.executeScript 注入到分頁裡執行，所以必須自給自足，不能引用外部變數。
//
// recId 是 null 時只量一次就回傳；有 recId 時會持續追蹤，位置改變或影片停止／不見時通知錄影程序。
// 換頁後這段程式會消失（沒有申請網站權限），錄影會停在最後的位置繼續錄。
export function videoTrackerMain(recId) {
  const px = (v) => parseFloat(v) || 0;

  // object-position 的一個軸：百分比依剩餘空間計算，px 直接位移，其他當置中
  function axisOffset(token, free) {
    if (!token) return free / 2;
    if (token.endsWith('%')) return (free * parseFloat(token)) / 100;
    if (token.endsWith('px')) return parseFloat(token);
    return free / 2;
  }

  function contentRect(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || !v.offsetWidth || !v.offsetHeight) return null;
    // 元素可能被 transform 縮放：先在元素自己的座標算，最後再乘上縮放比例
    const sx = r.width / v.offsetWidth, sy = r.height / v.offsetHeight;
    const cs = getComputedStyle(v);
    const left = px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const top = px(cs.borderTopWidth) + px(cs.paddingTop);
    const boxW = v.offsetWidth - left - px(cs.borderRightWidth) - px(cs.paddingRight);
    const boxH = v.offsetHeight - top - px(cs.borderBottomWidth) - px(cs.paddingBottom);
    if (boxW < 2 || boxH < 2) return null;

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

    // 換成可視區座標，只留在可視區裡的部分
    let vx1 = Math.max(0, r.left + (left + x) * sx), vy1 = Math.max(0, r.top + (top + y) * sy);
    let vx2 = Math.min(innerWidth, r.left + (left + x2) * sx), vy2 = Math.min(innerHeight, r.top + (top + y2) * sy);
    // 外層容器設了 overflow 裁切時，影片只有容器範圍內看得到（影片元素本身可能大得多）
    for (let el = v.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const ps = getComputedStyle(el);
      if (ps.overflowX === 'visible' && ps.overflowY === 'visible' && ps.clipPath === 'none') continue;
      const pr = el.getBoundingClientRect();
      if (ps.overflowX !== 'visible' || ps.clipPath !== 'none') { vx1 = Math.max(vx1, pr.left); vx2 = Math.min(vx2, pr.right); }
      if (ps.overflowY !== 'visible' || ps.clipPath !== 'none') { vy1 = Math.max(vy1, pr.top); vy2 = Math.min(vy2, pr.bottom); }
    }
    if (vx2 - vx1 < 2 || vy2 - vy1 < 2) return null;
    return { x: vx1, y: vy1, w: vx2 - vx1, h: vy2 - vy1 };
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

  // 回傳最大、正在顯示、沒被其他影片蓋住的影片元素和它的畫面位置（比例）；沒有影片時是 null
  function findVideo() {
    const videos = [...document.querySelectorAll('video')];
    const shown = [];
    for (const v of videos) {
      const cs = getComputedStyle(v);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      const r = contentRect(v);
      if (r) shown.push({ v, r });
    }
    // 優先選沒被蓋住的；萬一全部都判斷成被蓋住，退回選最大的
    const visible = shown.filter(({ v, r }) => !coveredByOtherVideo(v, r, videos));
    let best = null, bestEl = null;
    for (const { v, r } of visible.length ? visible : shown) {
      if (!best || r.w * r.h > best.w * best.h) { best = r; bestEl = v; }
    }
    if (!best) return null;
    return { el: bestEl, rect: { x: best.x / innerWidth, y: best.y / innerHeight, w: best.w / innerWidth, h: best.h / innerHeight } };
  }

  if (!recId) return findVideo()?.rect || null;

  window.__tabRecVideoTracker?.stop();
  let running = true;
  let timer = null;
  let synced = null; // 錄影程序目前用的位置
  let syncedState = null;
  const changed = (a, b) => !a || !b || ['x', 'y', 'w', 'h'].some((k) => Math.abs(a[k] - b[k]) > 0.002);

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

  // 影片狀態（給自動暫停用）：missing＝沒有影片，stopped＝暫停、結束或 3 秒沒有新畫面，playing＝正常播放
  let lastTime = -1, lastTimeChangedAt = performance.now(), lastEl = null;
  function videoState(found) {
    if (!found) return 'missing';
    const v = found.el, now = performance.now();
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

  let lastReportAt = 0;
  async function check() {
    const found = findVideo();
    const rect = found?.rect || null;
    const state = videoState(found);
    const moved = rect && changed(rect, synced); // 影片暫時不見時沿用最後的位置
    // 沒有變化時每 10 秒回報一次，順便確認錄影還在，結束了就停止追蹤
    if (!moved && state === syncedState && performance.now() - lastReportAt < 10000) return;
    lastReportAt = performance.now();
    try {
      const res = await chrome.runtime.sendMessage({
        target: 'sw', type: 'videoUpdate', recId, crop: moved ? rect : null, videoState: state,
      });
      if (!res?.ok) return stop();
      if (moved) synced = rect; // 確定送到了才算同步
      syncedState = state;
    } catch {
      stop();
    }
  }

  function stop() {
    running = false;
    clearInterval(timer);
    removeEventListener('resize', check);
    removeEventListener('scroll', check, true);
    if (window.__tabRecVideoTracker?.recId === recId) delete window.__tabRecVideoTracker;
  }

  timer = setInterval(check, 500);
  addEventListener('resize', check);
  addEventListener('scroll', check, true);
  window.__tabRecVideoTracker = { recId, stop };
  check(); // 開始時馬上回報一次目前位置，以防從量測到開始錄影之間影片移動過
  return findVideo()?.rect || null;
}
