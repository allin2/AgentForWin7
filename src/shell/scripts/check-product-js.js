'use strict';

/**
 * B8：对 product/ 下全部 JS 文件逐个执行 `node --check`。
 *
 * 文件由目录动态枚举而不是手工罗列，新增产品文件自动纳入 lint，杜绝“只检查名单内文件”的漏检。
 * 只做语法检查，不执行被检查文件；输出只包含相对路径与首条语法错误，失败时退出码为 1。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PRODUCT_ROOT = path.join(__dirname, '..', 'product');
const SKIPPED_DIRECTORIES = new Set(['node_modules']);

/** 递归列出 product/ 下的 .js 文件（相对 shell 包根目录、正斜杠、排序）。 */
function listProductJsFiles(root = PRODUCT_ROOT) {
  const packageRoot = path.dirname(root);
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(target);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(path.relative(packageRoot, target).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return files.sort();
}

function checkFiles(files, packageRoot = path.dirname(PRODUCT_ROOT)) {
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', path.join(packageRoot, file)], { encoding: 'utf8' });
    if (result.status !== 0) {
      const detail = String(result.stderr || result.error || 'unknown error').split(/\r?\n/).filter(Boolean).slice(0, 4).join(' | ');
      failures.push({ file, detail: detail.slice(0, 400) });
    }
  }
  return failures;
}

function main() {
  const files = listProductJsFiles();
  if (files.length === 0) {
    process.stderr.write('shell lint: product/ 下没有找到任何 JS 文件，枚举异常。\n');
    process.exit(1);
  }
  const failures = checkFiles(files);
  for (const failure of failures) process.stderr.write(`shell lint: ${failure.file}: ${failure.detail}\n`);
  if (failures.length > 0) process.exit(1);
  process.stdout.write(`shell lint: ${files.length} 个 product JS 文件语法检查通过\n`);
}

if (require.main === module) main();

module.exports = { listProductJsFiles, checkFiles };
