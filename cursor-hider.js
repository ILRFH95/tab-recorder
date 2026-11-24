// 錄影範圍內隱藏滑鼠游標。
//
// 分頁錄影時，滑鼠在分頁上移動或點擊，瀏覽器會把游標疊進錄影畫面（停 2 秒後消失），而且沒有參數能關掉
// （Chromium content/browser/media/capture/mouse_cursor_overlay_controller*.cc）。疊上去的是網頁當下的游標圖案，
// 所以滑鼠在錄影範圍內時，把網頁的游標換成透明的，錄影裡就看不到游標。代價是使用者在範圍內也看不到游標，
// 這沒辦法分開：瀏覽器錄到的游標就是畫面上的游標。
//
// 每個框架各自決定自己的游標（游標樣式由滑鼠底下那個框架的網頁決定）：
// 最上層把錄影範圍（分頁可視區的比例）換成自己的座標，每 0.25 秒往內層框架推送換算好的範圍，
// 內層框架回覆收到，再往它裡面的框架推。滑鼠移動時，各框架看滑鼠是否在範圍內，切換 <html> 上的 class；
// 游標樣式由 runCursorHider 用 insertCSS（使用者層級，蓋得過網頁自己的 !important）放進每個框架。
// 網頁元件的 Shadow DOM 裡選擇器碰不到，滑鼠經過時另外放一份樣式進去（封閉的 Shadow DOM 做不到）。
//
// 只有擴充功能有權限的框架會被注入，其他框架上照常顯示游標。之後才出現的框架（例如延遲載入的播放器）
// 一直沒回覆時，請背景程式重新注入一次；每個框架元件只請一次，沒權限的框架不會一直重試。
// 換頁後這段程式會消失，背景程式會在頁面載入後重新注入。
export const CURSOR_CLASS = '__tabRecNoCursor';
// 1×1 全透明 PNG；不支援自訂游標時退回 none
const TRANSPARENT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const CURSOR_RULE = `cursor: url("${TRANSPARENT}") 0 0, none !important;`;
export const CURSOR_CSS = `html.${CURSOR_CLASS}, html.${CURSOR_CLASS} * { ${CURSOR_RULE} }`;

