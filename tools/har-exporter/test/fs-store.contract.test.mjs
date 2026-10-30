// fs-store.contract.test.mjs — fs-store.js 写盘目标与 PII 落盘边界的最小契约测试
//
// 关注点（对应 better-harness 发现 har-exporter-change-unchecked）：
//   A. 写盘目标：writeText 只能经「用户选定的目录句柄」按
//      getFileHandle(create:true) → createWritable → write → close 落盘；失败则 abort 且不残留。
//   B. PII 落盘边界：HAR 正文（含会话 Cookie、卡号、CVV、邮箱等）只落磁盘，
//      绝不写入扩展的 IndexedDB；IDB 里只保留文件夹元数据与设置（字段白名单）。
//   C. forgetFolder 只从 IDB 移除并回退目标，绝不删磁盘文件。
//
// 零依赖：自带最小 IndexedDB 假件与目录句柄假件，仅用 node:test / node:assert。
// 不发起任何真实浏览器/磁盘/网络操作，不改变扩展运行行为。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FS_STORE_PATH = fileURLToPath(new URL('../fs-store.js', import.meta.url));

// ---------- 最小 IndexedDB 假件（内存态，回调走微任务，模拟真实异步请求） ----------
function createFakeIndexedDB(opts = {}) {
  const databases = new Map(); // name -> { version, stores: Map<storeName, {keyPath, rows:Map}> }

  function makeRequest() {
    return { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: undefined, error: null };
  }
  // 在微任务里触发回调：此时 fs-store 的 promisify 已同步挂好 onsuccess/onerror
  function fire(req, compute) {
    queueMicrotask(() => {
      try { req.result = compute(); req.error = null; }
      catch (e) { req.error = e; req.result = undefined; }
      if (req.error) { if (typeof req.onerror === 'function') req.onerror({ target: req }); }
      else if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
    });
  }
  function storeView(store) {
    return {
      get(key) { const r = makeRequest(); fire(r, () => (store.rows.has(key) ? store.rows.get(key) : undefined)); return r; },
      getAll() { const r = makeRequest(); fire(r, () => [...store.rows.values()]); return r; },
      put(rec) { const r = makeRequest(); fire(r, () => { const k = rec[store.keyPath]; store.rows.set(k, rec); return k; }); return r; },
      delete(key) { const r = makeRequest(); fire(r, () => { store.rows.delete(key); return undefined; }); return r; },
    };
  }
  function dbView(dbRecord) {
    return {
      objectStoreNames: { contains: (n) => dbRecord.stores.has(n) },
      createObjectStore(n, opts) {
        if (!dbRecord.stores.has(n)) dbRecord.stores.set(n, { keyPath: (opts && opts.keyPath) || null, rows: new Map() });
        return storeView(dbRecord.stores.get(n));
      },
      transaction(names) {
        const scope = Array.isArray(names) ? names : [names];
        const tx = {
          objectStore(n) {
            if (!scope.includes(n)) throw new Error(`NotFoundError: 事务范围外的 store ${n}`);
            const store = dbRecord.stores.get(n);
            if (!store) throw new Error(`NotFoundError: 无此 object store ${n}`);
            return storeView(store);
          },
        };
        setImmediate(() => {
          if (opts.abort) { tx.error = new Error('simulated transaction abort'); tx.onabort?.(); }
          else tx.oncomplete?.();
        });
        return tx;
      },
    };
  }
  return {
    open(name, version) {
      const req = makeRequest();
      queueMicrotask(() => {
        if (opts.failOpenOnce) {
          opts.failOpenOnce = false;
          req.error = new Error('simulated open failure');
          req.onerror?.();
          return;
        }
        let dbRecord = databases.get(name);
        const isNew = !dbRecord;
        if (isNew) { dbRecord = { version: 0, stores: new Map() }; databases.set(name, dbRecord); }
        req.result = dbView(dbRecord);
        req.error = null;
        if (isNew || (version != null && version > dbRecord.version)) {
          dbRecord.version = version != null ? version : dbRecord.version;
          if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
        }
        if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
      });
      return req;
    },
    // 测试辅助：导出所有已持久化记录，供 PII 落盘边界断言
    _dump() {
      const out = [];
      for (const [dbName, dbRecord] of databases) {
        for (const [storeName, store] of dbRecord.stores) {
          for (const [key, value] of store.rows) out.push({ dbName, storeName, key, value });
        }
      }
      return out;
    },
  };
}

