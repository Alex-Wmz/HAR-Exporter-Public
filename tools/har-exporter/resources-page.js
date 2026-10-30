(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const selected = new Set();
  let rows = [], visible = [], generation = null, phase = 'idle', page = 0, busy = false;
  const PAGE_SIZE = 25;
  const text = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; };
  const sizeText = (n) => n < 0 ? '未知' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
  function message(value, error = false) { $('result').textContent = value; $('result').classList.toggle('error', error); }
  function renderPhase() {
    $('phase').textContent = ({ idle: '当前无录制', starting: '正在连接', recording: '录制中', stopping: '正在收齐响应', ready: '数据已保留', exporting: 'HAR 正在保存' })[phase] || '';
  }
  function render() {
    const maxPage = Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1);
    page = Math.min(page, maxPage);
    const slice = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const fragment = document.createDocumentFragment();
    for (const row of slice) {
      const tr = document.createElement('tr'), choose = document.createElement('td'), cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = selected.has(row.id); cb.disabled = busy || !row.available;
      cb.setAttribute('aria-label', `选择 ${row.filename}`);
      cb.addEventListener('change', () => { if (cb.checked) selected.add(row.id); else selected.delete(row.id); render(); });
      choose.appendChild(cb); tr.appendChild(choose);
      const resource = document.createElement('td'), name = text('span', row.filename, 'name'), url = text('span', row.url, 'url');
      name.title = row.filename; url.title = row.url;
      resource.append(name, url);
      if (row.duplicateCount > 1) resource.appendChild(text('span', `相同地址 ${row.duplicateCount} 条`, 'detail'));
      tr.appendChild(resource); tr.appendChild(text('td', HarResources.TYPES[row.kind]));
      const source = text('td', `标签 ${row.tabId}`); source.appendChild(text('span', `${row.method} · ${row.status || '未响应'} · 跳 ${row.hop + 1}`, 'detail')); tr.appendChild(source);
      tr.appendChild(text('td', sizeText(row.size)));
      const body = text('td', row.label, row.available ? 'status-yes' : 'status-no'); body.appendChild(text('span', row.mime || 'MIME 未知', 'detail')); tr.appendChild(body);
      fragment.appendChild(tr);
    }
    $('rows').replaceChildren(fragment);
    $('empty').hidden = visible.length > 0;
    $('summary').textContent = `筛选 ${visible.length} 项 / 列表 ${rows.length} 条`;
    $('selection').textContent = `已选 ${selected.size} 项 · 每批最多 ${HarResources.LIMITS.batchFiles} 个文件 / 32 MiB`;
    $('page').textContent = `${page + 1} / ${maxPage + 1}`;
    $('previous').disabled = page === 0 || busy; $('next').disabled = page === maxPage || busy;
    $('refresh').disabled = busy;
    $('exportBodies').disabled = busy || !selected.size || selected.size > HarResources.LIMITS.batchFiles || !['recording', 'ready'].includes(phase);
    $('exportManifest').disabled = busy || !visible.length;
    const available = slice.filter((r) => r.available);
    $('selectPage').disabled = busy || !available.length;
    $('selectPage').checked = !!available.length && available.every((r) => selected.has(r.id));
    $('selectPage').indeterminate = available.some((r) => selected.has(r.id)) && !$('selectPage').checked;
    for (const id of ['query', 'kind', 'minSize', 'maxSize', 'collapse', 'availableOnly']) $(id).disabled = busy;
    renderPhase();
  }
  function applyFilters() {
    try {
      visible = HarResources.filter(rows, { query: $('query').value, kind: $('kind').value,
        minBytes: $('minSize').value === '' ? 0 : Number($('minSize').value) * 1024,
        maxBytes: $('maxSize').value === '' ? Infinity : Number($('maxSize').value) * 1024,
        availableOnly: $('availableOnly').checked, collapse: $('collapse').checked });
      const ids = new Set(visible.filter((r) => r.available).map((r) => r.id));
      for (const id of selected) if (!ids.has(id)) selected.delete(id);
      page = 0; message(''); render();
    } catch (error) { selected.clear(); visible = []; render(); message(error.message, true); }
  }
  async function refresh() {
    if (busy) return;
    $('refresh').disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'getResources' });
      if (!result?.ok) throw new Error(result?.error || '无法读取资源');
      if (generation !== result.generation) selected.clear();
      rows = result.rows; generation = result.generation; phase = result.phase;
      $('notice').hidden = !result.omitted;
      $('notice').textContent = result.omitted ? `列表达到容量上限，另有 ${result.omitted} 条未展示；原 HAR 不受影响。` : '';
      message(''); applyFilters();
    } catch (error) { message(error.message, true); render(); }
  }
  $('filters').addEventListener('submit', (event) => event.preventDefault());
  for (const id of ['query', 'kind', 'minSize', 'maxSize', 'availableOnly', 'collapse']) $(id).addEventListener('input', applyFilters);
  $('refresh').addEventListener('click', refresh);
  $('previous').addEventListener('click', () => { page--; render(); });
  $('next').addEventListener('click', () => { page++; render(); });
  $('selectPage').addEventListener('change', () => {
    for (const row of visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      if (row.available) { if ($('selectPage').checked) selected.add(row.id); else selected.delete(row.id); }
    }
    render();
  });
  $('exportBodies').addEventListener('click', async () => {
    if (busy || !selected.size) return;
    const batch = visible.filter((r) => selected.has(r.id)), expectedGeneration = generation;
    busy = true; render();
    try {
      const result = await HarResourceExport.batch(batch, async (id) => {
        const response = await chrome.runtime.sendMessage({ type: 'getResourceBody', generation: expectedGeneration, id });
        if (!response?.ok || response.generation !== expectedGeneration) throw new Error(response?.error || '录制数据已变化');
        return response.body;
      }, ({ completed, total, row }) => message(`正在另存为 ${completed + 1}/${total} · ${row.filename}`));
      for (const id of result.completed) selected.delete(id);
      message(result.error ? `已保存 ${result.completed.length} 个；其余未完成：${result.error}` : `已保存 ${result.completed.length} 个资源。`, !!result.error);
    } catch (error) { message(error.message, true); }
    finally { busy = false; render(); }
  });
  $('exportManifest').addEventListener('click', async () => {
    if (busy || !visible.length) return;
    busy = true; render();
    try {
      const content = JSON.stringify(HarResources.manifest(visible), null, 2);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await HarResourceExport.save(new Blob([content], { type: 'application/json' }), `resources_${stamp}.json`);
      message(`已保存 ${visible.length} 项的筛选清单。`);
    } catch (error) { message(error.message, true); }
    finally { busy = false; render(); }
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'status' || msg.phase === phase) return;
    phase = msg.phase;
    if (['idle', 'starting'].includes(phase)) { rows = []; visible = []; selected.clear(); }
    render();
  });
  $('version').textContent = chrome.runtime.getManifest().version;
  refresh();
})();
