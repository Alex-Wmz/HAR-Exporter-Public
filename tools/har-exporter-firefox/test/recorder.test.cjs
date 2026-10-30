const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function setup(options = {}) {
  const filters = [];
  const api = { webRequest: { filterResponseData() {
    const f = { written: [], closed: false, disconnected: false, write(data) { this.written.push(new Uint8Array(data)); }, close() { this.closed = true; }, disconnect() { this.disconnected = true; } };
    filters.push(f); return f;
  } } };
  const ctx = { TextEncoder, TextDecoder, Uint8Array, URL, btoa, setTimeout };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '../payload-policy.js'), 'utf8'), ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '../recorder.js'), 'utf8'), ctx);
  const capture = new ctx.FirefoxCapture(api, options);
  const before = (extra = {}) => capture.before({ requestId: '1', tabId: 1, url: 'https://example.test/api?a=1', method: 'GET', timeStamp: 1000, type: 'xmlhttprequest', ...extra });
  const headers = (value = 'application/json; charset=utf-8', extra = {}) => capture.responseHeaders({ requestId: '1', timeStamp: 1100, statusCode: 200, statusLine: 'HTTP/2 200 OK', responseHeaders: [{ name: 'Content-Type', value }], ...extra });
  const chunk = (s, f = filters.at(-1)) => f.ondata({ data: new TextEncoder().encode(s).buffer });
  return { capture, filters, before, headers, chunk };
}
test('UTF-8 chunk boundaries, unchanged passthrough, and valid HAR', () => {
  const { capture:c, filters, before, headers } = setup(); before(); headers();
  const bytes = new TextEncoder().encode('{"name":"中文"}'), f = filters[0];
  f.ondata({ data: bytes.slice(0, 11).buffer }); f.ondata({ data: bytes.slice(11).buffer }); f.onstop();
  c.complete({ requestId: '1', timeStamp: 1200 }); c.freeze();
  const har = c.build(new Map([[1, { title: 'Test' }]]), 'user-stop');
  assert.equal(har.log.entries[0].response.content.text, '{"name":"中文"}');
  assert.deepEqual(Buffer.concat(f.written.map((x) => Buffer.from(x))), Buffer.from(bytes));
  assert.equal(f.closed, true); assert.equal(har.log.entries[0].time, 200);
});
test('redirect keeps each response separate', () => {
  const { capture:c, before, headers, chunk } = setup(); before(); headers('text/plain', { statusCode: 302 });
  c.complete({ requestId: '1', timeStamp: 1150, redirectUrl: 'https://example.test/next', statusCode: 302 }, true);
  before({ url: 'https://example.test/next', timeStamp: 1160 }); headers(); chunk('{}');
  assert.equal(c.entries.length, 2); assert.equal(c.entries[0].data.response.status, 302); assert.equal(c.entries[1].data.response.status, 200);
});
test('stop boundary does not record redirected continuation', () => {
  const { capture:c, before, headers } = setup(); before(); headers('text/plain', { statusCode: 302 }); c.accepting = false;
  c.complete({ requestId: '1', timeStamp: 1150, redirectUrl: 'https://example.test/next', statusCode: 302 }, true);
  before({ url: 'https://example.test/next' }); headers('text/plain');
  assert.equal(c.entries.length, 1); assert.equal(c.entries[0].data.response.status, 302);
});
test('binary response stays exact base64', () => {
  const { capture:c, filters, before, headers } = setup({ includeMedia: true }); before(); headers('application/octet-stream');
  filters[0].ondata({ data: new Uint8Array([0, 255, 128]).buffer }); filters[0].onstop();
  assert.equal(c.entries[0].data.response.content.text, 'AP+A'); assert.equal(c.entries[0].data.response.content.encoding, 'base64');
});
test('media and SSE detach filters without interrupting request', () => {
  for (const mime of ['image/png', 'text/event-stream']) {
    const { capture:c, filters, before, headers } = setup(); before(); headers(mime);
    assert.equal(filters[0].disconnected, true); assert.equal(filters[0].closed, false); assert.equal(c.filters.size, 0);
  }
});
test('body limit forwards final chunk then disconnects', () => {
  const { capture:c, filters, before, headers, chunk } = setup({ maxBody: 3 }); before(); headers(); chunk('1234');
  assert.equal(filters[0].written[0].length, 4); assert.equal(filters[0].disconnected, true);
  assert.equal(c.entries[0].data._bodySkipped, 'per-body-limit'); assert.equal(c.entries[0].chunks.length, 0);
});
test('total budget disconnects and frozen callbacks cannot add payload', () => {
  const { capture:c, filters, before, headers, chunk } = setup({ maxTotal: 5 }); before(); headers(); chunk('123456');
  assert.equal(c.entries[0].data._bodySkipped, 'total-payload-limit'); c.freeze(); filters[0].onstop();
  assert.equal(c.entries[0].data.response.content.text, undefined);
});
test('settle releases unfinished stream and marks incomplete', async () => {
  const { capture:c, filters, before, headers, chunk } = setup(); before(); headers(); chunk('unfinished'); await c.settle(1);
  assert.equal(filters[0].disconnected, true); assert.equal(c.entries[0].data._incomplete, 'stopped-before-completion');
  assert.equal(c.entries[0].data._bodySkipped, 'stop-wait-timeout');
});
test('request headers and JSON POST retained; uploaded path omitted', () => {
  const { capture:c, before } = setup();
  before({ method: 'POST', requestBody: { raw: [{ bytes: new TextEncoder().encode('{"ok":true}').buffer }, { file: 'PRIVATE-UPLOAD-PATH' }] } });
  c.requestHeaders({ requestId: '1', requestHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cookie', value: 'session=test-value' }] });
  assert.equal(c.entries[0].data.request.postData.text, '{"ok":true}');
  assert.equal(c.entries[0].data.request.cookies[0].value, 'test-value');
  assert.equal(JSON.stringify(c.build(new Map(), '')).includes('PRIVATE-UPLOAD-PATH'), false);
});
test('entry/metadata bounds stop accepting and retain existing entries', () => {
  const s = setup({ maxEntries: 1 }); s.before(); s.before({ requestId: '2' }); assert.equal(s.capture.entries.length, 1); assert.equal(s.capture.accepting, false);
  const t = setup({ maxMetadata: 1 }); t.before(); assert.equal(t.capture.entries.length, 0); assert.equal(t.capture.accepting, false);
});
test('filter unavailable and network failures have explicit diagnostics', () => {
  const s = setup(); s.capture.api.webRequest.filterResponseData = () => { throw new Error('unsupported'); }; s.before();
  assert.equal(s.capture.entries[0].data._bodyError, 'filter-unavailable');
  s.capture.complete({ requestId: '1', timeStamp: 1200, error: 'NS_ERROR' }, false, true);
  assert.equal(s.capture.entries[0].data._error, 'NS_ERROR');
});
