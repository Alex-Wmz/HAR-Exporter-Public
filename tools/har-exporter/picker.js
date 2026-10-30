const $ = (id) => document.getElementById(id);

let picked = null;      // 本次刚选中的 FileSystemDirectoryHandle
let currentId = null;   // 当前导出目标
let currentHandle = null;
let recentExport = null;
let recentFolderHandle = null;
let pickedIsDefault = false;
let defaultHandle = null;

$('btnDefaultPick').addEventListener('click', () => chooseFolder(true));
$('btnDefaultPathCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(HarFs.DEFAULT_FOLDER_PATH); showMsg('已复制默认目录路径。', 'ok'); }
  catch { showMsg('复制失败，请手动复制上方路径。', 'err'); }
});
$('defaultConfirm').addEventListener('change', () => {
  $('btnSave').disabled = pickedIsDefault && !$('defaultConfirm').checked;
});
$('btnUseDefault').addEventListener('click', async () => {
  try {
    if (await HarFs.ensurePermission(defaultHandle) !== 'granted') throw new Error('未获得默认目录写入权限，请重新选择并授权');
    await HarFs.setTarget({ mode: 'default' });
    await renderList();
    showMsg('已切换到默认目录 ' + HarFs.DEFAULT_FOLDER_PATH, 'ok');
  } catch (e) { showMsg(e.message, 'err'); }
});

async function browse(handle) {
  clearMsg();
  try {
    await HarRecent.browseFolder(handle, window);
    showMsg('浏览窗口已关闭，保存位置未更改。', 'ok');
  } catch (e) { showMsg(e.message, 'err'); }
}

$('btnRecent').addEventListener('click', async () => {
  if (!recentExport) return;
  if (recentExport.method === 'folder') { await browse(recentFolderHandle); return; }
  clearMsg();
  try {
    await HarRecent.showDownload(recentExport, chrome);
    showMsg('已请求在系统文件夹中显示该文件。', 'ok');
  } catch (e) { showMsg(e.message, 'err'); }
});
$('btnCopy').addEventListener('click', async () => {
  if (!recentExport) return;
  try {
    await navigator.clipboard.writeText(recentExport.fullPath || recentExport.filename);
    showMsg(recentExport.fullPath ? '已复制完整文件路径。' : '已复制文件名。', 'ok');
  } catch { showMsg('复制失败，请手动选择上方文字复制。', 'err'); }
});
$('btnClearRecent').addEventListener('click', async () => {
  try {
    await HarFs.setSetting(HarRecent.KEY, null);
    await renderList();
    showMsg('已清除最近保存记录，磁盘文件和记忆文件夹不变。', 'ok');
  } catch (e) { showMsg('清除失败：' + e.message, 'err'); }
});

function displayName(f) {
  if (!f) return '未知文件夹';
  return f.label ? f.label : (f.name || '未命名文件夹');
}

function showMsg(text, kind) {
  const el = $('msg');
  el.textContent = text;
  el.className = kind === 'ok' ? 'ok' : 'err';
  el.classList.remove('hidden');
}

function clearMsg() {
  $('msg').classList.add('hidden');
}

