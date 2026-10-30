const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function event() {
  const listeners = new Set();
  return { listeners, addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); }, fire(...args) { return [...listeners].map((fn) => fn(...args)); } };
}
async function setup() {
  const downloadChanged = event(), runtimeMessage = event();
  const api = {
    runtime: { id: 'test-extension', onMessage: runtimeMessage },
    storage: { local: { get: async (d) => d, set: async () => {} } },
    browserAction: { setBadgeText: async () => {} },
    tabs: { get: async (id) => ({ id, title: 'Fixture', url: 'https://example.test/' }), onCreated: event(), onUpdated: event(), onRemoved: event() },
    webNavigation: { onCreatedNavigationTarget: event() },
    webRequest: { onBeforeRequest: event(), onSendHeaders: event(), onHeadersReceived: event(), onCompleted: event(), onBeforeRedirect: event(), onErrorOccurred: event(),
      filterResponseData() { return { write() {}, disconnect() {}, close() {} }; } },
    downloads: { onChanged: downloadChanged, download: async () => { downloadChanged.fire({ id: 1, state: { current: 'complete' } }); return 1; }, search: async () => [{ id: 1, state: 'complete' }] },
  };
  const ctx = { browser: api, TextEncoder, TextDecoder, Uint8Array, URL, Blob, btoa, setTimeout, crypto: require('node:crypto').webcrypto };
  vm.createContext(ctx);
  for (const file of ['payload-policy.js', 'recorder.js', 'background.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx);
  const send = (msg) => [...runtimeMessage.listeners][0](msg, { id: 'test-extension' });
  await send({ type: 'status' });
  return { api, send };
}
test('idle never records; only selected and followed tabs record', async () => {
  const { api, send } = await setup();
  const d = { requestId: 'a', tabId: 1, type: 'websocket', url: 'https://example.test/', method: 'GET', timeStamp: 1000 };
  api.webRequest.onBeforeRequest.fire(d); assert.equal((await send({ type: 'status' })).count, 0);
  await send({ type: 'start', tabId: 1 });
  api.webRequest.onBeforeRequest.fire({ ...d, tabId: 99 }); assert.equal((await send({ type: 'status' })).count, 0);
  api.webRequest.onBeforeRequest.fire(d);
  api.tabs.onCreated.fire({ id: 2, openerTabId: 1 });
  api.webRequest.onBeforeRequest.fire({ ...d, requestId: 'b', tabId: 2 });
  api.tabs.onCreated.fire({ id: 3, openerTabId: 2 });
  assert.equal((await send({ type: 'status' })).count, 2); assert.equal((await send({ type: 'status' })).tabs, 3);
  await send({ type: 'discard' }); assert.equal((await send({ type: 'status' })).phase, 'idle');
});
test('download cancellation retains capture; retry succeeds and releases listener', async () => {
  const { api, send } = await setup(); await send({ type: 'start', tabId: 1 });
  api.webRequest.onBeforeRequest.fire({ requestId: 'a', tabId: 1, type: 'websocket', url: 'https://example.test/', method: 'GET', timeStamp: 1000 });
  api.webRequest.onCompleted.fire({ requestId: 'a', timeStamp: 1200, statusCode: 101 });
  api.downloads.download = async () => { throw new Error('User canceled'); };
  let s = await send({ type: 'stop' }); assert.equal(s.phase, 'ready'); assert.equal(s.count, 1); assert.equal(s.lastResult.ok, false);
  assert.equal(api.downloads.onChanged.listeners.size, 0);
  api.downloads.download = async () => { api.downloads.onChanged.fire({ id: 2, state: { current: 'complete' } }); return 2; };
  api.downloads.search = async () => [{ id: 2, state: 'complete' }];
  s = await send({ type: 'stop' }); assert.equal(s.phase, 'idle'); assert.equal(s.count, 0); assert.equal(s.lastResult.count, 1);
  assert.equal(api.downloads.onChanged.listeners.size, 0);
});
test('download interruption retains data even after download id assigned', async () => {
  const { api, send } = await setup(); await send({ type: 'start', tabId: 1 });
  api.downloads.download = async () => 3; api.downloads.search = async () => [{ id: 3, state: 'interrupted' }];
  assert.equal((await send({ type: 'stop' })).phase, 'ready');
});
test('settings persist only preferences; changes forbidden during capture', async () => {
  const { api, send } = await setup(); let saved;
  api.storage.local.set = async (s) => { saved = s; };
  await send({ type: 'settings', follow: false, includeMedia: true }); assert.deepEqual(Object.keys(saved).sort(), ['follow', 'includeMedia']);
  await send({ type: 'start', tabId: 1 });
  assert.ok((await send({ type: 'settings', follow: true })).error);
  api.tabs.onCreated.fire({ id: 2, openerTabId: 1 }); assert.equal((await send({ type: 'status' })).tabs, 1);
});
test('foreign extension messages ignored; primary tab close retains data', async () => {
  const { api, send } = await setup();
  assert.equal([...api.runtime.onMessage.listeners][0]({ type: 'start', tabId: 1 }, { id: 'foreign' }), undefined);
  await send({ type: 'start', tabId: 1 }); api.tabs.onRemoved.fire(1);
  await new Promise((r) => setTimeout(r, 0)); assert.equal((await send({ type: 'status' })).phase, 'ready');
});
test('loss is visible with popup closed and survives successful export', async () => {
  const { api, send } = await setup(); const badges = [];
  api.browserAction.setBadgeText = async ({text}) => badges.push(text);
  api.webRequest.filterResponseData = () => { throw new Error('synthetic filter unavailable'); };
  await send({ type: 'start', tabId: 1 });
  api.webRequest.onBeforeRequest.fire({ requestId: 'a', tabId: 1, type: 'xmlhttprequest', url: 'https://example.test/api', method: 'GET', timeStamp: 1000 });
  api.webRequest.onCompleted.fire({ requestId: 'a', timeStamp: 1200, statusCode: 200 });
  assert.equal((await send({ type: 'status' })).stats.lostResponseBodies, 1);
  await new Promise((r) => setTimeout(r, 180)); assert.equal(badges.at(-1), '!');
  const saved = await send({ type: 'stop' });
  assert.equal(saved.phase, 'idle'); assert.equal(saved.count, 0); assert.equal(saved.lastResult.ok, true);
  assert.equal(saved.lastResult.incomplete, 0); assert.equal(saved.lastResult.lostResponseBodies, 1);
  assert.ok(saved.lastResult.warnings.includes('body-data-missing'));
});
