// fs-store.js — 导出目标文件夹的持久化层（IndexedDB）
//
// 被三处上下文共用，它们同属 chrome-extension://<id> 源，共享同一个 IndexedDB：
//   - popup.html  : <script src="fs-store.js">
//   - picker.html : <script src="fs-store.js">
//   - background  : importScripts('fs-store.js')  （MV3 service worker）
//
// 两个关键前提（已验证）：
//   1. FileSystemDirectoryHandle 是可结构化克隆对象，可以直接存进 IndexedDB；
//      这就是「记住上次保存位置 / 最近文件夹」的实现基础。
//   2. Chrome 不保证跨会话保留写权限，所以「用之前先 queryPermission」，
//      而 requestPermission 必须发生在用户手势内（因此只在 popup / picker 里调用，
//      service worker 里只 query，不 request）。
//
// HAR 正文不进入此数据库；保持原有 v1 schema，无需数据迁移。

(function (global) {
  'use strict';

  var DB_NAME = 'har_exporter';
  var DB_VERSION = 1;
  var STORE_FOLDERS = 'folders';
  var STORE_SETTINGS = 'settings';
  var KEY_LAST_FOLDER = 'lastFolderId';
  var DEFAULT_FOLDER_PATH = global.HarExportConfig?.defaultFolderPath || '';
  var DEFAULT_FOLDER_NAME = DEFAULT_FOLDER_PATH.split(/[\\/]/).filter(Boolean).pop() || '';
  // Each preset has its own preference. Generic builds preserve the legacy key.
  var KEY_TARGET = DEFAULT_FOLDER_PATH ? 'exportTarget_default:' + DEFAULT_FOLDER_PATH : 'exportTarget';
  var KEY_DEFAULT_FOLDER = 'defaultFolder:' + DEFAULT_FOLDER_PATH;
  // 是否跟随「由已录制标签页打开的新标签页」一起录制（默认开）
  var KEY_FOLLOW_NEW_TABS = 'followNewTabs';

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      var blocked = false;
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
          db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () {
        if (blocked) { req.result.close(); return; }
        req.result.onversionchange = function () { req.result.close(); dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { blocked = true; reject(new Error('IndexedDB 被其他标签页占用，请关闭后重试')); };
    });
    dbPromise = dbPromise.catch(function (error) { dbPromise = null; throw error; });
    return dbPromise;
  }

  function promisify(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function withStore(name, mode, fn) {
    var db = await openDb();
    var tx = db.transaction(name, mode);
    // A successful request can still be followed by a quota/transaction abort.
    // Report success only after the transaction commits.
    var complete = new Promise(function (resolve, reject) {
      tx.oncomplete = resolve;
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务已中止')); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB 事务失败')); };
    });
    var result = Promise.resolve().then(function () { return fn(tx.objectStore(name)); });
    try { return (await Promise.all([result, complete]))[0]; }
    catch (error) { try { tx.abort(); } catch {} throw error; }
  }

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  // ---------- 设置 ----------

  function getSetting(key, dflt) {
    return withStore(STORE_SETTINGS, 'readonly', async function (os) {
      var rec = await promisify(os.get(key));
      return rec === undefined ? dflt : rec.value;
    });
  }

  function setSetting(key, value) {
    return withStore(STORE_SETTINGS, 'readwrite', async function (os) {
      await promisify(os.put({ key: key, value: value }));
      return value;
    });
  }

  async function getTarget() {
    var target = await getSetting(KEY_TARGET, null);
    if (!DEFAULT_FOLDER_PATH) return target || { mode: 'ask' };
    // Preserve the personal 1.4.6 choice only when its confirmed path matches.
    if (!target && await legacyDefaultFolder()) target = await getSetting('exportTarget_default_146', null);
    if (target && target.mode !== 'default') return target;
    var folder = await getDefaultFolder();
    return folder && folder.handle
      ? { mode: 'folder', folderId: folder.id, defaultFolder: true }
      : { mode: 'default' };
  }

  async function getDefaultFolder() {
    if (!DEFAULT_FOLDER_PATH) return null;
    return await getFolder(await getSetting(KEY_DEFAULT_FOLDER, null)) || await legacyDefaultFolder();
  }

  async function legacyDefaultFolder() {
    if (!DEFAULT_FOLDER_PATH) return null;
    var folder = await getFolder(await getSetting('defaultFolder_default_146', null));
    return folder?.label === DEFAULT_FOLDER_PATH ? folder : null;
  }

  async function saveDefaultFolder(handle, pathConfirmed) {
    if (!DEFAULT_FOLDER_PATH || !pathConfirmed || !handle || handle.name !== DEFAULT_FOLDER_NAME) {
      throw new Error('请选择并确认默认目录 ' + DEFAULT_FOLDER_PATH);
    }
    if (await queryPermission(handle) !== 'granted') throw new Error('尚未获得默认文件夹的写入权限');
    var rec = await saveFolder(handle, DEFAULT_FOLDER_PATH);
    await setSetting(KEY_DEFAULT_FOLDER, rec.id);
    await setTarget({ mode: 'default' });
    return rec;
  }

  function setTarget(target) {
    return setSetting(KEY_TARGET, target);
  }

  function getLastFolderId() {
    return getSetting(KEY_LAST_FOLDER, null);
  }

  function getFollowNewTabs() {
    return getSetting(KEY_FOLLOW_NEW_TABS, true);
  }

  function setFollowNewTabs(enabled) {
    return setSetting(KEY_FOLLOW_NEW_TABS, !!enabled);
  }

  // ---------- 文件夹收藏 ----------

  function listFolders() {
    return withStore(STORE_FOLDERS, 'readonly', async function (os) {
      var all = (await promisify(os.getAll())) || [];
      return all.sort(function (a, b) {
        return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
      });
    });
  }

  function getFolder(id) {
    if (!id) return Promise.resolve(null);
    return withStore(STORE_FOLDERS, 'readonly', async function (os) {
      return (await promisify(os.get(id))) || null;
    });
  }

  function putFolder(rec) {
    return withStore(STORE_FOLDERS, 'readwrite', async function (os) {
      await promisify(os.put(rec));
      return rec;
    });
  }

  // 同一目录重复选择时不新增条目，而是复用旧条目（按句柄比较，不靠路径字符串）
  async function findFolderByHandle(handle) {
    if (!handle || typeof handle.isSameEntry !== 'function') return null;
    var all = await listFolders();
    for (var i = 0; i < all.length; i++) {
      try {
        if (await all[i].handle.isSameEntry(handle)) return all[i];
      } catch (e) { /* 句柄失效，跳过 */ }
    }
    return null;
  }

  /**
   * 记住一个文件夹，并把它设为「上次保存位置」与当前导出目标。
   * @param {FileSystemDirectoryHandle} handle
   * @param {string} [label] 备注名（可选，便于区分同名文件夹）。传 undefined 表示不改已有备注。
   */
  async function saveFolder(handle, label) {
    var existing = await findFolderByHandle(handle);
    var now = Date.now();
    var rec = {
      id: existing ? existing.id : newId(),
      name: handle.name || '',
      label: label !== undefined && label !== null ? label : (existing ? existing.label : ''),
      handle: handle,
      createdAt: existing ? existing.createdAt : now,
      lastUsedAt: existing ? existing.lastUsedAt : 0,
      useCount: existing ? existing.useCount : 0,
    };
    await putFolder(rec);
    await setSetting(KEY_LAST_FOLDER, rec.id);
    await setTarget({ mode: 'folder', folderId: rec.id });
    return rec;
  }

  async function renameFolder(id, label) {
    var rec = await getFolder(id);
    if (!rec) return null;
    rec.label = label || '';
    return putFolder(rec);
  }

  // 导出成功后调用：更新时间戳，并把它记为「上次保存位置」
  async function touchFolder(id) {
    var rec = await getFolder(id);
    if (!rec) return null;
    rec.lastUsedAt = Date.now();
    rec.useCount = (rec.useCount || 0) + 1;
    await putFolder(rec);
    await setSetting(KEY_LAST_FOLDER, id);
    return rec;
  }

  // 仅从列表移除（不会删除磁盘上的任何文件）
  async function forgetFolder(id) {
    await withStore(STORE_FOLDERS, 'readwrite', async function (os) {
      await promisify(os.delete(id));
    });
    var target = await getTarget();
    if (target && target.folderId === id) await setTarget({ mode: target.defaultFolder ? 'default' : 'ask' });
    var last = await getLastFolderId();
    if (last === id) {
      var rest = await listFolders();
      await setSetting(KEY_LAST_FOLDER, rest.length ? rest[0].id : null);
    }
  }

  // ---------- 权限与写入 ----------

  // 只查询，不弹授权框。service worker 里只能调这个。
  async function queryPermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') {
      return Promise.resolve('unsupported');
    }
    try { return await handle.queryPermission({ mode: 'readwrite' }); }
    catch { return 'denied'; }
  }

  // 查询 + 必要时申请。必须在用户手势（点击）内调用，否则 Chrome 会直接拒绝。
  async function ensurePermission(handle) {
    var perm = await queryPermission(handle);
    if (perm === 'granted' || perm === 'unsupported') return perm;
    if (!handle || typeof handle.requestPermission !== 'function') return 'denied';
    try {
      return await handle.requestPermission({ mode: 'readwrite' });
    } catch (e) {
      return 'denied';
    }
  }

  async function writeText(handle, filename, text) {
    if (!filename || /[\\/\x00-\x1f]/.test(filename) || filename === '.' || filename === '..') throw new Error('无效文件名');
    var fileHandle = await handle.getFileHandle(filename, { create: true });
    var writable = await fileHandle.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch (e2) { /* ignore */ }
      throw e;
    }
    return { ok: true, name: filename };
  }

  global.HarFs = {
    DEFAULT_FOLDER_PATH: DEFAULT_FOLDER_PATH,
    DEFAULT_FOLDER_NAME: DEFAULT_FOLDER_NAME,
    getDefaultFolder: getDefaultFolder,
    saveDefaultFolder: saveDefaultFolder,
    // 设置
    getSetting: getSetting,
    setSetting: setSetting,
    getTarget: getTarget,
    setTarget: setTarget,
    getLastFolderId: getLastFolderId,
    getFollowNewTabs: getFollowNewTabs,
    setFollowNewTabs: setFollowNewTabs,
    // 文件夹
    listFolders: listFolders,
    getFolder: getFolder,
    saveFolder: saveFolder,
    renameFolder: renameFolder,
    touchFolder: touchFolder,
    forgetFolder: forgetFolder,
    findFolderByHandle: findFolderByHandle,
    // 权限与写入
    queryPermission: queryPermission,
    ensurePermission: ensurePermission,
    writeText: writeText,
    // 常量
    KEY_LAST_FOLDER: KEY_LAST_FOLDER,
    KEY_TARGET: KEY_TARGET,
    KEY_FOLLOW_NEW_TABS: KEY_FOLLOW_NEW_TABS,
  };
})(self);
