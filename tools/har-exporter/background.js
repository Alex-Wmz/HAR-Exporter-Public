// Recording lifecycle and export. HAR payloads stay in memory until the user saves.
importScripts('export-config.js', 'fs-store.js', 'payload-policy.js', 'capture.js', 'recent-export.js', 'resources.js');

const VERSION = chrome.runtime.getManifest().version;
const state = {
  phase: 'idle', recording: false, primaryTabId: null, tabIds: new Set(), tabInfo: new Map(),
  attaching: new Map(), sessions: new Set(), tasks: new Set(), capture: null,
  followNewTabs: true, includeMedia: false, reason: '', lastResult: null, generation: 0,
};
let keepalivePromise = null;
let freezePromise = null;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function timeout(promise, ms = 8000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('操作超时')), ms);
  })]).finally(() => clearTimeout(timer));
}
const command = (source, method, params = {}) => timeout(chrome.debugger.sendCommand(source, method, params));
function status() {
  return { phase: state.phase, recording: state.recording, count: state.capture?.entries.length || 0,
    tabs: state.tabIds.size, tabId: state.primaryTabId, followNewTabs: state.followNewTabs,
    includeMedia: state.includeMedia, reason: state.reason, lastResult: state.lastResult, stats: state.capture?.summary() || null };
}
function broadcastCount() {
  const st = status();
  const loss = st.stats?.lostResponseBodies || st.stats?.lostRequestBodies;
  if (state.phase === 'recording' || state.phase === 'ready') {
    chrome.action.setBadgeText({ text: loss ? '!' : state.phase === 'ready' ? 'SAVE' : 'REC' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: loss ? '#b06000' : '#e74c3c' }).catch(() => {});
  }
  chrome.runtime.sendMessage({ type: 'status', ...st }).catch(() => {});
}
let broadcastTimer;
function scheduleCount() {
  if (!broadcastTimer) broadcastTimer = setTimeout(() => { broadcastTimer = null; broadcastCount(); }, 150);
}
function setPhase(phase) {
  state.phase = phase;
  state.recording = phase === 'recording';
  chrome.action.setBadgeText({ text: ({ recording: 'REC', stopping: '…', exporting: '…', ready: 'SAVE' })[phase] || '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: phase === 'recording' ? '#e74c3c' : '#b06000' }).catch(() => {});
  broadcastCount();
}
async function ensureKeepalive() {
  if (!keepalivePromise) keepalivePromise = (async () => {
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS'],
      justification: '为 HAR 导出创建 Blob，并在录制、等待保存期间保持内存数据可用',
    });
  })().finally(() => { keepalivePromise = null; });
  return keepalivePromise;
}
async function releaseKeepalive() {
  try { if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument(); } catch {}
}
function track(promise) {
  state.tasks.add(promise);
  promise.finally(() => state.tasks.delete(promise)).catch(() => {});
  return promise;
}
async function enableSession(source) {
  await command(source, 'Network.enable', { maxPostDataSize: 1024 * 1024,
    maxResourceBufferSize: 12 * 1024 * 1024, maxTotalBufferSize: 64 * 1024 * 1024 });
  // Only child frames and dedicated workers belonging to this tab. Do not
  // attach to shared/service workers that may serve unrelated tabs.
  try {
    await command(source, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false,
      flatten: true, filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }] });
  } catch { state.capture?.warnings.add('child-targets-unavailable'); }
}
async function attachTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  if (state.attaching.has(tabId)) return state.attaching.get(tabId);
  if (state.tabIds.has(tabId)) return true;
  const generation = state.generation;
  const task = (async () => {
    let attached = false;
    let abandoned = false;
    try {
      const attaching = chrome.debugger.attach({ tabId }, '1.3');
      attaching.then(async () => {
        if (abandoned) { try { await chrome.debugger.detach({ tabId }); } catch {} }
      }).catch(() => {});
      await timeout(attaching);
      attached = true;
      if (generation !== state.generation || !['starting', 'recording'].includes(state.phase)) {
        await chrome.debugger.detach({ tabId });
        return false;
      }
      // Register before Network.enable: events can arrive before its callback.
      state.tabIds.add(tabId);
      try {
        const tab = await timeout(chrome.tabs.get(tabId));
        state.tabInfo.set(tabId, { title: tab.title || '', url: tab.url || '' });
      } catch {}
      await enableSession({ tabId });
      return true;
    } catch {
      abandoned = true;
      state.tabIds.delete(tabId);
      if (attached) { try { await chrome.debugger.detach({ tabId }); } catch {} }
      return false;
    }
  })();
  state.attaching.set(tabId, task);
  try { return await task; } finally { if (state.attaching.get(tabId) === task) state.attaching.delete(tabId); }
}
async function detachAllTabs() {
  const ids = [...state.tabIds];
  state.tabIds.clear();
  state.sessions.clear();
  await Promise.all(ids.map(async (tabId) => { try { await timeout(chrome.debugger.detach({ tabId })); } catch {} }));
}
async function maybeFollowNewTab(sourceTabId, newTabId, url) {
  if (state.phase !== 'recording' || !state.followNewTabs) return;
  if (!state.tabIds.has(sourceTabId) && !state.attaching.has(sourceTabId)) return;
  if (!Number.isInteger(newTabId) || newTabId < 0) return;
  if (state.attaching.has(sourceTabId)) await state.attaching.get(sourceTabId);
  if (state.phase !== 'recording' || !state.followNewTabs || !state.tabIds.has(sourceTabId)) return;
  if (url) state.tabInfo.set(newTabId, { url });
  if (!await attachTab(newTabId)) state.capture?.warnings.add('new-tab-attach-failed');
  broadcastCount();
}
async function startRecording(tabId) {
  if (state.phase !== 'idle') return { ok: false, error: state.phase === 'ready' ? '请先导出或放弃上一轮数据' : '当前操作尚未结束' };
  if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, error: '无效标签页' };
  setPhase('starting');
  state.lastResult = null;
  state.reason = '';
  state.generation++;
  state.primaryTabId = tabId;
  state.tabInfo.clear();
  state.capture = new HarCapture(command, {}, scheduleCount);
  try {
    state.followNewTabs = await HarFs.getFollowNewTabs().catch(() => true);
    state.includeMedia = await HarFs.getSetting('includeMedia', false).catch(() => false);
    state.capture.options.includeMedia = state.includeMedia;
    await ensureKeepalive();
    const attached = await attachTab(tabId);
    if (state.phase !== 'starting') {
      if (freezePromise) await freezePromise;
      return { ok: false, error: '调试连接在启动时断开，请检查待导出数据' };
    }
    if (!attached) throw new Error('无法附加调试器：请使用普通网页，并关闭该页开发者工具或其他调试扩展');
    setPhase('recording');
    return { ok: true };
  } catch (e) {
    await detachAllTabs();
    state.capture = null;
    state.primaryTabId = null;
    await releaseKeepalive();
    setPhase('idle');
    return { ok: false, error: e.message };
  }
}
async function freezeRecording(reason = 'user-stop') {
  if (freezePromise) return freezePromise;
  if (!['recording', 'starting'].includes(state.phase)) return;
  state.reason = reason;
  setPhase('stopping');
  state.capture.accepting = false;
  freezePromise = (async () => {
    await Promise.allSettled([...state.attaching.values(), ...state.tasks]);
    await state.capture.settle();
    await detachAllTabs();
    setPhase('ready');
  })();
  try { await freezePromise; } finally { freezePromise = null; }
}
function buildHar() {
  const first = new Map();
  for (const e of state.capture.entries) if (!first.has(e.tabId)) first.set(e.tabId, e.data.startedDateTime);
  const pages = [...first].map(([tabId, startedDateTime]) => {
    const info = state.tabInfo.get(tabId) || {};
    let host = '';
    try { host = new URL(info.url).host; } catch {}
    return { id: `tab_${tabId}`, startedDateTime, title: info.title || host || `标签页 ${tabId}`,
      pageTimings: { onContentLoad: -1, onLoad: -1 } };
  });
  return state.capture.build(pages, VERSION, state.reason);
}
function buildFilename() {
  const title = (state.tabInfo.get(state.primaryTabId)?.title || 'page').replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').slice(0, 40).replace(/[. ]+$/g, '') || 'page';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `HAR_${title}_${ts}_${crypto.randomUUID().slice(0, 8)}.har`;
}
async function blobMessage(msg) {
  const res = await chrome.runtime.sendMessage({ to: 'offscreen', ...msg });
  if (!res?.ok) throw new Error(res?.error || '无法创建导出文件');
  return res;
}
async function downloadHar(json, filename) {
  await ensureKeepalive();
  const token = crypto.randomUUID();
  let listener;
  try {
    await blobMessage({ type: 'blob-begin', token });
    // Chrome message size is bounded. UTF-16 chunks are joined before Blob encoding.
    for (let i = 0; i < json.length; i += 512 * 1024) await blobMessage({ type: 'blob-chunk', token, text: json.slice(i, i + 512 * 1024) });
    const { url } = await blobMessage({ type: 'blob-end', token });
    let downloadId;
    const early = new Map();
    let resolveDone, rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    done.catch(() => {}); // completion can precede downloads.search
    // Install before calling download, because small downloads may complete early.
    const check = (id, value) => {
      if (id !== downloadId) { if (downloadId === undefined && early.size < 32) early.set(id, value); return; }
      if (value.state === 'complete') resolveDone();
      if (value.state === 'interrupted' || value.error) rejectDone(new Error(value.error || '下载已取消或中断'));
    };
    listener = (d) => check(d.id, { state: d.state?.current, error: d.error?.current });
    chrome.downloads.onChanged.addListener(listener);
    downloadId = await chrome.downloads.download({ url, filename: `HARExports/${filename}`, saveAs: true, conflictAction: 'uniquify' });
    if (!Number.isInteger(downloadId)) throw new Error('浏览器未创建下载任务');
    if (early.has(downloadId)) check(downloadId, early.get(downloadId));
    const items = await chrome.downloads.search({ id: downloadId });
    if (items[0]) check(downloadId, items[0]);
    await done;
    // The user may rename the file in Save As. Query its final path after completion.
    const [completed] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
    const fullPath = completed?.filename || '';
    return { downloadId, fullPath, filename: fullPath ? fullPath.split(/[\\/]/).pop() : filename };
  } finally {
    if (listener) chrome.downloads.onChanged.removeListener(listener);
    await blobMessage({ type: 'blob-release', token }).catch(() => {});
  }
}
async function exportHarViaDownload(json, filename, fallbackReason) {
  const location = await downloadHar(json, filename);
  return { method: 'downloads', fallbackReason, ...location };
}
async function exportHar(json, filename) {
  let target;
  try { target = await HarFs.getTarget(); } catch {
    if (HarFs.DEFAULT_FOLDER_PATH) throw new Error('无法读取保存设置，请重新打开插件检查默认目录授权');
    return exportHarViaDownload(json, filename, 'store-unavailable');
  }
  if (target?.mode === 'default') throw new Error('请先在插件中选择并授权默认目录 ' + HarFs.DEFAULT_FOLDER_PATH);
  if (target?.mode !== 'folder' || !target.folderId) return exportHarViaDownload(json, filename, null);
  let folder;
  try { folder = await HarFs.getFolder(target.folderId); } catch {
    if (target.defaultFolder) throw new Error('无法读取默认目录记录，请重新授权 ' + HarFs.DEFAULT_FOLDER_PATH);
    return exportHarViaDownload(json, filename, 'store-unavailable');
  }
  if (target.defaultFolder) {
    if (!folder?.handle || await HarFs.queryPermission(folder.handle) !== 'granted') {
      throw new Error('默认目录需要重新授权：' + HarFs.DEFAULT_FOLDER_PATH);
    }
    try { await HarFs.writeText(folder.handle, filename, json); }
    catch { throw new Error('默认目录写入失败，请检查目录和权限：' + HarFs.DEFAULT_FOLDER_PATH); }
    await HarFs.touchFolder(folder.id).catch(() => {});
    return { method: 'folder', folderId: folder.id, folderName: HarFs.DEFAULT_FOLDER_PATH };
  }
  if (!folder?.handle) return exportHarViaDownload(json, filename, 'folder-missing');
  if (await HarFs.queryPermission(folder.handle) !== 'granted') return exportHarViaDownload(json, filename, 'no-permission');
  try { await HarFs.writeText(folder.handle, filename, json); } catch { return exportHarViaDownload(json, filename, 'write-failed'); }
  await HarFs.touchFolder(folder.id).catch(() => {});
  return { method: 'folder', folderId: folder.id, folderName: folder.label || folder.name };
}
async function discardRecording() {
  if (!['recording', 'ready'].includes(state.phase)) return { ok: false, error: '当前操作尚未结束' };
  setPhase('stopping');
  state.generation++;
  state.capture.freeze('discarded');
  await Promise.allSettled([...state.attaching.values(), ...state.tasks]);
  await detachAllTabs();
  state.capture = null;
  state.primaryTabId = null;
  state.tabInfo.clear();
  state.lastResult = null;
  state.reason = '';
  await releaseKeepalive();
  setPhase('idle');
  return { ok: true, exported: false };
}
async function stopRecording(exportFile = true) {
  if (!exportFile) return discardRecording();
  if (!['recording', 'ready'].includes(state.phase)) return { ok: false, error: '当前未录制或导出正在进行' };
  if (state.phase === 'recording') await freezeRecording();
  setPhase('exporting');
  try {
    const { har, ...counts } = buildHar();
    const filename = buildFilename();
    const saved = await exportHar(JSON.stringify(har, null, 1), filename);
    const result = { ok: true, exported: true, ...counts, filename, ...saved };
    result.recentExport = HarRecent.record(saved, filename);
    // The file is already saved: a metadata failure must never trigger a duplicate export.
    try { await HarFs.setSetting(HarRecent.KEY, result.recentExport); }
    catch { result.locationWarning = '文件已保存，但未能记住最近保存位置；请保留本次文件名。'; }
    state.lastResult = result;
    state.capture = null;
    state.primaryTabId = null;
    state.tabInfo.clear();
    await releaseKeepalive();
    setPhase('idle');
    return result;
  } catch (e) {
    state.lastResult = { ok: false, error: `导出未完成：${e.message}。数据已保留，可再次导出。` };
    setPhase('ready');
    return state.lastResult;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!['starting', 'recording', 'stopping'].includes(state.phase) || !state.tabIds.has(source.tabId)) return;
  if (method === 'Target.attachedToTarget') {
    if (state.phase === 'stopping') return;
    const child = { tabId: source.tabId, sessionId: params.sessionId };
    state.sessions.add(JSON.stringify([child.tabId, child.sessionId]));
    track(enableSession(child).catch(() => state.capture?.warnings.add('child-target-enable-failed')));
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    state.capture.markDetached(source.tabId, params.sessionId);
    state.sessions.delete(JSON.stringify([source.tabId, params.sessionId]));
    return;
  }
  if (source.sessionId && !state.sessions.has(JSON.stringify([source.tabId, source.sessionId]))) return;
  try { state.capture.handle(source, method, params); } catch { state.capture.warnings.add('protocol-event-error'); }
  scheduleCount();
  if (!state.capture.accepting && state.phase === 'recording') freezeRecording('capture-limit').catch(() => {});
});
chrome.debugger.onDetach.addListener((source) => {
  if (!state.tabIds.has(source.tabId)) return;
  state.tabIds.delete(source.tabId);
  state.capture?.markDetached(source.tabId);
  if (source.tabId === state.primaryTabId && ['recording', 'starting'].includes(state.phase)) freezeRecording('primary-tab-detached').catch(() => {});
  else broadcastCount();
});
chrome.tabs.onCreated.addListener((tab) => { track(maybeFollowNewTab(tab?.openerTabId, tab?.id).catch(() => {})); });
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => { track(maybeFollowNewTab(d?.sourceTabId, d?.tabId, d?.url).catch(() => {})); });
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d?.frameId === 0 && d.url && state.tabIds.has(d.tabId)) {
    const info = state.tabInfo.get(d.tabId) || {};
    state.tabInfo.set(d.tabId, { ...info, url: d.url });
  }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to === 'offscreen') return false;
  // Only this extension's pages can control recording; no content scripts exist.
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    try {
      if (msg.type === 'keepalive') {
        sendResponse({ ok: true });
        if (state.phase === 'idle') await releaseKeepalive();
      } else if (msg.type === 'getResources' || msg.type === 'getResourceBody') {
        if (sender.url !== chrome.runtime.getURL('resources.html') || sender.tab?.id === state.primaryTabId) {
          throw new Error('资源请求来源无效');
        }
        if (msg.type === 'getResources') {
          const entries = ['recording', 'ready'].includes(state.phase) ? state.capture?.entries || [] : [];
          sendResponse({ ok: true, generation: state.generation, phase: state.phase, ...HarResources.index(entries) });
        } else {
          if (!['recording', 'ready'].includes(state.phase) || !state.capture || msg.generation !== state.generation) throw new Error('录制数据已变化，请刷新资源列表');
          if (typeof msg.id !== 'string' || !/^(0|[1-9]\d{0,4})$/.test(msg.id)) throw new Error('无效资源 ID');
          sendResponse({ ok: true, generation: state.generation, body: HarResources.body(state.capture.entries[Number(msg.id)], msg.id) });
        }
      } else if (msg.type === 'getStatus') {
        if (state.phase === 'idle') {
          state.followNewTabs = await HarFs.getFollowNewTabs().catch(() => true);
          state.includeMedia = await HarFs.getSetting('includeMedia', false).catch(() => false);
        }
        sendResponse(status());
      } else if (msg.type === 'setFollowNewTabs') {
        await HarFs.setFollowNewTabs(!!msg.value);
        state.followNewTabs = !!msg.value;
        sendResponse({ ok: true });
      } else if (msg.type === 'setIncludeMedia') {
        if (state.phase !== 'idle') throw new Error('请在下一轮开始前修改此设置');
        await HarFs.setSetting('includeMedia', !!msg.value);
        state.includeMedia = !!msg.value;
        sendResponse({ ok: true });
      } else if (msg.type === 'start') sendResponse(await startRecording(msg.tabId));
      else if (msg.type === 'stop') sendResponse(await stopRecording());
      else if (msg.type === 'cancel') sendResponse(await discardRecording());
      else sendResponse({ ok: false, error: '未知操作' });
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
  })();
  return true;
});