// 注入到分頁的每個框架執行（必須自給自足，不能引用外部變數）。
// initialCrop 是開始時的範圍（分頁可視區的比例，null 代表整個分頁），之後向背景程式查最新的範圍
export function cursorHiderMain(initialCrop, nonce, cls, rule) {
  const KEY = '__tabRecCH';
  const isTop = window === window.top;
  const PUSH_MS = 250;
  const POLL_MS = 500;
  const ACK_WAIT_MS = 2000; // 內層框架這麼久都沒回覆：多半是之後才出現的框架，請背景程式重新注入
  const STALE_MS = 3000; // 內層框架超過這麼久沒收到範圍：先恢復游標
  const GONE_MS = 15000; // 超過這麼久：外層不在了（錄影結束、外層換頁），整個停掉
  const px = (v) => parseFloat(v) || 0;

  window.__tabRecCursorHider?.stop();
  // 已經請過重新注入的框架元件 → 當時的網址。存在 window 上，重新注入後還記得，沒權限的框架才不會一直重試
  const asked = (window.__tabRecCHAsked ||= new WeakMap());

  let region = null; // 這個框架可視區座標裡的錄影範圍；null 代表不隱藏
  let pointer = null; // 滑鼠最後的位置（這個框架的座標）
  let inside = false;
  let lastFromParent = performance.now();
  let stopped = false;

  // Shadow DOM 用的樣式：滑鼠經過時放進去，跟著 inside 開關
  let shadowSheet = null;
  try {
    shadowSheet = new CSSStyleSheet();
    // 這份樣式跟網頁元件自己的樣式同一層級，比的是選擇器權重：:is() 取最高的那個（三個 id），蓋得過一般的 button 之類
    shadowSheet.replaceSync(`:is(*, #_t#_t#_t) { ${rule} }`);
    shadowSheet.disabled = true;
  } catch {
    shadowSheet = null;
  }
  const shadowRoots = new Set();

  function apply() {
    inside = Boolean(region && pointer &&
      pointer.x >= region.x && pointer.x < region.x + region.w &&
      pointer.y >= region.y && pointer.y < region.y + region.h);
    document.documentElement?.classList.toggle(cls, inside);
    if (shadowSheet) shadowSheet.disabled = !inside;
  }

  function adoptShadowRoots(e) {
    if (!shadowSheet) return;
    for (const node of e.composedPath()) {
      if (!(node instanceof ShadowRoot) || shadowRoots.has(node)) continue;
      try {
        node.adoptedStyleSheets = [...node.adoptedStyleSheets, shadowSheet];
        shadowRoots.add(node);
      } catch {
        // 不能改的就算了
      }
    }
  }

  function onPointer(e) {
    pointer = { x: e.clientX, y: e.clientY };
    adoptShadowRoots(e);
    apply();
  }

  // 內層框架在這個框架裡的位置與縮放（扣掉邊框和內距）；看不到時是 null
  function frameBox(f) {
    const r = f.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || !f.offsetWidth || !f.offsetHeight) return null;
    const cs = getComputedStyle(f);
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;
    const sx = r.width / f.offsetWidth, sy = r.height / f.offsetHeight;
    return { ox: r.left + (px(cs.borderLeftWidth) + px(cs.paddingLeft)) * sx, oy: r.top + (px(cs.borderTopWidth) + px(cs.paddingTop)) * sy, sx, sy };
  }

  const acked = new WeakMap(); // 內層框架的 window → 最後一次回覆的時間
  const firstSeen = new WeakMap(); // 框架元件 → 這次第一次看到的時間
  let lastReinjectAt = -Infinity;

  // 網頁元件（開放的 Shadow DOM）裡也可能有框架。整頁掃描比較花時間，每 2 秒才重新找一次 shadow root
  let openRoots = [], rootsAt = -Infinity;
  function findOpenRoots() {
    const roots = [];
    const walk = (root) => {
      const it = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
      for (let el = it.nextNode(); el; el = it.nextNode()) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return roots;
  }
  function frameElements() {
    const now = performance.now();
    if (now - rootsAt > 2000) {
      openRoots = findOpenRoots();
      rootsAt = now;
    }
    const sel = 'iframe, frame';
    return [...document.querySelectorAll(sel), ...openRoots.flatMap((r) => (r.isConnected === false ? [] : [...r.querySelectorAll(sel)]))];
  }

  function pushChildren(type = 'region') {
    const now = performance.now();
    const missing = [];
    for (const f of frameElements()) {
      const win = f.contentWindow;
      if (!win) continue;
      const b = region && type === 'region' ? frameBox(f) : null;
      const child = b && {
        x: (region.x - b.ox) / b.sx, y: (region.y - b.oy) / b.sy, w: region.w / b.sx, h: region.h / b.sy,
      };
      try {
        win.postMessage({ [KEY]: nonce, type, region: child || null }, '*');
      } catch {
        // 框架正在換頁等情況，下一輪再推
      }
      if (type !== 'region') continue;
      if (!firstSeen.has(f)) firstSeen.set(f, now);
      const src = f.src || 'about:blank';
      if (now - (acked.get(win) ?? -Infinity) > ACK_WAIT_MS && now - firstSeen.get(f) > ACK_WAIT_MS && asked.get(f) !== src) {
        missing.push([f, src]);
      }
    }
    // 有沒回覆、也還沒請過的框架：請背景程式重新注入整個分頁（最多每 5 秒一次）
    if (missing.length && now - lastReinjectAt > 5000) {
      lastReinjectAt = now;
      for (const [f, src] of missing) asked.set(f, src);
      chrome.runtime.sendMessage({ target: 'sw', type: 'cursorReinject' }).catch(() => {});
    }
  }

  function onMessage(e) {
    const d = e.data;
    if (!d || typeof d !== 'object' || d[KEY] !== nonce || !e.source) return;
    if (d.type === 'ack') {
      acked.set(e.source, performance.now());
      // 這個框架已經有程式了：解除「請過一次」的記號，之後它自己重新整理時還能再補
      for (const f of frameElements()) if (f.contentWindow === e.source) asked.delete(f);
      return;
    }
    if (isTop || e.source !== parent) return;
    if (d.type === 'end') return stop();
    if (d.type !== 'region') return;
    lastFromParent = performance.now();
    const r = d.region;
    region = r && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? r : null;
    apply();
    try {
      parent.postMessage({ [KEY]: nonce, type: 'ack' }, '*');
    } catch {
      // 外層正在換頁
    }
    pushChildren();
  }

  let pushTimer = null, pollTimer = null;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(pushTimer);
    clearInterval(pollTimer);
    removeEventListener('pointermove', onPointer, true);
    removeEventListener('pointerdown', onPointer, true);
    removeEventListener('message', onMessage);
    document.documentElement?.classList.remove(cls);
    for (const root of shadowRoots) {
      try {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== shadowSheet);
      } catch {
        // 不能改的就算了
      }
    }
    shadowRoots.clear();
    pushChildren('end');
    if (window.__tabRecCursorHider?.nonce === nonce) delete window.__tabRecCursorHider;
  }

  addEventListener('pointermove', onPointer, true);
  addEventListener('pointerdown', onPointer, true);
  addEventListener('message', onMessage);
  window.__tabRecCursorHider = { nonce, stop };

  if (!isTop) {
    // 內層框架：只照外層推來的範圍做，太久沒收到就恢復游標，再久就停掉
    pushTimer = setInterval(() => {
      const idle = performance.now() - lastFromParent;
      if (idle > GONE_MS) stop();
      else if (idle > STALE_MS && region) {
        region = null;
        apply();
      }
    }, 1000);
    return;
  }

  // 最上層：向背景程式確認錄影還在（或正要開始），並取得目前的範圍（「自動框住影片」時會跟著影片移動）
  let crop = initialCrop || { x: 0, y: 0, w: 1, h: 1 };
  async function poll() {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'sw', type: 'cursorState' });
      if (!res?.ok || !res.alive) return stop();
      crop = res.crop || { x: 0, y: 0, w: 1, h: 1 };
    } catch {
      stop();
    }
  }
  function push() {
    region = { x: crop.x * innerWidth, y: crop.y * innerHeight, w: crop.w * innerWidth, h: crop.h * innerHeight };
    apply();
    pushChildren();
  }
  pollTimer = setInterval(poll, POLL_MS);
  pushTimer = setInterval(push, PUSH_MS);
  push();
}

// 在分頁裡開始隱藏游標。crop 是目前的範圍（null 代表整個分頁）。
// 失敗（沒有權限、內建頁面）時丟出錯誤，由呼叫端決定怎麼提示；錄影照常進行
export async function runCursorHider(tabId, crop) {
  await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, css: CURSOR_CSS, origin: 'USER' });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: cursorHiderMain,
    args: [crop || null, crypto.randomUUID(), CURSOR_CLASS, CURSOR_RULE],
  });
}
