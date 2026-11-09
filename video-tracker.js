// 「自動框住影片」：找出網頁裡最大、正在顯示的影片，回傳它實際畫面（扣掉黑邊）在可視區的位置比例。
// 這個函式會被 chrome.scripting.executeScript 注入到分頁裡執行，所以必須自給自足，不能引用外部變數。
//
// recId 是 null 時只量一次就回傳；有 recId 時會持續追蹤，位置改變就通知錄影程序更新範圍。
// 換頁後這段程式會消失（沒有申請網站權限），錄影會停在最後的位置繼續錄。
export function videoTrackerMain(recId) {
  function contentRect(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(v);
    let x = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    let y = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
    let w = v.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let h = v.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const vw = v.videoWidth, vh = v.videoHeight;
    const fit = cs.objectFit;
    // 影片預設是 contain：畫面等比縮放放進元素裡，多出來的是黑邊，要扣掉
    if (vw && vh && fit !== 'fill' && fit !== 'cover') {
      let scale = Math.min(w / vw, h / vh);
      if (fit === 'none') scale = 1;
      if (fit === 'scale-down') scale = Math.min(scale, 1);
      const cw = vw * scale, ch = vh * scale;
      x += (w - cw) / 2;
      y += (h - ch) / 2;
      w = cw;
      h = ch;
    }
    // 只留在可視區裡的部分
    const left = Math.max(0, x), top = Math.max(0, y);
    const right = Math.min(innerWidth, x + w), bottom = Math.min(innerHeight, y + h);
    if (right - left < 2 || bottom - top < 2) return null;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  function measure() {
    let best = null;
    for (const v of document.querySelectorAll('video')) {
      const cs = getComputedStyle(v);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      const r = contentRect(v);
      if (r && (!best || r.w * r.h > best.w * best.h)) best = r;
    }
    if (!best) return null;
    return { x: best.x / innerWidth, y: best.y / innerHeight, w: best.w / innerWidth, h: best.h / innerHeight };
  }

  if (!recId) return measure();

  window.__tabRecVideoTracker?.stop();
  let last = measure();
  let timer = null;
  const changed = (a, b) => !a || !b || ['x', 'y', 'w', 'h'].some((k) => Math.abs(a[k] - b[k]) > 0.002);

  let ticks = 0;
  async function check() {
    const now = measure();
    const moved = now && changed(now, last); // 影片暫時不見時沿用最後的位置
    // 位置沒變時每 10 秒問一次錄影還在不在，結束了就停止追蹤
    if (!moved && ++ticks % 20 !== 0) return;
    if (moved) last = now;
    try {
      const msg = moved ? { type: 'videoRect', recId, crop: now } : { type: 'videoAlive', recId };
      const res = await chrome.runtime.sendMessage({ target: 'sw', ...msg });
      if (!res?.ok) stop();
    } catch {
      stop();
    }
  }

  function stop() {
    clearInterval(timer);
    removeEventListener('resize', check);
    removeEventListener('scroll', check, true);
    if (window.__tabRecVideoTracker?.recId === recId) delete window.__tabRecVideoTracker;
  }

  timer = setInterval(check, 500);
  addEventListener('resize', check);
  addEventListener('scroll', check, true);
  window.__tabRecVideoTracker = { recId, stop };
  return last;
}
