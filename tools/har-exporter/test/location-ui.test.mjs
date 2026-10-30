// Production UI scripts exercised against a small DOM/API double, not a real browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { flush } from './harness.mjs';

function element() {
  const classes = new Set();
  return { textContent: '', value: '', disabled: false, children: [], listeners: {},
    classList: { add: (x) => classes.add(x), remove: (x) => classes.delete(x),
      toggle: (x, force) => force ? classes.add(x) : classes.delete(x) },
    appendChild(child) { this.children.push(child); },
    set innerHTML(value) { this.children = []; },
    get options() { return this.children.flatMap((x) => x.children.length ? x.children : [x]); },
    addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {},
  };
}
async function ui(page, item, options = {}) {
  const html = readFileSync(new URL(`../${page}.html`, import.meta.url), 'utf8');
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], element()]));
  const folder = { id: 'original', name: 'HAR', handle: { kind: 'directory', name: 'HAR' }, lastUsedAt: 1 };
  const effects = { shown: [], copied: [], browsed: [], windows: [], writes: 0 };
  let stored = item;
  const context = { console, Date, Promise, setTimeout: () => 0, clearTimeout() {},
    document: { getElementById: (id) => { assert.ok(nodes[id], `missing UI element: ${id}`); return nodes[id]; }, createElement: element },
    navigator: { clipboard: { writeText: async (v) => effects.copied.push(v) } },
    HarFs: { DEFAULT_FOLDER_PATH: options.defaultFolderPath || '', DEFAULT_FOLDER_NAME: 'HARExports',
      getDefaultFolder: async () => null, getSetting: async () => stored, setSetting: async (k, v) => { stored = v; },
      listFolders: async () => [folder], getTarget: async () => options.target || ({ mode: 'folder', folderId: 'original' }), getLastFolderId: async () => 'original' },
    chrome: { runtime: { id: 'own', getURL: (p) => p, onMessage: { addListener() {} },
      sendMessage: async () => ({ phase: 'idle', count: 0, tabs: 0 }) },
      downloads: { search: async ({ id }) => [{ id, state: 'complete', exists: true, byExtensionId: 'own' }],
        show: async (id) => effects.shown.push(id) },
      windows: { create: async (options) => effects.windows.push(options) } },
    HarPayload: { describe: () => ({ budget: '', warning: '' }) },
    close() {},
    showOpenFilePicker: async (opts) => { effects.browsed.push(opts); throw { name: 'AbortError' }; },
  };
  context.self = context; context.window = context;
  vm.createContext(context);
  for (const file of ['recent-export.js', `${page}.js`]) vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context);
  await flush();
  return { context, nodes, effects, getStored: () => stored, folder, click: (id) => nodes[id].listeners.click() };
}
const folderItem = { method: 'folder', filename: 'capture.har', folderId: 'original', folderName: 'HAR', savedAt: 1 };
const downloadItem = { method: 'downloads', filename: 'renamed.har', fullPath: '/synthetic/renamed.har', downloadId: 7, savedAt: 1 };

test('saved-folder UI browses original handle, copies name and clears only the location record', async () => {
  const h = await ui('picker', folderItem);
  assert.match(h.nodes.recentSummary.textContent, /capture.har/);
  assert.equal(h.nodes.btnRecent.textContent, '浏览保存文件夹…');
  await h.click('btnRecent');
  assert.equal(h.effects.browsed[0].startIn, h.folder.handle);
  assert.match(h.nodes.msg.textContent, /保存位置未更改/);
  await h.click('btnCopy');
  assert.deepEqual(h.effects.copied, ['capture.har']);
  await h.click('btnClearRecent');
  assert.equal(h.getStored(), null);
  assert.equal(h.nodes.btnRecent.disabled, true);
  assert.equal(h.nodes.list.children.length, 1, 'remembered folder survives clearing recent metadata');
});

test('download UI shows actual path, reveals only its id and copies full path', async () => {
  const h = await ui('picker', downloadItem);
  assert.equal(h.nodes.btnRecent.textContent, '在文件夹中显示');
  assert.match(h.nodes.recentSummary.textContent, /synthetic\/renamed.har/);
  await h.click('btnRecent');
  await h.click('btnCopy');
  assert.deepEqual(h.effects.shown, [7]);
  assert.deepEqual(h.effects.copied, [downloadItem.fullPath]);
});

test('upgrade without a recent record still offers Browse for the existing remembered folder', async () => {
  const h = await ui('picker', null);
  assert.equal(h.nodes.btnRecent.disabled, true);
  const browse = h.nodes.list.children[0].children[1].children.find((x) => x.textContent === '浏览…');
  await browse.listeners.click();
  assert.equal(h.effects.browsed[0].startIn, h.folder.handle);
  assert.equal(h.getStored(), null);
});

test('popup supports one-click download reveal and does not reinterpret remembered target as latest export', async () => {
  const h = await ui('popup', downloadItem);
  assert.equal(h.nodes.btnLocate.textContent, '在文件夹中显示');
  await h.click('btnLocate');
  assert.deepEqual(h.effects.shown, [7]);
  assert.equal(h.effects.windows.length, 0);
  const f = await ui('popup', folderItem);
  await f.click('btnLocate');
  assert.equal(f.effects.windows[0].url, 'picker.html');
  assert.equal(f.effects.windows[0].type, 'popup');
});

test('preset is preselected on upgrade and Start opens setup before recording', async () => {
  const h = await ui('popup', null, { defaultFolderPath: 'Z:\\Synthetic\\HARExports', target: { mode: 'default' } });
  assert.equal(h.nodes.folderSelect.value, '__default__');
  assert.match(h.nodes.folderHint.textContent, /首次/);
  await h.click('btnStart');
  assert.equal(h.effects.windows.length, 1);
});
test('preset picker requires path confirmation before saving the selected handle', async () => {
  const h = await ui('picker', null, { defaultFolderPath: 'Z:\\Synthetic\\HARExports' });
  const selected = { name: 'HARExports' }; let saved = 0;
  h.context.showDirectoryPicker = async () => selected;
  h.context.HarFs.ensurePermission = async () => 'granted';
  h.context.HarFs.saveDefaultFolder = async (handle, confirmed) => {
    assert.equal(handle, selected); assert.equal(confirmed, true); saved++;
    return { id: 'configured', name: 'HARExports' };
  };
  await h.click('btnDefaultPick');
  assert.equal(h.nodes.btnSave.disabled, true);
  await h.click('btnSave'); assert.equal(saved, 0);
  h.nodes.defaultConfirm.checked = true; h.nodes.defaultConfirm.listeners.change();
  assert.equal(h.nodes.btnSave.disabled, false);
  await h.click('btnSave'); assert.equal(saved, 1);
});
test('preset picker rejects the wrong basename without saving it', async () => {
  const h = await ui('picker', null, { defaultFolderPath: 'Z:\\Synthetic\\HARExports' });
  h.context.showDirectoryPicker = async () => ({ name: 'other' });
  await h.click('btnDefaultPick');
  assert.match(h.nodes.msg.textContent, /本次选择未保存/);
});
