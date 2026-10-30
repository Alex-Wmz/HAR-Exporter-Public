const $ = (id) => document.getElementById(id);

const OPT_ASK = 'ask';
const OPT_DEFAULT = '__default__';
const OPT_PICK = '__pick__';
const PREFIX_FOLDER = 'folder:';
const OK_TIMEOUT = 4500;

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function displayName(f) {
  if (!f) return '未知文件夹';
  return f.label ? f.label : (f.name || '未命名文件夹');
}

let currentStatus = { phase: 'idle', count: 0, tabs: 0 };
let busy = false;
let recentExport = null;
async function loadRecent() {
  recentExport = await HarFs.getSetting(HarRecent.KEY, null).catch(() => null);
  $('recentSummary').textContent = HarRecent.describe(recentExport);
  $('btnLocate').textContent = recentExport?.method === 'downloads' ? '在文件夹中显示' : '浏览保存文件夹…';
}
function render(st) {
  currentStatus = st;
  const { phase, count, tabs } = st;
  const recording = phase === 'recording';
  const hasData = phase !== 'idle';
  const working = busy || ['starting', 'stopping', 'exporting'].includes(phase);
  $('dot').classList.toggle('rec', recording);
  $('statusIdle').classList.toggle('hidden', hasData);
  $('statusRec').classList.toggle('hidden', !hasData);
  $('statusLabel').textContent = ({ starting: '正在连接…', recording: '录制中…', stopping: '正在收齐响应…', ready: '数据已保留，等待导出。', exporting: '等待保存完成…' })[phase] || '';
  $('btnStart').classList.toggle('hidden', hasData);
  $('btnStop').classList.toggle('hidden', !hasData);
  $('btnCancel').classList.toggle('hidden', !hasData);
  $('btnStart').disabled = working;
  $('btnStop').disabled = working;
  $('btnCancel').disabled = working;
  $('btnResources').disabled = working || !hasData;
  $('chkMedia').disabled = hasData || working;
  $('chkFollow').disabled = working || phase === 'ready';
  $('btnStop').textContent = phase === 'ready' ? '导出已保留的数据' : phase === 'exporting' ? '等待保存完成…' : phase === 'stopping' ? '正在收齐响应…' : '■ 停止并导出 HAR';
  $('tabsHint').textContent = phase === 'ready' ? '可更换保存位置后重试。请先导出，再关闭浏览器或重新加载扩展。' : '完成后停止；已有请求最多再等待 5 秒。';
  $('tabsHint').classList.toggle('hidden', recording && tabs > 1);
  $('count').textContent = count;
  const multi = (tabs || 0) > 1;
  $('tabsLine').classList.toggle('hidden', !multi);
  $('tabsCount').textContent = tabs || 1;
  const info = HarPayload.describe(st.stats || (st.lastResult?.ok ? st.lastResult : null), !st.stats && st.lastResult?.ok);
  $('budgetStatus').textContent = info.budget;
  $('captureWarning').textContent = info.warning;
  $('captureWarning').classList.toggle('hidden', !info.warning);
}

async function refresh() {
  const st = await send({ type: 'getStatus' });
  await loadRecent();
  render(st);
  $('chkFollow').checked = st.followNewTabs !== false;
  $('chkMedia').checked = !!st.includeMedia;
  if (st.lastResult) showResult(st.lastResult);
  else if (st.reason === 'primary-tab-detached') showError('主标签页已关闭或调试已取消。已捕获的数据仍可导出。');
  else if (st.reason === 'capture-limit') showError('达到请求数量或请求头容量上限，录制已停止，请导出后分段继续。');
}

function showError(text) {
  const el = $('err');
  el.textContent = text;
  el.classList.remove('hidden');
  $('ok').classList.add('hidden');
  clearTimeout(showError._t);
}

function showOk(text, sticky) {
  const el = $('ok');
  el.textContent = text;
  el.classList.remove('hidden');
  $('err').classList.add('hidden');
  clearTimeout(showOk._t);
  if (!sticky) showOk._t = setTimeout(() => el.classList.add('hidden'), OK_TIMEOUT);
}

