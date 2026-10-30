import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapture, request, response, finish, flush } from './harness.mjs';

const source = { tabId: 1 };
function redirect(c, url = 'https://example.test/after', hasExtraInfo = false) {
  c.handle(source, 'Network.requestWillBeSent', {
    requestId: 'r', timestamp: 2, wallTime: 1700000001,
    request: { url, method: 'GET', headers: {} },
    redirectResponse: { status: 302, headers: { Location: url }, mimeType: 'text/html' },
    redirectHasExtraInfo: hasExtraInfo,
  });
}
function extra(c, side, headers, statusCode = 200) {
  c.handle(source, `Network.${side}ExtraInfo`, { requestId: 'r', headers, statusCode });
}

test('停止后的重定向保留原跳302，后续响应和再次跳转不能覆盖原跳', async () => {
  const c = loadCapture();
  request(c, 'r', source, { url: 'https://example.test/before' });
  const stopping = c.settle(1000);
  redirect(c);
  response(c, 'r', source, { status: 200 });
  redirect(c, 'https://example.test/third');
  finish(c);
  request(c, 'unrelated');
  await stopping;
  assert.equal(c.entries.length, 1);
  const e = c.entries[0].data;
  assert.equal(e.request.url, 'https://example.test/before');
  assert.equal(e.response.status, 302);
  assert.equal(e.response.redirectURL, 'https://example.test/after');
  assert.equal(e._redirectContinuationSkipped, 'capture-stopped');
  assert.equal(e._bodySkipped, 'redirect');
  assert.equal(e._incomplete, undefined);
});

test('停止后封闭重定向链仍接收原跳的迟到额外头，不混入后跳', async () => {
  const c = loadCapture(); request(c);
  const stopping = c.settle(1000);
  redirect(c, 'https://example.test/after', true);
  response(c, 'r', source, { status: 200 }, true);
  extra(c, 'requestWillBeSent', { Cookie: 'original=synthetic' });
  extra(c, 'responseReceived', { Location: 'https://example.test/after', 'Set-Cookie': 'original=synthetic' }, 302);
  extra(c, 'requestWillBeSent', { Cookie: 'later=synthetic' });
  extra(c, 'responseReceived', { 'Set-Cookie': 'later=synthetic' }, 200);
  finish(c);
  await stopping;
  const e = c.entries[0].data;
  assert.equal(e.response.status, 302);
  assert.equal(e.response.redirectURL, 'https://example.test/after');
  assert.deepEqual(e.request.cookies, [{ name: 'original', value: 'synthetic' }]);
  assert.deepEqual(e.response.cookies, [{ name: 'original', value: 'synthetic' }]);
  assert.equal(e._extraInfoIncomplete, undefined);
});

test('条数上限截断重定向也不能把最终200写回原跳', async () => {
  const c = loadCapture({ maxEntries: 1 }); request(c);
  redirect(c);
  response(c); finish(c);
  await c.settle(100);
  assert.equal(c.entries.length, 1);
  assert.equal(c.entries[0].data.response.status, 302);
  assert.equal(c.entries[0].data._redirectContinuationSkipped, 'capture-stopped');
  assert.ok(c.warnings.has('entry-limit'));
});

test('正文已完成时仍等待预期额外头，两侧收齐后才冻结', async () => {
  const c = loadCapture(); request(c); response(c, 'r', source, {}, true); finish(c);
  await flush();
  const stopping = c.settle(1000);
  await flush();
  assert.equal(c.frozen, false);
  extra(c, 'requestWillBeSent', { Cookie: 'late=synthetic' });
  await flush();
  assert.equal(c.frozen, false);
  extra(c, 'responseReceived', { 'Set-Cookie': 'late=synthetic' });
  await stopping;
  assert.deepEqual(c.entries[0].data.request.cookies, [{ name: 'late', value: 'synthetic' }]);
  assert.deepEqual(c.entries[0].data.response.cookies, [{ name: 'late', value: 'synthetic' }]);
  assert.equal(c.entries[0].data._extraInfoIncomplete, undefined);
});

test('预期额外头永久缺失时限时冻结，超时迟到事件不能改变导出快照', async () => {
  const c = loadCapture(); request(c); response(c, 'r', source, {}, true); finish(c);
  await flush();
  const started = Date.now();
  await c.settle(30);
  assert.ok(Date.now() - started >= 30);
  assert.equal(c.entries[0].data._extraInfoIncomplete, true);
  const snapshot = JSON.stringify(c.build([], '1.4.3', 'test'));
  extra(c, 'requestWillBeSent', { Cookie: 'too-late=synthetic' });
  extra(c, 'responseReceived', { 'Set-Cookie': 'too-late=synthetic' });
  assert.equal(JSON.stringify(c.build([], '1.4.3', 'test')), snapshot);
});

test('明确没有额外头的已完成请求无需额外等待', async () => {
  const c = loadCapture(); request(c); response(c); finish(c); await flush();
  const stopping = c.settle(1000);
  assert.equal(c.frozen, true);
  await stopping;
  assert.equal(c.entries[0].data._extraInfoIncomplete, undefined);
});

test('后跳请求头超过元数据预算时，仍保留原跳302且拒绝后跳200', async () => {
  const c = loadCapture({ maxMetadataBytes: 200 }); request(c);
  c.handle(source, 'Network.requestWillBeSent', {
    requestId: 'r', timestamp: 2,
    request: { url: 'https://test/after', method: 'GET', headers: { 'x-large': 'x'.repeat(500) } },
    redirectResponse: { status: 302, headers: { Location: 'https://test/after' } },
    redirectHasExtraInfo: false,
  });
  response(c); finish(c); await c.settle(0);
  assert.equal(c.entries.length, 1);
  assert.equal(c.entries[0].data.response.status, 302);
  assert.equal(c.entries[0].data.response.redirectURL, 'https://test/after');
  assert.equal(c.entries[0].data._redirectContinuationSkipped, 'capture-stopped');
  assert.ok(c.warnings.has('metadata-limit'));
});

test('原跳响应头超过元数据预算时，显式保留缺失而不填入后跳200', async () => {
  const c = loadCapture({ maxMetadataBytes: 200 }); request(c);
  c.handle(source, 'Network.requestWillBeSent', {
    requestId: 'r', timestamp: 2,
    request: { url: 'https://test/after', method: 'GET', headers: {} },
    redirectResponse: { status: 302, headers: { 'x-large': 'x'.repeat(500) } },
    redirectHasExtraInfo: false,
  });
  response(c); finish(c); await c.settle(0);
  assert.equal(c.entries[0].data.response.status, 0);
  assert.equal(c.entries[0].data._metadataSkipped, 'metadata-limit');
  assert.equal(c.entries[0].data._redirectContinuationSkipped, 'capture-stopped');
  assert.ok(c.entries[0].data._incomplete);
});
