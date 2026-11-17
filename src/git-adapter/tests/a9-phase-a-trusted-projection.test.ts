/**
 * Phase A2/A4（H-P1-01、H-P2-23、H-P2-03）：
 * - Git 投影以绝对路径执行 git，PATH 中位于工作区内的 git 不会被执行；
 * - 只读子命令白名单在代码层强制；
 * - 状态解析使用 `--porcelain=v1 -z`，中文/空格路径与 R/C 两段路径正确。
 */
import * as childProcess from 'child_process';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertReadOnlyGitArgs,
  parsePorcelainV1Z,
  projectTrustedGit,
  resolveTrustedGitExecutable,
  TrustedGitReadOnlyViolation,
} from '../src';

// 包装 execFile 以便断言传给它的可执行文件路径，同时保持真实执行。
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execFile: jest.fn((...args: unknown[]) => (actual.execFile as (...a: unknown[]) => unknown)(...args)) };
});
const execFileMock = childProcess.execFile as unknown as jest.Mock;

function cleanGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), `a9-phase-a-global-${process.pid}.missing`),
  };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: cleanGitEnv() });
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function realGitDir(): string {
  const resolved = resolveTrustedGitExecutable(os.tmpdir());
  if (!resolved) throw new Error('git executable not found on PATH');
  return path.dirname(resolved);
}

describe('Phase A2: read-only subcommand whitelist', () => {
  const accepted: string[][] = [
    ['rev-parse', '--show-toplevel'],
    ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '-b'],
    ['-c', 'core.fsmonitor=false', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.required=false', 'diff', '--no-ext-diff', 'HEAD', '--stat', '--patch', '--unified=3'],
    ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
    ['config', '--get', 'core.hooksPath'],
    ['branch', '--show-current'],
    ['branch', '--list', 'feature/*'],
    ['remote', '-v'],
    ['remote', 'get-url', 'origin'],
    ['log', '--oneline', '-n', '5'],
    ['describe', '--tags'],
  ];
  it.each(accepted)('accepts %j', (...args) => {
    expect(() => assertReadOnlyGitArgs(args)).not.toThrow();
  });

  const rejected: string[][] = [
    ['push', 'origin', 'main'],
    ['commit', '-m', 'x'],
    ['checkout', '-f', 'HEAD'],
    ['reset', '--hard'],
    ['clean', '-fdx'],
    ['fetch'],
    ['gc'],
    [],
    ['-C', '..', 'status'],
    ['-c', 'core.pager=evil', 'status'],
    ['-c', 'core.sshCommand=evil', 'log'],
    ['config', 'user.name', 'attacker'],
    ['config', '--unset', 'core.fsmonitor'],
    ['config', '--global', '--get', 'user.name'],
    ['config', '--edit'],
    ['branch', 'new-branch'],
    ['branch', '-D', 'main'],
    ['branch', '--list', '-m', 'a', 'b'],
    ['remote', 'add', 'evil', 'https://example.invalid/x.git'],
    ['remote', 'show', 'origin'],
    ['remote', 'set-url', 'origin', 'x'],
    ['diff', '--output=/tmp/leak'],
    ['log', '--output', '/tmp/leak'],
  ];
  it.each(rejected)('rejects %j', (...args) => {
    expect(() => assertReadOnlyGitArgs(args)).toThrow(TrustedGitReadOnlyViolation);
  });
});

