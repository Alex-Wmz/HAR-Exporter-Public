// CDP -> HAR 1.2. No disk storage, browser globals or page execution.
(function (global) {
  'use strict';
  const bytes = (s) => new TextEncoder().encode(String(s)).length;
  const headers = (input) => (Array.isArray(input) ? input : Object.entries(input || {}).map(([name, value]) => ({ name, value })))
    .flatMap(({ name, value }) => String(value ?? '').split('\n').map((v) => ({ name, value: v })));
  const header = (list, name) => list.find((h) => h.name.toLowerCase() === name)?.value || '';
  function cookies(list, response = false) {
    const rows = list.filter((h) => h.name.toLowerCase() === (response ? 'set-cookie' : 'cookie'));
    return rows.flatMap(({ value }) => {
      const parts = value.split(';').map((v) => v.trim()).filter(Boolean);
      const pair = (v) => { const i = v.indexOf('='); return i < 0 ? null : { name: v.slice(0, i), value: v.slice(i + 1) }; };
      if (!response) return parts.map(pair).filter(Boolean);
      const c = pair(parts.shift() || '');
      if (!c) return [];
      for (const part of parts) {
        const i = part.indexOf('=');
        const name = (i < 0 ? part : part.slice(0, i)).toLowerCase();
        const val = part.slice(i + 1);
        if (name === 'path' || name === 'domain') c[name] = val;
        if (name === 'secure') c.secure = true;
        if (name === 'httponly') c.httpOnly = true;
        if (name === 'expires' && Number.isFinite(Date.parse(val))) c.expires = new Date(val).toISOString();
        if (name === 'samesite') c._sameSite = val;
      }
      return [c];
    });
  }
  function query(url) {
    try { return [...new URL(url).searchParams].map(([name, value]) => ({ name, value })); } catch { return []; }
  }
  function response(r = {}) {
    const hs = headers(r.headers);
    const protocol = ({ h2: 'HTTP/2', h3: 'HTTP/3', 'http/1.1': 'HTTP/1.1', 'http/1.0': 'HTTP/1.0' })[r.protocol] || r.protocol || 'unknown';
    return { status: r.status || 0, statusText: r.statusText || '', httpVersion: protocol,
      headers: hs, cookies: cookies(hs, true), content: { size: -1, mimeType: r.mimeType || '' },
      redirectURL: header(hs, 'location'), headersSize: -1, bodySize: -1 };
  }
  class HarCapture {
    constructor(send, options = {}, onChange = () => {}) {
      this.send = send;
      this.onChange = onChange;
      this.options = { maxBodyBytes: 10 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
        maxPostBytes: 1024 * 1024, maxMetadataBytes: 16 * 1024 * 1024, maxEntries: 10000, includeMedia: false, ...options };
      this.entries = [];
      this.chains = new Map();
      this.pending = new Set();
      this.bodyQueue = [];
      this.bodyActive = 0;
      this.budget = new global.HarPayload.PayloadBudget(this.options.maxTotalBytes);
      this.metadataBytes = 0;
      this.accepting = true;
      this.frozen = false;
      this.warnings = new Set();
    }
    key(source, id) { return JSON.stringify([source.tabId, source.sessionId || '', id]); }
    chain(source, id, create = false) {
      const key = this.key(source, id);
      if (!this.chains.has(key) && create && this.chains.size >= this.options.maxEntries) {
        this.warnings.add('entry-limit'); this.accepting = false;
      }
      if (!this.chains.has(key) && create && this.chains.size < this.options.maxEntries) {
        this.chains.set(key, { source: { ...source }, id, hops: [], requestExtra: [], responseExtra: [] });
      }
      return this.chains.get(key);
    }
    track(promise) {
      this.pending.add(promise);
      promise.finally(() => this.pending.delete(promise)).catch(() => {});
      return promise;
    }
    reserve(text, entry, kind) {
      const size = bytes(text);
      if (kind !== 'encoded-body' && size > (kind === 'post' ? this.options.maxPostBytes : this.options.maxBodyBytes)) {
        entry.data[kind === 'post' ? '_postDataSkipped' : '_bodySkipped'] = 'per-body-limit';
        this.onChange();
        return false;
      }
      const pool = kind === 'post' ? 'post' : global.HarPayload.responseClass(entry.data);
      const reason = this.budget.reserve(pool, size);
      if (reason) {
        entry.data[kind === 'post' ? '_postDataSkipped' : '_bodySkipped'] = reason;
        this.warnings.add('payload-limit');
        this.onChange();
        return false;
      }
      this.onChange();
      return true;
    }
    get retainedBytes() { return this.budget.retained; }
    summary() { return global.HarPayload.summarize(this.entries.map((e) => e.data), this.budget, this.warnings); }
    retainMetadata(value, entry) {
      const size = bytes(JSON.stringify(value));
      if (this.metadataBytes + size > this.options.maxMetadataBytes) {
        this.warnings.add('metadata-limit');
        this.accepting = false;
        if (entry) entry.data._metadataSkipped = 'metadata-limit';
        return false;
      }
      this.metadataBytes += size;
      return true;
    }
    post(entry, text) {
      if (this.frozen || entry.data.request.postData) return;
      entry.data.request.bodySize = bytes(text);
      if (!this.reserve(text, entry, 'post')) return;
      entry.data.request.postData = { mimeType: header(entry.data.request.headers, 'content-type') || 'application/octet-stream', text };
      if (/^multipart\/form-data/i.test(entry.data.request.postData.mimeType)) entry.data._postDataNote = 'CDP may omit uploaded file contents';
    }
    extra(chain) {
      // Both ExtraInfo streams have the order of redirect hops, but may precede
      // their base events. Only consume after hasExtraInfo identifies that hop.
      for (const e of chain.hops) {
        if (e.extraExpected === undefined) break;
        if (!e.extraExpected) continue;
        if (!e.requestExtra && chain.requestExtra.length) {
          const x = chain.requestExtra.shift();
          // ExtraInfo contains the actual wire headers. Keeping omitted base
          // headers could falsely claim a blocked Cookie/Authorization was sent.
          if (x.headers) e.data.request.headers = headers(x.headers);
          e.data.request.cookies = cookies(e.data.request.headers);
          if (e.data.request.postData) e.data.request.postData.mimeType = header(e.data.request.headers, 'content-type') || e.data.request.postData.mimeType;
          e.requestExtra = true;
        }
        if (!e.responseExtra && chain.responseExtra.length) {
          const x = chain.responseExtra.shift();
          if (!e.data.response) e.data.response = response();
          const r = e.data.response;
          if (x.headers) r.headers = headers(x.headers);
          r.cookies = cookies(r.headers, true);
          if (x.statusCode !== undefined && x.statusCode !== r.status) {
            r._effectiveStatus = r.status;
            r.status = x.statusCode;
            r.statusText = '';
          }
          if (x.headersText) r.headersSize = bytes(x.headersText);
          r.redirectURL = header(r.headers, 'location') || r.redirectURL;
          if (x.blockedCookies?.length) r._blockedCookies = x.blockedCookies;
          e.responseExtra = true;
        }
      }
    }
    timing(e, end) {
      const duration = Math.max(0, ((end ?? e.start) - e.start) * 1000);
      const wait = Math.min(duration, Math.max(0, ((e.responseAt ?? end ?? e.start) - e.start) * 1000));
      e.data.timings = { send: 0, wait, receive: duration - wait };
      e.data.time = duration;
    }
    handle(source, method, p) {
      if (this.frozen || !method.startsWith('Network.')) return;
      const start = method === 'Network.requestWillBeSent' || method === 'Network.webSocketCreated';
      if (start && this.accepting && this.entries.length >= this.options.maxEntries) {
        this.warnings.add('entry-limit'); this.accepting = false;
      }
      let chain = this.chain(source, p.requestId, this.accepting && (start || method.endsWith('ExtraInfo')));
      if (!chain) return;
      let e = chain.hops.at(-1);
      if (method.endsWith('ExtraInfo')) {
        const queue = method === 'Network.requestWillBeSentExtraInfo' ? chain.requestExtra : chain.responseExtra;
        const retained = { headers: p.headers, statusCode: p.statusCode, headersText: p.headersText, blockedCookies: p.blockedCookies };
        if (queue.length < this.options.maxEntries && this.retainMetadata(retained, e)) queue.push(retained);
        this.extra(chain);
        return;
      }
      // After a redirect crosses the stop/limit boundary, later base events
      // reuse the same requestId but belong to an unrecorded hop. ExtraInfo
      // above may still complete the recorded hop's wire headers.
      if (chain.redirectContinuationSkipped) return;
      if (start) {
        if (p.redirectResponse && e) {
          // Seal first: either hop's metadata may exhaust the budget before
          // we can create the next entry. Reopen only after that entry exists.
          chain.redirectContinuationSkipped = true;
          e.data._redirectContinuationSkipped = 'capture-stopped';
          if (!this.retainMetadata(p.redirectResponse.headers, e)) return;
          e.data.response = response(p.redirectResponse);
          e.data.response.redirectURL = p.request.url;
          e.data._redirected = true;
          e.data._bodySkipped = 'redirect';
          e.done = true;
          e.extraExpected = p.redirectHasExtraInfo !== false;
          this.timing(e, p.timestamp);
          this.extra(chain);
          if (!this.accepting) return;
        }
        if (!this.accepting) return;
        if (this.entries.length >= this.options.maxEntries) {
          this.warnings.add('entry-limit');
          this.accepting = false;
          return;
        }
        const r = p.request || { url: p.url, method: 'GET', headers: {} };
        if (!this.retainMetadata({ url: r.url, headers: r.headers })) return;
        const hs = headers(r.headers);
        const data = { startedDateTime: new Date((p.wallTime || Date.now() / 1000) * 1000).toISOString(), time: 0,
          request: { method: r.method, url: r.url, httpVersion: 'unknown', headers: hs,
            queryString: query(r.url), cookies: cookies(hs), headersSize: -1, bodySize: r.hasPostData ? -1 : 0 },
          response: null, cache: {}, timings: { send: 0, wait: 0, receive: 0 }, _resourceType: p.type || (method === 'Network.webSocketCreated' ? 'WebSocket' : 'Other') };
        e = { data, tabId: source.tabId, start: p.timestamp || 0, done: false, chain,
          stream: method === 'Network.webSocketCreated' ? 'websocket' : null };
        if (chain.redirectContinuationSkipped) {
          delete chain.hops.at(-1).data._redirectContinuationSkipped;
          chain.redirectContinuationSkipped = false;
        }
        this.entries.push(e);
        chain.hops.push(e);
        if (r.postData !== undefined) this.post(e, r.postData);
        else if (r.hasPostData) this.track(this.send(source, 'Network.getRequestPostData', { requestId: p.requestId })
          .then((result) => { if (result?.postData !== undefined) this.post(e, result.postData); })
          .catch(() => { if (!this.frozen) data._postDataError = 'unavailable'; }));
        return;
      }
      if (!e) return;
      if (method === 'Network.responseReceived' || method === 'Network.webSocketHandshakeResponseReceived') {
        if (!this.retainMetadata(p.response.headers, e)) return;
        e.data.response = response(p.response);
        if (p.type) e.data._resourceType = p.type;
        e.data.request.httpVersion = e.data.response.httpVersion;
        e.responseAt = p.timestamp;
        e.extraExpected = p.hasExtraInfo !== false && e.stream !== 'websocket';
        if (p.response.fromDiskCache || p.response.fromServiceWorker || p.response.fromPrefetchCache) e.data._fromCache = true;
        if (/^text\/event-stream/i.test(p.response.mimeType)) e.stream = 'eventsource';
        this.extra(chain);
      } else if (method === 'Network.webSocketWillSendHandshakeRequest') {
        e.start = p.timestamp;
        if (p.wallTime) e.data.startedDateTime = new Date(p.wallTime * 1000).toISOString();
        e.data.request.headers = headers(p.request.headers);
        e.data.request.cookies = cookies(e.data.request.headers);
      } else if (method === 'Network.dataReceived') {
        e.decoded = (e.decoded || 0) + (p.dataLength || 0);
        e.encoded = (e.encoded || 0) + (p.encodedDataLength || 0);
      } else if (method === 'Network.requestServedFromCache') {
        e.data._fromCache = true;
      } else if (method === 'Network.loadingFinished') {
        if (e.done) return;
        e.done = true;
        this.timing(e, p.timestamp);
        if (e.data.response) {
          e.data.response._transferSize = p.encodedDataLength;
          e.data.response.bodySize = e.encoded ?? -1;
          e.data.response.content.size = e.decoded ?? -1;
        }
        this.queueBody(e);
      } else if (method === 'Network.loadingFailed' || method === 'Network.webSocketFrameError') {
        e.done = true;
        e.data._error = p.errorText || 'failed';
        if (!e.data.response) e.data.response = response({ statusText: e.data._error });
        e.data._bodySkipped = 'request-failed';
        if (p.blockedReason) e.data._blockedReason = p.blockedReason;
        if (p.corsErrorStatus) e.data._corsError = p.corsErrorStatus;
        e.extraExpected ??= true;
        this.extra(chain);
        this.timing(e, p.timestamp);
      } else if (method === 'Network.webSocketClosed') {
        e.done = true;
        this.timing(e, p.timestamp);
      } else if (method === 'Network.eventSourceMessageReceived' || /^Network.webSocketFrame(Sent|Received)$/.test(method)) {
        const message = p.response ? { type: method.endsWith('Sent') ? 'send' : 'receive', time: p.timestamp,
          opcode: p.response.opcode, data: p.response.payloadData } : { time: p.timestamp, event: p.eventName, id: p.eventId, data: p.data };
        const field = p.response ? '_webSocketMessages' : '_eventSourceMessages';
        const rows = e.data[field] ||= [];
        if (rows.length >= 10000) { e.data._messagesTruncated = true; return; }
        if (this.reserve(JSON.stringify(message), e, 'body')) rows.push(message);
        else e.data._messagesTruncated = true;
      }
    }
    queueBody(e) {
      if (!e.data.response) { e.data._bodyError = 'response-not-received'; return; }
      const d = e.data;
      const r = d.response;
      if (e.stream) { d._bodySkipped = 'stream-messages'; return; }
      if (d.request.method === 'HEAD' || [204, 205, 304].includes(r.status)) {
        r.content.size = 0; d._bodySkipped = 'no-body'; return;
      }
      if (!this.options.includeMedia && /^(image\/|audio\/|video\/|font\/)|application\/(x-font|font|vnd\.ms-fontobject)/i.test(r.content.mimeType)) {
        d._bodySkipped = 'media-filter'; return;
      }
      if (e.decoded > this.options.maxBodyBytes) { d._bodySkipped = 'per-body-limit'; return; }
      const reason = this.budget.reason(global.HarPayload.responseClass(d), e.decoded || 0);
      if (reason) { d._bodySkipped = reason; this.warnings.add('payload-limit'); return; }
      e.bodyPending = true;
      this.bodyQueue.push(e);
      this.pumpBodies();
    }
    pumpBodies() {
      while (!this.frozen && this.bodyActive < 4 && this.bodyQueue.length) {
        const e = this.bodyQueue.shift();
        this.bodyActive++;
        this.track(this.send(e.chain.source, 'Network.getResponseBody', { requestId: e.chain.id }).then((result) => {
          if (this.frozen) return;
          if (typeof result?.body !== 'string') throw new Error('missing body');
          const size = result.base64Encoded ? Math.floor(result.body.length * 3 / 4) - (result.body.match(/=*$/)[0].length) : bytes(result.body);
          e.data.response.content.size = size;
          if (size > this.options.maxBodyBytes) { e.data._bodySkipped = 'per-body-limit'; return; }
          if (!this.reserve(result.body, e, 'encoded-body')) return;
          e.data.response.content.text = result.body;
          if (result.base64Encoded) e.data.response.content.encoding = 'base64';
        }).catch(() => { if (!this.frozen) e.data._bodyError = 'unavailable-or-timeout'; }).finally(() => {
          e.bodyPending = false;
          this.bodyActive--;
          this.onChange();
          this.pumpBodies();
        }));
      }
    }
    get inflight() { return this.entries.filter((e) => !e.done && !e.stream).length; }
    get awaitingExtraInfo() {
      return this.entries.some((e) => e.extraExpected && (!e.requestExtra || !e.responseExtra));
    }
    async settle(ms = 5000) {
      this.accepting = false;
      const end = Date.now() + ms;
      while ((this.inflight || this.pending.size || this.bodyQueue.length || this.awaitingExtraInfo) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 25));
      }
      this.freeze();
    }
    freeze(reason = 'stopped-before-completion') {
      this.frozen = true;
      this.accepting = false;
      for (const e of this.entries) {
        if (!e.data.response) e.data.response = response();
        if (!e.done && !e.stream) { e.data._incomplete = reason; e.data._bodySkipped = 'incomplete'; }
        if (e.stream) { e.data._bodySkipped = 'stream-messages'; if (!e.done) e.data._streamOpenAtStop = true; }
        if (e.bodyPending) e.data._bodyError = 'stop-wait-timeout';
        if (e.extraExpected && (!e.requestExtra || !e.responseExtra)) e.data._extraInfoIncomplete = true;
        if (e.data.request.bodySize === -1 && !e.data.request.postData) e.data._postDataError ||= 'unavailable-at-stop';
      }
      this.bodyQueue.length = 0;
    }
    markDetached(tabId, sessionId) {
      for (const e of this.entries) {
        if (e.tabId !== tabId || (sessionId && e.chain.source.sessionId !== sessionId) || e.done) continue;
        e.done = true;
        e.data._incomplete = 'debugger-detached';
        e.data._bodySkipped = 'incomplete';
      }
    }
    build(pages, version, reason) {
      const entries = this.entries.map((e) => ({ ...e.data, response: e.data.response || response(), pageref: `tab_${e.tabId}` }));
      const counts = { ...this.summary(), tabs: pages.length };
      return { har: { log: { version: '1.2', creator: { name: 'HAR Exporter (Chrome Extension)', version },
        pages, entries, _capture: { ...counts, reason, options: this.options } } }, ...counts };
    }
  }
  global.HarCapture = HarCapture;
})(self);
