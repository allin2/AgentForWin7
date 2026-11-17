/**
 * Phase A3（H-P2-01、H-P2-02）：a9-ignore 元字符转义、glob 语义、坏规则容错，
 * 以及被忽略项在 list/search 中计入 skipped（reason=ignored）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { A9WorkspaceService, createWorkspaceIgnoreFilter } from '../../src';

describe('Phase A3: a9-ignore rules', () => {
  let tempDir: string;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-a-ignore-'));
    warnSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const withRules = (rules: string) => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), rules, 'utf8');
    return createWorkspaceIgnoreFilter(tempDir);
  };

  it.each([
    ['*.c++', ['main.c++', 'src/util.c++'], ['main.cpp', 'main.c', 'mainXc++']],
    ['~$*', ['~$report.docx', 'docs/~$lock.xlsx'], ['report.docx', 'a~$b.txt']],
    ['*.[ab', ['x.[ab'], ['x.a', 'x.b']],
    ['a+b.txt', ['a+b.txt'], ['aab.txt', 'ab.txt']],
    ['(copy)*', ['(copy) of x.txt'], ['copy of x.txt']],
    ['{x}.txt', ['{x}.txt'], ['x.txt']],
    ['a|b', ['a|b'], ['a', 'b']],
    ['^caret', ['^caret'], ['caret']],
    ['cost$', ['cost$'], ['cost']],
    ['file?.log', ['file1.log', 'fileX.log'], ['file.log', 'file12.log', 'file/.log']],
    ['[ab].txt', ['a.txt', 'b.txt'], ['c.txt', 'ab.txt']],
    ['[!ab].txt', ['c.txt'], ['a.txt', 'b.txt']],
    ['/rooted*.tmp', ['rooted1.tmp'], ['sub/rooted1.tmp']],
    ['docs/**/draft.md', ['docs/a/b/draft.md', 'docs/draft.md'], ['other/draft.md']],
  ])('rule %s ignores only the intended paths', (rule, ignored, kept) => {
    const filter = withRules(`${rule}\n`);
    expect(filter.warnings).toEqual([]);
    for (const target of ignored) expect(filter.isIgnored(target)).toBe(true);
    for (const target of kept) expect(filter.isIgnored(target)).toBe(false);
  });

  it('later negation re-includes a path and later rules win', () => {
    const filter = withRules('*.log\n!keep.log\n');
    expect(filter.isIgnored('a.log')).toBe(true);
    expect(filter.isIgnored('keep.log')).toBe(false);
    expect(filter.isIgnored('sub/keep.log')).toBe(false);
  });

  it('supports escaped leading # and ! literals', () => {
    const filter = withRules('\\#hash.txt\n\\!bang.txt\n');
    expect(filter.isIgnored('#hash.txt')).toBe(true);
    expect(filter.isIgnored('!bang.txt')).toBe(true);
    expect(filter.isIgnored('hash.txt')).toBe(false);
  });

  it('skips a single uncompilable rule with a warning and keeps the other rules working', () => {
    const filter = withRules('[z-a].txt\ngood_*.tmp\n');
    expect(filter.warnings).toHaveLength(1);
    expect(filter.warnings?.[0].rule).toBe('[z-a].txt');
    expect(filter.warnings?.[0].reason).toContain('已跳过');
    expect(filter.isIgnored('good_one.tmp')).toBe(true);
    expect(filter.isIgnored('z.txt')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[z-a].txt'), expect.objectContaining({ code: 'A9_IGNORE_RULE_INVALID' }));
  });

  it('skips an over-long rule instead of compiling it', () => {
    const filter = withRules(`${'a'.repeat(600)}*\nok.txt\n`);
    expect(filter.warnings).toHaveLength(1);
    expect(filter.isIgnored('ok.txt')).toBe(true);
  });
});

describe('Phase A3: ignored items are reported in skipped', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-a-ignore-svc-'));
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '*.c++\n*.[ab\n~$*\n[z-a].x\n', 'utf8');
    fs.mkdirSync(path.join(tempDir, 'build'));
    fs.mkdirSync(path.join(tempDir, 'node_modules'));
    fs.writeFileSync(path.join(tempDir, 'build', 'out.txt'), 'needle in build');
    fs.writeFileSync(path.join(tempDir, 'main.c++'), 'needle in cpp');
    fs.writeFileSync(path.join(tempDir, '~$lock.docx'), 'needle in lock');
    fs.writeFileSync(path.join(tempDir, 'keep.txt'), 'needle kept');
  });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  it('list does not throw on bad rules and reports ignored entries', async () => {
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const result = await new A9WorkspaceService(tempDir).list('', {});
      const names = result.entries.map((entry) => entry.name);
      expect(names).toContain('keep.txt');
      expect(names).not.toEqual(expect.arrayContaining(['build', 'node_modules', 'main.c++', '~$lock.docx']));
      const ignored = result.skipped.filter((item) => item.reason === 'ignored').map((item) => item.path).sort();
      expect(ignored).toEqual(['build', 'main.c++', 'node_modules', '~$lock.docx']);
      expect(result.skippedTotal).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });

  it('search does not throw on bad rules, skips ignored files and reports them', async () => {
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const result = await new A9WorkspaceService(tempDir).search('needle');
      expect(result.matches.map((match) => match.filePath)).toEqual(['keep.txt']);
      const ignored = result.skipped.filter((item) => item.reason === 'ignored').map((item) => item.path).sort();
      expect(ignored).toEqual(['build', 'main.c++', 'node_modules', '~$lock.docx']);
      expect(result.skippedTotal).toBe(4);
      expect(result.skippedFiles).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignored detail entries cannot crowd out real read failures beyond the reserved slots', async () => {
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(tempDir, `skip_${i}.c++`), 'x');
      const result = await new A9WorkspaceService(tempDir).list('', {});
      expect(result.skippedTotal).toBe(44);
      expect(result.skipped.filter((item) => item.reason === 'ignored').length).toBeLessThanOrEqual(25);
    } finally {
      warn.mockRestore();
    }
  });
});
