// Browser fixture ONLY; not referenced by production extension pages.
const listeners = new Set();
const fixtureStats = { count: 3, nonEmptyBody: 1, nonEmptyApiBody: 1, apiRequests: 2, incomplete: 0,
  lostResponseBodies: 1, lostRequestBodies: 0, warnings: ['body-data-missing'],
  budget: { requestBytes: 128, requestLimitBytes: 8 * 1048576, apiBytes: 1024, resourceBytes: 16 * 1048576, resourceLimitBytes: 16 * 1048576, responseLimitBytes: 56 * 1048576 } };
let fixtureState = { phase: 'idle', count: 0, tabs: 0, followNewTabs: true, includeMedia: false, lastResult: null, stats: null };
let attempted = false;
self.fixtureMessage = (msg) => new Promise((resolve) => { for (const cb of listeners) cb(msg, { id: 'fixture' }, resolve); });
self.chrome = {
  runtime: { id: 'fixture', getURL: (path) => '/' + path,
    onMessage: { addListener: (cb) => listeners.add(cb) },
    sendMessage: async (msg) => {
      if (msg.type === 'keepalive') return { ok: true };
      if (msg.type === 'getStatus') return fixtureState;
      if (msg.type === 'setFollowNewTabs') fixtureState.followNewTabs = msg.value;
      if (msg.type === 'setIncludeMedia') fixtureState.includeMedia = msg.value;
      if (msg.type === 'start') { fixtureState.phase = 'recording'; fixtureState.count = 3; fixtureState.tabs = 1; fixtureState.stats = fixtureStats; }
      if (msg.type === 'cancel') fixtureState = { ...fixtureState, phase: 'idle', count: 0, tabs: 0, lastResult: null };
      if (msg.type === 'stop') {
        fixtureState.phase = 'exporting';
        for (const cb of listeners) cb({ type: 'status', ...fixtureState });
        await new Promise((r) => setTimeout(r, 80));
        if (!attempted) {
          attempted = true;
          fixtureState.phase = 'ready';
          fixtureState.lastResult = { ok: false, error: '测试：保存取消。数据已保留，可再次导出。' };
        } else {
          fixtureState.phase = 'idle';
          fixtureState.stats = null;
          fixtureState.lastResult = { ...fixtureStats, ok: true, exported: true, count: 3, tabs: 1, withBody: 1, bodyFailed: 1,
            bodySkipped: 1, incomplete: 1, failed: 0, filename: 'HAR_中文😀_test.har', method: 'downloads' };
        }
        return fixtureState.lastResult;
      }
      for (const cb of listeners) cb({ type: 'status', ...fixtureState });
      return { ok: true };
    } },
  tabs: { query: async () => [{ id: 1, url: 'https://example.test/' }] },
};
