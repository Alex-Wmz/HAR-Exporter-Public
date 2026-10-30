import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, loadCapture, request, response, finish, emitRequest, deferred, flush } from './harness.mjs';
const source = { tabId: 1 };
const extra = (c, side, headers, id = 'r', from = source) => c.handle(from, `Network.${side}ExtraInfo`, { requestId: id, headers, statusCode: 200 });
const value = (hs, name) => hs.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
const exported = (h) => h.writes.at(-1).har.log;

test('迟到的真实请求头替换旧值，并更新 Cookie 和 POST 类型', async () => {
  const c = loadCapture();
  request(c, 'r', source, { method: 'POST', headers: { Cookie: 'old=0', 'Content-Type': 'text/plain' }, postData: '中文😀' });
  response(c, 'r', source, {}, true);
  extra(c, 'requestWillBeSent', { cookie: 'auth=abc==; b=2', 'content-type': 'application/json', Authorization: 'synthetic-token' });
  extra(c, 'responseReceived', {});
  const r = c.entries[0].data.request;
  assert.equal(value(r.headers, 'Cookie'), 'auth=abc==; b=2');
  assert.deepEqual(r.cookies, [{ name: 'auth', value: 'abc==' }, { name: 'b', value: '2' }]);
  assert.equal(r.postData.mimeType, 'application/json');
  assert.equal(r.bodySize, 10);
});

test('真实网络头中省略的旧 Cookie/Authorization 不得残留为已发送凭证', () => {
  const c = loadCapture();
  request(c, 'r', source, { headers: { Cookie: 'not-sent=1', Authorization: 'not-sent' } });
  response(c, 'r', source, {}, true);
  extra(c, 'requestWillBeSent', { Accept: '*/*' });
  assert.deepEqual(c.entries[0].data.request.cookies, []);
  assert.equal(value(c.entries[0].data.request.headers, 'Authorization'), undefined);
});

test('提前到达的额外响应头：多条 Set-Cookie、属性和 304 网络状态', () => {
  const c = loadCapture();
  extra(c, 'requestWillBeSent', { Cookie: 'a=1' });
  c.handle(source, 'Network.responseReceivedExtraInfo', { requestId: 'r', statusCode: 304,
    headers: { 'Set-Cookie': 'a=1; Path=/; Secure; HttpOnly\nb=2; Expires=Wed, 21 Oct 2030 07:28:00 GMT' }, headersText: 'HTTP/1.1 304\r\n\r\n' });
  request(c); response(c, 'r', source, { protocol: 'h2' }, true);
  const r = c.entries[0].data.response;
  assert.equal(r.status, 304);
  assert.equal(r._effectiveStatus, 200);
  assert.equal(r.cookies.length, 2);
  assert.equal(r.cookies[0].path, '/');
  assert.equal(r.cookies[0].secure, true);
  assert.equal(r.cookies[0].httpOnly, true);
  assert.equal(r.cookies[1].expires, '2030-10-21T07:28:00.000Z');
  assert.equal(r.httpVersion, 'HTTP/2');
});

test('对抗性乱序：300 个可重现的重定向/额外头交错序列不串跳', async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const c = loadCapture();
    const all = ['a', 'c']; // middle hop explicitly has no ExtraInfo
    const steps = [
      [() => request(c, 'r', source, { url: 'https://test/a' }),
        () => c.handle(source, 'Network.requestWillBeSent', { requestId: 'r', timestamp: 2, wallTime: 1700000001,
          request: { url: 'https://test/b', method: 'GET', headers: {} }, redirectResponse: { status: 302, headers: {} }, redirectHasExtraInfo: true }),
        () => c.handle(source, 'Network.requestWillBeSent', { requestId: 'r', timestamp: 3, wallTime: 1700000002,
          request: { url: 'https://test/c', method: 'GET', headers: {} }, redirectResponse: { status: 307, headers: {} }, redirectHasExtraInfo: false }),
        () => response(c, 'r', source, {}, true), () => finish(c)],
      all.map((x) => () => extra(c, 'requestWillBeSent', { Cookie: `hop=${x}` })),
      all.map((x) => () => extra(c, 'responseReceived', { 'Set-Cookie': `hop=${x}` })),
    ];
    let n = seed;
    while (steps.some((s) => s.length)) {
      n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
      const candidates = steps.filter((s) => s.length);
      candidates[n % candidates.length].shift()();
    }
    await Promise.all(c.pending);
    c.freeze();
    assert.deepEqual(c.entries.map((e) => value(e.data.request.headers, 'cookie')), ['hop=a', undefined, 'hop=c'], `seed=${seed}`);
    assert.deepEqual(c.entries.map((e) => value(e.data.response.headers, 'set-cookie')), ['hop=a', undefined, 'hop=c'], `seed=${seed}`);
    assert.equal(c.entries.length, 3);
  }
});

