/**
 * @module a9-ignore
 * @description A9 工作区文件忽略规则与过滤 (PRD §5 A9-F01 / ADR-0089)
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_IGNORED_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.agent_recovery',
  'dist',
  'build',
  'bin',
  'obj',
]);

export interface IgnoreRuleWarning {
  rule: string;
  reason: string;
}

export interface IgnoreFilter {
  isIgnored(relativePath: string, isDirectory?: boolean): boolean;
  /** 编译失败而被跳过的规则（单条坏规则不影响其余规则与 list/search）。 */
  readonly warnings?: ReadonlyArray<IgnoreRuleWarning>;
}

const MAX_RULE_LENGTH = 512;
const MAX_WARNINGS = 20;

interface IgnoreRule {
  negate: boolean;
  matches(targetPath: string): boolean;
}

/**
 * 构建针对指定工作区的忽略规则过滤器
 */
export function createWorkspaceIgnoreFilter(workspaceRoot: string): IgnoreFilter {
  const rules: IgnoreRule[] = [];
  const warnings: IgnoreRuleWarning[] = [];

  const loadFile = (fileName: string): void => {
    const filePath = path.join(workspaceRoot, fileName);
    if (!fs.existsSync(filePath)) return;
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      recordWarning(warnings, fileName, `读取失败：${String((error as Error)?.message ?? error).slice(0, 200)}`);
      return;
    }
    for (const line of parseIgnoreLines(content)) {
      try {
        rules.push(compileIgnoreRule(line));
      } catch (error) {
        recordWarning(warnings, line, `规则无法编译，已跳过：${String((error as Error)?.message ?? error).slice(0, 200)}`);
      }
    }
  };

  // 读取 .gitignore 与 .agentignore（后者在后，同一路径上后出现的规则优先）
  loadFile('.gitignore');
  loadFile('.agentignore');

  return {
    warnings,
    isIgnored(relativePath: string, _isDirectory?: boolean): boolean {
      const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!normalized || normalized === '.') return false;

      const segments = normalized.split('/');
      for (const segment of segments) {
        if (DEFAULT_IGNORED_NAMES.has(segment)) return true;
      }

      let ignored = false;
      for (const rule of rules) {
        if (rule.matches(normalized)) ignored = !rule.negate;
      }
      return ignored;
    },
  };
}

function recordWarning(warnings: IgnoreRuleWarning[], rule: string, reason: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push({ rule: rule.slice(0, 120), reason });
  process.emitWarning(`A9 ignore rule skipped: ${rule.slice(0, 120)} (${reason})`, {
    type: 'A9IgnoreRuleWarning',
    code: 'A9_IGNORE_RULE_INVALID',
  });
}

function parseIgnoreLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/**
 * glob → RegExp 源码：`**` 跨目录，`*` 与 `?` 不跨 `/`，`[...]`/`[!...]` 字符类；
 * 其余正则元字符一律按字面转义。未闭合的 `[` 按字面处理。
 */
function globToRegExpSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      let j = i;
      while (glob[j] === '*') j += 1;
      if (j - i >= 2) {
        if ((i === 0 || glob[i - 1] === '/') && glob[j] === '/') {
          out += '(?:.*/)?';
          i = j + 1;
        } else {
          out += '.*';
          i = j;
        }
      } else {
        out += '[^/]*';
        i = j;
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      let k = i + 1;
      let negate = false;
      if (glob[k] === '!' || glob[k] === '^') { negate = true; k += 1; }
      const bodyStart = k;
      if (glob[k] === ']') k += 1;
      while (k < glob.length && glob[k] !== ']') k += 1;
      if (k >= glob.length) {
        out += '\\[';
        i += 1;
        continue;
      }
      const body = glob.slice(bodyStart, k).replace(/[\\\]\[^]/g, '\\$&');
      out += `[${negate ? '^' : ''}${body}]`;
      i = k + 1;
      continue;
    }
    out += escapeRegExp(ch);
    i += 1;
  }
  return out;
}

function compileIgnoreRule(line: string): IgnoreRule {
  if (line.length > MAX_RULE_LENGTH) throw new Error(`规则长度超过 ${MAX_RULE_LENGTH} 字符`);
  let pattern = line;
  let negate = false;
  if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }
  let cleanPattern = pattern.replace(/\\/g, '/');
  if (cleanPattern.endsWith('/')) {
    cleanPattern = cleanPattern.slice(0, -1);
  }
  if (!cleanPattern) throw new Error('规则为空');

  const anchored = cleanPattern.startsWith('/');
  if (anchored) cleanPattern = cleanPattern.slice(1);
  if (!cleanPattern) throw new Error('规则为空');

  if (!/[*?[]/.test(cleanPattern)) {
    if (anchored) {
      return { negate, matches: (target) => target === cleanPattern || target.startsWith(cleanPattern + '/') };
    }
    return {
      negate,
      matches: (target) => target === cleanPattern || target.endsWith('/' + cleanPattern) || target.includes('/' + cleanPattern + '/'),
    };
  }

  const source = globToRegExpSource(cleanPattern);
  const regex = new RegExp(anchored ? `^${source}(?:/|$)` : `(?:^|/)${source}(?:/|$)`);
  return { negate, matches: (target) => regex.test(target) };
}
