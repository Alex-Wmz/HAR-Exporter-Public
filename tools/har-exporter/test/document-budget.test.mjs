import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadCapture, request, finish, flush } from './harness.mjs';

const require = createRequire(import.meta.url);
const firefox = require('../../har-exporter-firefox/test/harness.cjs');
const policy = {};
new Function('self', readFileSync(new URL('../payload-policy.js', import.meta.url), 'utf8'))(policy);

const entry = (type, mime, method = 'GET') => ({ request: { method },
  response: { content: { mimeType: mime } }, _resourceType: type });

test('HTML navigations are separate from scripts and API responses across browsers', () => {
  for (const type of ['Document', 'main_frame', 'sub_frame']) {
    for (const mime of ['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml']) {
      assert.equal(policy.HarPayload.responseClass(entry(type, mime)), 'document');
      assert.equal(policy.HarPayload.responseClass(entry(type, mime, 'POST')), 'document');
    }
  }
  assert.equal(policy.HarPayload.responseClass(entry('XHR', 'text/html')), 'api');
  assert.equal(policy.HarPayload.responseClass(entry('Fetch', 'application/javascript')), 'resource');
  assert.equal(policy.HarPayload.responseClass(entry('Document', 'application/json')), 'api');
  assert.equal(policy.HarPayload.responseClass(entry('Image', 'image/svg+xml')), 'resource');
});

test('Chrome and Firefox retain 3.4 MB search HTML after 16 MiB scripts fill ordinary space', async () => {
  const MiB = 1024 * 1024;
  const rows = [
    { id: 'script1', type: 'Script', ff: 'script', mime: 'application/javascript', body: 's'.repeat(8 * MiB) },
    { id: 'script2', type: 'Script', ff: 'script', mime: 'application/javascript', body: 's'.repeat(8 * MiB) },
    { id: 'overflow', type: 'Script', ff: 'script', mime: 'application/javascript', body: 's'.repeat(MiB) },
    { id: 'search', type: 'Document', ff: 'main_frame', mime: 'text/html', body: '<html><body>' + 'x'.repeat(3400000) + '</body></html>' },
    { id: 'fares', type: 'Fetch', ff: 'xmlhttprequest', mime: 'application/json', body: '{"flights":[{"price":123.45}]}' },
  ];
  const c = loadCapture({}, async (source, method, params) => ({ body: rows.find(r => r.id === params.requestId).body }));
  const f = firefox.setup();
  for (const row of rows) {
    request(c, row.id);
    c.handle({ tabId: 1 }, 'Network.responseReceived', { requestId: row.id, type: row.type,
      response: { status: 200, headers: {}, mimeType: row.mime }, hasExtraInfo: false, timestamp: 2 });
    finish(c, row.id); await flush();
    const r = f.begin({ id: row.id, type: row.ff, mime: row.mime });
    for (let n = 0; n < row.body.length; n += 256 * 1024) {
      if (!r.f.disconnected) f.chunk(r, row.body.slice(n, n + 256 * 1024));
    }
    f.end(r); r.f.written.length = 0;
  }
  for (const entries of [c.entries, f.capture.entries]) {
    assert.equal(entries[2].data._bodySkipped, 'resource-payload-limit');
    assert.equal(entries[3].data.response.content.text, rows[3].body);
    assert.equal(entries[3].data._bodySkipped, undefined);
    assert.equal(entries[4].data.response.content.text, rows[4].body);
  }
  for (const stats of [c.summary(), f.capture.summary()]) {
    assert.equal(stats.budget.resourceBytes, 16 * MiB);
    assert.equal(stats.budget.documentBytes, Buffer.byteLength(rows[3].body));
    assert.equal(stats.nonEmptyDocumentBody, 1);
    assert.equal(stats.documentRequests, 1);
    assert.equal(stats.nonEmptyApiBody, 1);
    assert.equal(stats.lostResponseBodies, 1); // rejected script remains explicitly reported
    assert.ok(stats.budget.retainedBytes <= 64 * MiB);
    assert.match(policy.HarPayload.describe(stats).budget, /网页正文/);
  }
  assert.equal(f.capture.buffered, 0);
  assert.equal(f.capture.resourceBuffered, 0);
});

test('navigation priority still obeys shared response and request limits', () => {
  const b = new policy.HarPayload.PayloadBudget(800);
  assert.equal(b.reserve('resource', 200), null);
  assert.equal(b.reserve('document', 500), null);
  assert.equal(b.reserve('document', 1), 'total-payload-limit');
  assert.equal(b.reserve('api', 1), 'total-payload-limit');
  assert.equal(b.reserve('post', 100), null);
  assert.equal(b.reserve('post', 1), 'request-payload-limit');
  assert.equal(b.retained, 800);
  assert.equal(b.snapshot().documentBytes, 500);
});

test('empty, missing and nonempty document bodies are counted separately with UTF-8 bytes', () => {
  const b = new policy.HarPayload.PayloadBudget(80);
  const make = (text, more = {}) => ({ ...entry('Document', 'text/html'),
    response: { status: 200, content: { mimeType: 'text/html', ...(text === undefined ? {} : { text }) } }, ...more });
  b.reserve('document', policy.HarPayload.bytes('中文'));
  const stats = policy.HarPayload.summarize([make('中文'), make(''), make(undefined, { _bodySkipped: 'per-body-limit' })], b, []);
  assert.equal(stats.documentRequests, 3);
  assert.equal(stats.nonEmptyDocumentBody, 1);
  assert.equal(stats.apiRequests, 0);
  assert.equal(stats.lostResponseBodies, 1);
  assert.equal(stats.budget.documentBytes, 6);
});
