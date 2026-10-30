// Synthetic UI fixture only; no access to user folders or browser download history.
const fixtureFolder = { id: 'synthetic-folder', name: 'HAR', label: '测试资料 / HAR',
  lastUsedAt: Date.now(), useCount: 6, handle: { kind: 'directory', name: 'HAR' } };
let fixtureRecent = { method: 'folder', folderId: fixtureFolder.id, folderName: fixtureFolder.label,
  filename: 'HAR_测试页面_2026-09-22_示范.har', savedAt: Date.now() };
if (new URLSearchParams(location.search).has('download')) fixtureRecent = {
  method: 'downloads', filename: 'HAR_示范.har', fullPath: '/synthetic/exports/HAR_示范.har', downloadId: 7, savedAt: Date.now() };
if (new URLSearchParams(location.search).has('empty')) fixtureRecent = null;
self.HarFs = {
  ...HarFs,
  listFolders: async () => [fixtureFolder],
  getTarget: async () => ({ mode: 'folder', folderId: fixtureFolder.id }),
  getSetting: async () => fixtureRecent,
  setSetting: async (key, value) => { fixtureRecent = value; },
};
self.showOpenFilePicker = async () => {
  document.getElementById('recentSummary').setAttribute('data-browsed', 'true');
  throw new DOMException('Cancelled', 'AbortError');
};
self.chrome = { runtime: { id: 'fixture' }, downloads: {
  search: async () => [{ id: 7, state: 'complete', exists: true, byExtensionId: 'fixture' }],
  show: async () => document.getElementById('recentSummary').setAttribute('data-revealed', 'true'),
} };
