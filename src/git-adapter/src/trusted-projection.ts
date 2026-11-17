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
  /** R/C 状态项的来源路径；`path` 为目标（新）路径。 */
  originalPath?: string;
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
  | 'A9_GIT_CONFIG_UNREADABLE'
  | 'A9_GIT_OUTPUT_TOO_LARGE'
  | 'A9_GIT_FILTER_UNNEUTRALIZABLE';

export interface TrustedGitDiagnostic {
  code: TrustedGitDiagnosticCode;
  operation: string;
  detail: string;
}

const MAX_DIFF_BYTES = 512 * 1024;
const READ_ONLY_COMMANDS = new Set(['status', 'rev-parse', 'diff', 'log', 'branch', 'config', 'remote', 'describe']);

/** 投影允许注入的 `-c` 覆盖项：只关闭 fsmonitor 与 filter 回调。 */
const ALLOWED_CONFIG_OVERRIDE = /^(?:core\.fsmonitor=false|filter\.[^=\s]+\.(?:clean|smudge|process)=|filter\.[^=\s]+\.required=false)$/;
const CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--name-only', '--list', '-l', '--show-origin', '--null', '-z']);
const CONFIG_QUERY_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']);
const BRANCH_READ_FLAGS = new Set([
  '--list', '-l', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
  '--no-color', '--color', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format',
]);
const REMOTE_READ_FLAGS = new Set(['-v', '--verbose']);
const REMOTE_READ_SUBCOMMANDS = new Set(['get-url']);

export class TrustedGitReadOnlyViolation extends Error {
  readonly code = 'A9_GIT_NOT_READ_ONLY';
  constructor(detail: string) {
    super(`git-adapter 只允许只读子命令：${detail}`);
    this.name = 'TrustedGitReadOnlyViolation';
  }
}

/**
 * 在代码层强制只读子命令白名单（H-P2-23）。除白名单子命令外一律拒绝；
 * `config` 必须是查询形式，`branch`/`remote` 必须是列出形式，任何输出重定向选项被拒绝。
 */
export function assertReadOnlyGitArgs(args: readonly string[]): void {
  let index = 0;
  while (index < args.length && args[index] === '-c') {
    const override = args[index + 1];
    if (override === undefined || !ALLOWED_CONFIG_OVERRIDE.test(override)) {
      throw new TrustedGitReadOnlyViolation('不允许的 -c 配置覆盖');
    }
    index += 2;
  }
  const sub = args[index];
  if (sub === undefined || !READ_ONLY_COMMANDS.has(sub)) {
    throw new TrustedGitReadOnlyViolation(`子命令不在白名单：${String(sub)}`);
  }
  const rest = args.slice(index + 1);
  if (rest.some((arg) => arg === '--output' || arg.startsWith('--output='))) {
    throw new TrustedGitReadOnlyViolation('不允许 --output 重定向写入');
  }
  const flagName = (arg: string): string => (arg.startsWith('--') ? arg.split('=')[0] : arg);
  if (sub === 'config') {
    const flags = rest.filter((arg) => arg.startsWith('-'));
    if (flags.some((arg) => !CONFIG_READ_FLAGS.has(flagName(arg))) || !flags.some((arg) => CONFIG_QUERY_FLAGS.has(arg))) {
      throw new TrustedGitReadOnlyViolation('config 只允许 --get/--get-all/--get-regexp/--list 查询');
    }
  } else if (sub === 'branch') {
    const flags = rest.filter((arg) => arg.startsWith('-'));
    const positional = rest.filter((arg) => !arg.startsWith('-'));
    const listing = flags.some((arg) => arg === '--list' || arg === '-l' || arg === '--show-current');
    if (flags.some((arg) => !BRANCH_READ_FLAGS.has(flagName(arg))) || (positional.length > 0 && !listing)) {
      throw new TrustedGitReadOnlyViolation('branch 只允许列出形式');
    }
  } else if (sub === 'remote') {
    const flags = rest.filter((arg) => arg.startsWith('-'));
    const positional = rest.filter((arg) => !arg.startsWith('-'));
    if (flags.some((arg) => !REMOTE_READ_FLAGS.has(arg))
      || (positional.length > 0 && !REMOTE_READ_SUBCOMMANDS.has(positional[0]))) {
      throw new TrustedGitReadOnlyViolation('remote 只允许列出/show/get-url');
    }
  }
}