// ---------- 最小 FileSystemDirectoryHandle 假件 ----------
// sink 是测试侧持有的外部记账本：calls 记录句柄方法调用，diskWrites 记录「已提交到磁盘」的内容。
// 关键：sink 不挂在 handle 上，因此 handle 被存进 IDB 时不含任何写盘内容/PII。
function createFakeDirHandle(name, sink, opts = {}) {
  const handle = {
    kind: 'directory',
    name,
    async getFileHandle(filename, options) {
      sink.calls.push({ op: 'getFileHandle', filename, options });
      return {
        kind: 'file',
        name: filename,
        async createWritable() {
          sink.calls.push({ op: 'createWritable', filename });
          let staged = null; // 模拟：write 暂存，close 提交，abort 丢弃
          return {
            async write(text) {
              sink.calls.push({ op: 'write', filename, length: text.length });
              if (opts.failWrite) throw new Error('simulated write failure');
              staged = text;
            },
            async close() {
              sink.calls.push({ op: 'close', filename });
              if (opts.failClose) throw new Error('simulated close failure');
              if (staged !== null) sink.diskWrites.push({ filename, text: staged });
            },
            async abort() { sink.calls.push({ op: 'abort', filename }); staged = null; },
          };
        },
      };
    },
    async isSameEntry(other) { return other === handle; },
    queryPermission(desc) { sink.calls.push({ op: 'queryPermission', desc }); return opts.permission || 'granted'; },
    async requestPermission(desc) { sink.calls.push({ op: 'requestPermission', desc }); return opts.permission || 'granted'; },
    async removeEntry(entryName) { sink.calls.push({ op: 'removeEntry', entryName }); },
  };
  return handle;
}

function newSink() { return { calls: [], diskWrites: [] }; }

// ---------- 加载 fs-store.js ----------
// fs-store.js 是经典脚本 `(function(global){...})(self)`。用 new Function 注入 self / indexedDB，
// 保持在同一 realm，避免跨 vm 上下文的微任务顺序问题。
function loadHarFs(options) {
  const code = readFileSync(FS_STORE_PATH, 'utf8');
  let n = 0;
  const selfObj = { crypto: { randomUUID: () => `uuid-${++n}` },
    HarExportConfig: { defaultFolderPath: options?.defaultFolderPath || '' } };
  const indexedDB = createFakeIndexedDB(options);
  const factory = new Function('self', 'indexedDB', `${code}\n;return self.HarFs;`);
  const HarFs = factory(selfObj, indexedDB);
  return { HarFs, indexedDB };
}

// 模拟一段含 PII 的 HAR 正文（会话 Cookie + 卡号 + CVV + 邮箱），以及一组必检标记
function makeSensitiveHarBody() {
  const markers = ['SESSIONID=abc123SECRET', '4111111111111111', 'cvv=737', 'pax@example.com'];
  const body = JSON.stringify({
    log: {
      version: '1.2',
      entries: [{
        request: { headers: [{ name: 'Cookie', value: markers[0] }] },
        response: { content: { text: `card=${markers[1]} ${markers[2]} email=${markers[3]}` } },
      }],
    },
  });
  return { body, markers };
}

// ---------- 契约测试 ----------

test('公共契约：HarFs 暴露约定的 API 面', () => {
  const { HarFs } = loadHarFs();
  assert.ok(HarFs, 'HarFs 应挂载到 self');
  const fns = [
    'getSetting', 'setSetting', 'getTarget', 'setTarget', 'getLastFolderId',
    'listFolders', 'getFolder', 'saveFolder', 'renameFolder', 'touchFolder',
    'forgetFolder', 'findFolderByHandle', 'queryPermission', 'ensurePermission', 'writeText',
  ];
  for (const f of fns) assert.equal(typeof HarFs[f], 'function', `HarFs.${f} 应为函数`);
  assert.equal(HarFs.KEY_LAST_FOLDER, 'lastFolderId');
  assert.equal(HarFs.KEY_TARGET, 'exportTarget');
});

test('写盘目标：writeText 仅经用户句柄按 getFileHandle(create)→createWritable→write→close 落盘', async () => {
  const { HarFs } = loadHarFs();
  const sink = newSink();
  const handle = createFakeDirHandle('salamair', sink);
  const body = '{"log":{"version":"1.2"}}';

  const res = await HarFs.writeText(handle, 'capture.har', body);
  assert.deepEqual(res, { ok: true, name: 'capture.har' });

  assert.deepEqual(sink.calls.map((c) => c.op), ['getFileHandle', 'createWritable', 'write', 'close']);
  const gh = sink.calls.find((c) => c.op === 'getFileHandle');
  assert.equal(gh.filename, 'capture.har');
  assert.equal(gh.options && gh.options.create, true, '必须以 create:true 打开目标文件');
  assert.deepEqual(sink.diskWrites, [{ filename: 'capture.har', text: body }], '内容应提交到用户选定句柄对应的磁盘位置');
});

