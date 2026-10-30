import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadCapture, request, response, finish, flush, createHarness, emitRequest } from './harness.mjs';
const require = createRequire(import.meta.url);
const firefox = require('../../har-exporter-firefox/test/harness.cjs');

test('shared policy stays byte-identical between the standalone packages', () => {
  assert.deepEqual(readFileSync(new URL('../payload-policy.js', import.meta.url)), readFileSync(new URL('../../har-exporter-firefox/payload-policy.js', import.meta.url)));
});
test('Chrome and Firefox keep the same late API after resource saturation', async () => {
  const rows = [
    { id: 'script1', type: 'Script', mime: 'application/javascript', body: 'x'.repeat(190) },
    { id: 'script2', type: 'Script', mime: 'application/javascript', body: 'x'.repeat(50) },
    { id: 'search', type: 'XHR', mime: 'application/json', method: 'POST', post: '{"date":"2030-01-01"}', body: '{"flights":[]}' },
    { id: 'followup', type: 'Fetch', mime: 'application/json', body: '{"ok":true}' },
  ];
  const c = loadCapture({ maxTotalBytes: 800 }, async (src, method, p) => ({ body: rows.find((r) => r.id === p.requestId).body }));
  const f = firefox.setup({ maxTotal: 800, maxBuffered: 1000 });
  for (const r of rows) {
    request(c, r.id, { tabId: 1 }, { method: r.method || 'GET', postData: r.post });
    response(c, r.id, { tabId: 1 }, { mimeType: r.mime }); finish(c, r.id); await flush();
    const row = f.begin({ id: r.id, type: r.type === 'Script' ? 'script' : 'xmlhttprequest', mime: r.mime, method: r.method || 'GET', post: r.post });
    f.chunk(row, r.body); f.end(row);
  }
  const project = (entries) => Array.from(entries, ({ data }) => ({ post: data.request.postData?.text, body: data.response.content.text, skipped: data._bodySkipped }));
  assert.deepEqual(project(c.entries), project(f.capture.entries));
  assert.equal(c.summary().nonEmptyApiBody, 2); assert.equal(c.summary().lostResponseBodies, 1);
  assert.deepEqual(c.summary().budget, JSON.parse(JSON.stringify(f.capture.budget.snapshot())));
});
test('request bodies remain available after all response space is used', async () => {
  const c = loadCapture({ maxTotalBytes: 800 }, async () => ({ body: 'x'.repeat(700) }));
  request(c); response(c); finish(c); await flush();
  request(c, 'post', { tabId: 1 }, { method: 'POST', postData: 'p'.repeat(100) });
  assert.equal(c.entries[1].data.request.postData.text.length, 100);
  request(c, 'post2', { tabId: 1 }, { method: 'POST', postData: 'x' });
  assert.equal(c.entries[2].data._postDataSkipped, 'request-payload-limit'); assert.equal(c.retainedBytes, 800);
});
test('body retrieval failure appears in live and saved summaries', async () => {
  const h = createHarness({ command: async (s, method) => { if (method === 'Network.getResponseBody') throw new Error('test unavailable'); } });
  const badges = []; h.chrome.action.setBadgeText = async ({text}) => badges.push(text);
  await h.startRecording(1); emitRequest(h.L, 1, 'bad', 'https://example.test/api'); await flush();
  assert.equal(h.status().stats.lostResponseBodies, 1);
  await new Promise((r) => setTimeout(r, 180)); assert.equal(badges.at(-1), '!');
  const saved = await h.stopRecording(); assert.equal(saved.ok, true); assert.equal(saved.lostResponseBodies, 1);
  assert.equal(h.writes[0].har.log._capture.responseLossReasons['unavailable-or-timeout'], 1);
  assert.ok(saved.warnings.includes('body-data-missing'));
});
test('HTTP completed and incomplete=0 cannot hide per-body omission', async () => {
  const c = loadCapture({ maxBodyBytes: 3 }, async () => ({ body: '1234' }));
  request(c); response(c); finish(c); await flush(); c.freeze();
  const stats = c.build([], '1.4.3', 'test').har.log._capture;
  assert.equal(stats.incomplete, 0); assert.equal(stats.lostResponseBodies, 1); assert.equal(stats.captureLimited, true);
});
test('resource type and JSON MIME identify APIs without airline-specific hosts', async () => {
  const self = {};
  new Function('self', readFileSync(new URL('../payload-policy.js', import.meta.url), 'utf8'))(self);
  const classify = (method, mimeType, _resourceType) => self.HarPayload.responseClass({ request: { method }, response: { content: { mimeType } }, _resourceType });
  assert.equal(classify('GET', 'application/problem+json', 'Other'), 'api');
  assert.equal(classify('GET', 'text/plain', 'XHR'), 'api');
  assert.equal(classify('GET', 'application/javascript', 'Fetch'), 'resource');
  assert.equal(classify('POST', 'text/html', 'Document'), 'document');
  assert.equal(classify('GET', 'image/svg+xml', 'Image'), 'resource');
});
test('default quotas reserve 8 MiB requests and at least 40 MiB APIs', () => {
  const c = loadCapture(); const b = c.summary().budget; const MiB = 1024 * 1024;
  assert.equal(b.requestLimitBytes, 8 * MiB); assert.equal(b.resourceLimitBytes, 16 * MiB);
  assert.equal(b.responseLimitBytes - b.resourceLimitBytes, 40 * MiB);
});
test('default budgets survive 50 MiB static traffic followed by 30 MiB API data', async () => {
  const MiB = 1024 * 1024;
  const script = '//'+ 'x'.repeat(2 * MiB - 2);
  const json = JSON.stringify({ value: 'x'.repeat(3 * MiB - 12) });
  const c = loadCapture({}, async (src, method, p) => ({ body: p.requestId.startsWith('s') ? script : json }));
  const f = firefox.setup();
  for (let i = 0; i < 35; i++) {
    const isScript = i < 25; const id = (isScript ? 's' : 'a') + i;
    const body = isScript ? script : json; const mime = isScript ? 'application/javascript' : 'application/json';
    const post = isScript ? undefined : '{"query":"synthetic"}';
    request(c, id, { tabId: 1 }, { method: post ? 'POST' : 'GET', postData: post });
    response(c, id, { tabId: 1 }, { mimeType: mime }); finish(c, id); await flush();
    const row = f.begin({ id, mime, type: isScript ? 'script' : 'xmlhttprequest', method: post ? 'POST' : 'GET', post });
    // Real response streams are chunked; all chunks still reach the page.
    for (let offset = 0; offset < body.length; offset += 256 * 1024) {
      if (!row.f.disconnected) f.chunk(row, body.slice(offset, offset + 256 * 1024));
    }
    f.end(row); row.f.written.length = 0;
  }
  for (const stats of [c.summary(), f.capture.summary()]) {
    assert.equal(stats.count, 35); assert.equal(stats.nonEmptyApiBody, 10); assert.equal(stats.lostRequestBodies, 0);
    assert.equal(stats.lostResponseBodies, 17); assert.equal(stats.budget.resourceBytes, 16 * MiB);
    assert.ok(stats.budget.apiBytes >= 29 * MiB); assert.ok(stats.budget.retainedBytes <= 64 * MiB);
  }
  assert.equal(f.capture.buffered, 0); assert.equal(f.capture.resourceBuffered, 0);
});
