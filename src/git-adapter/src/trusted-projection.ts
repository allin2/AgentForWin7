/**
 * @module trusted-projection
 * @description A9 Trusted Git 状态投影 (PRD §6 A9-G01 / ADR-0089)
 *
 * UI 的 Git 状态/Diff 使用本结构化投影：只读子命令白名单 + 用户真实 Git
 * 配置（非隔离），并探测 hooks/filters/textconv/credential helper 等外部
 * 执行机制供 UI 提示。真实 Git 写命令仍走 TrustedShellRunner + 行为策略；
 * 本模块绝不执行写操作。非 Git 工作区返回显式降级，不抛异常。
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface TrustedGitExternalMechanism {
  kind: 'hooks' | 'hooks_path_override' | 'filter' | 'textconv' | 'credential_helper' | 'pager' | 'fsmonitor' | 'ssh_command';
  detail: string;
}

export interface TrustedGitStatusEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

export interface TrustedGitProjection {
  schemaVersion: '1.0';
  isGit: boolean;
  /** 非 Git 工作区的降级说明（完整 Agent 能力保留）。 */
  degradedReason?: string;
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  clean?: boolean;
  entries: TrustedGitStatusEntry[];
  diffPreview: string;
  diffTruncated: boolean;
  /** 仓库存在外部执行机制（hooks/filters/helpers）时如实列出。 */
  externalMechanisms: TrustedGitExternalMechanism[];
  notes: string[];
  /** Optional bounded diagnostics; existing projection fields remain stable. */
  diagnostics?: TrustedGitDiagnostic[];
}

export type TrustedGitDiagnosticCode =
  | 'A9_GIT_NOT_REPOSITORY'
  | 'A9_GIT_SPAWN_FAILED'
  | 'A9_GIT_TIMEOUT'
  | 'A9_GIT_EXIT_FAILED'
  | 'A9_GIT_CONFIG_UNREADABLE';

export interface TrustedGitDiagnostic {
  code: TrustedGitDiagnosticCode;
  operation: string;
  detail: string;
}

const MAX_DIFF_BYTES = 512 * 1024;
const READ_ONLY_COMMANDS = new Set(['status', 'rev-parse', 'diff', 'log', 'branch', 'config', 'remote', 'describe']);

interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  failure?: 'spawn_failed' | 'timeout' | 'exit_nonzero';
}

function execGit(
  workDir: string,
  args: string[],
  options: { observeConfigOnly?: boolean; disabledFilters?: string[] } = {},
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    try {
      // Projection is an observation path, not a request to execute repository
      // callbacks. `git config` itself only reads configuration and must remain
      // unmodified so we can report the real effective fsmonitor setting.
      const filterOverrides = (options.disabledFilters || []).flatMap((name) => [
        '-c', `filter.${name}.clean=`,
        '-c', `filter.${name}.smudge=`,
        '-c', `filter.${name}.process=`,
        '-c', `filter.${name}.required=false`,
      ]);
      const safeArgs = options.observeConfigOnly
        ? args
        : ['-c', 'core.fsmonitor=false', ...filterOverrides, ...args];
      execFile('git', safeArgs, {
        cwd: workDir,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_PAGER: 'cat',
          PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
        },
      }, (err, stdout, stderr) => {
        const rawCode = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0;
        const timedOut = Boolean(err && ((err as any).killed || (err as any).code === 'ETIMEDOUT'));
        const spawnFailed = Boolean(err && typeof (err as any).code === 'string' && (err as any).code !== 'ETIMEDOUT');
        resolve({ code: rawCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
          ...(timedOut ? { failure: 'timeout' } : spawnFailed ? { failure: 'spawn_failed' } : rawCode !== 0 ? { failure: 'exit_nonzero' } : {}) });
      });
    } catch (_err) {
      resolve({ code: 1, stdout: '', stderr: '', failure: 'spawn_failed' });
    }
  });
}

/**
 * 投影一个工作区的 Git 状态。所有 git 子命令限定只读白名单。
 */
