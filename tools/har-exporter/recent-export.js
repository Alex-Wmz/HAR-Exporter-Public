// Only one successful export's location metadata; never HAR payloads or headers.
(function (global) {
  'use strict';
  const KEY = 'lastSuccessfulExport';
  function record(saved, filename, savedAt = Date.now()) {
    const out = { method: saved.method, filename: saved.filename || filename, savedAt };
    if (saved.method === 'folder') {
      out.folderId = saved.folderId;
      out.folderName = saved.folderName;
    } else if (saved.method === 'downloads') {
      out.downloadId = saved.downloadId;
      if (saved.fullPath) out.fullPath = saved.fullPath;
    } else throw new Error('未知保存方式');
    return out;
  }
  function describe(item) {
    if (!item) return '升级后成功导出一次，即可显示文件名、时间和保存位置。';
    const where = item.method === 'downloads'
      ? (item.fullPath || '通过另存为保存，可在文件夹中显示')
      : `文件夹：${item.folderName || '已记住的目录'}（浏览器不提供完整路径）`;
    return `${item.filename}\n${new Date(item.savedAt).toLocaleString()}\n${where}`;
  }
  // Must be called directly from a click, with a handle already loaded in memory.
  // The chooser shows filenames; no file contents are read and no target is changed.
  async function browseFolder(handle, win = global) {
    if (!handle) throw new Error('该文件夹已从列表移除，请重新选择文件夹。');
    if (typeof win.showOpenFilePicker !== 'function') throw new Error('当前浏览器不支持浏览文件夹，请使用 Chrome 或 Edge。');
    try {
      await win.showOpenFilePicker({ startIn: handle, multiple: false,
        types: [{ description: 'HAR 网络记录', accept: { 'application/json': ['.har'] } }],
        excludeAcceptAllOption: false });
      return true;
    } catch (e) {
      if (e?.name === 'AbortError') return false;
      throw new Error('无法浏览原文件夹，可能已移动或权限失效；请重新选择文件夹。');
    }
  }
  async function showDownload(item, api) {
    if (!Number.isInteger(item?.downloadId) || item.downloadId < 0) throw new Error('没有可定位的下载记录。');
    const [found] = await api.downloads.search({ id: item.downloadId });
    if (!found || (found.byExtensionId && found.byExtensionId !== api.runtime.id)) throw new Error('下载记录已清除，请复制下方保存路径到资源管理器查找。');
    if (found.state !== 'complete' || found.exists === false) throw new Error('文件可能已移动或删除，请按下方原保存路径查找。');
    await api.downloads.show(item.downloadId);
  }
  global.HarRecent = { KEY, record, describe, browseFolder, showDownload };
})(self);
