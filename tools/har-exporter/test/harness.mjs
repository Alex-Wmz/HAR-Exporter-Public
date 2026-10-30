import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

export const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export function createHarness(options = {}) {
  const L = {}, attached = new Set(), detachCalls = [], commands = [], writes = [], blobs = new Map(), stored = [];
  const settings = options.settings || new Map();
  const event = (key) => {
    const callbacks = new Set();
    L[key] = (...args) => { for (const cb of callbacks) cb(...args); };
    return { addListener: (cb) => callbacks.add(cb), removeListener: (cb) => callbacks.delete(cb) };
  };
  const noop = async () => {};
  let doc = false, downloadId = 0;
  const downloads = new Map();
  const chrome = {
    runtime: { id: 'test-extension', getManifest: () => ({ version: manifest.version }), getURL: (p) => `chrome-extension://test-extension/${p}`, onMessage: event('message'),
      sendMessage: async (msg) => {
        if (msg.to !== 'offscreen') return;
        if (msg.type === 'blob-begin') blobs.set(msg.token, []);
        if (msg.type === 'blob-chunk') blobs.get(msg.token).push(msg.text);
        if (msg.type === 'blob-end') return { ok: true, url: `blob:${msg.token}` };
        if (msg.type === 'blob-release') blobs.delete(msg.token);
        return { ok: true };
      } },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    offscreen: { hasDocument: async () => doc, createDocument: async () => { doc = true; }, closeDocument: async () => { doc = false; } },
    debugger: { onEvent: event('debuggerEvent'), onDetach: event('debuggerDetach'),
      attach: async (source) => { if (options.attach) await options.attach(source); attached.add(source.tabId); },
      detach: async (source) => { detachCalls.push(source.tabId); attached.delete(source.tabId); L.debuggerDetach(source); },
      sendCommand: async (source, method, params) => {
        commands.push({ source, method, params });
        if (options.command) { const result = await options.command(source, method, params); if (result !== undefined) return result; }
        return method === 'Network.getResponseBody' ? { body: '{"ok":true}', base64Encoded: false } : {};
      } },
    tabs: { get: async (id) => ({ id, title: `标题-${id}`, url: `https://example.test/${id}` }), onCreated: event('tabsCreated') },
    webNavigation: { onCreatedNavigationTarget: event('navTarget'), onCommitted: event('navCommitted') },
    downloads: { onChanged: event('downloadChanged'),
      download: async (spec) => {
        const json = blobs.get(spec.url.slice(5)).join('');
        writes.push({ json, har: JSON.parse(json), spec });
        if (options.download) return options.download(spec, json, L, downloads);
        const id = ++downloadId;
        downloads.set(id, { id, state: 'complete' });
        L.downloadChanged({ id, state: { current: 'complete' } });
        return id;
      }, search: async ({ id }) => downloads.has(id) ? [downloads.get(id)] : [],
    },
  };
  const HarFs = {
    getFollowNewTabs: async () => settings.get('followNewTabs') ?? true,
    setFollowNewTabs: async (v) => settings.set('followNewTabs', v),
    getSetting: async (k, d) => settings.get(k) ?? d,
    setSetting: async (k, v) => { if (options.setSetting) await options.setSetting(k, v); settings.set(k, v); stored.push({ k, v }); },
    getTarget: async () => options.target || { mode: 'ask' },
    getFolder: async () => options.folder,
    queryPermission: async () => options.permission || 'granted',
    writeText: async (handle, filename, json) => { if (options.write) await options.write(); writes.push({ har: JSON.parse(json), json, filename }); },
    touchFolder: noop,
  };
  const self = {};
  new Function('self', readFileSync(new URL('../payload-policy.js', import.meta.url), 'utf8'))(self);
  new Function('self', readFileSync(new URL('../capture.js', import.meta.url), 'utf8'))(self);
  new Function('self', readFileSync(new URL('../recent-export.js', import.meta.url), 'utf8'))(self);
  new Function('self', readFileSync(new URL('../resources.js', import.meta.url), 'utf8'))(self);
  const code = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const api = new Function('self', 'chrome', 'importScripts', 'HarFs', 'HarCapture', 'crypto', 'HarRecent', 'HarResources',
    `${code}\nreturn { state, startRecording, stopRecording, buildHar, maybeFollowNewTab, freezeRecording, status };`)
    (self, chrome, () => {}, HarFs, self.HarCapture, webcrypto, self.HarRecent, self.HarResources);
  return { chrome, L, attached, detachCalls, commands, writes, stored, blobs, HarFs, ...api };
}
export function emitRequest(L, tabId, requestId, url, extra = {}) {
  const source = { tabId, ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) };
  L.debuggerEvent(source, 'Network.requestWillBeSent', { requestId, request: { method: 'GET', url, headers: {}, ...extra.request }, wallTime: 1700000000, timestamp: 1 });
  L.debuggerEvent(source, 'Network.responseReceived', { requestId, response: { status: 200, headers: {}, mimeType: 'application/json', ...extra.response }, hasExtraInfo: false, timestamp: 2 });
  L.debuggerEvent(source, 'Network.loadingFinished', { requestId, timestamp: 3, encodedDataLength: 10 });
}
export function loadCapture(options = {}, send = async () => ({ body: '{}', base64Encoded: false })) {
  const self = {};
  new Function('self', readFileSync(new URL('../payload-policy.js', import.meta.url), 'utf8'))(self);
  new Function('self', readFileSync(new URL('../capture.js', import.meta.url), 'utf8'))(self);
  return new self.HarCapture(send, options);
}
export function request(c, id = 'r', source = { tabId: 1 }, request = {}) {
  c.handle(source, 'Network.requestWillBeSent', { requestId: id, request: { method: 'GET', url: `https://example.test/${id}`, headers: {}, ...request }, wallTime: 1700000000, timestamp: 1 });
}
export function response(c, id = 'r', source = { tabId: 1 }, r = {}, extra = false) {
  c.handle(source, 'Network.responseReceived', { requestId: id, response: { status: 200, headers: {}, mimeType: 'application/json', ...r }, hasExtraInfo: extra, timestamp: 2 });
}
export function finish(c, id = 'r', source = { tabId: 1 }) {
  c.handle(source, 'Network.loadingFinished', { requestId: id, timestamp: 3, encodedDataLength: 20 });
}