function isInsideDirectory(candidate: string, directory: string, caseInsensitive: boolean): boolean {
  const norm = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const relative = path.relative(norm(directory), norm(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realPathOrResolved(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch (_err) {
    return path.resolve(value);
  }
}

export interface ResolveGitOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * 在 PATH 中把 git 解析为绝对路径（H-P1-01）。排除工作区目录及其子目录、相对
 * 路径与空 PATH 项（Windows 上它们等价于 cwd 搜索），不返回裸名。找不到返回 null。
 */
export function resolveTrustedGitExecutable(workDir: string, options: ResolveGitOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isWin = platform === 'win32';
  const pathModule = isWin ? path.win32 : path.posix;
  const pathKey = Object.keys(env).find((key) => (isWin ? key.toUpperCase() === 'PATH' : key === 'PATH'));
  const rawPath = pathKey ? env[pathKey] : undefined;
  if (!rawPath) return null;
  const work = realPathOrResolved(workDir);
  // execFile 在 Windows 上无法直接运行 .cmd/.bat，只接受真实可执行文件。
  const names = isWin ? ['git.exe'] : ['git'];
  for (const rawDir of rawPath.split(isWin ? ';' : ':')) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !pathModule.isAbsolute(dir)) continue;
    if (isInsideDirectory(realPathOrResolved(dir), work, isWin)) continue;
    for (const name of names) {
      const candidate = pathModule.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
        const real = realPathOrResolved(candidate);
        if (isInsideDirectory(real, work, isWin)) continue;
        return candidate;
      } catch (_err) {
        // 该 PATH 项不含可用 git，继续下一项。
      }
    }
  }
  return null;
}

const gitPathCache = new Map<string, string>();

/** 缓存键含 PATH：用户中途改 PATH 时重新解析；未找到的结果不缓存，便于安装后立即恢复。 */
function resolveGitCached(workDir: string): string | null {
  const key = `${process.platform}\n${workDir}\n${process.env.PATH ?? process.env.Path ?? ''}`;
  const cached = gitPathCache.get(key);
  if (cached !== undefined) {
    if (fs.existsSync(cached)) return cached;
    gitPathCache.delete(key);
  }
  const resolved = resolveTrustedGitExecutable(workDir);
  if (resolved) gitPathCache.set(key, resolved);
  return resolved;
}

interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  failure?: 'spawn_failed' | 'timeout' | 'exit_nonzero' | 'output_too_large';
}

function execGit(
  workDir: string,
  args: string[],
  options: { observeConfigOnly?: boolean; disabledFilters?: string[] } = {},
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
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
    try {
      assertReadOnlyGitArgs(safeArgs);
    } catch (violation) {
      reject(violation);
      return;
    }
    try {
      const gitPath = resolveGitCached(workDir);
      if (!gitPath) {
        resolve({ code: 1, stdout: '', stderr: '', failure: 'spawn_failed' });
        return;
      }
      execFile(gitPath, safeArgs, {
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
        const outputTooLarge = Boolean(err && (err as any).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        const timedOut = Boolean(err && ((err as any).killed || (err as any).code === 'ETIMEDOUT'));
        const spawnFailed = Boolean(err && typeof (err as any).code === 'string'
          && (err as any).code !== 'ETIMEDOUT'
          && !outputTooLarge);
        resolve({ code: rawCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
          ...(outputTooLarge ? { failure: 'output_too_large' } : timedOut ? { failure: 'timeout' }
            : spawnFailed ? { failure: 'spawn_failed' } : rawCode !== 0 ? { failure: 'exit_nonzero' } : {}) });
      });
    } catch (_err) {
      resolve({ code: 1, stdout: '', stderr: '', failure: 'spawn_failed' });
    }
  });
}

/**
 * 解析 `git status --porcelain=v1 -z -b` 输出（H-P2-03）。记录以 NUL 分隔，路径不带引号/转义；
 * R/C 状态项后紧跟一条来源路径记录（`XY 目标\0来源\0`）。
 */