test('跨标签及子会话相同 requestId 隔离，正文命令路由到准确会话', async () => {
  const calls = [];
  const c = loadCapture({}, async (s, m, p) => { calls.push({ s, m, p }); return { body: JSON.stringify(s) }; });
  const sources = [{ tabId: 1 }, { tabId: 2 }, { tabId: 1, sessionId: 'x:y' }, { tabId: 1, sessionId: 'x' }];
  for (const s of sources) { request(c, 'same:id', s); response(c, 'same:id', s); finish(c, 'same:id', s); }
  await c.settle();
  assert.equal(c.entries.length, 4);
  assert.deepEqual(calls.map((x) => x.s), sources);
  assert.ok(calls.every((x) => !('sessionId' in x.p)));
  assert.deepEqual(c.entries.map((e) => JSON.parse(e.data.response.content.text)), sources);
});

test('立即停止等待尚在获取的响应体，保存前保持冻结边界', async () => {
  const body = deferred();
  const h = createHarness({ command: (s, m) => m === 'Network.getResponseBody' ? body.promise : undefined });
  await h.startRecording(1); emitRequest(h.L, 1, 'a', 'https://test/a');
  const saving = h.stopRecording();
  await flush();
  assert.equal(h.writes.length, 0);
  emitRequest(h.L, 1, 'b', 'https://test/after-stop');
  body.resolve({ body: '完整中文😀', base64Encoded: false });
  assert.equal((await saving).ok, true);
  assert.equal(exported(h).entries.length, 1);
  assert.equal(exported(h).entries[0].response.content.text, '完整中文😀');
});

test('停止后等待已发出请求返回，不丢未收到响应的条目', async () => {
  const c = loadCapture(); request(c);
  const stopping = c.settle(1000);
  response(c); finish(c);
  await stopping;
  assert.equal(c.entries[0].data.response.content.text, '{}');
  assert.equal(c.entries[0].data._incomplete, undefined);
});

test('永不结束的请求、悬挂正文命令超时后保留并标记；迟到数据不能改快照', async () => {
  const body = deferred();
  const c = loadCapture({}, () => body.promise);
  request(c, 'pending');
  request(c, 'body'); response(c, 'body'); finish(c, 'body');
  await c.settle(30);
  assert.equal(c.entries[0].data._incomplete, 'stopped-before-completion');
  assert.equal(c.entries[1].data._bodyError, 'stop-wait-timeout');
  const snapshot = JSON.stringify(c.entries.map((e) => e.data));
  body.resolve({ body: 'too late' }); await flush();
  assert.equal(JSON.stringify(c.entries.map((e) => e.data)), snapshot);
});

test('收到响应头后网络断开仍必须记录失败，时间总和一致', () => {
  const c = loadCapture(); request(c); response(c);
  c.handle(source, 'Network.loadingFailed', { requestId: 'r', timestamp: 4, errorText: 'net::ERR_CONNECTION_RESET', blockedReason: 'other' });
  const d = c.entries[0].data;
  assert.equal(d.response.status, 200);
  assert.equal(d._error, 'net::ERR_CONNECTION_RESET');
  assert.equal(d.time, 3000);
  assert.equal(Object.values(d.timings).reduce((a, b) => a + b, 0), d.time);
});

test('正文被浏览器淘汰不会报成功正文；媒体开关可包含二进制，base64 padding 大小准确', async () => {
  const c = loadCapture({ includeMedia: true }, async () => ({ body: 'YQ==', base64Encoded: true }));
  request(c); response(c, 'r', source, { mimeType: 'image/png' }); finish(c); await c.settle();
  assert.deepEqual(c.entries[0].data.response.content, { size: 1, mimeType: 'image/png', text: 'YQ==', encoding: 'base64' });
  const error = loadCapture({}, async () => { throw new Error('evicted'); });
  request(error); response(error); finish(error); await error.settle();
  assert.equal(error.entries[0].data._bodyError, 'unavailable-or-timeout');
});

