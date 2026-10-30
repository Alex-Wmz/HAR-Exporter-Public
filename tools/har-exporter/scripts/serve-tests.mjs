// Optional local browser harness; no dependencies or external network access.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const files = new Set(['export-config.js', 'payload-policy.js', 'capture.js', 'fs-store.js', 'recent-export.js', 'picker.js', 'popup.js', 'offscreen.js', 'test/browser.html', 'test/native-browser.js', 'test/popup-mock.js', 'test/location-mock.js',
  'resources.js', 'resource-export.js', 'resources-page.js', 'test/resources-mock.js', 'icons/icon48.png']);
const port = Number(process.argv[2] || 8766);
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'test/browser.html';
  try {
    let text, type = name.endsWith('.js') ? 'text/javascript' : 'text/html';
    if (name === 'popup-test.html') {
      text = (await readFile(new URL('popup.html', root), 'utf8')).replace('<script src="fs-store.js">', '<script src="test/popup-mock.js"></script><script src="fs-store.js">');
    } else if (name === 'location-test.html') {
      text = (await readFile(new URL('picker.html', root), 'utf8')).replace('<script src="picker.js">', '<script src="test/location-mock.js"></script><script src="picker.js">');
    } else if (name === 'resources-test.html') {
      text = (await readFile(new URL('resources.html', root), 'utf8')).replace('<script src="resource-export.js">', '<script src="test/resources-mock.js"></script><script src="resource-export.js">');
    } else if (name.startsWith('firefox/')) {
      const file = name.slice(8);
      if (!['popup-test.html', 'popup.js', 'popup.css', 'payload-policy.js', 'test/popup-mock.js'].includes(file)) { res.writeHead(404); res.end(); return; }
      const ffRoot = new URL('../har-exporter-firefox/', root);
      text = await readFile(new URL(file === 'popup-test.html' ? 'popup.html' : file, ffRoot), 'utf8');
      if (file === 'popup-test.html') text = text.replace('<script src="popup.js">', '<script src="test/popup-mock.js"></script><script src="popup.js">');
      if (file.endsWith('.css')) type = 'text/css';
    } else if (name === 'offscreen-test.html') {
      text = '<!doctype html><script src="test/popup-mock.js"></script><script src="offscreen.js"></script>';
    } else {
      if (!files.has(name)) { res.writeHead(404); res.end(); return; }
      if (name.endsWith('.png')) { text = await readFile(new URL(name, root)); type = 'image/png'; }
      else text = await readFile(new URL(name, root), 'utf8');
    }
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(text);
  } catch { res.writeHead(500); res.end('Local test fixture unavailable'); }
});
server.listen(port, '127.0.0.1', () => console.log(`HAR browser harness: http://127.0.0.1:${port}/ (${fileURLToPath(root)})`));