describe('Phase A2: absolute git executable resolution', () => {
  let work: string;
  let realDir: string;
  afterEach(() => {
    execFileMock.mockClear();
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  it('skips PATH entries inside the workspace, relative entries and empty entries, and returns an absolute path', () => {
    realDir = realGitDir();
    work = makeTempDir('a9-phase-a-work-');
    const sub = path.join(work, 'bin');
    fs.mkdirSync(sub);
    for (const dir of [work, sub]) {
      fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\nexit 0\n');
      fs.chmodSync(path.join(dir, 'git'), 0o755);
    }
    const env = { PATH: [work, sub, '', '.', 'relative/bin', realDir].join(path.delimiter) };
    const resolved = resolveTrustedGitExecutable(work, { env });
    expect(resolved).toBe(path.join(realDir, 'git'));
    expect(path.isAbsolute(resolved as string)).toBe(true);
  });

  it('returns null when only workspace-local git candidates exist', () => {
    work = makeTempDir('a9-phase-a-work-');
    fs.writeFileSync(path.join(work, 'git'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(work, 'git'), 0o755);
    expect(resolveTrustedGitExecutable(work, { env: { PATH: work } })).toBeNull();
    expect(resolveTrustedGitExecutable(work, { env: {} })).toBeNull();
  });

  it('rejects a workspace git reached through a symlinked PATH directory', () => {
    work = makeTempDir('a9-phase-a-work-');
    const linkParent = makeTempDir('a9-phase-a-link-');
    try {
      fs.writeFileSync(path.join(work, 'git'), '#!/bin/sh\nexit 0\n');
      fs.chmodSync(path.join(work, 'git'), 0o755);
      const link = path.join(linkParent, 'bin');
      fs.symlinkSync(work, link, 'dir');
      expect(resolveTrustedGitExecutable(work, { env: { PATH: link } })).toBeNull();
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it('projection executes the real git by absolute path and never the decoy placed in the workspace', async () => {
    realDir = realGitDir();
    work = makeTempDir('a9-phase-a-work-');
    git(work, 'init', '-q', '-b', 'main');
    const marker = path.join(os.tmpdir(), `a9-phase-a-decoy-${process.pid}.marker`);
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(path.join(work, 'git'), `#!/bin/sh\necho called > ${JSON.stringify(marker)}\nexit 3\n`);
    fs.chmodSync(path.join(work, 'git'), 0o755);

    execFileMock.mockClear();
    const oldPath = process.env.PATH;
    process.env.PATH = [work, realDir].join(path.delimiter);
    try {
      const projection = await projectTrustedGit(work);
      expect(projection.isGit).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      expect(execFileMock).toHaveBeenCalled();
      for (const call of execFileMock.mock.calls) {
        expect(call[0]).toBe(path.join(realDir, 'git'));
        expect(path.isAbsolute(String(call[0]))).toBe(true);
      }
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(marker, { force: true });
    }
  });

  it('reports A9_GIT_SPAWN_FAILED instead of running a bare git name when no trusted git exists', async () => {
    work = makeTempDir('a9-phase-a-work-');
    fs.writeFileSync(path.join(work, 'git'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(work, 'git'), 0o755);
    execFileMock.mockClear();
    const oldPath = process.env.PATH;
    process.env.PATH = work;
    try {
      const projection = await projectTrustedGit(work);
      expect(projection.isGit).toBe(false);
      expect(projection.diagnostics?.[0]).toMatchObject({ code: 'A9_GIT_SPAWN_FAILED' });
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe('Phase A4: porcelain v1 -z status parsing', () => {
  it('parses NUL-separated records with spaces, Chinese names and R/C two-part paths', () => {
    const stdout = [
      '## main...origin/main [ahead 2, behind 1]',
      ' M 空 格 文件.md',
      'R  新 名字.txt', '旧 名字.txt',
      'C  副本.txt', '原件.txt',
      '?? 未跟踪/文件.txt',
      '',
    ].join('\0');
    const parsed = parsePorcelainV1Z(stdout);
    expect(parsed.header).toBe('## main...origin/main [ahead 2, behind 1]');
    expect(parsed.entries).toEqual([
      { indexStatus: ' ', worktreeStatus: 'M', path: '空 格 文件.md' },
      { indexStatus: 'R', worktreeStatus: ' ', path: '新 名字.txt', originalPath: '旧 名字.txt' },
      { indexStatus: 'C', worktreeStatus: ' ', path: '副本.txt', originalPath: '原件.txt' },
      { indexStatus: '?', worktreeStatus: '?', path: '未跟踪/文件.txt' },
    ]);
  });

  describe('against a real repository', () => {
    let repo: string;
    let previousGlobal: string | undefined;
    let previousNoSystem: string | undefined;
    beforeEach(() => {
      previousGlobal = process.env.GIT_CONFIG_GLOBAL;
      previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
      process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), `a9-phase-a-global-${process.pid}.missing`);
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      repo = makeTempDir('a9-phase-a-repo-');
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'agent@example.com');
      git(repo, 'config', 'user.name', 'A9 Test');
      fs.writeFileSync(path.join(repo, '旧 名字.txt'), 'rename source content\nline two\nline three\n');
      fs.writeFileSync(path.join(repo, '空 格.md'), 'base\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'init');
    });
    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true });
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    });

    it('returns unquoted Chinese/space paths and both sides of a staged rename', async () => {
      git(repo, 'mv', '旧 名字.txt', '新 名字.txt');
      fs.writeFileSync(path.join(repo, '空 格.md'), 'changed\n');
      fs.mkdirSync(path.join(repo, '未跟踪 目录'));
      fs.writeFileSync(path.join(repo, '未跟踪 目录', '文件 一.txt'), 'x\n');

      const projection = await projectTrustedGit(repo);

      expect(projection.entries).toEqual(expect.arrayContaining([
        { indexStatus: 'R', worktreeStatus: ' ', path: '新 名字.txt', originalPath: '旧 名字.txt' },
        { indexStatus: ' ', worktreeStatus: 'M', path: '空 格.md' },
        { indexStatus: '?', worktreeStatus: '?', path: '未跟踪 目录/' },
      ]));
      expect(projection.entries.every((entry) => !entry.path.includes('\\') && !entry.path.startsWith('"'))).toBe(true);
      expect(projection.clean).toBe(false);
    });

    it('safely degrades without throwing when repository contains a filter with "=" in its name', async () => {
      // 在本地仓库配置一个过滤器名带 "=" 的 filter
      git(repo, 'config', 'filter.a=b.clean', 'cat');

      const projection = await projectTrustedGit(repo);

      expect(projection.isGit).toBe(true);
      expect(projection.clean).toBe(false);
      const unneutralizedDiag = (projection.diagnostics ?? []).find(
        (d) => d.code === 'A9_GIT_FILTER_UNNEUTRALIZABLE',
      );
      expect(unneutralizedDiag).toBeDefined();
      expect(unneutralizedDiag?.detail).toContain('a=b');
    });
  });
});