test('写盘目标：writeText 写入失败时 abort 并抛出，磁盘上不残留半截文件', async () => {
  const { HarFs } = loadHarFs();
  const sink = newSink();
  const handle = createFakeDirHandle('wizz_air', sink, { failWrite: true });

  await assert.rejects(() => HarFs.writeText(handle, 'x.har', 'secret-body'), /simulated write failure/);
  assert.ok(sink.calls.some((c) => c.op === 'abort'), '写入失败应调用 abort()');
  assert.equal(sink.diskWrites.length, 0, '失败时不应有任何内容提交到磁盘');
});

test('PII 落盘边界：HAR 正文（Cookie/卡号/CVV/邮箱）只落磁盘，绝不写入 IndexedDB', async () => {
  const { HarFs, indexedDB } = loadHarFs();
  const sink = newSink();
  const handle = createFakeDirHandle('salamair', sink);

  // 走完整持久化流程：记住文件夹 → 设为目标 → touch → 写盘
  await HarFs.saveFolder(handle, 'SalamAir');
  const target = await HarFs.getTarget();
  assert.equal(target.mode, 'folder');
  await HarFs.touchFolder(target.folderId);

  const { body, markers } = makeSensitiveHarBody();
  await HarFs.writeText(handle, 'capture.har', body);

  // 1) 正文确实落到了磁盘（用户选定目录）
  assert.equal(sink.diskWrites.length, 1);
  assert.equal(sink.diskWrites[0].text, body);

  // 2) IndexedDB 里持久化的所有记录，序列化后不得包含任何 PII 标记
  const records = indexedDB._dump();
  assert.ok(records.length > 0, 'IDB 应有文件夹/设置记录');
  const serialized = JSON.stringify(records.map((r) => r.value));
  for (const marker of markers) {
    assert.ok(!serialized.includes(marker), `PII 标记不应出现在 IndexedDB：${marker}`);
  }

  // 3) IDB 里只应是文件夹元数据与设置：字段白名单校验
  const folderRec = records.find((r) => r.storeName === 'folders');
  assert.ok(folderRec, '应有 folders 记录');
  const allowedFolderKeys = ['id', 'name', 'label', 'handle', 'createdAt', 'lastUsedAt', 'useCount'];
  for (const k of Object.keys(folderRec.value)) {
    assert.ok(allowedFolderKeys.includes(k), `folders 记录出现非白名单字段：${k}`);
  }
  const settingRecs = records.filter((r) => r.storeName === 'settings');
  assert.ok(settingRecs.length >= 2, '应有 exportTarget 与 lastFolderId 两条设置');
  for (const r of settingRecs) {
    assert.deepEqual(Object.keys(r.value).sort(), ['key', 'value'], 'settings 记录应只含 key/value');
  }
});

test('forgetFolder：只从 IDB 移除并回退目标，绝不删磁盘文件', async () => {
  const { HarFs } = loadHarFs();
  const sink = newSink();
  const handle = createFakeDirHandle('legacy_system', sink);

  const rec = await HarFs.saveFolder(handle, 'Legacy');
  await HarFs.writeText(handle, 'keep.har', 'body-on-disk');

  await HarFs.forgetFolder(rec.id);

  assert.deepEqual(await HarFs.listFolders(), [], 'IDB 文件夹记录应已移除');
  assert.deepEqual(await HarFs.getTarget(), { mode: 'ask' }, '目标应回退为每次询问');
  assert.ok(!sink.calls.some((c) => c.op === 'removeEntry'), 'forgetFolder 不得删除磁盘文件');
  assert.equal(sink.diskWrites.length, 1, '此前写入磁盘的文件应保持不变');
});

test('IDB 请求成功之后事务仍可能中止，不能谎报设置保存成功', async () => {
  const { HarFs } = loadHarFs({ abort: true });
  await assert.rejects(HarFs.setTarget({ mode: 'ask' }), /transaction abort/);
});

test('IDB 首次打开失败后下一次可重试，不永久缓存 rejected Promise', async () => {
  const { HarFs } = loadHarFs({ failOpenOnce: true });
  await assert.rejects(HarFs.getTarget(), /open failure/);
  assert.deepEqual(await HarFs.getTarget(), { mode: 'ask' });
});

