const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./harness.cjs');

test('discarded oversized response returns all budget; later JSON is complete', () => {
  const s = setup({ maxTotal: 400, maxBody: 100 });
  const a = s.begin(); s.chunk(a, 'a'.repeat(60)); s.chunk(a, 'b'.repeat(60));
  assert.equal(s.capture.buffered, 0); assert.equal(s.capture.used, 0);
  const b = s.begin(); s.chunk(b, 'x'.repeat(90)); s.end(b);
  assert.equal(b.e.data.response.content.text.length, 90); assert.equal(s.capture.used, 90);
});
test('finished response is charged once, not a permanent threefold reservation', () => {
  const s = setup({ maxTotal: 300000 });
  for (const n of [95000, 20012]) { const r = s.begin(); s.chunk(r, 'x'.repeat(n)); s.end(r); }
  assert.equal(s.capture.used, 115012); assert.equal(s.capture.buffered, 0);
  assert.equal(s.capture.summary().nonEmptyApiBody, 2);
});
test('resource saturation keeps request and API capacity available', () => {
  const s = setup({ maxTotal: 800, maxBuffered: 1000 });
  const a = s.begin({ type: 'script', mime: 'application/javascript' }); s.chunk(a, 'a'.repeat(190)); s.end(a);
  const b = s.begin({ type: 'script', mime: 'application/javascript' }); s.chunk(b, 'b'.repeat(50)); s.end(b);
  const c = s.begin({ method: 'POST', post: '{"query":"test"}' }); s.chunk(c, '{"flights":[]}'); s.end(c);
  assert.equal(b.e.data._bodySkipped, 'resource-payload-limit');
  assert.equal(c.e.data.request.postData.text, '{"query":"test"}');
  assert.equal(c.e.data.response.content.text, '{"flights":[]}');
});
test('request budget cannot be stolen by API responses and vice versa', () => {
  const s = setup({ maxTotal: 800 });
  const a = s.begin(); s.chunk(a, 'a'.repeat(700)); s.end(a);
  const b = s.begin({ method: 'POST', post: 'p'.repeat(100) }); s.chunk(b, '{}'); s.end(b);
  assert.equal(b.e.data.request.postData.text.length, 100);
  assert.equal(b.e.data._bodySkipped, 'total-payload-limit');
  const c = s.begin({ method: 'POST', post: 'x' });
  assert.equal(c.e.data._postDataSkipped, 'request-payload-limit');
  assert.equal(s.capture.used, 800);
});
test('temporary limit is bounded and reclaimed after stream rejection', () => {
  const s = setup({ maxBuffered: 100 });
  const a = s.begin(); s.chunk(a, 'a'.repeat(60));
  const b = s.begin(); s.chunk(b, 'b'.repeat(50));
  assert.equal(b.e.data._bodySkipped, 'temporary-buffer-limit'); assert.equal(s.capture.buffered, 60);
  s.end(a); const c = s.begin(); s.chunk(c, 'c'.repeat(90)); s.end(c);
  assert.equal(c.e.data.response.content.text.length, 90); assert.equal(s.capture.peakBuffered, 90);
  assert.equal(s.capture.buffered, 0);
});
test('parallel scripts cannot take API temporary buffer reserve', () => {
  const s = setup({ maxBuffered: 400 });
  const a = s.begin({ type: 'script', mime: 'application/javascript' }); s.chunk(a, 'a'.repeat(90));
  const b = s.begin({ type: 'script', mime: 'application/javascript' }); s.chunk(b, 'b'.repeat(30));
  assert.equal(b.e.data._bodySkipped, 'temporary-buffer-limit');
  const c = s.begin(); s.chunk(c, 'c'.repeat(300)); s.end(c); s.end(a);
  assert.equal(s.capture.buffered, 0); assert.equal(s.capture.resourceBuffered, 0);
  assert.equal(c.e.data.response.content.text.length, 300);
});
test('base64 expansion checked at conversion; rejection releases raw bytes', () => {
  const s = setup({ maxTotal: 16 });
  const a = s.begin({ mime: 'application/octet-stream' }); s.chunk(a, Array(12).fill(255)); s.end(a);
  assert.equal(a.e.data._bodySkipped, 'total-payload-limit'); assert.equal(s.capture.used, 0);
  assert.equal(s.capture.buffered, 0);
  const b = s.begin(); s.chunk(b, '{}'); s.end(b); assert.equal(s.capture.used, 2);
});
test('declared charset stored budget uses resulting UTF-8 size', () => {
  const s = setup(); const a = s.begin({ mime: 'text/plain; charset=windows-1252' });
  s.chunk(a, [233, 233]); s.end(a);
  assert.equal(a.e.data.response.content.text, 'éé'); assert.equal(s.capture.used, 4);
  assert.equal(a.e.data.response.content.size, 2);
});
for (const reason of ['filter-error', 'network-error', 'redirect', 'restart', 'freeze']) test(`${reason} releases each chunk exactly once`, () => {
  const s = setup(); const a = s.begin(); s.chunk(a, 'pending');
  if (reason === 'filter-error') a.f.onerror();
  if (reason === 'network-error') s.capture.complete({ requestId: a.id, timeStamp: 1200, error: 'NS_ERROR_FAILURE' }, false, true);
  if (reason === 'redirect') s.capture.complete({ requestId: a.id, timeStamp: 1200, redirectUrl: 'https://example.test/next' }, true);
  if (reason === 'restart') s.begin({ id: a.id });
  if (reason === 'freeze') s.capture.freeze();
  a.f.onstop(); a.f.onerror();
  assert.equal(s.capture.buffered, 0); assert.equal(s.capture.used, 0); assert.equal(s.capture.resourceBuffered, 0);
  assert.equal(a.e.data.response.content.text, undefined);
});
test('completed HTTP request with lost body is clearly limited in export and live status', () => {
  const s = setup({ maxBody: 3 }); const a = s.begin(); s.chunk(a, '1234'); s.end(a);
  const live = s.capture.summary(); s.capture.freeze(); const exported = s.capture.build(new Map(), 'test').log._capture;
  assert.equal(exported.incomplete, 0); assert.equal(exported.lostResponseBodies, 1);
  assert.equal(exported.captureLimited, true); assert.ok(exported.warnings.includes('body-data-missing'));
  assert.equal(live.lostResponseBodies, exported.lostResponseBodies);
  assert.match(s.ctx.HarPayload.describe(exported).warning, /正文有缺失/); assert.ok(s.changes() > 0);
});
test('no-body and media policy are not counted as accidental body loss', () => {
  const s = setup(); const a = s.begin({ status: 204 }); s.end(a);
  const b = s.begin({ type: 'image', mime: 'image/png' }); s.end(b);
  const stats = s.capture.summary(); assert.equal(stats.lostResponseBodies, 0); assert.equal(stats.nonEmptyBody, 0);
});
test('conversion failure frees buffer so next request can be captured', () => {
  const s = setup(); s.ctx.btoa = () => { throw new Error('test conversion failure'); };
  const a = s.begin({ mime: 'application/octet-stream' }); s.chunk(a, [255]); s.end(a);
  assert.equal(a.e.data._bodyError, 'body-conversion-failed'); assert.equal(s.capture.buffered, 0);
  const b = s.begin(); s.chunk(b, '{}'); s.end(b); assert.equal(b.e.data.response.content.text, '{}');
});
test('frozen late callbacks do not resurrect retained content or change accounting', () => {
  const s = setup(); const a = s.begin(); s.chunk(a, 'pending'); s.capture.freeze();
  const before = JSON.stringify(s.capture.build(new Map(), 'test'));
  s.chunk(a, 'late'); a.f.onstop(); a.f.onerror();
  assert.equal(JSON.stringify(s.capture.build(new Map(), 'test')), before); assert.equal(s.capture.buffered, 0);
});
for (const outcome of ['redirect', 'no-content', 'network-error']) test(`early filter error followed by ${outcome} is distinct from lost response data`, () => {
  const s = setup(); const a = s.begin(); a.f.onerror();
  if (outcome === 'redirect') s.capture.complete({ requestId: a.id, timeStamp: 1200, statusCode: 302, redirectUrl: 'https://example.test/next' }, true);
  if (outcome === 'no-content') s.capture.complete({ requestId: a.id, timeStamp: 1200, statusCode: 204 });
  if (outcome === 'network-error') s.capture.complete({ requestId: a.id, timeStamp: 1200, error: 'NS_ERROR_FAILURE' }, false, true);
  assert.equal(s.capture.summary().lostResponseBodies, 0);
  assert.equal(s.capture.summary().bodySkippedReasons['filter-unavailable'], 1);
  assert.equal(s.capture.summary().failed, outcome === 'network-error' ? 1 : 0);
});
