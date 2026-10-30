import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, emitRequest, flush } from './harness.mjs';

const self = { URL, Blob };
new Function('self', readFileSync(new URL('../resources.js', import.meta.url), 'utf8'))(self);
new Function('self', readFileSync(new URL('../resource-export.js', import.meta.url), 'utf8'))(self);
const R = self.HarResources, E = self.HarResourceExport;
function entry({ url = 'https://example.test/file.pdf', mime = 'application/pdf', text = 'PDF', encoding,
  size, status = 200, tabId = 1, sessionId = '', extra = {}, method = 'GET', headers = [], requestHeaders = [] } = {}) {
  const e = { done: true, tabId, chain: { source: { tabId, sessionId }, hops: [] },
    data: { request: { url, method, headers: requestHeaders }, response: { status, headers,
      content: { mimeType: mime, size: size ?? (encoding === 'base64' ? Buffer.from(text || '', 'base64').length : Buffer.byteLength(text || '')),
        ...(text === undefined ? {} : { text }), ...(encoding ? { encoding } : {}) } }, ...extra } };
  e.chain.hops.push(e); return e;
}
const message = (h, msg, url = h.chrome.runtime.getURL('resources.html')) => new Promise((resolve) => h.L.message(msg, { id: 'test-extension', url }, resolve));

test('resource classification distinguishes documents, playlists, segments and active page code', () => {
  for (const [mime, url, kind] of [
    ['image/png', '/photo', 'image'], ['audio/mpeg', '/song', 'audio'], ['video/mp4', '/movie', 'video'],
    ['application/pdf', '/report', 'document'], ['application/octet-stream', '/file.docx', 'document'],
    ['application/dash+xml', '/stream', 'playlist'], ['text/plain', '/video.m3u8', 'playlist'],
    ['video/mp2t', '/segment', 'segment'], ['audio/mp4', '/part.m4s', 'segment'],
    ['application/json', '/api', null], ['text/html', '/fake.pdf', null], ['application/javascript', '/fake.png', null],
    ['text/css', '/fake.jpg', null], ['application/octet-stream', '/program.exe', null],
  ]) assert.equal(R.kind(entry({ mime, url: 'https://example.test' + url })), kind);
  assert.equal(R.kind(entry({ url: 'file:///C:/private.pdf' })), null);
});

test('index and manifest expose only whitelisted metadata with query values, URL credentials and fragment masked', () => {
  const e = entry({ url: 'https://account:password@example.test/file.pdf?token=SECRET&a=PRIVATE#fragment-secret',
    requestHeaders: [{ name: 'Cookie', value: 'cookie-secret' }, { name: 'Authorization', value: 'auth-secret' }], text: 'BODY_SECRET' });
  const result = R.index([e]);
  const serialized = JSON.stringify([result, R.manifest(result.rows)]);
  for (const secret of ['account:', 'password', 'SECRET', 'PRIVATE', 'fragment-secret', 'cookie-secret', 'auth-secret']) assert.ok(!serialized.includes(secret), secret);
  assert.match(result.rows[0].url, /token=\[hidden\]/);
  assert.equal(result.rows[0].filename, 'file.pdf');
  assert.equal(result.rows[0].available, true);
});

test('projection and folding do not mutate HAR entries or discard any original request', () => {
  const entries = [entry(), entry(), entry({ tabId: 2 })], before = structuredClone(entries);
  const rows = R.index(entries).rows;
  const folded = R.filter(rows, { collapse: true });
  assert.equal(folded.length, 2); assert.equal(folded[0].duplicateCount, 2);
  assert.deepEqual(folded[0].members, ['0', '1']); assert.equal(R.filter(rows).length, 3);
  assert.deepEqual(entries, before);
});

test('folding never merges different signed URLs, tabs, sessions, ranges, statuses or redirect hops', () => {
  const a = entry({ url: 'https://example.test/file.pdf?token=first' });
  const b = entry({ url: 'https://example.test/file.pdf?token=second' });
  const rows = R.index([a, b, entry({ url: a.data.request.url, tabId: 2 }), entry({ url: a.data.request.url, sessionId: 'frame' }),
    entry({ url: a.data.request.url, requestHeaders: [{ name: 'Range', value: 'bytes=10-' }] }), entry({ url: a.data.request.url, status: 206 })]).rows;
  assert.equal(rows[0].url, rows[1].url); assert.equal(R.filter(rows, { collapse: true }).length, 6);
  const first = entry(), last = entry(); last.chain = first.chain; first.chain.hops.push(last);
  assert.deepEqual(R.index([first, last]).rows.map((r) => r.hop), [0, 1]);
  assert.equal(R.filter(R.index([first, last]).rows, { collapse: true }).length, 2);
  assert.equal(R.filter(R.index([entry({ text: 'one' }), entry({ text: 'two' })]).rows, { collapse: true }).length, 2);
  assert.equal(R.filter(R.index([
    entry({ status: 206, headers: [{ name: 'Content-Range', value: 'bytes 0-2/6' }] }),
    entry({ status: 206, headers: [{ name: 'Content-Range', value: 'bytes 3-5/6' }] }),
  ]).rows, { collapse: true }).length, 2);
});

