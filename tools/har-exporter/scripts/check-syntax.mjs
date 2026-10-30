#!/usr/bin/env node
// check-syntax.mjs — HAR 扩展的最小「语法 + 一致性」校验层（零依赖，仅用 Node 内置模块）
//
// 目的：给 tools/har-exporter 这个捕获会话 Cookie 与支付 PII 的扩展建立可复现的
//       项目自有机械校验，替代过去只在会话内临时跑、未落库的检查。
//
// 做两件事：
//   1) 语法：对扩展根目录下逐个 .js 文件跑 `node --check`（当前 Node 运行时）。
//   2) 一致性：manifest.json 可解析，且它与各 HTML 引用的本地文件（service_worker、
//      default_popup、图标、<script src>）都真实存在——防止「改了/删了文件却漏改引用」。
//
// 不引入构建链、不打包、不改变扩展运行行为；任一检查失败即以退出码 1 结束。

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const EXT_DIR = fileURLToPath(new URL('..', import.meta.url));

const passes = [];
const failures = [];

function ok(label) {
  passes.push(label);
  console.log(`  \u2713 ${label}`);
}
function fail(label, detail) {
  failures.push(detail ? `${label}\n    ${detail}` : label);
  console.log(`  \u2717 ${label}${detail ? `\n    ${detail}` : ''}`);
}

// ---------- 1. 逐个 JS 文件语法检查（node --check） ----------
console.log('[1/2] 语法检查：node --check 逐个 JS 文件');
const jsFiles = ['', 'scripts', 'test'].flatMap((dir) => readdirSync(path.join(EXT_DIR, dir))
  .filter((f) => /\.[cm]?js$/.test(f)).map((f) => path.join(dir, f))).sort();
if (jsFiles.length === 0) fail('未发现任何 .js 文件', '扩展根目录应至少包含 background.js 等脚本');
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', path.join(EXT_DIR, f)], { encoding: 'utf8' });
  if (r.status === 0) ok(`node --check ${f}`);
  else fail(`node --check ${f}`, (r.stderr || r.stdout || `退出码 ${r.status}`).trim());
}

// ---------- 2. 一致性检查：manifest 与 HTML 引用的本地文件必须存在 ----------
console.log('\n[2/2] 一致性检查：manifest.json 与 HTML 的本地引用');

function isRemote(ref) {
  return /^(https?:|data:|chrome-extension:|blob:|\/\/)/i.test(ref);
}
// 校验一个被引用的本地路径是否存在（相对扩展根目录）
function checkRef(ref, referencedBy) {
  if (!ref || isRemote(ref)) return;
  const clean = String(ref).split('#')[0].split('?')[0];
  if (!clean) return;
  if (existsSync(path.resolve(EXT_DIR, clean))) ok(`${referencedBy} \u2192 ${clean}`);
  else fail(`引用缺失：${referencedBy}`, `指向不存在的本地文件 ${clean}`);
}

// 2a. manifest.json 可解析
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  ok('manifest.json 可解析为 JSON');
} catch (e) {
  fail('manifest.json 解析', e.message);
}

// 2b. manifest 内引用的本地文件
if (manifest) {
  const pkg = JSON.parse(readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));
  if (manifest.version === pkg.version) ok('manifest/package 版本一致');
  else fail('manifest/package 版本不一致');
  if (manifest.minimum_chrome_version === '125') ok('已声明子会话所需最低 Chrome 版本');
  else fail('最低 Chrome 版本缺失或不一致');
  if (manifest.background && manifest.background.service_worker) {
    checkRef(manifest.background.service_worker, 'manifest.background.service_worker');
  }
  if (manifest.action && manifest.action.default_popup) {
    checkRef(manifest.action.default_popup, 'manifest.action.default_popup');
  }
  for (const iconSet of [manifest.icons, manifest.action && manifest.action.default_icon]) {
    if (iconSet) for (const size of Object.keys(iconSet)) checkRef(iconSet[size], `manifest 图标 ${size}`);
  }
}

for (const f of jsFiles.filter((f) => !f.includes(path.sep))) {
  const code = readFileSync(path.join(EXT_DIR, f), 'utf8');
  for (const call of code.matchAll(/^\s*importScripts\(([^)]+)\)/gm)) {
    for (const ref of call[1].matchAll(/['"]([^'"]+)['"]/g)) checkRef(ref[1], `${f} importScripts`);
  }
}

// 2c. 每个 HTML 里的 <script src="..."> 本地引用必须存在
const htmlFiles = readdirSync(EXT_DIR).filter((f) => f.endsWith('.html')).sort();
for (const h of htmlFiles) {
  const html = readFileSync(path.join(EXT_DIR, h), 'utf8');
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let m;
  let found = 0;
  while ((m = re.exec(html)) !== null) {
    checkRef(m[1], `${h} <script src>`);
    found += 1;
  }
  if (found === 0) console.log(`  \u2022 ${h} 无本地 <script src> 引用（跳过）`);
}

// ---------- 汇总 ----------
console.log(`\n[结果] 通过 ${passes.length} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.error('\n失败明细：');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\u2713 语法与一致性检查全部通过');
