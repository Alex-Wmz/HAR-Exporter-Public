// Save only locally assembled Blobs. Never request the resource URL again.
(function (global) {
  'use strict';
  async function save(blob, filename, api = global.chrome, urls = global.URL) {
    if (!filename || /[\x00-\x1f\\/:*?"<>|]/.test(filename) || /[. ]$/.test(filename)) throw new Error('无效导出文件名');
    const url = urls.createObjectURL(blob), early = new Map();
    let id, listener, resolveDone, rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    done.catch(() => {});
    const check = (downloadId, value) => {
      if (downloadId !== id) { if (id === undefined && early.size < 32) early.set(downloadId, value); return; }
      if (value.state === 'complete') resolveDone();
      if (value.state === 'interrupted' || value.error) rejectDone(new Error('保存已取消或中断'));
    };
    try {
      listener = (d) => check(d.id, { state: d.state?.current, error: d.error?.current });
      api.downloads.onChanged.addListener(listener);
      id = await api.downloads.download({ url, filename: `HARResources/${filename}`, saveAs: true, conflictAction: 'uniquify' });
      if (!Number.isInteger(id)) throw new Error('浏览器未创建保存任务');
      if (early.has(id)) check(id, early.get(id));
      const [item] = await api.downloads.search({ id });
      if (item) check(id, item);
      await done;
      return { id, filename };
    } finally {
      if (listener) api.downloads.onChanged.removeListener(listener);
      urls.revokeObjectURL(url);
    }
  }
  async function batch(rows, getBody, onProgress = () => {}, saveBlob = save) {
    const limits = global.HarResources.LIMITS;
    if (!rows.length || rows.length > limits.batchFiles) throw new Error(`每批请选择 1-${limits.batchFiles} 个资源`);
    if (rows.some((r) => !r.available)) throw new Error('所选资源中有未保留完整正文的条目');
    if (rows.reduce((n, r) => n + Math.max(0, r.size), 0) > limits.batchBytes) throw new Error('每批正文最多 32 MiB');
    const completed = [];
    let bytes = 0;
    for (const row of rows) {
      try {
        onProgress({ completed: completed.length, total: rows.length, row });
        const value = await getBody(row.id);
        bytes += value.bytes;
        if (bytes > limits.batchBytes) throw new Error('每批正文最多 32 MiB');
        const blob = global.HarResources.toBlob(value);
        await saveBlob(blob, value.filename);
        completed.push(row.id);
      } catch (error) { return { completed, failedId: row.id, error: error.message }; }
    }
    return { completed };
  }
  global.HarResourceExport = Object.freeze({ save, batch });
})(self);