test('filters combine type, text, availability and byte limits without treating unknown size as zero', () => {
  const rows = R.index([entry({ size: -1 }), entry({ url: 'https://example.test/empty.pdf', text: '', size: 0 }),
    entry({ url: 'https://example.test/photo.png', mime: 'image/png', size: 2048 }), entry({ extra: { _bodySkipped: 'media-filter' } })]).rows;
  assert.equal(R.filter(rows, { minBytes: 0, maxBytes: 0 }).length, 1);
  assert.equal(R.filter(rows, { minBytes: 1024, kind: 'image', query: 'photo', availableOnly: true }).length, 1);
  assert.equal(R.filter(rows, { availableOnly: true }).length, 3);
  assert.throws(() => R.filter(rows, { minBytes: -1 }));
  assert.throws(() => R.filter(rows, { minBytes: 2, maxBytes: 1 }));
});

test('missing, incomplete, redirected, partial, filtered and failed bodies are never exported as full files', () => {
  const cases = [
    entry({ status: 206 }), entry({ headers: [{ name: 'Content-Range', value: 'bytes 0-2/50' }] }),
    entry({ extra: { _bodySkipped: 'media-filter' } }), entry({ extra: { _incomplete: 'timeout' } }),
    entry({ extra: { _bodyError: 'unavailable' } }), entry({ status: 302 }), entry({ status: 404 }),
    entry({ status: 204 }), entry({ status: 304 }), entry({ method: 'HEAD' }),
  ];
  const missing = entry(); delete missing.data.response.content.text; cases.push(missing);
  const pending = entry(); pending.bodyPending = true; cases.push(pending);
  for (const e of cases) { assert.equal(R.bodyState(e).available, false); assert.throws(() => R.body(e, '0')); }
});

test('binary bytes and UTF-8 text export faithfully from captured bodies, with no URL replay', async () => {
  const bytes = Uint8Array.from([0, 255, 1, 127, 128]);
  const binary = R.body(entry({ text: Buffer.from(bytes).toString('base64'), encoding: 'base64' }), '0');
  assert.deepEqual(new Uint8Array(await R.toBlob(binary).arrayBuffer()), bytes);
  const text = R.body(entry({ text: '中文\u0000\u{1f600}' }), '1');
  assert.equal(await R.toBlob(text).text(), '中文\u0000\u{1f600}');
  assert.equal(text.bytes, Buffer.byteLength(text.text));
  assert.equal(R.kind(entry({ url: 'https://example.test/part.ts', mime: 'video/mp2t' })), 'segment');
});

test('body validation rejects invalid base64, unsupported encoding and oversized text', () => {
  for (const text of ['!!', 'YQ', 'YR==', 'YQ==\n']) assert.throws(() => R.body(entry({ text, encoding: 'base64' }), '0'));
  assert.throws(() => R.body(entry({ encoding: 'gzip' }), '0'));
  assert.throws(() => R.body(entry({ text: 'x'.repeat(R.LIMITS.bodyBytes + 1), size: 0 }), '0'), /上限/);
  assert.throws(() => R.toBlob({ text: 'abc', bytes: 1, encoding: 'utf8' }), /长度/);
});

test('resource metadata budget and row limit only truncate the resource view, not capture data', () => {
  const entries = Array.from({ length: 30 }, (_, i) => entry({ url: `https://example.test/${i}.pdf` }));
  const a = R.index(entries, { maxRows: 3 }); assert.equal(a.rows.length, 3); assert.equal(a.omitted, 27);
  const b = R.index(entries, { maxMetadataBytes: 700 }); assert.ok(b.metadataBytes <= 700); assert.ok(b.omitted > 0);
  assert.equal(entries.length, 30); assert.equal(entries[29].data.response.content.text, 'PDF');
});

test('filenames block path traversal, reserved Windows names, control and bidi characters', () => {
  for (const raw of ['../CON.exe', '%2e%2e%2fAUX.exe', 'file%5Cname.pdf', 'a%00b.pdf', 'a%E2%80%AEb.pdf']) {
    const name = R.filename(entry({ url: 'https://example.test/' + raw }), '0');
    assert.ok(!/[\\/:\x00-\x1f\u202a-\u202e]/.test(name)); assert.match(name, /\.pdf$/);
    assert.ok(!/^(CON|AUX)\./i.test(name));
  }
});

