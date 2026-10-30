import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, emitRequest } from './harness.mjs';
const scope = {};
new Function('self', readFileSync(new URL('../recent-export.js', import.meta.url), 'utf8'))(scope);
const recent = scope.HarRecent;

async function capture(h) {
  await h.startRecording(1);
  emitRequest(h.L, 1, 'r', 'https://example.test/private', { request: { headers: { Cookie: 'SYNTHETIC-SECRET' } } });
  return h.stopRecording();
}

test('successful Save As remembers actual renamed path and id across background restarts, without payload', async () => {
  const settings = new Map();
  const h = createHarness({ settings, download: async (spec, json, L, items) => {
    items.set(12, { id: 12, state: 'complete', filename: '/synthetic/export/renamed.har' });
    return 12;
  } });
  const res = await capture(h);
  assert.equal(res.filename, 'renamed.har');
  const again = createHarness({ settings });
  const item = await again.HarFs.getSetting(recent.KEY);
  assert.equal(item.fullPath, '/synthetic/export/renamed.har');
  assert.equal(item.downloadId, 12);
  assert.equal(item.filename, 'renamed.har');
  assert.ok(item.savedAt > 0);
  assert.equal(JSON.stringify(item).includes('SYNTHETIC-SECRET'), false);
  assert.deepEqual(Object.keys(item).sort(), ['downloadId', 'filename', 'fullPath', 'method', 'savedAt']);
});

test('folder save references original folder even if selected target later changes', async () => {
  const h = createHarness({ target: { mode: 'folder', folderId: 'first' }, folder: { id: 'first', name: 'HAR', handle: {} } });
  const res = await capture(h);
  assert.equal(res.recentExport.method, 'folder');
  assert.equal(res.recentExport.folderId, 'first');
  assert.equal(res.recentExport.folderName, 'HAR');
  assert.equal(res.recentExport.fullPath, undefined);
  assert.equal(res.recentExport.handle, undefined);
});

test('cancelled download preserves previous successful record and retry data', async () => {
  const previous = { method: 'downloads', filename: 'previous.har', savedAt: 1, downloadId: 4 };
  const settings = new Map([[recent.KEY, previous]]);
  const h = createHarness({ settings, download: async () => { throw new Error('cancelled'); } });
  const res = await capture(h);
  assert.equal(res.ok, false);
  assert.equal(h.state.phase, 'ready');
  assert.deepEqual(settings.get(recent.KEY), previous);
});

test('metadata failure after successful file write does not invite duplicate export', async () => {
  const h = createHarness({ setSetting: async () => { throw new Error('storage unavailable'); } });
  const res = await capture(h);
  assert.equal(res.ok, true);
  assert.equal(h.state.phase, 'idle');
  assert.equal(h.writes.length, 1);
  assert.match(res.locationWarning, /文件已保存/);
  assert.equal((await h.stopRecording()).ok, false);
});

test('folder write failure followed by Save As remembers actual download, not original folder', async () => {
  const h = createHarness({ target: { mode: 'folder', folderId: 'old' }, folder: { id: 'old', name: 'HAR', handle: {} },
    write: async () => { throw new Error('not writable'); } });
  const res = await capture(h);
  assert.equal(res.method, 'downloads');
  assert.equal(res.recentExport.folderId, undefined);
  assert.equal(res.recentExport.downloadId, 1);
  assert.equal(res.fallbackReason, 'write-failed');
});

test('file chooser is invoked synchronously with original handle and does not read selected content', async () => {
  const handle = { kind: 'directory', name: 'HAR' };
  let called = false;
  const done = recent.browseFolder(handle, { showOpenFilePicker: (opts) => {
    called = true;
    assert.equal(opts.startIn, handle);
    assert.equal(opts.multiple, false);
    return Promise.resolve([{ getFile: () => { throw new Error('must not read'); } }]);
  } });
  assert.equal(called, true, 'must preserve click activation');
  assert.equal(await done, true);
});

test('chooser cancellation is normal; removed or invalid folder is explicit without fallback', async () => {
  assert.equal(await recent.browseFolder({}, { showOpenFilePicker: async () => { throw { name: 'AbortError' }; } }), false);
  await assert.rejects(recent.browseFolder(null, {}), /已从列表移除/);
  await assert.rejects(recent.browseFolder({}, {}), /不支持/);
  await assert.rejects(recent.browseFolder({}, { showOpenFilePicker: async () => { throw { name: 'NotAllowedError' }; } }), /权限失效/);
});

test('download reveal uses only saved id, checks missing/deleted/unrelated entries, never downloads again', async () => {
  const shown = [];
  let item = { id: 4, state: 'complete', exists: true, byExtensionId: 'own' };
  const api = { runtime: { id: 'own' }, downloads: {
    search: async (query) => { assert.deepEqual(query, { id: 4 }); return item ? [item] : []; },
    show: async (id) => shown.push(id),
    download: () => { throw new Error('must not redownload'); },
  } };
  await recent.showDownload({ downloadId: 4 }, api);
  assert.deepEqual(shown, [4]);
  item.exists = false;
  await assert.rejects(recent.showDownload({ downloadId: 4 }, api), /移动或删除/);
  item = { state: 'complete', byExtensionId: 'other' };
  await assert.rejects(recent.showDownload({ downloadId: 4 }, api), /下载记录已清除/);
  item = null;
  await assert.rejects(recent.showDownload({ downloadId: 4 }, api), /下载记录已清除/);
  assert.deepEqual(shown, [4]);
});