test('默认媒体筛选、单体上限、累计上限都在 HAR 中说明原因', async () => {
  const media = loadCapture(); request(media); response(media, 'r', source, { mimeType: 'image/svg+xml' }); finish(media); media.freeze();
  assert.equal(media.entries[0].data._bodySkipped, 'media-filter');
  const c = loadCapture({ maxBodyBytes: 6, maxTotalBytes: 9 }, async (s, m, p) => ({ body: p.requestId === 'big' ? '1234567' : '中文' }));
  for (const id of ['big', 'one', 'two']) { request(c, id); response(c, id); finish(c, id); }
  await c.settle();
  assert.deepEqual(c.entries.map((e) => e.data._bodySkipped), ['per-body-limit', undefined, 'total-payload-limit']);
  assert.equal(c.retainedBytes, 6);
});

test('已知超大解码响应不再发正文命令；HEAD/204 明确无正文', () => {
  const c = loadCapture({ maxBodyBytes: 3 }, () => { throw new Error('must not call'); });
  request(c); response(c);
  c.handle(source, 'Network.dataReceived', { requestId: 'r', dataLength: 4 }); finish(c);
  assert.equal(c.entries[0].data._bodySkipped, 'per-body-limit');
  request(c, 'head', source, { method: 'HEAD' }); response(c, 'head'); finish(c, 'head');
  assert.equal(c.entries[1].data._bodySkipped, 'no-body');
});

test('正文抓取最多四个并发，排队请求不丢失', async () => {
  let active = 0, peak = 0;
  const gates = [];
  const c = loadCapture({}, async () => { const d = deferred(); gates.push(d); peak = Math.max(peak, ++active); await d.promise; active--; return { body: 'ok' }; });
  for (let i = 0; i < 13; i++) { request(c, String(i)); response(c, String(i)); finish(c, String(i)); }
  assert.equal(gates.length, 4);
  while (gates.length) { gates.splice(0).forEach((g) => g.resolve()); await flush(); }
  await c.settle();
  assert.equal(peak, 4);
  assert.equal(c.entries.filter((e) => e.data.response.content.text === 'ok').length, 13);
});

test('POST 缺失时补取，超出限制只标记，不把正文写入扩展设置', async () => {
  const c = loadCapture({ maxPostBytes: 4 }, async () => ({ postData: '中文' }));
  request(c, 'r', source, { method: 'POST', hasPostData: true });
  await Promise.all(c.pending);
  assert.equal(c.entries[0].data.request.bodySize, 6);
  assert.equal(c.entries[0].data._postDataSkipped, 'per-body-limit');
  assert.equal(c.entries[0].data.request.postData, undefined);
});

test('保存对话框取消：可重试同一份数据，并禁止开始覆盖待导出数据', async () => {
  let attempt = 0;
  const h = createHarness({ download: async (spec, json, L, downloads) => {
    if (++attempt === 1) throw new Error('USER_CANCELED');
    downloads.set(4, { id: 4, state: 'complete' }); return 4;
  } });
  await h.startRecording(1); emitRequest(h.L, 1, 'a', 'https://test/a'); await flush();
  assert.equal((await h.stopRecording()).ok, false);
  assert.equal(h.state.phase, 'ready');
  assert.equal((await h.startRecording(2)).ok, false);
  assert.equal(h.state.capture.entries.length, 1);
  assert.equal((await h.stopRecording()).ok, true);
  assert.deepEqual(h.writes[0].har, h.writes[1].har);
  assert.equal(h.state.phase, 'idle');
  assert.equal(h.blobs.size, 0);
});

test('下载开始不等于成功：必须等 complete，中断恢复待导出状态', async () => {
  const h = createHarness({ download: async (spec, json, L, downloads) => { downloads.set(9, { id: 9, state: 'in_progress' }); return 9; } });
  await h.startRecording(1); emitRequest(h.L, 1, 'a', 'https://test/a'); await flush();
  const saving = h.stopRecording(); await flush();
  assert.equal(h.state.phase, 'exporting');
  assert.equal(h.state.lastResult, null);
  assert.equal((await h.stopRecording()).ok, false);
  assert.equal((await h.stopRecording(false)).ok, false);
  h.L.downloadChanged({ id: 9, state: { current: 'interrupted' }, error: { current: 'FILE_NO_SPACE' } });
  assert.equal((await saving).ok, false);
  assert.equal(h.state.phase, 'ready');
  await h.stopRecording(false);
});

test('下载完成事件早于 download 返回也能确认成功', async () => {
  const h = createHarness(); await h.startRecording(1); emitRequest(h.L, 1, 'r', 'https://test/');
  assert.equal((await h.stopRecording()).exported, true);
});

