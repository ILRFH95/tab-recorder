// OPFS 寫檔 worker。所有操作依序排隊執行，確保同一個檔案的寫入順序正確。
const handles = new Map();
const rootPromise = navigator.storage.getDirectory();
let queue = Promise.resolve();

self.onmessage = (e) => {
  queue = queue.then(() => run(e.data));
};

async function run({ id, op, name, buf }) {
  try {
    if (op === 'open') {
      if (handles.has(name)) throw new Error(`檔案已在使用中：${name}`);
      const root = await rootPromise;
      const fh = await root.getFileHandle(name, { create: true });
      const h = await fh.createSyncAccessHandle();
      if (h.getSize() > 0) {
        // 絕不覆寫既有的錄影
        h.close();
        throw new Error(`檔案已存在：${name}`);
      }
      handles.set(name, h);
    } else if (op === 'write') {
      const h = handles.get(name);
      if (!h) throw new Error(`檔案未開啟：${name}`);
      // write() 可能只寫入一部分，要寫到全部寫完為止
      const data = new Uint8Array(buf);
      let offset = 0;
      while (offset < data.length) {
        const n = h.write(data.subarray(offset), { at: h.getSize() });
        if (!n) throw new Error('寫入了 0 位元組（硬碟可能已滿）');
        offset += n;
      }
      h.flush();
    } else if (op === 'close') {
      const h = handles.get(name);
      if (h) {
        handles.delete(name);
        try {
          h.flush();
        } finally {
          h.close();
        }
      }
    }
    self.postMessage({ id });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
}