export async function projectTrustedGit(workDir: string): Promise<TrustedGitProjection> {
  const notes: string[] = [];
  const diagnostics: TrustedGitDiagnostic[] = [];
  const projection: TrustedGitProjection = {
    schemaVersion: '1.0',
    isGit: false,
    entries: [],
    diffPreview: '',
    diffTruncated: false,
    externalMechanisms: [],
    notes,
  };

  if (!workDir || !fs.existsSync(workDir)) {
    diagnostics.push({ code: 'A9_GIT_NOT_REPOSITORY', operation: 'workspace', detail: '工作区目录不存在，无法建立 Git 投影。' });
    projection.degradedReason = '工作区目录不存在';
    projection.diagnostics = diagnostics;
    return projection;
  }

  const toplevel = await execGit(workDir, ['rev-parse', '--show-toplevel']);
  if (toplevel.code !== 0) {
    const code = toplevel.failure === 'spawn_failed' ? 'A9_GIT_SPAWN_FAILED'
      : toplevel.failure === 'timeout' ? 'A9_GIT_TIMEOUT'
      : /not a git repository|不是 git 仓库|not a repository/i.test(toplevel.stderr)
        ? 'A9_GIT_NOT_REPOSITORY' : 'A9_GIT_EXIT_FAILED';
    diagnostics.push({ code, operation: 'rev-parse', detail: code === 'A9_GIT_NOT_REPOSITORY'
      ? '当前工作区不是 Git 仓库。' : 'Git 只读探测未成功。' });
    projection.degradedReason = '当前工作区不是 Git 仓库（或 git 不可用）；Agent 文件/Shell 能力不受影响，仅无 Git 状态/Diff 投影。';
    projection.diagnostics = diagnostics;
    return projection;
  }

  projection.isGit = true;

  const filterConfig = await execGit(
    workDir,
    ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
    { observeConfigOnly: true },
  );
  addConfigDiagnostic(diagnostics, filterConfig, 'config filters');
  const disabledFilters = filterConfig.code === 0
    ? Array.from(new Set(filterConfig.stdout.split(/\r?\n/).map((line) => {
      const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(line.trim());
      return match ? match[1] : '';
    }).filter(Boolean)))
    : [];

  const branchResult = await execGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  addCommandDiagnostic(diagnostics, branchResult, 'rev-parse branch');
  projection.branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;

  const headResult = await execGit(workDir, ['rev-parse', 'HEAD']);
  addCommandDiagnostic(diagnostics, headResult, 'rev-parse HEAD');
  projection.head = headResult.code === 0 ? headResult.stdout.trim() : undefined;

  const statusResult = await execGit(workDir, ['status', '--porcelain=v1', '-b'], { disabledFilters });
  addCommandDiagnostic(diagnostics, statusResult, 'status');
  if (statusResult.code === 0) {
    for (const line of statusResult.stdout.split('\n')) {
      if (!line) continue;
      if (line.startsWith('##')) {
        const aheadMatch = /ahead (\d+)/.exec(line);
        const behindMatch = /behind (\d+)/.exec(line);
        if (aheadMatch) projection.ahead = Number(aheadMatch[1]);
        if (behindMatch) projection.behind = Number(behindMatch[1]);
        continue;
      }
      projection.entries.push({
        indexStatus: line.slice(0, 1),
        worktreeStatus: line.slice(1, 2),
        path: line.slice(3),
      });
    }
    projection.clean = projection.entries.length === 0;
  }

  const diffResult = await execGit(workDir, [
    'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--stat', '--patch', `--unified=3`,
  ], { disabledFilters });
  addCommandDiagnostic(diagnostics, diffResult, 'diff');
  if (diffResult.code === 0) {
    if (diffResult.stdout.length > MAX_DIFF_BYTES) {
      projection.diffPreview = diffResult.stdout.slice(0, MAX_DIFF_BYTES);
      projection.diffTruncated = true;
    } else {
      projection.diffPreview = diffResult.stdout;
    }
  }

  projection.externalMechanisms = await detectExternalMechanisms(workDir, diagnostics);

  if (projection.externalMechanisms.length > 0) {
    notes.push('该仓库存在 hooks/filters/helpers 等外部执行机制：Trusted Full Access 经 Shell 使用用户真实 Git 环境时，这些机制拥有当前用户执行权（ADR-0089）。');
  }
  notes.push('本投影只读；模型的真实 Git 写命令经 TrustedShellRunner 与行为策略执行。');
  if (diagnostics.length > 0) projection.diagnostics = diagnostics;
  return projection;
}

function commandDiagnostic(result: GitCommandResult, operation: string): TrustedGitDiagnostic {
  const code = result.failure === 'spawn_failed' ? 'A9_GIT_SPAWN_FAILED'
    : result.failure === 'timeout' ? 'A9_GIT_TIMEOUT' : 'A9_GIT_EXIT_FAILED';
  return { code, operation, detail: code === 'A9_GIT_TIMEOUT' ? 'Git 命令超时。' : code === 'A9_GIT_SPAWN_FAILED' ? 'Git 无法启动。' : 'Git 命令退出码非零。' };
}

function addCommandDiagnostic(diagnostics: TrustedGitDiagnostic[], result: GitCommandResult, operation: string): void {
  if (result.failure) diagnostics.push(commandDiagnostic(result, operation));
}

