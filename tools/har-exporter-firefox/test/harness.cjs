const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function setup(options = {}) {
  const filters = [];
  const api = { webRequest: { filterResponseData() {
    const f = { written: [], closed: false, disconnected: false,
      write(data) { this.written.push(Buffer.from(data)); }, close() { this.closed = true; }, disconnect() { this.disconnected = true; } };
    filters.push(f); return f;
  } } };
  const ctx = { TextEncoder, TextDecoder, Uint8Array, URL, btoa, setTimeout };
  vm.createContext(ctx);
  for (const file of ['payload-policy.js', 'recorder.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx);
  let changes = 0;
  const capture = new ctx.FirefoxCapture(api, options, () => changes++);
  let seq = 0;
  function begin({ method = 'GET', type = 'xmlhttprequest', mime = 'application/json', post, id = String(++seq), status = 200 } = {}) {
    capture.before({ requestId: id, tabId: 1, type, url: 'https://example.test/' + id, method, timeStamp: 1000,
      requestBody: post === undefined ? undefined : { raw: [{ bytes: new TextEncoder().encode(post).buffer }] } });
    capture.responseHeaders({ requestId: id, timeStamp: 1100, statusCode: status, statusLine: 'HTTP/2 ' + status,
      responseHeaders: [{ name: 'Content-Type', value: mime }] });
    return { id, f: filters.at(-1), e: capture.entries.at(-1) };
  }
  function chunk(row, text) { row.f.ondata({ data: typeof text === 'string' ? new TextEncoder().encode(text).buffer : Uint8Array.from(text).buffer }); }
  function end(row) { row.f.onstop(); capture.complete({ requestId: row.id, timeStamp: 1200, statusCode: 200 }); }
  return { capture, begin, chunk, end, filters, ctx, changes: () => changes };
}
module.exports = { setup };