function showResult(res) {
  if (!res.ok) { showError(res.error || '操作未完成'); return; }
  if (!res.exported) return;
  const destination = res.method === 'folder' ? ` →「${res.folderName}」` : '';
  const fallback = res.fallbackReason ? '\n原目录不可写，已通过另存为保存。' : '';
  const warnings = res.warnings?.length ? '\n存在采集限制，具体原因见 HAR 的 log._capture.warnings。' : '';
  const loss = `缺失响应正文 ${res.lostResponseBodies || 0} 条、请求正文 ${res.lostRequestBodies || 0} 条。`;
  const locationWarning = res.locationWarning ? '\n' + res.locationWarning : '';
  showOk(`✓ 文件已保存 ${res.count} 条请求（${res.tabs} 个标签页）${destination}\n${res.filename}\n非空响应体 ${res.nonEmptyBody} 条；非空接口响应 ${res.nonEmptyApiBody}/${res.apiRequests}；网页正文 ${res.nonEmptyDocumentBody || 0}/${res.documentRequests || 0}；未完成 ${res.incomplete} 条。\n${loss}${fallback}${warnings}${locationWarning}`, true);
}

// ---------- 导出文件夹选择 ----------

let folderCache = [];
let defaultFolderId = null;

function addOption(parent, value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  parent.appendChild(o);
  return o;
}

async function loadFolders() {
  const [folders, lastId, target, defaultFolder] = await Promise.all([
    HarFs.listFolders().catch(() => []),
    HarFs.getLastFolderId().catch(() => null),
    HarFs.getTarget(),
    HarFs.getDefaultFolder(),
  ]);
  folderCache = folders;
  defaultFolderId = defaultFolder?.id || null;

  const sel = $('folderSelect');
  sel.innerHTML = '';

  $('btnDefaultFolder').classList.toggle('hidden', !HarFs.DEFAULT_FOLDER_PATH);
  $('btnDefaultFolder').textContent = `设置默认目录：${HarFs.DEFAULT_FOLDER_PATH}…`;
  if (HarFs.DEFAULT_FOLDER_PATH) addOption(sel, OPT_DEFAULT, `默认：${HarFs.DEFAULT_FOLDER_PATH}${defaultFolderId ? '' : '（首次需授权）'}`);
  addOption(sel, OPT_ASK, '每次询问（另存为对话框）');

  // A remembered directory is not necessarily the most recent successful Save As.
  const last = folders.find((f) => f.id === lastId) || folders[0];
  if (last) {
    addOption(sel, PREFIX_FOLDER + last.id, `记忆文件夹：${displayName(last)}`);
  }

  // 其余历史文件夹（最多 8 个，按最近使用排序）
  const others = folders.filter((f) => f.id !== (last && last.id)).slice(0, 8);
  if (others.length) {
    const g = document.createElement('optgroup');
    g.label = '最近文件夹';
    sel.appendChild(g);
    for (const f of others) addOption(g, PREFIX_FOLDER + f.id, displayName(f));
  }

  addOption(sel, OPT_PICK, '选择其他文件夹…');

  // 回显当前导出目标
  const current = target?.mode === 'default' || target?.defaultFolder ? OPT_DEFAULT : target && target.mode === 'folder' && target.folderId
    ? PREFIX_FOLDER + target.folderId
    : OPT_ASK;
  sel.value = [...sel.options].some((o) => o.value === current) ? current : HarFs.DEFAULT_FOLDER_PATH ? OPT_DEFAULT : OPT_ASK;

  updateForget();
  updateHint();
}

function selectedFolderId() {
  const v = $('folderSelect').value;
  if (v === OPT_DEFAULT) return defaultFolderId;
  return v.startsWith(PREFIX_FOLDER) ? v.slice(PREFIX_FOLDER.length) : null;
}

function updateForget() {
  $('btnForget').classList.toggle('hidden', !selectedFolderId() || $('folderSelect').value === OPT_DEFAULT);
}

function updateHint() {
  if ($('folderSelect').value === OPT_DEFAULT) {
    $('folderHint').textContent = defaultFolderId ? `直接保存到 ${HarFs.DEFAULT_FOLDER_PATH}` : '首次请点下方按钮选择并授权默认目录';
    return;
  }
  const id = selectedFolderId();
  if (!id) {
    $('folderHint').textContent = '导出时由你手动选择保存位置';
    return;
  }
  const f = folderCache.find((x) => x.id === id);
  $('folderHint').textContent = f
    ? (f.label ? `文件夹名：${f.name}` : '已记住该文件夹，直接写入，不弹窗')
    : '';
}

$('folderSelect').addEventListener('change', async () => {
  try {
  const v = $('folderSelect').value;
  if (v === OPT_PICK) {
    await openPicker();
    return;
  }
  const id = selectedFolderId();
  await HarFs.setTarget(v === OPT_DEFAULT ? { mode: 'default' } : id ? { mode: 'folder', folderId: id } : { mode: 'ask' });
  updateForget();
  updateHint();
  } catch (e) { showError('保存位置未更新：' + e.message); await loadFolders(); }
});

