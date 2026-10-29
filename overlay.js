// 在網頁上框選錄影範圍。這個函式會被 chrome.scripting.executeScript 注入到分頁裡執行，
// 所以必須自給自足，不能引用外部變數。initial 是要預先顯示的範圍（比例），可以是 null。
export function overlayMain(initial) {
  window.__tabRecOverlay?.close();

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: "Microsoft JhengHei", system-ui, sans-serif; }
      .layer { position: fixed; inset: 0; cursor: crosshair; }
      .layer.empty { background: rgba(0,0,0,.45); }
      .box { position: absolute; outline: 2px dashed #fff; cursor: move;
             box-shadow: 0 0 0 1px rgba(0,0,0,.6), 0 0 0 200vmax rgba(0,0,0,.45); }
      .box[hidden] { display: none; }
      .h { position: absolute; width: 12px; height: 12px; background: #fff; border: 1px solid #333; }
      .nw { left: -7px; top: -7px; cursor: nwse-resize; } .ne { right: -7px; top: -7px; cursor: nesw-resize; }
      .sw { left: -7px; bottom: -7px; cursor: nesw-resize; } .se { right: -7px; bottom: -7px; cursor: nwse-resize; }
      .bar { position: fixed; left: 50%; transform: translateX(-50%); top: 12px; display: flex; gap: 8px;
             align-items: center; padding: 8px 10px; background: #202124; color: #fff; border-radius: 8px;
             font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.4); white-space: nowrap; }
      .bar.bottom { top: auto; bottom: 12px; }
      .size { font-family: Consolas, monospace; min-width: 84px; color: #9bb3d6; }
      button { font: inherit; border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; background: #3c4043; color: #fff; }
      button.primary { background: #9bb3d6; color: #0e1726; }
      button:hover { filter: brightness(1.15); }
      input { font: inherit; width: 110px; padding: 4px 6px; border-radius: 6px; border: 1px solid #5f6368;
              background: #303134; color: #fff; }
      .msg { color: #fdd663; }
    </style>
    <div class="layer empty"></div>
    <div class="box" hidden><i class="h nw" data-c="nw"></i><i class="h ne" data-c="ne"></i><i class="h sw" data-c="sw"></i><i class="h se" data-c="se"></i></div>
    <div class="bar">
      <span class="hint">拖曳框出要錄的範圍</span>
      <span class="size"></span>
      <input class="name" placeholder="範圍組名稱">
      <button class="save">儲存範圍</button>
      <button class="primary start">開始錄影</button>
      <button class="cancel">取消</button>
      <span class="msg"></span>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const layer = $('.layer'), box = $('.box'), bar = $('.bar'), sizeEl = $('.size'), msgEl = $('.msg');

  let r = initial
    ? { x: initial.x * innerWidth, y: initial.y * innerHeight, w: initial.w * innerWidth, h: initial.h * innerHeight }
    : null;
  let drag = null;

  function render() {
    if (!r) {
      box.hidden = true;
      layer.classList.add('empty');
      sizeEl.textContent = '';
      return;
    }
    box.hidden = false;
    layer.classList.remove('empty');
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const dpr = devicePixelRatio;
    sizeEl.textContent = `${Math.round(r.w * dpr)}×${Math.round(r.h * dpr)}`;
    // 框到上方時把工具列移到下方，免得擋住
    bar.classList.toggle('bottom', r.y < 70 && r.y + r.h > 0);
  }

  function clampPoint(e) {
    return { x: Math.min(Math.max(e.clientX, 0), innerWidth), y: Math.min(Math.max(e.clientY, 0), innerHeight) };
  }

  function beginDraw(e, anchor) {
    drag = { kind: 'draw', anchor };
    e.target.setPointerCapture(e.pointerId);
  }

  layer.addEventListener('pointerdown', (e) => {
    const p = clampPoint(e);
    r = { x: p.x, y: p.y, w: 0, h: 0 };
    beginDraw(e, p);
    render();
  });

  box.addEventListener('pointerdown', (e) => {
    const c = e.target.dataset?.c;
    if (c) {
      // 拖角落：以對角為固定點重新拉框
      const anchor = { x: c.includes('w') ? r.x + r.w : r.x, y: c.includes('n') ? r.y + r.h : r.y };
      beginDraw(e, anchor);
    } else {
      drag = { kind: 'move', dx: e.clientX - r.x, dy: e.clientY - r.y };
      e.target.setPointerCapture(e.pointerId);
    }
    e.stopPropagation();
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.kind === 'draw') {
      const p = clampPoint(e);
      r = {
        x: Math.min(p.x, drag.anchor.x),
        y: Math.min(p.y, drag.anchor.y),
        w: Math.abs(p.x - drag.anchor.x),
        h: Math.abs(p.y - drag.anchor.y),
      };
    } else {
      r.x = Math.min(Math.max(e.clientX - drag.dx, 0), innerWidth - r.w);
      r.y = Math.min(Math.max(e.clientY - drag.dy, 0), innerHeight - r.h);
    }
    render();
  });

  root.addEventListener('pointerup', () => {
    drag = null;
    if (r && (r.w < 8 || r.h < 8)) r = null;
    render();
  });

  function cropRatio() {
    if (!r) return null;
    return { x: r.x / innerWidth, y: r.y / innerHeight, w: r.w / innerWidth, h: r.h / innerHeight };
  }

  function close() {
    removeEventListener('keydown', onKey, true);
    host.remove();
    if (window.__tabRecOverlay === api) delete window.__tabRecOverlay;
  }

  async function startRecording() {
    const crop = cropRatio();
    if (!crop) {
      msgEl.textContent = '請先框出範圍';
      return;
    }
    close();
    // 等框選畫面確實從畫面上消失再開始擷取，避免錄到它
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 100))));
    const res = await chrome.runtime.sendMessage({ target: 'sw', type: 'start', crop, pageDpr: devicePixelRatio });
    if (!res?.ok) alert(`無法開始錄影：${res?.error || '未知錯誤'}`);
  }

  async function savePreset() {
    const crop = cropRatio();
    if (!crop) {
      msgEl.textContent = '請先框出範圍';
      return;
    }
    const res = await chrome.runtime.sendMessage({ target: 'sw', type: 'savePreset', name: $('.name').value, crop });
    msgEl.textContent = res?.ok ? `已${res.replaced ? '更新' : '儲存'}「${res.name}」` : `儲存失敗：${res?.error}`;
  }

  function onKey(e) {
    const inInput = e.composedPath()[0] === $('.name');
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') inInput ? savePreset() : startRecording();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  $('.start').addEventListener('click', startRecording);
  $('.save').addEventListener('click', savePreset);
  $('.cancel').addEventListener('click', close);
  // 不讓網頁自己的快捷鍵吃掉名稱欄位的輸入
  $('.name').addEventListener('keydown', (e) => e.stopPropagation());
  addEventListener('keydown', onKey, true);

  const api = { close };
  window.__tabRecOverlay = api;
  document.documentElement.appendChild(host);
  render();
}
