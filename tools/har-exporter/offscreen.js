// Offscreen owns Blob URLs; payload is never placed in extension storage.
let current = null;
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to !== 'offscreen' || sender.id !== chrome.runtime.id) return false;
  try {
    if (msg.type === 'blob-begin') {
      if (current?.url) URL.revokeObjectURL(current.url);
      current = { token: msg.token, chunks: [], length: 0 };
    } else {
      if (current?.token !== msg.token) throw new Error('导出会话不匹配');
      if (msg.type === 'blob-chunk') {
        if (typeof msg.text !== 'string' || current.url) throw new Error('无效文件分块');
        current.length += msg.text.length;
        if (current.length > 160 * 1024 * 1024) throw new Error('HAR 太大，请分段录制');
        current.chunks.push(msg.text);
      } else if (msg.type === 'blob-end') {
        if (current.url) throw new Error('文件已准备完成');
        current.url = URL.createObjectURL(new Blob([current.chunks.join('')], { type: 'application/octet-stream' }));
        current.chunks = [];
        sendResponse({ ok: true, url: current.url });
        return false;
      } else if (msg.type === 'blob-release') {
        if (current.url) URL.revokeObjectURL(current.url);
        current = null;
      } else throw new Error('未知导出操作');
    }
    sendResponse({ ok: true });
  } catch (e) { sendResponse({ ok: false, error: e.message }); }
  return false;
});
setInterval(() => chrome.runtime.sendMessage({ type: 'keepalive' }).catch(() => {}), 20000);
