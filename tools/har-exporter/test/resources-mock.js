// Synthetic browser fixture only. Not included in runtime packages.
(function () {
  const listeners = new Set(), downloadListeners = new Set(), downloads = new Map();
  let downloadId = 0, generation = 7, phase = 'recording';
  const fixture = (path, mime, body, options = {}) => ({ done: true, tabId: options.tabId || 1,
    data: { request: { method: 'GET', url: 'https://assets.example.test/' + path, headers: [] },
      response: { status: options.status || 200, headers: [], content: { mimeType: mime,
        size: options.size ?? new TextEncoder().encode(body).length, text: body, ...(options.encoding ? { encoding: options.encoding } : {}) } },
      ...(options.extra || {}) } });
  let entries = [
    fixture('annual-report.pdf?token=SYNTHETIC_SECRET_123', 'application/pdf', '%PDF-SYNTHETIC'),
    fixture('annual-report.pdf?token=SYNTHETIC_SECRET_123', 'application/pdf', '%PDF-SYNTHETIC'),
    fixture('photo.png', 'image/png', 'AAH/gA==', { encoding: 'base64', size: 4 }),
    fixture('video.mp4', 'video/mp4', 'PART', { status: 206 }),
    fixture('not-captured.jpg', 'image/jpeg', '', { extra: { _bodySkipped: 'media-filter' }, size: -1 }),
    fixture('%E4%B8%AD%E6%96%87.txt', 'text/plain', '中文\u{1f600}'),
    fixture('stream.m3u8', 'application/vnd.apple.mpegurl', '#EXTM3U\n'),
    fixture('other-tab.pdf?token=SYNTHETIC_SECRET_456', 'application/pdf', '%PDF-OTHER', { tabId: 2 }),
  ];
  self.resourceFixture = { saved: [], cancelNext: false,
    broadcast() { for (const listener of listeners) listener({ type: 'status', phase }); }, reset() {
    entries = []; generation++; phase = 'idle';
    for (const listener of listeners) listener({ type: 'status', phase: 'idle' });
  } };
  self.chrome = { runtime: { getManifest: () => ({ version: '1.5.0' }), onMessage: { addListener: (listener) => listeners.add(listener) },
    sendMessage: async (msg) => {
      if (msg.type === 'getResources') return { ok: true, phase, generation, ...HarResources.index(entries) };
      if (msg.type === 'getResourceBody') {
        if (msg.generation !== generation) return { ok: false, error: '录制数据已变化' };
        return { ok: true, generation, body: HarResources.body(entries[Number(msg.id)], msg.id) };
      }
      throw new Error('Unexpected fixture request');
    } }, downloads: { onChanged: { addListener: (listener) => downloadListeners.add(listener), removeListener: (listener) => downloadListeners.delete(listener) },
    download: async (spec) => {
      if (!spec.url.startsWith('blob:')) throw new Error('Fixture blocks non-Blob requests');
      const id = ++downloadId;
      const content = new Uint8Array(await (await fetch(spec.url)).arrayBuffer());
      const state = self.resourceFixture.cancelNext ? 'interrupted' : 'complete';
      self.resourceFixture.cancelNext = false;
      if (state === 'complete') self.resourceFixture.saved.push({ filename: spec.filename, bytes: [...content] });
      downloads.set(id, { id, state });
      for (const listener of downloadListeners) listener({ id, state: { current: state } });
      return id;
    }, search: async ({ id }) => [downloads.get(id)] } };
})();