function addConfigDiagnostic(diagnostics: TrustedGitDiagnostic[], result: GitCommandResult, operation: string): void {
  if (!result.failure) return;
  if (result.failure === 'exit_nonzero' && result.stderr.trim()) {
    diagnostics.push({ code: 'A9_GIT_CONFIG_UNREADABLE', operation, detail: 'Git 配置不可读。' });
    return;
  }
  diagnostics.push(commandDiagnostic(result, operation));
}

/**
 * 探测仓库/用户配置中的外部执行机制（提示用途，不阻断）。
 */
export async function detectExternalMechanisms(workDir: string, diagnostics: TrustedGitDiagnostic[] = []): Promise<TrustedGitExternalMechanism[]> {
  const mechanisms: TrustedGitExternalMechanism[] = [];

  const hooksPath = await execGit(workDir, ['config', '--get', 'core.hooksPath'], { observeConfigOnly: true });
  addConfigDiagnostic(diagnostics, hooksPath, 'config core.hooksPath');
  if (hooksPath.code === 0 && hooksPath.stdout.trim()) {
    mechanisms.push({ kind: 'hooks_path_override', detail: `core.hooksPath=${hooksPath.stdout.trim()}` });
  } else {
    const defaultHooksDir = path.join(workDir, '.git', 'hooks');
    try {
      if (fs.existsSync(defaultHooksDir)) {
        const activeHooks = fs.readdirSync(defaultHooksDir).filter((name) => !name.endsWith('.sample') && !name.startsWith('.'));
        if (activeHooks.length > 0) {
          mechanisms.push({ kind: 'hooks', detail: `active hooks: ${activeHooks.join(', ')}` });
        }
      }
    } catch (_err) {
      diagnostics.push({ code: 'A9_GIT_CONFIG_UNREADABLE', operation: 'hooks', detail: 'Git hooks 目录不可读。' });
    }
  }

  for (const attrFile of [path.join(workDir, '.gitattributes'), path.join(workDir, '.git', 'info', 'attributes')]) {
    try {
      if (!fs.existsSync(attrFile)) continue;
      const text = fs.readFileSync(attrFile, 'utf8');
      if (/(^|\s)filter\b/.test(text)) mechanisms.push({ kind: 'filter', detail: `${attrFile} 定义了 filter` });
      if (/(^|\s)diff\s*=\s*\S+/.test(text) && /(^|\s)diff\b/.test(text)) {
        const named = /diff\s*=\s*(\S+)/.exec(text);
        if (named) mechanisms.push({ kind: 'textconv', detail: `${attrFile}: diff=${named[1]}` });
      }
    } catch (_err) {
      diagnostics.push({ code: 'A9_GIT_CONFIG_UNREADABLE', operation: 'attributes', detail: 'Git attributes 配置不可读。' });
    }
  }

  const credentialHelper = await execGit(workDir, ['config', '--get', 'credential.helper'], { observeConfigOnly: true });
  addConfigDiagnostic(diagnostics, credentialHelper, 'config credential.helper');
  if (credentialHelper.code === 0 && credentialHelper.stdout.trim()) {
    mechanisms.push({ kind: 'credential_helper', detail: `credential.helper=${credentialHelper.stdout.trim()}` });
  }

  const pager = await execGit(workDir, ['config', '--get', 'core.pager'], { observeConfigOnly: true });
  addConfigDiagnostic(diagnostics, pager, 'config core.pager');
  if (pager.code === 0 && pager.stdout.trim() && pager.stdout.trim() !== 'cat') {
    mechanisms.push({ kind: 'pager', detail: `core.pager=${pager.stdout.trim()}` });
  }

  const fsmonitor = await execGit(workDir, ['config', '--get', 'core.fsmonitor'], { observeConfigOnly: true });
  addConfigDiagnostic(diagnostics, fsmonitor, 'config core.fsmonitor');
  if (fsmonitor.code === 0 && fsmonitor.stdout.trim() && fsmonitor.stdout.trim() !== 'false') {
    mechanisms.push({ kind: 'fsmonitor', detail: `core.fsmonitor=${fsmonitor.stdout.trim()}` });
  }

  const sshCommand = await execGit(workDir, ['config', '--get', 'core.sshCommand'], { observeConfigOnly: true });
  addConfigDiagnostic(diagnostics, sshCommand, 'config core.sshCommand');
  if (sshCommand.code === 0 && sshCommand.stdout.trim()) {
    mechanisms.push({ kind: 'ssh_command', detail: `core.sshCommand=${sshCommand.stdout.trim()}` });
  }

  return mechanisms;
}

export { READ_ONLY_COMMANDS };