test('写入成功但 close 失败仍 abort，不提交半截正文', async () => {
  const { HarFs } = loadHarFs(); const sink = newSink();
  const handle = createFakeDirHandle('test', sink, { failClose: true });
  await assert.rejects(HarFs.writeText(handle, 'test.har', 'SYNTHETIC'), /close failure/);
  assert.equal(sink.diskWrites.length, 0);
  assert.equal(sink.calls.at(-1).op, 'abort');
});

test('目录权限同步抛错时返回 denied，非法文件名不会传给目录句柄', async () => {
  const { HarFs } = loadHarFs();
  assert.equal(await HarFs.queryPermission({ queryPermission: () => { throw new Error('revoked'); } }), 'denied');
  const sink = newSink(); const handle = createFakeDirHandle('test', sink);
  for (const name of ['../outside.har', '..', 'a/b.har', 'a\\b.har', '']) await assert.rejects(HarFs.writeText(handle, name, 'x'), /无效文件名/);
  assert.equal(sink.calls.length, 0);
});

const presetPath = 'Z:\\Synthetic\\HARExports';
test('preset default ignores a legacy target and an unconfirmed identical directory name', async () => {
  const { HarFs } = loadHarFs({ defaultFolderPath: presetPath });
  const other = await HarFs.saveFolder(createFakeDirHandle('HARExports', newSink()), 'old');
  await HarFs.setSetting('exportTarget', { mode: 'folder', folderId: other.id });
  await HarFs.setSetting(HarFs.KEY_TARGET, null);
  assert.deepEqual(await HarFs.getTarget(), { mode: 'default' });
  assert.equal(await HarFs.getDefaultFolder(), null);
  assert.equal((await HarFs.listFolders()).length, 1);
});
test('default requires path confirmation, the configured basename, and write permission', async () => {
  const { HarFs } = loadHarFs({ defaultFolderPath: presetPath });
  await assert.rejects(HarFs.saveDefaultFolder(createFakeDirHandle('HARExports', newSink()), false), /确认/);
  await assert.rejects(HarFs.saveDefaultFolder(createFakeDirHandle('wrong', newSink()), true), /确认/);
  await assert.rejects(HarFs.saveDefaultFolder(createFakeDirHandle('HARExports', newSink(), { permission: 'denied' }), true), /写入权限/);
  assert.deepEqual(await HarFs.getTarget(), { mode: 'default' });
  assert.equal((await HarFs.listFolders()).length, 0);
});
test('confirmed preset persists separately and removal returns to setup', async () => {
  const { HarFs } = loadHarFs({ defaultFolderPath: presetPath });
  const record = await HarFs.saveDefaultFolder(createFakeDirHandle('HARExports', newSink()), true);
  assert.equal(record.label, presetPath);
  assert.deepEqual(await HarFs.getTarget(), { mode: 'folder', folderId: record.id, defaultFolder: true });
  await HarFs.setTarget({ mode: 'ask' });
  assert.deepEqual(await HarFs.getTarget(), { mode: 'ask' });
  await HarFs.setTarget({ mode: 'default' });
  await HarFs.forgetFolder(record.id);
  assert.deepEqual(await HarFs.getTarget(), { mode: 'default' });
});
test('personal 1.4.6 authorization migrates only when the confirmed absolute path matches', async () => {
  const { HarFs } = loadHarFs({ defaultFolderPath: presetPath });
  const record = await HarFs.saveFolder(createFakeDirHandle('HARExports', newSink()), presetPath);
  await HarFs.setSetting('defaultFolder_default_146', record.id);
  await HarFs.setSetting('exportTarget_default_146', { mode: 'default' });
  await HarFs.setSetting(HarFs.KEY_TARGET, null);
  assert.equal((await HarFs.getTarget()).defaultFolder, true);
  await HarFs.renameFolder(record.id, 'another path');
  assert.deepEqual(await HarFs.getTarget(), { mode: 'default' });
  assert.equal(await HarFs.getDefaultFolder(), null);
});
test('generic build retains the old target key and has no preset directory', async () => {
  const { HarFs } = loadHarFs();
  assert.equal(HarFs.KEY_TARGET, 'exportTarget');
  assert.equal(HarFs.DEFAULT_FOLDER_PATH, '');
  assert.equal(await HarFs.getDefaultFolder(), null);
  await HarFs.setSetting('exportTarget', { mode: 'folder', folderId: 'old' });
  assert.deepEqual(await HarFs.getTarget(), { mode: 'folder', folderId: 'old' });
  await assert.rejects(HarFs.saveDefaultFolder(createFakeDirHandle('HARExports', newSink()), true), /确认/);
});
