// Read-only projections of captured responses. No network or browser API calls.
(function (global) {
  'use strict';
  const LIMITS = Object.freeze({ rows: 2000, metadataBytes: 2 * 1024 * 1024,
    bodyBytes: 10 * 1024 * 1024, batchBytes: 32 * 1024 * 1024, batchFiles: 10 });
  const TYPES = Object.freeze({ image: '图片', audio: '音频', video: '视频', document: '文档', playlist: '播放清单', segment: '媒体片段' });
  const EXTENSIONS = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', bmp: 'image', ico: 'image',
    mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', opus: 'audio',
    mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', avi: 'video', mkv: 'video',
    pdf: 'document', txt: 'document', csv: 'document', json: 'document', xml: 'document', doc: 'document', docx: 'document',
    xls: 'document', xlsx: 'document', ppt: 'document', pptx: 'document', odt: 'document', ods: 'document', epub: 'document', zip: 'document',
    m3u8: 'playlist', mpd: 'playlist', ts: 'segment', m4s: 'segment',
  };
  const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
    'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/mp2t': 'ts',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json', 'application/xml': 'xml',
    'text/xml': 'xml', 'application/zip': 'zip', 'application/epub+zip': 'epub', 'application/msword': 'doc',
    'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'application/vnd.apple.mpegurl': 'm3u8', 'application/x-mpegurl': 'm3u8', 'audio/mpegurl': 'm3u8', 'application/dash+xml': 'mpd' };
  const mime = (entry) => String(entry?.data?.response?.content?.mimeType || '').split(';')[0].trim().toLowerCase().slice(0, 120);
  const header = (list, name) => (list || []).find((h) => String(h.name).toLowerCase() === name)?.value || '';
  function parseUrl(raw) {
    if (typeof raw !== 'string') return null;
    try { const url = new URL(raw); return /^https?:$/.test(url.protocol) ? url : null; } catch { return null; }
  }
  function extension(url) {
    try { return decodeURIComponent(url.pathname.split('/').pop()).split('.').at(-1).toLowerCase(); } catch { return ''; }
  }
  function kind(entry, url = parseUrl(entry?.data?.request?.url)) {
    if (!url) return null;
    const m = mime(entry), ext = extension(url);
    if (/html|javascript|ecmascript/.test(m)) return null;
    if (['m3u8', 'mpd'].includes(ext) || /mpegurl|dash\+xml/.test(m)) return 'playlist';
    if (['ts', 'm4s'].includes(ext) || m === 'video/mp2t') return 'segment';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('video/')) return 'video';
    if (MIME_EXT[m] && EXTENSIONS[MIME_EXT[m]] === 'document') {
      if (['application/json', 'application/xml', 'text/xml', 'text/plain'].includes(m) && !EXTENSIONS[ext]) return null;
      return 'document';
    }
    return !m || m === 'application/octet-stream' ? EXTENSIONS[ext] || null : null;
  }
  function displayUrl(raw) {
    if (String(raw).length > 8192) return '[地址过长，已隐藏]';
    const url = parseUrl(raw);
    if (!url) return '[无效地址]';
    const keys = [...url.searchParams.keys()].slice(0, 30);
    const query = keys.length ? '?' + keys.map((key) => encodeURIComponent(key).slice(0, 80) + '=[hidden]').join('&') : '';
    return (url.origin + url.pathname + query).slice(0, 2048);
  }
  function filename(entry, id) {
    const url = parseUrl(entry?.data?.request?.url);
    let name = '';
    try { name = decodeURIComponent(url?.pathname.split('/').pop() || ''); } catch {}
    name = name.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\\/:*?"<>|]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120);
    if (!name) name = `resource_${id}`;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    const desired = MIME_EXT[mime(entry)] || (url && EXTENSIONS[extension(url)] ? extension(url) : 'bin');
    const old = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (old !== desired) name = (old ? name.slice(0, -(old.length + 1)) : name) + '.' + desired;
    return name;
  }
  function bodyState(entry) {
    const d = entry?.data || {}, r = d.response, content = r?.content;
    if (d.request?.method === 'HEAD' || [204, 205, 304].includes(r?.status)) return { available: false, state: 'empty', label: '响应无正文' };
    if (d._incomplete) return { available: false, state: 'incomplete', label: '请求未完成' };
    if (d._error || d._bodyError) return { available: false, state: 'error', label: '正文读取失败' };
    if (r?.status === 206 || header(r?.headers, 'content-range')) return { available: false, state: 'partial', label: '分段响应，不能作为完整文件' };
    if (d._redirected || (r?.status >= 300 && r?.status < 400 && r?.status !== 304)) return { available: false, state: 'redirect', label: '重定向' };
    if (d._bodySkipped) return { available: false, state: 'skipped', label: ({ 'media-filter': '未采集媒体正文',
      'per-body-limit': '超出单条正文上限', 'resource-payload-limit': '资源正文预算已满', 'total-payload-limit': '正文预算已满',
      'no-body': '响应无正文', 'stream-messages': '流式消息，非完整文件' })[d._bodySkipped] || '正文未保留' };
    if (!entry?.done || entry.bodyPending) return { available: false, state: 'pending', label: '等待正文' };
    if (!r || r.status < 200 || r.status >= 300 || typeof content?.text !== 'string') return { available: false, state: 'missing', label: '无可导出的正文' };
    if (content.encoding && content.encoding !== 'base64') return { available: false, state: 'encoding', label: '不支持的正文编码' };
    if (content.size > LIMITS.bodyBytes) return { available: false, state: 'limit', label: '超出单条正文上限' };
    return { available: true, state: 'captured', label: content.encoding === 'base64' ? '已捕获' : '已捕获 · UTF-8' };
  }
  function index(entries, options = {}) {
    const maxRows = Math.min(LIMITS.rows, options.maxRows ?? LIMITS.rows);
    const maxMetadataBytes = Math.min(LIMITS.metadataBytes, options.maxMetadataBytes ?? LIMITS.metadataBytes);
    const rows = [], groups = new Map(), hops = new Map();
    let total = 0, metadataBytes = 0, groupCount = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i], d = e.data || {}, url = parseUrl(d.request?.url);
      const hop = e.chain ? hops.get(e.chain) || 0 : 0;
      if (e.chain) hops.set(e.chain, hop + 1);
      const type = kind(e, url);
      if (!type) continue;
      total++;
      if (rows.length >= maxRows) continue;
      const body = bodyState(e), content = d.response?.content;
      const row = { id: String(i), tabId: e.tabId, pageRef: `tab_${e.tabId}`, hop,
        kind: type, filename: filename(e, i), url: displayUrl(d.request.url), mime: mime(e),
        method: String(d.request.method || 'GET').slice(0, 16), status: d.response?.status || 0,
        size: Number.isFinite(content?.size) && content.size >= 0 ? content.size : -1,
        startedDateTime: String(d.startedDateTime || '').slice(0, 40), ...body };
      // Exact signed URLs stay inside the background. UI folding receives only opaque group IDs.
      let bucket = groups.get(d.request.url);
      if (!bucket) groups.set(d.request.url, bucket = new Map());
      const scope = JSON.stringify([row.tabId, e.chain?.source?.sessionId || '', hop, row.method, row.status,
        row.mime, row.size, row.state, content?.encoding || '', header(d.request.headers, 'range'), header(d.response?.headers, 'content-range')]);
      if (!bucket.has(scope)) bucket.set(scope, new Map());
      const bodies = bucket.get(scope), captured = content?.text ?? null;
      if (!bodies.has(captured)) bodies.set(captured, ++groupCount);
      row.group = bodies.get(captured);
      const size = new TextEncoder().encode(JSON.stringify(row)).length;
      if (metadataBytes + size > maxMetadataBytes) continue;
      metadataBytes += size;
      rows.push(row);
    }
    return { rows, total, omitted: total - rows.length, metadataBytes, limits: LIMITS };
  }
  function filter(rows, settings = {}) {
    const min = settings.minBytes ?? 0, max = settings.maxBytes ?? Infinity;
    if (!Number.isFinite(min) || min < 0 || max < min || (max !== Infinity && !Number.isFinite(max))) throw new Error('大小筛选无效');
    const query = String(settings.query || '').trim().toLowerCase().slice(0, 200);
    const result = rows.filter((r) => (!settings.kind || settings.kind === r.kind)
      && (!settings.availableOnly || r.available) && (!(min > 0 || max < Infinity) || r.size >= 0 && r.size >= min && r.size <= max)
      && (!query || `${r.filename}\n${r.url}\n${r.mime}`.toLowerCase().includes(query)));
    if (!settings.collapse) return result.map((r) => ({ ...r, duplicateCount: 1, members: [r.id] }));
    const folded = new Map();
    for (const row of result) {
      if (folded.has(row.group)) { const r = folded.get(row.group); r.duplicateCount++; r.members.push(row.id); }
      else folded.set(row.group, { ...row, duplicateCount: 1, members: [row.id] });
    }
    return [...folded.values()];
  }
  function body(entry, id) {
    if (!entry || !kind(entry)) throw new Error('不是本轮支持的资源');
    const st = bodyState(entry);
    if (!st.available) throw new Error(st.label);
    const c = entry.data.response.content;
    let size;
    if (c.encoding === 'base64') {
      if (c.text.length > 4 * Math.ceil(LIMITS.bodyBytes / 3)) throw new Error('正文超过导出上限');
      try { const decoded = atob(c.text); if (btoa(decoded) !== c.text) throw new Error(); size = decoded.length; }
      catch { throw new Error('Base64 正文无效'); }
    } else size = new TextEncoder().encode(c.text).length;
    if (size > LIMITS.bodyBytes) throw new Error('正文超过导出上限');
    return { text: c.text, encoding: c.encoding || 'utf8', mime: mime(entry), bytes: size, filename: filename(entry, id) };
  }
  function toBlob(value) {
    if (typeof value?.text !== 'string') throw new Error('缺少正文');
    let data;
    if (value.encoding === 'base64') {
      const binary = atob(value.text);
      data = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    } else if (value.encoding === 'utf8') data = new TextEncoder().encode(value.text);
    else throw new Error('不支持的正文编码');
    if (data.byteLength > LIMITS.bodyBytes || data.byteLength !== value.bytes) throw new Error('正文长度不匹配');
    return new Blob([data], { type: value.encoding === 'utf8' ? 'text/plain;charset=utf-8' : 'application/octet-stream' });
  }
  function manifest(rows) {
    return { format: 'HAR captured resources', version: 1, exportedAt: new Date().toISOString(),
      urls: 'Query values, URL credentials and fragments are omitted; paths and filenames may still be sensitive.',
      resources: rows.map((r) => ({ filename: r.filename, url: r.url, kind: r.kind, mime: r.mime, size: r.size,
        status: r.status, method: r.method, pageRef: r.pageRef, hop: r.hop, startedDateTime: r.startedDateTime,
        bodyState: r.label, duplicateCount: r.duplicateCount || 1 })) };
  }
  global.HarResources = Object.freeze({ LIMITS, TYPES, kind, displayUrl, filename, bodyState, index, filter, body, toBlob, manifest });
})(self);
