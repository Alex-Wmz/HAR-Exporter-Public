'use strict';
let phase = 'idle', capture = null, primary = null, reason = '', lastResult = null;
let tabs = new Map(), follow = true, includeMedia = false;
const settingsReady = browser.storage.local.get({ follow: true, includeMedia: false }).then((s) => {
  follow = s.follow; includeMedia = s.includeMedia;
});
function status() { return { phase, count: capture?.entries.length || 0, tabs: tabs.size, follow, includeMedia, reason, lastResult, stats: capture?.summary() || null }; }
function badge() {
  const s = capture?.summary();
  const loss = s?.lostResponseBodies || s?.lostRequestBodies;
  const text = loss && ['recording', 'ready'].includes(phase) ? '!' : ({ recording: 'REC', stopping: '…', exporting: '…', ready: 'SAVE' })[phase] || '';
  browser.browserAction.setBadgeText({ text }).catch(() => {});
}
let badgeTimer;
function scheduleBadge() { if (!badgeTimer) badgeTimer = setTimeout(() => { badgeTimer = null; badge(); }, 150); }
async function freeze(why) {
  if (phase !== 'recording') return;
  phase = 'stopping'; reason = why; badge();
  await capture.settle(); phase = 'ready'; badge();
}
function dispatch(method, d, ...args) {
  if (!capture || !['recording', 'stopping'].includes(phase)) return;
  try {
    if (method === 'before' && (!tabs.has(d.tabId) || phase !== 'recording')) return;
    capture[method](d, ...args);
    scheduleBadge();
    if (!capture.accepting && phase === 'recording') freeze('capture-limit').catch(() => {});
  } catch { capture.warnings.add('capture-event-error'); }
}
const urls = { urls: ['<all_urls>'] };
browser.webRequest.onBeforeRequest.addListener((d) => { dispatch('before', d); return {}; }, urls, ['blocking', 'requestBody']);
browser.webRequest.onSendHeaders.addListener((d) => dispatch('requestHeaders', d), urls, ['requestHeaders']);
browser.webRequest.onHeadersReceived.addListener((d) => dispatch('responseHeaders', d), urls, ['responseHeaders']);
browser.webRequest.onCompleted.addListener((d) => dispatch('complete', d), urls);
browser.webRequest.onBeforeRedirect.addListener((d) => dispatch('complete', d, true), urls);
browser.webRequest.onErrorOccurred.addListener((d) => dispatch('complete', d, false, true), urls);
function followTab(parent, id) {
  if (phase === 'recording' && follow && tabs.has(parent) && Number.isInteger(id) && id >= 0) tabs.set(id, { title: '' });
}
browser.tabs.onCreated.addListener((t) => followTab(t.openerTabId, t.id));
browser.webNavigation.onCreatedNavigationTarget.addListener((d) => followTab(d.sourceTabId, d.tabId));
browser.tabs.onUpdated.addListener((id, change) => { if (tabs.has(id) && change.title) tabs.set(id, { title: change.title }); });
browser.tabs.onRemoved.addListener((id) => { if (id === primary && phase === 'recording') freeze('primary-tab-closed').catch(() => {}); });
async function save(json, filename) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/octet-stream' }));
  let id, listener, resolveDone, rejectDone;
  const early = new Map();
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  done.catch(() => {});
  function check(key, value) {
    if (id === undefined) { if (early.size < 32) early.set(key, value); return; }
    if (key !== id) return;
    if (value.state === 'complete') resolveDone();
    if (value.state === 'interrupted' || value.error) rejectDone(new Error(value.error || '保存被取消'));
  }
  try {
    listener = (d) => check(d.id, { state: d.state?.current, error: d.error?.current });
    browser.downloads.onChanged.addListener(listener);
    id = await browser.downloads.download({ url, filename, saveAs: true, conflictAction: 'uniquify' });
    if (!Number.isInteger(id)) throw new Error('未创建下载任务');
    if (early.has(id)) check(id, early.get(id));
    const [item] = await browser.downloads.search({ id }); if (item) check(id, item);
    await done;
  } finally { if (listener) browser.downloads.onChanged.removeListener(listener); URL.revokeObjectURL(url); }
}
browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  return (async () => {
    await settingsReady;
    if (msg.type === 'status') return status();
    if (msg.type === 'settings') {
      if (phase !== 'idle') throw new Error('请在下一轮录制前修改设置');
      await browser.storage.local.set({ follow: !!msg.follow, includeMedia: !!msg.includeMedia });
      follow = !!msg.follow; includeMedia = !!msg.includeMedia; return status();
    }
    if (msg.type === 'start') {
      if (phase !== 'idle') throw new Error('请先导出或放弃上一轮数据');
      phase = 'starting'; lastResult = null; reason = '';
      try {
        const tab = await browser.tabs.get(msg.tabId);
        if (!/^https?:/i.test(tab.url || '')) throw new Error('请切换到普通 HTTP/HTTPS 网页');
        capture = new FirefoxCapture(browser, { includeMedia }, scheduleBadge); primary = tab.id;
        tabs = new Map([[tab.id, { title: tab.title || '' }]]); phase = 'recording'; badge(); return status();
      } catch (e) { phase = 'idle'; throw e; }
    }
    if (msg.type === 'discard') {
      if (!['recording', 'ready'].includes(phase)) throw new Error('请等待当前操作结束');
      capture.freeze(); capture = null; tabs.clear(); primary = null; lastResult = null; reason = ''; phase = 'idle'; badge(); return status();
    }
    if (msg.type === 'stop') {
      if (!['recording', 'ready'].includes(phase)) throw new Error('请等待当前操作结束');
      if (phase === 'recording') await freeze('user-stop');
      phase = 'exporting'; badge();
      try {
        const har = capture.build(tabs, reason);
        const filename = `HAR_Firefox_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomUUID().slice(0, 8)}.har`;
        await save(JSON.stringify(har, null, 1), filename);
        lastResult = { ...har.log._capture, ok: true, filename };
        capture = null; tabs.clear(); primary = null; phase = 'idle'; badge(); return status();
      } catch (e) { phase = 'ready'; lastResult = { ok: false, error: `导出未完成：${e.message}。数据已保留，可重试。` }; badge(); return status(); }
    }
    throw new Error('未知操作');
  })().catch((e) => ({ error: e.message }));
});
