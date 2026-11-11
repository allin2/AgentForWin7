/**
 * A9-05 回归测试：Trusted Git 投影（真实临时 Git 仓库）。
 *
 * 覆盖：状态/Diff 展示、真实 hooks/helper 提示、非 Git 工作区降级。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectTrustedGit } from '../src';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: cleanGitEnv() });
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), `a9-git-proj-global-${process.pid}.missing`),
  };
}

function findGitBinary(): string {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_err) {
      // Continue through PATH entries until the real Git executable is found.
    }
  }
  throw new Error('git executable not found');
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('A9-05: trusted git projection on real temp repositories', () => {
  let repo: string;
  let previousGitConfigGlobal: string | undefined;
  let previousGitConfigNoSystem: string | undefined;

  beforeEach(() => {
    previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    previousGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), `a9-git-proj-global-${process.pid}.missing`);
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    repo = makeTempDir('a9-git-proj-');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'agent@example.com');
    git(repo, 'config', 'user.name', 'A9 Test');
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
    if (previousGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousGitConfigNoSystem;
  });

  it('projects branch, head and clean status', async () => {
    const projection = await projectTrustedGit(repo);
    expect(projection.isGit).toBe(true);
    expect(projection.branch).toBe('main');
    expect(projection.head).toMatch(/^[0-9a-f]{40}$/);
    expect(projection.clean).toBe(true);
    expect(projection.entries).toEqual([]);
  });

  it('projects modified and untracked entries with diff preview', async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo changed\n');
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'untracked');
    const projection = await projectTrustedGit(repo);
    expect(projection.clean).toBe(false);
    const paths = projection.entries.map((e) => e.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('new-file.txt');
    expect(projection.diffPreview).toContain('demo changed');
  });

  it('reports active hooks and credential helpers as external mechanisms', async () => {
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook\n');
    fs.chmodSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
    git(repo, 'config', 'credential.helper', 'store');

    const projection = await projectTrustedGit(repo);
    const kinds = projection.externalMechanisms.map((m) => m.kind);
    expect(kinds).toContain('hooks');
    expect(kinds).toContain('credential_helper');
    expect(projection.notes.join(' ')).toContain('外部执行机制');
  });

  it('reports core.hooksPath overrides explicitly', async () => {
    const hooksDir = path.join(repo, 'custom-hooks');
    fs.mkdirSync(hooksDir);
    git(repo, 'config', 'core.hooksPath', 'custom-hooks');
    const projection = await projectTrustedGit(repo);
    expect(projection.externalMechanisms.some((m) => m.kind === 'hooks_path_override' && m.detail.includes('custom-hooks'))).toBe(true);
  });

  it('does not diagnose absent config and still reports an explicit pager', async () => {
    const withoutConfig = await projectTrustedGit(repo);
    expect(withoutConfig.diagnostics?.some((item) => item.operation.startsWith('config')) ?? false).toBe(false);

    git(repo, 'config', 'core.pager', 'less');
    const withPager = await projectTrustedGit(repo);
    expect(withPager.externalMechanisms).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'pager', detail: 'core.pager=less' }),
    ]));
  });

  it('does not diagnose a repository with no commits', async () => {
    const empty = makeTempDir('a9-git-proj-empty-');
    try {
      git(empty, 'init', '-q', '-b', 'main');
      const projection = await projectTrustedGit(empty);
      expect(projection.isGit).toBe(true);
      expect(projection.diagnostics).toBeUndefined();
      expect(projection.branch).toBeUndefined();
      expect(projection.head).toBeUndefined();
      expect(projection.diffPreview).toBe('');
      expect(projection.entries).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reports an oversized diff separately from a Git spawn failure', async () => {
    const largePath = path.join(repo, 'large.txt');
    fs.writeFileSync(largePath, 'base\n');
    git(repo, 'add', 'large.txt');
    git(repo, 'commit', '-q', '-m', 'large baseline');
    fs.writeFileSync(largePath, `${'x'.repeat(5 * 1024 * 1024)}\n`);

    const projection = await projectTrustedGit(repo);
    expect(projection.branch).toBe('main');
    expect(projection.head).toMatch(/^[0-9a-f]{40}$/);
    expect(projection.entries.some((entry) => entry.path === 'large.txt')).toBe(true);
    expect(projection.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'A9_GIT_OUTPUT_TOO_LARGE', operation: 'diff' }),
    ]));
    expect(projection.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'A9_GIT_SPAWN_FAILED', operation: 'diff' }),
    ]));
  });

  it('does not execute fsmonitor or textconv callbacks while projecting status and diff', async () => {
    const callback = path.join(repo, 'projection-callback.js');
    const fsmonitorMarker = path.join(repo, 'fsmonitor-called.txt');
    const textconvMarker = path.join(repo, 'textconv-called.txt');
    const filterMarker = path.join(repo, 'filter-called.txt');
    fs.writeFileSync(callback, [
      "const fs = require('fs');",
      "const kind = process.argv[2];",
      `fs.appendFileSync(kind === 'fsmonitor' ? ${JSON.stringify(fsmonitorMarker)} : kind === 'filter' ? ${JSON.stringify(filterMarker)} : ${JSON.stringify(textconvMarker)}, 'called\\n');`,
      "if (kind === 'textconv' && process.argv[3]) process.stdout.write(fs.readFileSync(process.argv[3]));",
    ].join('\n'));
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'README.md diff=a9-projection filter=a9-filter\n');
    git(repo, 'config', 'core.fsmonitor', `node "${callback}" fsmonitor`);
    git(repo, 'config', 'diff.a9-projection.textconv', `node "${callback}" textconv`);
    git(repo, 'config', 'filter.a9-filter.clean', `node "${callback}" filter`);
    fs.writeFileSync(path.join(repo, 'README.md'), '# callback must not run\n');

    const projection = await projectTrustedGit(repo);

    expect(projection.isGit).toBe(true);
    expect(projection.entries.some((entry) => entry.path === 'README.md')).toBe(true);
    expect(projection.externalMechanisms.some((item) => item.kind === 'fsmonitor')).toBe(true);
    expect(projection.externalMechanisms.some((item) => item.kind === 'textconv')).toBe(true);
    expect(fs.existsSync(fsmonitorMarker)).toBe(false);
    expect(fs.existsSync(textconvMarker)).toBe(false);
    expect(fs.existsSync(filterMarker)).toBe(false);
  });

  it('degrades explicitly for non-git workspaces without throwing', async () => {
    const plain = makeTempDir('a9-non-git-');
    try {
      const projection = await projectTrustedGit(plain);
      expect(projection.isGit).toBe(false);
      expect(projection.degradedReason).toContain('不是 Git 仓库');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('distinguishes git spawn failure and non-zero exit from a non-repository', async () => {
    const oldPath = process.env.PATH;
    const fakeRoot = makeTempDir('a9-git-fake-');
    try {
      process.env.PATH = fakeRoot;
      const missing = await projectTrustedGit(repo);
      expect(missing.diagnostics?.[0]).toMatchObject({ code: 'A9_GIT_SPAWN_FAILED' });
      fs.writeFileSync(path.join(fakeRoot, 'git'), '#!/bin/sh\nexit 7\n');
      fs.chmodSync(path.join(fakeRoot, 'git'), 0o755);
      const failed = await projectTrustedGit(repo);
      expect(failed.diagnostics?.[0]).toMatchObject({ code: 'A9_GIT_EXIT_FAILED' });
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it('reports unreadable Git configuration mechanisms without hiding them as absent', async () => {
    const hooks = path.join(repo, '.git', 'hooks');
    fs.rmSync(hooks, { recursive: true, force: true });
    fs.writeFileSync(hooks, 'unreadable marker');
    const projection = await projectTrustedGit(repo);
    expect(projection.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'A9_GIT_CONFIG_UNREADABLE' }),
    ]));
  });

  it('reports a Git config command failure from a delegated fake Git', async () => {
    const oldPath = process.env.PATH;
    const fakeRoot = makeTempDir('a9-git-config-fake-');
    try {
      const realGit = findGitBinary();
      const fakeGit = path.join(fakeRoot, 'git');
      fs.writeFileSync(fakeGit, [
        '#!/bin/sh',
        'if [ "$1" = "config" ]; then',
        '  echo "synthetic config failure" >&2',
        '  exit 9',
        'fi',
        `exec ${JSON.stringify(realGit)} "$@"`,
        '',
      ].join('\n'));
      fs.chmodSync(fakeGit, 0o755);
      process.env.PATH = `${fakeRoot}${path.delimiter}${oldPath || ''}`;

      const projection = await projectTrustedGit(repo);
      expect(projection.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'A9_GIT_CONFIG_UNREADABLE' }),
      ]));
      expect(projection.diagnostics?.some((item) => item.operation.startsWith('config'))).toBe(true);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