$('btnForget').addEventListener('click', async () => {
  const id = selectedFolderId();
  if (!id) return;
  const f = folderCache.find((x) => x.id === id);
  // 只从扩展的列表里移除，不会动磁盘上的任何文件
  if (!confirm(`从列表移除「${displayName(f)}」？\n\n只会忘记这个位置，不会删除磁盘上的任何文件。`)) return;
  try {
  await HarFs.forgetFolder(id);
  await loadFolders();
  showOk('已从列表移除。');
  } catch (e) { showError('移除失败：' + e.message); }
});

async function openPicker() {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('picker.html'),
      type: 'popup',
      width: 620,
      height: 700,
      focused: true,
    });
  } catch (e) {
    showError(`无法打开文件夹选择窗口: ${e.message}`);
    await loadFolders(); // 把下拉框从「选择其他文件夹…」复位
    return;
  }
  window.close(); // popup 交棒给独立窗口，避免弹窗失焦被关导致选择丢失
}

// ---------- 录制控制 ----------

$('btnDefaultFolder').addEventListener('click', openPicker);

$('btnResources').addEventListener('click', async () => {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('resources.html') }); }
  catch { showError('无法打开资源列表'); }
});

$('btnLocate').addEventListener('click', async () => {
  if (recentExport?.method !== 'downloads') { await openPicker(); return; }
  try { await HarRecent.showDownload(recentExport, chrome); }
  catch (e) { showError(e.message); }
});

$('btnStart').addEventListener('click', async () => {
  if (busy) return;
  if ($('folderSelect').value === OPT_DEFAULT && !defaultFolderId) { await openPicker(); return; }
  busy = true;
  render(currentStatus);
  try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    showError('只能在 http/https 网页上录制，请切换到目标网页（浏览器内部页面不支持）。');
    return;
  }
  const res = await send({ type: 'start', tabId: tab.id });
  if (!res.ok) {
    showError(res.error || '启动失败');
    return;
  }
  window.close(); // 关闭 popup 让用户去操作页面
  } catch (e) { showError('启动失败：' + e.message); }
  finally { busy = false; await refresh().catch(() => {}); }
});

$('btnStop').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  render(currentStatus);

  // 文件夹的写入授权必须在用户手势内申请（service worker 无权弹授权框），
  // 所以趁这次点击先把权限确认好；失败也不阻断，导出流程会自动退回另存为。
  try {
    const folderId = selectedFolderId();
    if (folderId) {
      const folder = folderCache.find((f) => f.id === folderId);
      if (folder && folder.handle) {
        await HarFs.ensurePermission(folder.handle);
      }
    }
  } catch { /* worker will fall back to Save As */ }

  let res;
  try {
    res = await send({ type: 'stop' });
  } catch (e) {
    res = { ok: false, error: String(e) };
  }

  if (!res.ok) {
    showError(res.error || '导出失败');
    busy = false;
    await refresh().catch(() => {});
    return;
  }
  busy = false;
  await refresh().catch(() => {});
  showResult(res);
});

$('btnCancel').addEventListener('click', async () => {
  if (busy || !confirm('确认放弃本轮已捕获的数据？此操作无法恢复。')) return;
  busy = true;
  render(currentStatus);
  try {
    const res = await send({ type: 'cancel' });
    if (!res.ok) showError(res.error);
  } catch (e) { showError('放弃失败：' + e.message); }
  finally { busy = false; await refresh().catch(() => {}); }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    render(msg);
    if (msg.lastResult) showResult(msg.lastResult);
    if (msg.lastResult?.exported) loadRecent().catch(() => {});
  }
});

// 跟随新标签页：录制前改会持久化，录制中改也立即生效
$('chkFollow').addEventListener('change', async () => {
  const on = $('chkFollow').checked;
  try {
    const res = await send({ type: 'setFollowNewTabs', value: on });
    if (!res.ok) throw new Error(res.error);
  } catch (e) {
    showError('设置未保存：' + e.message);
    await refresh().catch(() => {});
  }
});

$('chkMedia').addEventListener('change', async () => {
  try {
    const res = await send({ type: 'setIncludeMedia', value: $('chkMedia').checked });
    if (!res.ok) throw new Error(res.error);
  } catch (e) { showError('设置未保存：' + e.message); await refresh().catch(() => {}); }
});

(async () => {
  await loadFolders();
  await refresh();
})().catch((e) => showError('无法连接录制后台：' + e.message));