for (const scenario of ['permission', 'write', 'missing']) test(`文件夹 ${scenario} 故障回退另存为，等保存完成才算成功`, async () => {
  const h = createHarness({ target: { mode: 'folder', folderId: 'f' }, folder: scenario === 'missing' ? null : { id: 'f', name: 'Test', handle: {} },
    permission: scenario === 'permission' ? 'denied' : 'granted', write: scenario === 'write' ? async () => { throw new Error('disk error'); } : undefined });
  await h.startRecording(1); emitRequest(h.L, 1, 'a', 'https://test/');
  const result = await h.stopRecording();
  assert.equal(result.ok, true); assert.equal(result.method, 'downloads'); assert.ok(result.fallbackReason);
});

test('主标签关闭后可以导出数据，已关闭子标签的 page 信息仍存在', async () => {
  const h = createHarness(); await h.startRecording(1);
  await h.maybeFollowNewTab(1, 2, 'https://test/child');
  emitRequest(h.L, 2, 'a', 'https://test/a'); await flush();
  h.L.debuggerDetach({ tabId: 2 }); h.L.debuggerDetach({ tabId: 1 }); await flush();
  assert.equal(h.state.phase, 'ready');
  assert.equal((await h.stopRecording()).ok, true);
  assert.equal(exported(h).pages[0].title, '标题-2');
  assert.equal(exported(h).entries[0].pageref, 'tab_2');
});

test('双击开始、双信号跟随只附加一次；停止期间延迟附加最终释放', async () => {
  const gate = deferred(); let calls = 0;
  const h = createHarness({ attach: async ({ tabId }) => { calls++; if (tabId === 2) await gate.promise; } });
  const starting = h.startRecording(1);
  assert.equal((await h.startRecording(1)).ok, false);
  await starting;
  h.L.tabsCreated({ id: 2, openerTabId: 1 });
  h.L.navTarget({ sourceTabId: 1, tabId: 2 }); await flush();
  assert.equal(calls, 2);
  const stopping = h.stopRecording(false);
  gate.resolve(); await stopping;
  assert.equal(h.attached.size, 0);
  assert.equal(h.state.phase, 'idle');
});

test('Network.enable 完成之前到达的请求也记录；未录制导航不进入内存', async () => {
  let h;
  h = createHarness({ command: (s, m) => { if (m === 'Network.enable') emitRequest(h.L, s.tabId, 'r', 'https://test/early'); } });
  await h.startRecording(1); await flush();
  assert.equal(h.state.capture.entries.length, 1);
  h.L.navCommitted({ tabId: 99, frameId: 0, url: 'https://unrelated.test/' });
  assert.equal(h.state.tabInfo.has(99), false);
  await h.stopRecording(false);
});

test('子框架递归开启网络和自动附加，其他未登记会话不录制', async () => {
  const h = createHarness(); await h.startRecording(1);
  h.L.debuggerEvent(source, 'Target.attachedToTarget', { sessionId: 'frame', targetInfo: { type: 'iframe' } }); await flush();
  emitRequest(h.L, 1, 'r', 'https://test/frame', { sessionId: 'frame' });
  emitRequest(h.L, 1, 'r', 'https://test/other', { sessionId: 'unknown' }); await flush();
  assert.equal(h.state.capture.entries.length, 1);
  assert.ok(h.commands.some((x) => x.method === 'Target.setAutoAttach' && x.source.sessionId === 'frame'));
  assert.ok(h.commands.some((x) => x.method === 'Network.getResponseBody' && x.source.sessionId === 'frame'));
  await h.stopRecording(false);
});

