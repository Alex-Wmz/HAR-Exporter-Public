#!/usr/bin/env node
// verify.mjs — 一键跑完本扩展的最小校验层（跨平台，不依赖 shell 的 && 语法）
//
//   1) scripts/check-syntax.mjs：逐个 JS 的 node --check + manifest/HTML 引用一致性
//   2) node --test test/       ：fs-store 写盘目标与 PII 落盘边界契约测试
//
// 两步都以子进程运行并透传输出；任一失败则整体退出码为 1。
// 等价于 `npm run check`，但也可直接 `node scripts/verify.mjs` 运行。

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const EXT_DIR = fileURLToPath(new URL('..', import.meta.url));

function run(label, args) {
  console.log(`\n===== ${label} =====`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: EXT_DIR });
  if (r.error) {
    console.error(`启动失败：${r.error.message}`);
    return false;
  }
  return r.status === 0;
}

// 显式发现测试文件（不依赖 node --test 的目录/glob 语义，跨 Node 版本稳定）
const TEST_DIR = path.join(EXT_DIR, 'test');
const testFiles = existsSync(TEST_DIR)
  ? readdirSync(TEST_DIR).filter((f) => /\.test\.[cm]?js$/.test(f)).sort().map((f) => path.join('test', f))
  : [];

const okSyntax = run('语法与一致性检查', [path.join(HERE, 'check-syntax.mjs')]);

let okTest = false;
if (testFiles.length === 0) {
  console.log('\n===== 回归与对抗性测试 =====');
  console.error('  \u2717 test/ 下未发现任何 *.test.mjs 测试文件');
} else {
  okTest = run(`回归与对抗性测试（${testFiles.length} 个文件）`, ['--test', ...testFiles]);
}

console.log('\n===== 汇总 =====');
console.log(`语法 / 一致性：${okSyntax ? '通过' : '失败'}`);
console.log(`回归与对抗性测试：${okTest ? '通过' : '失败'}`);
process.exit(okSyntax && okTest ? 0 : 1);