export function parsePorcelainV1Z(stdout: string): { header?: string; entries: TrustedGitStatusEntry[] } {
  const records = stdout.split('\0');
  const entries: TrustedGitStatusEntry[] = [];
  let header: string | undefined;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('## ')) {
      header = record;
      continue;
    }
    if (record.length < 4 || record[2] !== ' ') continue;
    const indexStatus = record.slice(0, 1);
    const worktreeStatus = record.slice(1, 2);
    const entry: TrustedGitStatusEntry = { indexStatus, worktreeStatus, path: record.slice(3) };
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      const original = records[i + 1];
      if (original) entry.originalPath = original;
      i += 1;
    }
    entries.push(entry);
  }
  return { header, entries };
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
  const rawFilterNames = filterConfig.code === 0
    ? Array.from(new Set(filterConfig.stdout.split(/\r?\n/).map((line) => {
      const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(line.trim());
      return match ? match[1] : '';
    }).filter(Boolean)))
    : [];

  const unneutralizableFilters: string[] = [];
  const disabledFilters: string[] = [];
  for (const name of rawFilterNames) {
    if (name.includes('=') || /[\r\n\0\s]/.test(name)) {
      unneutralizableFilters.push(name);
    } else {
      disabledFilters.push(name);
    }
  }

  if (unneutralizableFilters.length > 0) {
    diagnostics.push({
      code: 'A9_GIT_FILTER_UNNEUTRALIZABLE',
      operation: 'filter neutralization',
      detail: `仓库配置包含无法通过 -c 禁用的过滤器名称 (${unneutralizableFilters.join(', ')})，为安全起见跳过 status 与 diff 投影。`,
    });
  }

  const branchResult = await execGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headResult = await execGit(workDir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const noCommit = headResult.failure === 'exit_nonzero' && headResult.code === 1 && headResult.stderr.trim() === '';
  if (!noCommit || branchResult.failure !== 'exit_nonzero') addCommandDiagnostic(diagnostics, branchResult, 'rev-parse branch');
  projection.branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;

  if (!noCommit) addCommandDiagnostic(diagnostics, headResult, 'rev-parse HEAD');
  projection.head = headResult.code === 0 ? headResult.stdout.trim() : undefined;

  if (unneutralizableFilters.length === 0) {
    const statusResult = await execGit(workDir, ['status', '--porcelain=v1', '-z', '-b'], { disabledFilters });
    addCommandDiagnostic(diagnostics, statusResult, 'status');
    if (statusResult.code === 0) {
      const parsed = parsePorcelainV1Z(statusResult.stdout);
      if (parsed.header) {
        const aheadMatch = /ahead (\d+)/.exec(parsed.header);
        const behindMatch = /behind (\d+)/.exec(parsed.header);
        if (aheadMatch) projection.ahead = Number(aheadMatch[1]);
        if (behindMatch) projection.behind = Number(behindMatch[1]);
      }
      projection.entries.push(...parsed.entries);
      projection.clean = projection.entries.length === 0;
    }

    const diffResult = await execGit(workDir, [
      'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--stat', '--patch', `--unified=3`,
    ], { disabledFilters });
    if (!noCommit || diffResult.failure !== 'exit_nonzero') addCommandDiagnostic(diagnostics, diffResult, 'diff');
    if (diffResult.code === 0) {
      if (diffResult.stdout.length > MAX_DIFF_BYTES) {
        projection.diffPreview = diffResult.stdout.slice(0, MAX_DIFF_BYTES);
        projection.diffTruncated = true;
      } else {
        projection.diffPreview = diffResult.stdout;
      }
    }
  } else {
    projection.clean = false;
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
    : result.failure === 'timeout' ? 'A9_GIT_TIMEOUT'
      : result.failure === 'output_too_large' ? 'A9_GIT_OUTPUT_TOO_LARGE' : 'A9_GIT_EXIT_FAILED';
  return { code, operation, detail: code === 'A9_GIT_TIMEOUT' ? 'Git 命令超时。'
    : code === 'A9_GIT_SPAWN_FAILED' ? 'Git 无法启动。'
      : code === 'A9_GIT_OUTPUT_TOO_LARGE' ? 'Git 输出超过上限。' : 'Git 命令退出码非零。' };
}

function addCommandDiagnostic(diagnostics: TrustedGitDiagnostic[], result: GitCommandResult, operation: string): void {
  if (result.failure) diagnostics.push(commandDiagnostic(result, operation));
}

function addConfigDiagnostic(diagnostics: TrustedGitDiagnostic[], result: GitCommandResult, operation: string): void {
  if (!result.failure) return;
  if (result.failure === 'exit_nonzero') {
    if (result.stderr.trim()) {
      diagnostics.push({ code: 'A9_GIT_CONFIG_UNREADABLE', operation, detail: 'Git 配置不可读。' });
    }
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
