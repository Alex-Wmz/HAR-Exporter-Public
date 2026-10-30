import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.manifest_version, 2);
assert.equal(manifest.background.scripts[0], 'payload-policy.js');
const refs = [...manifest.background.scripts, manifest.browser_action.default_popup, ...Object.values(manifest.icons), manifest.browser_action.default_icon];
for (const match of readFileSync(path.join(root, 'popup.html'), 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)) refs.push(match[1]);
for (const ref of refs) assert.ok(existsSync(path.join(root, ref)), 'missing runtime reference: ' + ref);
const files = ['', 'test', 'scripts'].flatMap((d) => readdirSync(path.join(root, d)).filter((f) => /\.[cm]?js$/.test(f)).map((f) => path.join(d, f)));
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, file + '\n' + r.stderr);
}
console.log(`${files.length} JS syntax checks and ${refs.length} runtime references passed; version ${manifest.version}`);
const tests = readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.cjs')).map((f) => path.join('test', f));
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
