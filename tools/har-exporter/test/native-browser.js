document.getElementById('run').addEventListener('click', async () => {
  const results = document.getElementById('results');
  results.replaceChildren();
  let passed = 0, failed = 0;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  async function test(name, fn) {
    const li = document.createElement('li'); results.appendChild(li);
    try { await fn(); li.textContent = '通过：' + name; li.className = 'pass'; passed++; }
    catch (e) { li.textContent = '失败：' + name + ' — ' + e.message; li.className = 'fail'; failed++; }
  }
  await test('原生 IndexedDB 设置提交后可读，不需要 schema 升级', async () => {
    await HarFs.setFollowNewTabs(false);
    assert(await HarFs.getFollowNewTabs() === false, 'setting not committed');
    await HarFs.setFollowNewTabs(true);
    assert(await HarFs.getFollowNewTabs() === true, 'second setting not committed');
  });
  await test('原生目录句柄可经 IndexedDB 克隆，写入中文 HAR 后逐字读回一致', async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('har-exporter-test', { create: true });
    const folder = await HarFs.saveFolder(dir, 'Synthetic OPFS fixture');
    const restored = await HarFs.getFolder(folder.id);
    assert(await restored.handle.isSameEntry(dir), 'handle clone mismatch');
    const filename = 'test-' + crypto.randomUUID() + '.har';
    const text = JSON.stringify({ text: '中文😀', marker: 'SYNTHETIC_ONLY_123' });
    await HarFs.writeText(restored.handle, filename, text);
    const file = await (await dir.getFileHandle(filename)).getFile();
    assert(await file.text() === text, 'saved bytes mismatch');
    assert(!JSON.stringify(await HarFs.listFolders()).includes('SYNTHETIC_ONLY_123'), 'payload found in settings database');
    await HarFs.setTarget({ mode: 'ask' });
  });
  await test('真实 Blob 多块拼接保留跨块 emoji，释放后 URL 失效', async () => {
    const frame = document.getElementById('offscreen').contentWindow;
    const token = crypto.randomUUID();
    const send = (msg) => frame.fixtureMessage({ to: 'offscreen', token, ...msg });
    assert((await send({ type: 'blob-begin' })).ok, 'begin failed');
    const text = '{"中文":"😀"}';
    const split = text.indexOf('😀') + 1;
    await send({ type: 'blob-chunk', text: text.slice(0, split) });
    await send({ type: 'blob-chunk', text: text.slice(split) });
    const blob = await send({ type: 'blob-end' });
    assert(blob.ok, 'end failed');
    assert(await (await fetch(blob.url)).text() === text, 'UTF-16 split corrupted');
    await send({ type: 'blob-release' });
    let invalid = false;
    try { await fetch(blob.url); } catch { invalid = true; }
    assert(invalid, 'URL not released');
  });
  await test('浏览器中 2,000 条混合请求并发录制，HAR 可序列化、条数与正文一致', async () => {
    const c = new HarCapture(async (source, method, p) => ({ body: '中文-' + p.requestId }));
    for (let i = 0; i < 2000; i++) {
      const source = { tabId: i % 3 + 1 }; const requestId = String(i);
      c.handle(source, 'Network.requestWillBeSent', { requestId, timestamp: 1, wallTime: 1700000000, request: { method: 'GET', url: 'https://example.test/' + i, headers: {} } });
      c.handle(source, 'Network.responseReceived', { requestId, timestamp: 2, hasExtraInfo: false, response: { status: 200, mimeType: 'application/json', headers: {} } });
      c.handle(source, 'Network.loadingFinished', { requestId, timestamp: 3 });
    }
    await c.settle(5000);
    const built = c.build([1, 2, 3].map((i) => ({ id: 'tab_' + i })), '1.4.3', 'test');
    const readback = JSON.parse(JSON.stringify(built.har));
    assert(readback.log.entries.length === 2000, 'entry loss');
    assert(built.withBody === 2000, 'body loss');
    assert(readback.log.entries[1999].response.content.text === '中文-1999', 'body mismatch');
  });
  document.getElementById('summary').textContent = `${passed} 项通过，${failed} 项失败`;
});
