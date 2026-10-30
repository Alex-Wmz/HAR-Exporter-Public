// Multi-tab lifecycle regression tests. Chrome APIs are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness as loadBackground, flush, emitRequest } from './harness.mjs';

// ---------- 测试 ----------

test('A. 同标签页内跳转后仍在录制（调试会话跟随标签，不丢后续请求）', async () => {
  const h = loadBackground();
  assert.equal((await h.startRecording(1)).ok, true);
  await flush();
  emitRequest(h.L, 1, 'r1', 'https://shop.example/step1');
  await flush();
  emitRequest(h.L, 1, 'r2', 'https://shop.example/step2'); // 同标签内跳转
  await flush();

  const { count } = await h.buildHar();
  assert.equal(count, 2);
  await h.stopRecording(false);
});

test('B. 由已录制标签页打开的新标签页会被自动附加并录进同一份 HAR', async () => {
  const h = loadBackground();
  await h.startRecording(1);
  await flush();
  emitRequest(h.L, 1, 'r1', 'https://shop.example/main');
  await flush();

  // webNavigation 路径（覆盖 rel=noopener）
  h.L.navTarget({ sourceTabId: 1, tabId: 2, url: 'https://pay.example/3ds' });
  await flush();
  assert.ok(h.attached.has(2), '新标签页 2 应被附加调试器');

  emitRequest(h.L, 2, 'r2', 'https://pay.example/api/confirm');
  await flush();

  const { har, count, tabs } = await h.buildHar();
  assert.equal(count, 2, '两个标签页的请求都应入 HAR');
  assert.equal(tabs, 2);
  assert.equal(har.log.pages.length, 2, '每个标签页应对应一个 page');
  await h.stopRecording(false);
});

test('B2. tabs.onCreated 的 openerTabId 路径同样能跟随（无需额外权限的兜底信号）', async () => {
  const h = loadBackground();
  await h.startRecording(1);
  await flush();

  h.L.tabsCreated({ id: 5, openerTabId: 1 });
  await flush();
  assert.ok(h.attached.has(5), 'openerTabId 指向已录制标签时应附加');
  await h.stopRecording(false);
});

test('B3. 链式跟随：新标签再开新标签也一并录制', async () => {
  const h = loadBackground();
  await h.startRecording(1);
  await flush();
  h.L.navTarget({ sourceTabId: 1, tabId: 2, url: 'https://pay.example/3ds' });
  await flush();
  h.L.navTarget({ sourceTabId: 2, tabId: 3, url: 'https://bank.example/otp' });
  await flush();

  assert.ok(h.attached.has(2) && h.attached.has(3), '链式新标签都应被附加');
  await h.stopRecording(false);
});

test('C. 与录制无关的标签页不会被附加（避免误录其他浏览）', async () => {
  const h = loadBackground();
  await h.startRecording(1);
  await flush();

  h.L.navTarget({ sourceTabId: 99, tabId: 4, url: 'https://other.example/' }); // 99 未被录制
  await flush();
  assert.equal(h.attached.has(4), false, '来源不是已录制标签页时不应附加');

  emitRequest(h.L, 4, 'rx', 'https://other.example/x');
  await flush();
  const { count } = await h.buildHar();
  assert.equal(count, 0, '未附加标签页的请求不应进入 HAR');
  await h.stopRecording(false);
});

test('D. 关闭跟随的新标签页，主录制继续；关闭主标签页则整轮结束', async () => {
  const h = loadBackground();
  await h.startRecording(1);
  await flush();
  h.L.navTarget({ sourceTabId: 1, tabId: 2, url: 'https://pay.example/' });
  await flush();

  // 模拟关闭新标签页 2（onDetach）
  h.attached.delete(2);
  h.L.debuggerDetach({ tabId: 2 });
  await flush();
  assert.equal(h.state.recording, true, '关闭跟随的新标签不应停止整轮录制');
  assert.equal(h.state.tabIds.has(2), false);

  emitRequest(h.L, 1, 'r1', 'https://shop.example/after');
  await flush();
  assert.equal((await h.buildHar()).count, 1, '主标签仍能继续录');

  // 关闭主标签页 1
  h.attached.delete(1);
  h.L.debuggerDetach({ tabId: 1 });
  await flush();
  assert.equal(h.state.recording, false, '主标签页分离应结束整轮录制');
  assert.equal(h.state.tabIds.size, 0, '所有标签都应被清理');
});

test('E. 关闭「跟随新标签页」开关后，新标签不再被纳入', async () => {
  const h = loadBackground();
  await h.HarFs.setFollowNewTabs(false);
  await h.startRecording(1);
  await flush();
  assert.equal(h.state.followNewTabs, false, '启动时应从持久化设置读取开关');

  h.L.navTarget({ sourceTabId: 1, tabId: 7, url: 'https://pay.example/' });
  await flush();
  assert.equal(h.attached.has(7), false, '关闭开关后不应附加新标签');
  await h.stopRecording(false);
});

test('F. HAR 结构：每个标签页一个 page，条目 pageref 必须指向存在的 page', async () => {
  const h = loadBackground();
  await h.startRecording(1);
  await flush();
  emitRequest(h.L, 1, 'r1', 'https://shop.example/main');
  await flush();
  h.L.navTarget({ sourceTabId: 1, tabId: 2, url: 'https://pay.example/3ds' });
  await flush();
  emitRequest(h.L, 2, 'r2', 'https://pay.example/api/confirm');
  emitRequest(h.L, 2, 'r3', 'https://pay.example/api/done');
  await flush();

  const { har } = await h.buildHar();
  const pageIds = new Set(har.log.pages.map((p) => p.id));
  assert.equal(pageIds.size, 2);
  for (const p of har.log.pages) {
    assert.ok(p.id && p.title && p.startedDateTime, 'page 应含 id/title/startedDateTime');
    assert.ok(p.pageTimings, 'page 应含 pageTimings');
  }
  assert.equal(har.log.entries.length, 3);
  const byPage = {};
  for (const e of har.log.entries) {
    assert.ok(pageIds.has(e.pageref), `pageref 必须指向存在的 page，实际 ${e.pageref}`);
    byPage[e.pageref] = (byPage[e.pageref] || 0) + 1;
  }
  assert.deepEqual(Object.values(byPage).sort(), [1, 2], '两个标签页分别录到 1 条与 2 条');
  // 内部字段不得外泄
  for (const e of har.log.entries) assert.equal(e._tabId, undefined);
  await h.stopRecording(false);
});