test('WebSocket/SSE 消息保留、结束中的流不阻塞停止，消息数量和正文总量受限', async () => {
  const c = loadCapture({ maxTotalBytes: 250, maxBodyBytes: 250 });
  c.handle(source, 'Network.webSocketCreated', { requestId: 'ws', url: 'wss://test/ws' });
  c.handle(source, 'Network.webSocketWillSendHandshakeRequest', { requestId: 'ws', timestamp: 1, wallTime: 1700000000, request: { headers: { Cookie: 'a=1' } } });
  c.handle(source, 'Network.webSocketHandshakeResponseReceived', { requestId: 'ws', timestamp: 2, response: { status: 101, headers: {} } });
  c.handle(source, 'Network.webSocketFrameReceived', { requestId: 'ws', timestamp: 3, response: { opcode: 1, payloadData: 'hello' } });
  request(c, 'sse'); response(c, 'sse', source, { mimeType: 'text/event-stream' });
  c.handle(source, 'Network.eventSourceMessageReceived', { requestId: 'sse', timestamp: 4, eventName: 'message', eventId: '1', data: 'world' });
  c.handle(source, 'Network.eventSourceMessageReceived', { requestId: 'sse', timestamp: 5, data: 'x'.repeat(400) });
  await c.settle(0);
  assert.equal(c.entries[0].data._webSocketMessages[0].data, 'hello');
  assert.equal(c.entries[1].data._eventSourceMessages[0].data, 'world');
  assert.equal(c.entries[1].data._messagesTruncated, true);
  assert.equal(c.entries[0].data._streamOpenAtStop, true);
  assert.ok(c.retainedBytes <= 250);
});

test('导出的标准字段和来源引用有效，内部对象不泄漏、不出现循环结构', async () => {
  const h = createHarness(); await h.startRecording(1); emitRequest(h.L, 1, 'r', 'https://test/?q=中文&q=😀');
  await h.stopRecording();
  const log = exported(h);
  assert.equal(log.creator.version, h.chrome.runtime.getManifest().version);
  assert.equal(log.version, '1.2');
  for (const e of log.entries) {
    assert.ok(log.pages.some((p) => p.id === e.pageref));
    assert.ok(Number.isFinite(Date.parse(e.startedDateTime)));
    for (const key of ['chain', 'source', 'tabId', 'bodyPending', '_ts']) assert.equal(e[key], undefined);
  }
  assert.equal(h.stored.length, 1);
  assert.equal(h.stored[0].k, 'lastSuccessfulExport');
  assert.deepEqual(Object.keys(h.stored[0].v).sort(), ['downloadId', 'filename', 'method', 'savedAt']);
});

test('base64 单体限制按解码大小而不是字符串膨胀后的大小判定', async () => {
  const c = loadCapture({ maxBodyBytes: 3, maxTotalBytes: 8 }, async () => ({ body: 'YWJj', base64Encoded: true }));
  request(c); response(c); finish(c); await c.settle();
  assert.equal(c.entries[0].data.response.content.size, 3);
  assert.equal(c.entries[0].data.response.content.text, 'YWJj');
  assert.equal(c.retainedBytes, 4);
});

test('新请求超过上限会停止接收，数量保持有界并给出警告', () => {
  const c = loadCapture({ maxEntries: 3 });
  for (let i = 0; i < 30; i++) request(c, String(i));
  assert.equal(c.entries.length, 3);
  assert.equal(c.chains.size, 3);
  assert.equal(c.accepting, false);
  assert.ok(c.warnings.has('entry-limit'));
});

test('额外头洪泛及巨大请求头不能无限占用内存', () => {
  const c = loadCapture({ maxMetadataBytes: 100 });
  request(c);
  extra(c, 'requestWillBeSent', { 'X-Large': 'x'.repeat(1000) });
  assert.equal(c.accepting, false);
  assert.ok(c.warnings.has('metadata-limit'));
  assert.equal(c.entries[0].data._metadataSkipped, 'metadata-limit');
  assert.ok(c.metadataBytes <= 100);
});

test('启动时被取消调试不能回到假录制状态，保留已收到数据', async () => {
  let h;
  h = createHarness({ command: (s, method) => {
    if (method === 'Network.enable') {
      emitRequest(h.L, s.tabId, 'r', 'https://test/early');
      h.L.debuggerDetach(s);
      throw new Error('detached during enable');
    }
  } });
  assert.equal((await h.startRecording(1)).ok, false);
  assert.equal(h.state.phase, 'ready');
  assert.equal(h.state.capture.entries.length, 1);
  assert.equal((await h.stopRecording()).ok, true);
});

test('第一次附加失败后可以再次开始，后台消息只接受本扩展', async () => {
  let attempt = 0;
  const h = createHarness({ attach: async () => { if (++attempt === 1) throw new Error('busy'); } });
  assert.equal((await h.startRecording(1)).ok, false);
  assert.equal(h.state.phase, 'idle');
  let replied = false;
  h.L.message({ type: 'start', tabId: 2 }, { id: 'unrelated-extension' }, () => { replied = true; });
  await flush(); assert.equal(replied, false); assert.equal(attempt, 1);
  assert.equal((await h.startRecording(1)).ok, true);
  await h.stopRecording(false);
});
