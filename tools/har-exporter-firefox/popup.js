'use strict';
const $ = (id) => document.getElementById(id);
let busy = false;
function render(s) {
  if (s.error) throw new Error(s.error);
  const working = busy || ['starting', 'stopping', 'exporting'].includes(s.phase);
  $('status').textContent = `${({ idle: '当前未录制', recording: '录制中', starting: '正在启动', stopping: '正在收齐响应', exporting: '等待保存完成', ready: '数据已保留，可再次导出' })[s.phase]} · ${s.count} 条请求 · ${s.tabs} 个标签页`;
  $('follow').checked = s.follow; $('media').checked = s.includeMedia;
  $('follow').disabled = $('media').disabled = s.phase !== 'idle' || working;
  $('start').hidden = s.phase !== 'idle'; $('start').disabled = working;
  $('stop').hidden = $('discard').hidden = s.phase === 'idle';
  $('stop').disabled = $('discard').disabled = working;
  $('stop').textContent = s.phase === 'ready' ? '导出已保留的数据' : '停止并导出 HAR';
  const info = HarPayload.describe(s.stats || (s.lastResult?.ok ? s.lastResult : null), !s.stats && s.lastResult?.ok);
  $('budgetStatus').textContent = info.budget;
  $('captureWarning').textContent = info.warning;
  $('captureWarning').hidden = !info.warning;
  if (s.lastResult) $('result').textContent = s.lastResult.ok ? `文件已保存：${s.lastResult.count} 条请求，${s.lastResult.nonEmptyBody} 条有非空响应。\n非空接口响应 ${s.lastResult.nonEmptyApiBody}/${s.lastResult.apiRequests}；网页正文 ${s.lastResult.nonEmptyDocumentBody || 0}/${s.lastResult.documentRequests || 0}；未完成 ${s.lastResult.incomplete} 条。\n缺失响应正文 ${s.lastResult.lostResponseBodies} 条、请求正文 ${s.lastResult.lostRequestBodies} 条。\n${s.lastResult.filename}` : s.lastResult.error;
}
async function refresh() { render(await browser.runtime.sendMessage({ type: 'status' })); }
async function run(task) {
  if (busy) return; busy = true; $('result').textContent = '';
  try { await refresh(); const result = await task(); if (result?.error) throw new Error(result.error); }
  catch (e) { $('result').textContent = e.message; }
  finally { busy = false; await refresh().catch(() => {}); }
}
$('start').onclick = () => run(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const res = await browser.runtime.sendMessage({ type: 'start', tabId: tab?.id });
  if (!res.error) window.close(); return res;
});
$('stop').onclick = () => run(() => browser.runtime.sendMessage({ type: 'stop' }));
$('discard').onclick = () => { if (confirm('放弃本轮未导出的数据？')) run(() => browser.runtime.sendMessage({ type: 'discard' })); };
for (const id of ['follow', 'media']) $(id).onchange = () => {
  const values = { type: 'settings', follow: $('follow').checked, includeMedia: $('media').checked };
  run(() => browser.runtime.sendMessage(values));
};
refresh().catch((e) => { $('result').textContent = e.message; });
setInterval(() => refresh().catch(() => {}), 500);
