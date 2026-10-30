/* Firefox webRequest capture. No network uploads or persistent payload storage. */
(function (root) {
  'use strict';
  const size = (s) => new TextEncoder().encode(s).length;
  const hs = (rows = []) => rows.map((h) => ({ name: h.name, value: h.value ?? '' }));
  const header = (rows, name) => rows.find((h) => h.name.toLowerCase() === name)?.value || '';
  const cookiePairs = (rows) => header(rows, 'cookie').split(';').map((s) => s.trim()).filter(Boolean).flatMap((s) => {
    const i = s.indexOf('='); return i < 0 ? [] : [{ name: s.slice(0, i), value: s.slice(i + 1) }];
  });
  function base64(data) {
    let s = '';
    for (let i = 0; i < data.length; i += 8192) s += String.fromCharCode(...data.subarray(i, i + 8192));
    return btoa(s);
  }
  class FirefoxCapture {
    constructor(api, options = {}, onChange = () => {}) {
      this.api = api;
      this.onChange = onChange;
      this.options = { includeMedia: false, maxBody: 10 * 1024 * 1024, maxTotal: 64 * 1024 * 1024, maxPost: 1024 * 1024, maxEntries: 10000, maxMetadata: 16 * 1024 * 1024, maxBuffered: 32 * 1024 * 1024, ...options };
      this.entries = []; this.active = new Map(); this.filters = new Set();
      this.budget = new root.HarPayload.PayloadBudget(this.options.maxTotal);
      this.buffered = 0; this.resourceBuffered = 0; this.peakBuffered = 0;
      this.metadata = 0; this.accepting = true; this.frozen = false;
      this.warnings = new Set(['websocket-messages-not-supported', 'sse-message-parsing-not-supported', 'worker-requests-without-tab-not-captured']);
    }
    get used() { return this.budget.retained; }
    summary() {
      const result = root.HarPayload.summarize(this.entries.map((e) => e.data), this.budget, this.warnings);
      Object.assign(result.budget, { bufferedBytes: this.buffered, peakBufferedBytes: this.peakBuffered,
        bufferLimitBytes: this.options.maxBuffered, resourceBufferLimitBytes: Math.floor(this.options.maxBuffered / 4) });
      return result;
    }
    reserveMetadata(value) {
      const n = size(JSON.stringify(value));
      if (this.metadata + n > this.options.maxMetadata) {
        this.accepting = false; this.warnings.add('metadata-limit'); return false;
      }
      this.metadata += n; return true;
    }
    before(d) {
      if (!this.accepting || this.frozen) return;
      if (this.entries.length >= this.options.maxEntries) { this.accepting = false; this.warnings.add('entry-limit'); return; }
      // Auth retries can repeat onBeforeRequest without a redirect event.
      const previous = this.active.get(d.requestId);
      if (previous) { previous.data._incomplete = 'request-restarted'; this.release(previous, 'request-restarted'); previous.done = true; }
      if (!this.reserveMetadata(d.url)) return;
      let queryString = [];
      try { queryString = [...new URL(d.url).searchParams].map(([name, value]) => ({ name, value })); } catch {}
      const e = { id: d.requestId, tabId: d.tabId, start: d.timeStamp, done: false, chunks: [], bodyBytes: 0, bodyDone: false,
        data: { startedDateTime: new Date(d.timeStamp).toISOString(), time: 0,
          request: { method: d.method, url: d.url, httpVersion: 'unknown', headers: [], cookies: [], queryString, headersSize: -1, bodySize: -1 },
          response: { status: 0, statusText: '', httpVersion: 'unknown', headers: [], cookies: [], content: { size: -1, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
          cache: {}, timings: { send: 0, wait: 0, receive: 0 }, _resourceType: d.type || 'other' } };
      this.entries.push(e); this.active.set(d.requestId, e);
      this.post(e, d.requestBody);
      if (d.type === 'websocket') { e.data._bodySkipped = 'websocket-not-supported'; e.bodyDone = true; return; }
      try {
        const f = this.api.webRequest.filterResponseData(d.requestId);
        e.filter = f; this.filters.add(e);
        f.ondata = (event) => {
          // Pass original bytes through BEFORE retaining a copy. Never rewrite page data.
          try { f.write(event.data); } catch { this.release(e, 'filter-write-failed'); return; }
          if (this.frozen || e.bodyDone) { this.release(e, 'capture-stopped'); return; }
          const n = event.data.byteLength;
          if (e.bodyBytes + n > this.options.maxBody) { this.release(e, 'per-body-limit'); return; }
          const pool = root.HarPayload.responseClass(e.data);
          const reason = this.budget.reason(pool, e.bodyBytes + n);
          if (reason) { this.warnings.add('payload-limit'); this.release(e, reason); return; }
          if (this.buffered + n > this.options.maxBuffered || (pool === 'resource' && this.resourceBuffered + n > Math.floor(this.options.maxBuffered / 4))) {
            this.release(e, 'temporary-buffer-limit'); return;
          }
          e.chunks.push(new Uint8Array(event.data).slice()); e.bodyBytes += n;
          this.buffered += n;
          if (pool === 'resource') { this.resourceBuffered += n; e.resourceBuffered = (e.resourceBuffered || 0) + n; }
          this.peakBuffered = Math.max(this.peakBuffered, this.buffered);
          this.onChange();
        };
        f.onstop = () => {
          try { if (!this.frozen && !e.bodyDone) this.finishBody(e); }
          catch { e.data._bodyError = 'body-conversion-failed'; }
          finally { this.clearBuffer(e); e.bodyDone = true; this.filters.delete(e); try { f.close(); } catch { try { f.disconnect(); } catch {} } this.onChange(); }
        };
        f.onerror = () => this.release(e, 'filter-unavailable');
      } catch { e.data._bodyError = 'filter-unavailable'; e.bodyDone = true; }
    }
    post(e, body) {
      if (!body) return;
      if (body.error) { e.data._postDataError = 'unavailable'; return; }
      let post;
      if (body.formData) {
        post = { mimeType: '', params: Object.entries(body.formData).flatMap(([name, values]) => values.map((value) => ({ name, value }))) };
        e.data._postDataNote = 'Parsed form fields; original multipart bytes and uploaded file contents may be unavailable';
      } else if (body.raw) {
        let total = 0;
        for (const part of body.raw) { if (part.file) e.data._postDataNote = 'Uploaded file contents omitted'; total += part.bytes?.byteLength || 0; }
        if (total > this.options.maxPost) { e.data._postDataSkipped = 'per-body-limit'; return; }
        const data = new Uint8Array(total); let offset = 0;
        for (const part of body.raw) if (part.bytes) { data.set(new Uint8Array(part.bytes), offset); offset += part.bytes.byteLength; }
        try { post = { mimeType: '', text: new TextDecoder('utf-8', { fatal: true }).decode(data) }; }
        catch { e.data._postDataSkipped = 'binary-request-body'; return; }
        e.data.request.bodySize = total;
      }
      if (!post) return;
      const n = size(post.text ?? JSON.stringify(post.params));
      if (n > this.options.maxPost) { e.data._postDataSkipped = 'per-body-limit'; return; }
      const reason = this.budget.reserve('post', n);
      if (reason) { e.data._postDataSkipped = reason; this.warnings.add('payload-limit'); return; }
      e.data.request.postData = post;
    }
    requestHeaders(d) {
      const e = this.active.get(d.requestId); if (!e || this.frozen) return;
      if (!this.reserveMetadata(d.requestHeaders || [])) { e.data._metadataSkipped = 'metadata-limit'; return; }
      e.data.request.headers = hs(d.requestHeaders); e.data.request.cookies = cookiePairs(e.data.request.headers);
      if (e.data.request.postData) e.data.request.postData.mimeType = header(e.data.request.headers, 'content-type') || 'application/octet-stream';
    }
    responseHeaders(d) {
      const e = this.active.get(d.requestId); if (!e || this.frozen) return;
      e.responseAt = d.timeStamp;
      const r = e.data.response;
      r.status = d.statusCode || 0;
      r.httpVersion = d.statusLine?.split(' ')[0] || 'unknown';
      r.statusText = d.statusLine?.replace(/^\S+\s+\d+\s*/, '') || '';
      e.data.request.httpVersion = r.httpVersion;
      if (this.reserveMetadata(d.responseHeaders || [])) r.headers = hs(d.responseHeaders);
      else e.data._metadataSkipped = 'metadata-limit';
      r.content.mimeType = header(r.headers, 'content-type');
      r.redirectURL = header(r.headers, 'location');
      if (d.fromCache) e.data._fromCache = true;
      // Set-Cookie remains verbatim in response.headers, without lossy parsing.
      e.data._responseCookiesNote = 'See Set-Cookie response headers';
      const mime = r.content.mimeType;
      if (/^text\/event-stream/i.test(mime)) this.release(e, 'sse-not-supported');
      else if (!this.options.includeMedia && /^(image\/|audio\/|video\/|font\/)|application\/(x-font|font|vnd\.ms-fontobject)/i.test(mime)) this.release(e, 'media-filter');
      else if (e.data.request.method === 'HEAD' || [204, 205, 304].includes(r.status)) { this.release(e, 'no-body'); r.content.size = 0; }
    }
    release(e, reason) {
      if (!e.bodyDone) e.data._bodySkipped = reason;
      this.clearBuffer(e); e.bodyDone = true; this.filters.delete(e);
      if (e.filter) { try { e.filter.disconnect(); } catch {} }
      this.onChange();
    }
    clearBuffer(e) {
      // Exactly once on success, error, size limit, redirect, restart and stop.
      this.buffered -= e.bodyBytes;
      this.resourceBuffered -= e.resourceBuffered || 0;
      e.chunks = []; e.bodyBytes = 0; e.resourceBuffered = 0;
    }
    finishBody(e) {
      const data = new Uint8Array(e.bodyBytes); let offset = 0;
      for (const chunk of e.chunks) { data.set(chunk, offset); offset += chunk.length; }
      const content = e.data.response.content; content.size = data.length;
      const mime = content.mimeType;
      let text, encoding;
      if (/^text\/|json|javascript|xml|urlencoded|svg/i.test(mime)) {
        const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(mime)?.[1] || 'utf-8';
        try { text = new TextDecoder(charset, { fatal: true }).decode(data); } catch {}
      }
      if (text === undefined) { text = base64(data); encoding = 'base64'; }
      const reason = this.budget.reserve(root.HarPayload.responseClass(e.data), size(text));
      if (reason) { e.data._bodySkipped = reason; this.warnings.add('payload-limit'); return; }
      content.text = text;
      if (encoding) content.encoding = encoding;
    }
    complete(d, redirect = false, error = false) {
      const e = this.active.get(d.requestId); if (!e || this.frozen) return;
      if (d.statusCode) e.data.response.status = d.statusCode;
      if (d.fromCache) e.data._fromCache = true;
      e.done = true;
      e.data.time = Math.max(0, d.timeStamp - e.start);
      const wait = Math.max(0, Math.min(e.data.time, (e.responseAt ?? d.timeStamp) - e.start));
      e.data.timings = { send: 0, wait, receive: e.data.time - wait };
      if (redirect) { e.data.response.redirectURL = d.redirectUrl || ''; e.data._redirected = true; this.release(e, 'redirect'); }
      if (error) { e.data._error = d.error || 'request-failed'; this.release(e, 'request-failed'); }
      this.active.delete(d.requestId);
    }
    freeze() {
      this.accepting = false; this.frozen = true;
      for (const e of this.entries) {
        if (!e.done) e.data._incomplete = 'stopped-before-completion';
        if (!e.bodyDone) this.release(e, 'stop-wait-timeout');
      }
    }
    async settle(ms = 5000) {
      this.accepting = false; const end = Date.now() + ms;
      while ((this.active.size || this.filters.size) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      this.freeze();
    }
    build(tabs, reason) {
      const seen = new Map();
      for (const e of this.entries) if (!seen.has(e.tabId)) seen.set(e.tabId, e.data.startedDateTime);
      return { log: { version: '1.2', creator: { name: 'HAR Exporter Firefox', version: '1.4.3' },
        pages: [...seen].map(([id, startedDateTime]) => ({ id: `tab_${id}`, title: tabs.get(id)?.title || `标签页 ${id}`, startedDateTime, pageTimings: { onContentLoad: -1, onLoad: -1 } })),
        entries: this.entries.map((e) => ({ ...e.data, pageref: `tab_${e.tabId}` })),
        _capture: { backend: 'firefox-webRequest', reason, options: this.options, ...this.summary() } } };
    }
  }
  root.FirefoxCapture = FirefoxCapture;
})(globalThis);
