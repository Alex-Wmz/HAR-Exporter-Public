// Local synthetic UI fixture only. Never included in colleague packages.
const fixtureStats = { count: 3, nonEmptyBody: 1, nonEmptyApiBody: 1, apiRequests: 2, incomplete: 0,
  lostResponseBodies: 1, lostRequestBodies: 0,
  budget: { requestBytes: 128, requestLimitBytes: 8 * 1048576, apiBytes: 1024, resourceBytes: 16 * 1048576, resourceLimitBytes: 16 * 1048576, responseLimitBytes: 56 * 1048576 } };
let fixture = { phase: 'idle', count: 0, tabs: 0, follow: true, includeMedia: false, stats: null };
let attempted = false;
window.close = () => {};
self.browser = { tabs: { query: async () => [{ id: 1 }] }, runtime: { sendMessage: async (msg) => {
  if (msg.type === 'start') fixture = { ...fixture, phase: 'recording', count: 3, tabs: 1, stats: fixtureStats };
  if (msg.type === 'stop') {
    if (!attempted) { attempted = true; fixture.phase = 'ready'; fixture.lastResult = { ok: false, error: '测试：保存取消，数据已保留。' }; }
    else { fixture.phase = 'idle'; fixture.count = 0; fixture.tabs = 0; fixture.stats = null; fixture.lastResult = { ...fixtureStats, ok: true, filename: 'HAR_Firefox_synthetic.har' }; }
  }
  if (msg.type === 'settings') Object.assign(fixture, { follow: msg.follow, includeMedia: msg.includeMedia });
  if (msg.type === 'discard') fixture = { ...fixture, phase: 'idle', count: 0, tabs: 0, stats: null, lastResult: null };
  return fixture;
} } };