function fmtDate(ts) {
  if (!ts) return '尚未使用';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 选择文件夹 ----------

$('btnPick').addEventListener('click', () => chooseFolder(false));
async function chooseFolder(forDefault) {
  clearMsg();
  if (typeof window.showDirectoryPicker !== 'function') {
    showMsg(
      '当前浏览器不支持「选择文件夹」(File System Access API)。\n' +
      '请使用较新的 Chrome / Edge，或改用扩展弹窗里的「每次询问（另存为对话框）」。',
      'err'
    );
    return;
  }
  try {
    const opts = { id: forDefault ? 'har-exporter-default-146' : 'har-exporter', mode: 'readwrite' };
    // 尽量从上次用过的目录打开，减少来回导航
    if (forDefault) opts.startIn = defaultHandle || 'downloads';
    else if (currentHandle) opts.startIn = currentHandle;
    const candidate = await window.showDirectoryPicker(opts);
    if (forDefault && candidate.name !== HarFs.DEFAULT_FOLDER_NAME) {
      showMsg('请选择默认目录 ' + HarFs.DEFAULT_FOLDER_PATH + '，本次选择未保存。', 'err');
      return;
    }
    picked = candidate;
    pickedIsDefault = forDefault;
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 用户取消
    showMsg(`选择失败：${(e && e.message) || e}`, 'err');
    return;
  }
  $('pickedName').textContent = picked.name || '（未命名文件夹）';
  $('labelInput').value = forDefault ? HarFs.DEFAULT_FOLDER_PATH : '';
  $('labelInput').readOnly = forDefault;
  $('defaultConfirm').checked = false;
  $('defaultConfirmWrap').classList.toggle('hidden', !forDefault);
  $('btnSave').disabled = forDefault;
  $('pickedBox').classList.remove('hidden');
  $('btnPick').textContent = '重新选择文件夹…';
  $('labelInput').focus();
}

$('btnRepick').addEventListener('click', () => {
  picked = null;
  pickedIsDefault = false;
  $('btnSave').disabled = false;
  $('pickedBox').classList.add('hidden');
  clearMsg();
});

$('btnSave').addEventListener('click', async () => {
  if (!picked) return;
  if (pickedIsDefault && !$('defaultConfirm').checked) { showMsg('请先核对并勾选默认目录路径。', 'err'); return; }
  clearMsg();
  const label = $('labelInput').value.trim();
  try {
    const perm = await HarFs.ensurePermission(picked);
    if (pickedIsDefault && perm !== 'granted') throw new Error('未获得默认目录写入权限，请允许后重试');
    const rec = pickedIsDefault
      ? await HarFs.saveDefaultFolder(picked, $('defaultConfirm').checked)
      : await HarFs.saveFolder(picked, label);
    currentId = rec.id;
    // 授权必须发生在用户手势内，趁这次点击一起办了
    await renderList();
    picked = null;
    pickedIsDefault = false;
    $('btnSave').disabled = false;
    $('pickedBox').classList.add('hidden');
    $('btnPick').textContent = '选择文件夹…';
    if (perm === 'granted') {
      showMsg(`✓ 已记住「${displayName(rec)}」，回到扩展弹窗即可看到。`, 'ok');
    } else {
      showMsg(
        `已记住「${displayName(rec)}」，但未获得写入权限。\n` +
        '导出时会退回另存为对话框；下次在弹窗点「停止并导出」时可重新授权。',
        'err'
      );
    }
  } catch (e) {
    showMsg(`保存失败：${(e && e.message) || e}`, 'err');
  }
});

// ---------- 已记住的文件夹 ----------

async function renderList() {
  const [folders, target, recent, defaultFolder] = await Promise.all([
    HarFs.listFolders().catch(() => []),
    HarFs.getTarget(),
    HarFs.getSetting(HarRecent.KEY, null).catch(() => null),
    HarFs.getDefaultFolder(),
  ]);
  defaultHandle = defaultFolder?.handle || null;
  $('defaultPanel').classList.toggle('hidden', !HarFs.DEFAULT_FOLDER_PATH);
  $('defaultPath').textContent = HarFs.DEFAULT_FOLDER_PATH;
  $('defaultConfirmText').textContent = '我已核对系统窗口地址栏，选择的是 ' + HarFs.DEFAULT_FOLDER_PATH;
  $('defaultStatus').textContent = defaultHandle
    ? (target.defaultFolder ? '当前默认目录已记住，导出时会检查写入权限。' : '默认目录已记住，点击“使用默认目录”即可切换。')
    : '首次使用请点击“选择并授权默认目录…”。授权前不会自动保存到旧目录。';
  $('btnUseDefault').disabled = !defaultHandle || !!target.defaultFolder;
  currentId = (target && target.mode === 'folder' && target.folderId) || null;
  currentHandle = folders.find((f) => f.id === currentId)?.handle || null;
  recentExport = recent;
  recentFolderHandle = folders.find((f) => f.id === recent?.folderId)?.handle || null;
  $('recentSummary').textContent = HarRecent.describe(recent);
  $('btnRecent').disabled = !recent;
  $('btnCopy').disabled = !recent;
  $('btnClearRecent').disabled = !recent;
  $('btnRecent').textContent = recent?.method === 'downloads' ? '在文件夹中显示' : '浏览保存文件夹…';
  $('btnCopy').textContent = recent?.fullPath ? '复制完整路径' : '复制文件名';

  const ul = $('list');
  ul.innerHTML = '';
  $('empty').classList.toggle('hidden', folders.length > 0);

  for (const f of folders) {
    const li = document.createElement('li');
    if (f.id === currentId) li.classList.add('current');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = displayName(f) + (recent?.method === 'folder' && f.id === recent.folderId ? '（最近导出）' : '');
    const sub = document.createElement('div');
    sub.className = 'sub2';
    sub.textContent = `${f.label ? '文件夹名 ' + f.name + ' · ' : ''}${fmtDate(f.lastUsedAt)}${f.useCount ? ' · 已用 ' + f.useCount + ' 次' : ''}`;
    meta.appendChild(nm);
    meta.appendChild(sub);

    const acts = document.createElement('div');
    acts.className = 'acts';

    const browseBtn = document.createElement('button');
    browseBtn.className = 'use';
    browseBtn.type = 'button';
    browseBtn.textContent = '浏览…';
    browseBtn.addEventListener('click', () => browse(f.handle));
    acts.appendChild(browseBtn);

    const useBtn = document.createElement('button');
    useBtn.className = 'use';
    useBtn.type = 'button';
    useBtn.textContent = f.id === currentId ? '当前' : '选用';
    useBtn.disabled = f.id === currentId;
    useBtn.addEventListener('click', async () => {
      try {
      // 顺手确认写权限，避免导出时才发现问题
      const perm = await HarFs.ensurePermission(f.handle);
      await HarFs.setTarget({ mode: 'folder', folderId: f.id });
      await renderList();
      if (perm === 'granted') showMsg(`✓ 已切到「${displayName(f)}」。`, 'ok');
      else showMsg(`已切到「${displayName(f)}」，但缺少写入权限，导出时会退回另存为对话框。`, 'err');
      } catch (e) { showMsg('选用失败：' + e.message, 'err'); }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.type = 'button';
    delBtn.textContent = '移除';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`从列表移除「${displayName(f)}」？\n\n只会忘记这个位置，不会删除磁盘上的任何文件。`)) return;
      try {
      await HarFs.forgetFolder(f.id);
      await renderList();
      clearMsg();
      } catch (e) { showMsg('移除失败：' + e.message, 'err'); }
    });

    acts.appendChild(useBtn);
    acts.appendChild(delBtn);
    li.appendChild(meta);
    li.appendChild(acts);
    ul.appendChild(li);
  }
}

$('btnClose').addEventListener('click', () => window.close());

renderList().catch((e) => showMsg('读取失败：' + e.message, 'err'));
