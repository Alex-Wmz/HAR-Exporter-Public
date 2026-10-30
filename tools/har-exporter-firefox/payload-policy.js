// Shared by both standalone extensions. Keep the Firefox copy byte-identical.
(function (root) {
  'use strict';
  const bytes = (text) => new TextEncoder().encode(String(text)).length;
  function responseClass(data) {
    const method = data.request?.method || 'GET';
    const mime = data.response?.content?.mimeType || '';
    // Navigation HTML often contains the complete server-rendered business data.
    // Keep it outside the static-resource pool, including Firefox frame types.
    if (/^(document|main_frame|sub_frame)$/i.test(data._resourceType || '') &&
        /^(text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(mime)) return 'document';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'api';
    if (/json|^(application|text)\/(?:[^;]+\+)?xml\b/i.test(mime)) return 'api';
    if (/javascript|ecmascript|^text\/css|^(image|audio|video|font)\//i.test(mime)) return 'resource';
    if (/^(xhr|fetch|xmlhttprequest|eventsource|websocket)$/i.test(data._resourceType || '')) return 'api';
    return 'resource';
  }
  class PayloadBudget {
    constructor(total = 64 * 1024 * 1024) {
      this.total = total;
      this.postLimit = Math.floor(total / 8);
      this.responseLimit = total - this.postLimit;
      this.resourceLimit = Math.floor(total / 4);
      this.used = { post: 0, api: 0, document: 0, resource: 0 };
    }
    reason(kind, size) {
      if (kind === 'post') return this.used.post + size > this.postLimit ? 'request-payload-limit' : null;
      if (kind === 'resource' && this.used.resource + size > this.resourceLimit) return 'resource-payload-limit';
      return this.used.api + this.used.document + this.used.resource + size > this.responseLimit ? 'total-payload-limit' : null;
    }
    reserve(kind, size) {
      const reason = this.reason(kind, size);
      if (!reason) this.used[kind] += size;
      return reason;
    }
    get retained() { return this.used.post + this.used.api + this.used.document + this.used.resource; }
    snapshot() {
      return { policy: 'api-document-priority-v2', unit: 'utf8-retained-text-bytes', totalLimitBytes: this.total,
        requestLimitBytes: this.postLimit, responseLimitBytes: this.responseLimit, resourceLimitBytes: this.resourceLimit,
        requestBytes: this.used.post, apiBytes: this.used.api, documentBytes: this.used.document, resourceBytes: this.used.resource, retainedBytes: this.retained };
    }
  }
  const expected = new Set(['no-body', 'redirect', 'media-filter', 'request-failed', 'stream-messages', 'websocket-not-supported', 'sse-not-supported']);
  function summarize(entries, budget, warnings) {
    const result = { count: entries.length, withBody: 0, nonEmptyBody: 0, apiRequests: 0, nonEmptyApiBody: 0, documentRequests: 0, nonEmptyDocumentBody: 0,
      bodyFailed: 0, bodySkipped: 0, failed: 0, incomplete: 0, lostResponseBodies: 0, lostRequestBodies: 0,
      responseLossReasons: {}, requestLossReasons: {}, bodySkippedReasons: {}, budget: budget.snapshot() };
    const add = (counts, reason) => { counts[reason] = (counts[reason] || 0) + 1; };
    for (const e of entries) {
      const text = e.response?.content?.text;
      const kind = responseClass(e);
      const api = e.request?.method !== 'OPTIONS' && kind === 'api';
      const document = e.request?.method !== 'OPTIONS' && kind === 'document';
      if (text !== undefined) result.withBody++;
      if (text?.length) { result.nonEmptyBody++; if (api) result.nonEmptyApiBody++; if (document) result.nonEmptyDocumentBody++; }
      if (api) result.apiRequests++;
      if (document) result.documentRequests++;
      if (e._bodyError) result.bodyFailed++;
      if (e._bodySkipped) { result.bodySkipped++; add(result.bodySkippedReasons, e._bodySkipped); }
      if (e._error) result.failed++;
      if (e._incomplete) result.incomplete++;
      // A filter can fail before the later redirect/no-content/error event.
      // Keep that raw diagnostic, but do not call an expected absence lost data.
      const noBodyExpected = e.request?.method === 'HEAD' || [204, 205, 304].includes(e.response?.status) || e._redirected || e._error;
      const responseLoss = noBodyExpected ? null : e._bodyError || (e._bodySkipped && !expected.has(e._bodySkipped) ? e._bodySkipped : null);
      const requestLoss = e._postDataError || e._postDataSkipped;
      if (responseLoss) { result.lostResponseBodies++; add(result.responseLossReasons, responseLoss); }
      if (requestLoss) { result.lostRequestBodies++; add(result.requestLossReasons, requestLoss); }
    }
    const allWarnings = new Set(warnings);
    if (result.lostResponseBodies || result.lostRequestBodies) allWarnings.add('body-data-missing');
    result.warnings = [...allWarnings];
    result.captureLimited = !!(result.lostResponseBodies || result.lostRequestBodies || result.incomplete || allWarnings.size);
    return result;
  }
  function describe(summary, saved = false) {
    if (!summary) return { budget: '', warning: '' };
    const b = summary.budget;
    const mib = (n) => (n / (1024 * 1024)).toFixed(1);
    const budget = b ? `请求正文 ${mib(b.requestBytes)} / ${mib(b.requestLimitBytes)} MiB；接口响应 ${mib(b.apiBytes)} MiB；网页正文 ${mib(b.documentBytes || 0)} MiB（${summary.nonEmptyDocumentBody || 0}/${summary.documentRequests || 0} 条非空）；其他响应 ${mib(b.resourceBytes)} / ${mib(b.resourceLimitBytes)} MiB。响应合计上限 ${mib(b.responseLimitBytes)} MiB。` : '';
    let warning = '';
    if (summary.lostResponseBodies || summary.lostRequestBodies) warning = `${saved ? '本次文件已保存，但正文有缺失' : '正文有缺失'}：${summary.lostResponseBodies} 条响应、${summary.lostRequestBodies} 条请求。${saved ? '下一轮请缩短录制时长。' : '建议保存后开始下一段录制；已丢失的正文无法补回。'}`;
    else if (b && ((b.requestLimitBytes > 0 && b.requestBytes >= b.requestLimitBytes * 0.8) || b.apiBytes + (b.documentBytes || 0) + b.resourceBytes >= b.responseLimitBytes * 0.8)) warning = '正文容量已接近上限，建议尽快保存并分段继续。';
    else if (b && b.resourceLimitBytes > 0 && b.resourceBytes >= b.resourceLimitBytes * 0.8) warning = '普通网页资源容量接近上限，网页正文、接口和请求正文仍有保留空间。';
    return { budget, warning };
  }
  root.HarPayload = { bytes, responseClass, PayloadBudget, summarize, describe };
})(typeof self === 'undefined' ? globalThis : self);
