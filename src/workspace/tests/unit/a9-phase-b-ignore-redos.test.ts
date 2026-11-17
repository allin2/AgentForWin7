/**
 * Phase B / P2-3：a9-ignore glob 匹配对灾难性回溯免疫，且语义与旧 glob→RegExp 实现一致。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWorkspaceIgnoreFilter } from '../../src';

/** 旧实现（回溯正则）仅作为小输入上的差分测试基准，不得用于产品代码。 */
function legacyRegExpSource(glob: string): string {
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      let j = i;
      while (glob[j] === '*') j += 1;
      if (j - i >= 2) {
        if ((i === 0 || glob[i - 1] === '/') && glob[j] === '/') { out += '(?:.*/)?'; i = j + 1; } else { out += '.*'; i = j; }
      } else { out += '[^/]*'; i = j; }
      continue;
    }
    if (ch === '?') { out += '[^/]'; i += 1; continue; }
    if (ch === '[') {
      let k = i + 1;
      let negate = false;
      if (glob[k] === '!' || glob[k] === '^') { negate = true; k += 1; }
      const bodyStart = k;
      if (glob[k] === ']') k += 1;
      while (k < glob.length && glob[k] !== ']') k += 1;
      if (k >= glob.length) { out += '\\['; i += 1; continue; }
      out += `[${negate ? '^' : ''}${glob.slice(bodyStart, k).replace(/[\\\]\[^]/g, '\\$&')}]`;
      i = k + 1;
      continue;
    }
    out += escape(ch);
    i += 1;
  }
  return out;
}

function legacyMatches(rule: string, target: string): boolean {
  let pattern = rule;
  if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);
  const source = legacyRegExpSource(pattern);
  return new RegExp(anchored ? `^${source}(?:/|$)` : `(?:^|/)${source}(?:/|$)`).test(target);
}

describe('Phase B P2-3: a9-ignore ReDoS immunity', () => {
  let tempDir: string;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-ignore-redos-'));
    warnSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const filterFor = (rules: string) => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), rules, 'utf8');
    return createWorkspaceIgnoreFilter(tempDir);
  };

  it.each([
    ['many separated stars ending in a literal', `${'*a'.repeat(100)}*b`, 'a'.repeat(300), `${'a'.repeat(300)}b`],
    ['stars mixed with ? wildcards', `${'*?'.repeat(80)}*b`, 'a'.repeat(300), `${'a'.repeat(300)}b`],
    ['globstars between segments', `${'**/a'.repeat(60)}/b`, `${'a/'.repeat(150)}a`, `${'a/'.repeat(150)}b`],
    ['anchored many stars', `/${'*a'.repeat(100)}*b`, 'a'.repeat(300), `${'a'.repeat(300)}b`],
    ['nested directory stars', `${'*/a*'.repeat(50)}b`, `${'a/'.repeat(100)}a`, `${'a/'.repeat(100)}ab`],
  ])('matches a pathological rule in bounded time: %s', (_label, rule, nonMatch, match) => {
    const filter = filterFor(`${rule}\n`);
    const started = Date.now();
    expect(filter.isIgnored(nonMatch)).toBe(false);
    expect(filter.isIgnored(match)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(filter.warnings).toEqual([]);
  });

  it('is equivalent to the legacy regex on thousands of small random rules and paths', () => {
    let seed = 0x9e3779b9;
    const rand = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const tokens = ['a', 'b', '.', '*', '**', '/', '?', '[ab]', '[!a]', '**/', '*a', 'a*', '[b'];
    const chars = ['a', 'b', '.', '/', '\n'];
    const mismatches: string[] = [];
    for (let round = 0; round < 1500; round += 1) {
      let rule = '';
      for (let t = 1 + rand(6); t > 0; t -= 1) rule += tokens[rand(tokens.length)];
      // 排除被解析层特殊处理的规则：空、注释、否定、转义、仅含字面量（走字面量快速路径）。
      if (!rule.trim() || /^[#!\\]/.test(rule) || rule.trim() !== rule || /^\/*$/.test(rule.replace(/\/$/, ''))) continue;
      if (!/[*?[]/.test(rule)) continue;
      const filter = filterFor(`${rule}\n`);
      if (filter.warnings && filter.warnings.length > 0) continue;
      for (let sample = 0; sample < 25; sample += 1) {
        let target = '';
        for (let n = 1 + rand(8); n > 0; n -= 1) target += chars[rand(chars.length)];
        const normalized = target.replace(/^\/+/, '');
        if (!normalized || normalized === '.' || normalized.split('/').some((segment) => segment === '.git')) continue;
        if (filter.isIgnored(target) !== legacyMatches(rule, normalized)) {
          mismatches.push(`${JSON.stringify(rule)} vs ${JSON.stringify(target)}`);
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it('keeps the negation order and unanchored restart after a slash', () => {
    const filter = filterFor('a*b\n!a1b\n');
    expect(filter.isIgnored('x/y/a123b')).toBe(true);
    expect(filter.isIgnored('x/y/a1b')).toBe(false);
    expect(filter.isIgnored('xa1b')).toBe(false);
  });
});