function downloader(mode = 'complete') {
  const callbacks = new Set(), revoked = [], specs = [];
  const chrome = { downloads: { onChanged: { addListener: (x) => callbacks.add(x), removeListener: (x) => callbacks.delete(x) },
    download: async (spec) => { specs.push(spec); for (const cb of callbacks) { cb({ id: 99, state: { current: 'interrupted' } }); cb({ id: 7, state: { current: mode } }); } return 7; },
    search: async () => [{ id: 7, state: mode }],
  } };
  const urls = { createObjectURL: () => 'blob:synthetic-only', revokeObjectURL: (url) => revoked.push(url) };
  return { chrome, urls, callbacks, revoked, specs };
}
test('local export waits for its own completion and releases Blob URLs and listeners', async () => {
  const h = downloader(); const result = await E.save(new Blob(['PDF']), 'file.pdf', h.chrome, h.urls);
  assert.equal(result.id, 7); assert.equal(h.specs[0].url, 'blob:synthetic-only');
  assert.equal(h.specs[0].saveAs, true); assert.equal(h.specs[0].conflictAction, 'uniquify');
  assert.equal(h.callbacks.size, 0); assert.deepEqual(h.revoked, ['blob:synthetic-only']);
});
test('cancelled local save reports failure, cleans up and never accepts dangerous downloads', async () => {
  const h = downloader('interrupted');
  await assert.rejects(E.save(new Blob(['PDF']), 'file.pdf', h.chrome, h.urls), /取消|中断/);
  assert.equal(h.callbacks.size, 0); assert.equal(h.revoked.length, 1);
  await assert.rejects(E.save(new Blob(), '../file.pdf', h.chrome, h.urls), /文件名/);
});
test('batch export is sequential, preserves completed files and stops on cancellation without retry', async () => {
  const rows = R.index([entry(), entry(), entry()]).rows, calls = [];
  const result = await E.batch(rows, async (id) => R.body(entry(), id), () => {}, async () => {
    calls.push('save'); if (calls.length === 2) throw new Error('cancel');
  });
  assert.deepEqual(result.completed, ['0']); assert.equal(result.failedId, '1'); assert.equal(calls.length, 2);
  await assert.rejects(E.batch(Array(11).fill(rows[0]), async () => { throw new Error('must not call'); }), /每批/);
  await assert.rejects(E.batch([{ ...rows[0], size: 33 * 1024 * 1024 }], async () => {}), /32 MiB/);
});

test('resource APIs require the exact own extension page and never return headers or replay requests', async () => {
  const h = createHarness({ command: async (source, method) => method === 'Network.getResponseBody' ? { body: 'JVBERg==', base64Encoded: true } : undefined });
  await h.startRecording(1); emitRequest(h.L, 1, 'pdf', 'https://example.test/file.pdf?token=SECRET', { response: { mimeType: 'application/pdf' } }); await flush();
  const before = JSON.stringify(h.buildHar()); const commands = h.commands.length;
  const list = await message(h, { type: 'getResources' }); assert.equal(list.rows.length, 1); assert.ok(!JSON.stringify(list).includes('SECRET'));
  const body = await message(h, { type: 'getResourceBody', generation: list.generation, id: '0', url: 'https://not-requested.test' });
  assert.equal(body.body.text, 'JVBERg=='); assert.equal(body.body.filename, 'file.pdf'); assert.equal(h.commands.length, commands);
  assert.equal(JSON.stringify(h.buildHar()), before); assert.equal(h.writes.length, 0);
  for (const url of ['https://example.test/', h.chrome.runtime.getURL('popup.html'), h.chrome.runtime.getURL('resources.html') + '?other']) {
    assert.equal((await message(h, { type: 'getResourceBody', generation: list.generation, id: '0' }, url)).ok, false);
  }
  for (const id of ['-1', '00', 'NaN', '__proto__', '100000', '9999']) assert.equal((await message(h, { type: 'getResourceBody', generation: list.generation, id })).ok, false);
  await h.stopRecording(false);
});

test('successful HAR save still clears capture and recent-export behavior remains unchanged', async () => {
  const h = createHarness(); await h.startRecording(1);
  emitRequest(h.L, 1, 'pdf', 'https://example.test/file.pdf', { response: { mimeType: 'application/pdf' } }); await flush();
  const list = await message(h, { type: 'getResources' });
  const saved = await h.stopRecording(); assert.equal(saved.ok, true); assert.equal(h.state.capture, null);
  assert.equal((await message(h, { type: 'getResources' })).rows.length, 0);
  assert.equal((await message(h, { type: 'getResourceBody', generation: list.generation, id: '0' })).ok, false);
  assert.equal(h.writes.length, 1); assert.ok(h.stored.some((x) => x.k === 'lastSuccessfulExport'));
});

test('stale resource generation cannot read a new recording under the same row ID', async () => {
  const h = createHarness(); await h.startRecording(1);
  emitRequest(h.L, 1, 'a', 'https://example.test/a.pdf', { response: { mimeType: 'application/pdf' } }); await flush();
  const old = await message(h, { type: 'getResources' }); await h.stopRecording(false); await h.startRecording(1);
  emitRequest(h.L, 1, 'b', 'https://example.test/b.pdf', { response: { mimeType: 'application/pdf' } }); await flush();
  assert.equal((await message(h, { type: 'getResourceBody', generation: old.generation, id: '0' })).ok, false);
  await h.stopRecording(false);
});
