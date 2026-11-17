/** A9-70 P2. Electron 22 / Node 16 built-ins + injected yazl Worker port.
 * Cooperative host checks; not an OS sandbox against external concurrent processes.
 * First batch enforces ZIP32 limits; Windows Explorer and ZIP64 are NOT_PERFORMED.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CheckpointManager } from './checkpoint-manager';
import { IoGuard, captureAnchor, captureNearestAnchor, samePath, assertAnchor } from './directory-identity';
import { OfficeBatchIdentity } from './a9-office-batch';

export const OFFICE_ARCHIVE_LIMITS = Object.freeze({
  sources: 100,
  files: 2000, // strictly < 65535 (ZIP32 max entry count)
  entriesVisited: 8000,
  fileBytes: 64 * 1024 * 1024, // 64 MiB per file (strictly < 4 GiB ZIP32)
  totalSourceBytes: 128 * 1024 * 1024, // 128 MiB uncompressed total (strictly < 4 GiB ZIP32)
  maxArchiveBytes: 128 * 1024 * 1024, // 128 MiB archive output (strictly < 4 GiB ZIP32)
  plans: 16,
  outputPathChars: 240,
  archiveEntryUtf8Bytes: 512,
  planBytes: 1024 * 1024,
});

const EMPTY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export class OfficeArchiveError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'OfficeArchiveError';
  }
}

function fail(code: string, details?: Record<string, unknown>): never {
  throw new OfficeArchiveError(code, details);
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail('ARCHIVE_CANCELLED');
}
function errorCode(error: unknown): string {
  if (error instanceof OfficeArchiveError) return error.code;
  return String((error as NodeJS.ErrnoException)?.code || 'ARCHIVE_IO_UNKNOWN').slice(0, 80);
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const digest = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export interface ArchiveFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function identity(stat: fs.Stats): ArchiveFileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function sameFile(a: ArchiveFileIdentity, b: ArchiveFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function fileStat(file: string, guard: IoGuard): fs.Stats {
  guard.check(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('ARCHIVE_NOT_REGULAR_FILE');
  return stat;
}

async function hashFile(
  file: string,
  guard: IoGuard,
  max: number,
  signal?: AbortSignal,
): Promise<{ sha256: string; identity: ArchiveFileIdentity }> {
  cancelled(signal);
  const before = fileStat(file, guard);
  if (before.size > max) fail('ARCHIVE_FILE_BYTE_LIMIT');
  guard.check(file);
  const fd = fs.openSync(file, 'r');
  try {
    if (!sameFile(identity(before), identity(fs.fstatSync(fd)))) fail('ARCHIVE_SOURCE_DRIFT');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      cancelled(signal);
      guard.check(file);
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!n) fail('ARCHIVE_SOURCE_DRIFT');
      hash.update(buffer.subarray(0, n));
      offset += n;
      await tick();
    }
    cancelled(signal);
    if (!sameFile(identity(before), identity(fs.fstatSync(fd))) || !sameFile(identity(before), identity(fileStat(file, guard)))) {
      fail('ARCHIVE_SOURCE_DRIFT');
    }
    return { sha256: hash.digest('hex'), identity: identity(before) };
  } finally {
    fs.closeSync(fd);
  }
}

function absent(file: string, guard: IoGuard): void {
  guard.check(file);
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  fail('ARCHIVE_TARGET_EXISTS');
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function exclusionReason(
  relative: string,
  absPath: string,
  recoveryRoot: string,
  destRel: string,
  manifestRel?: string,
): string | undefined {
  const norm = relative.replace(/\\/g, '/');
  const lower = norm.toLowerCase();
  if (lower === destRel.toLowerCase() || (manifestRel && lower === manifestRel.toLowerCase())) return 'excluded_output';
  const segments = norm.split('/');
  if (segments.some(s => s.toLowerCase() === '.git')) return 'excluded_git';
  if (segments.some(s => s.toLowerCase() === '.agent_recovery') || isWithin(recoveryRoot, absPath)) return 'excluded_recovery';
  if (segments.some(s => /^_待清理隔离区_/.test(s))) return 'excluded_quarantine';
  const base = path.posix.basename(norm);
  if (/^~\$/.test(base) || /^\.~lock\./i.test(base)) return 'excluded_office_lock';
  if (/^\.a9-(?:archive|batch|transfer)-/i.test(base) || /^\.office-.*\.tmp$/i.test(base) || /\.tmp-\d+-[0-9a-f]+$/i.test(base)) {
    return 'excluded_temp';
  }
  return undefined;
}

function relativeName(value: string, output = false, allowRoot = false): string {
  if (typeof value !== 'string') fail('ARCHIVE_PATH_INVALID');
  const normalized = value === '.' ? '' : value.replace(/\/+$/, '');
  if (allowRoot && normalized === '') return '';
  if (!normalized || normalized.length > 4096 || /[\\\x00-\x1f:*?"<>|]/.test(normalized)
    || path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    fail('ARCHIVE_PATH_INVALID');
  }
  const segments = normalized.split('/');
  if (segments.some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
    fail('ARCHIVE_PATH_INVALID');
  }
  if (output) {
    if (segments.some(s => ['.git', '.agent_recovery'].includes(s.toLowerCase()) || /^~\$/.test(s)
      || /^_待清理隔离区_/.test(s) || /^\.a9-(?:archive|batch|transfer)-/i.test(s))) {
      fail('ARCHIVE_PATH_INVALID');
    }
  }
  return normalized;
}

function validateIdentity(value: OfficeBatchIdentity): void {
  if (!value || Object.keys(value).sort().join(',') !== 'conversationId,turnId,workspaceId'
    || Object.values(value).some(v => typeof v !== 'string' || !/^[\w.-]{1,128}$/.test(v))) {
    fail('ARCHIVE_IDENTITY_INVALID');
  }
}
function identityKey(value: OfficeBatchIdentity): string {
  validateIdentity(value);
  return JSON.stringify([value.workspaceId, value.conversationId, value.turnId]);
}

export interface OfficeArchivePlanInput {
  sources: string[];
  destination: string;
  manifestPath?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface ArchivePlanEntry {
  source: string;
  archivePath: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  sourceIdentity: ArchiveFileIdentity;
}

export interface OfficeArchivePlan {
  schemaVersion: 1;
  planId: string;
  version: 1;
  identity: OfficeBatchIdentity;
  destination: string;
  manifestPath?: string;
  zipFormat: 'ZIP32';
  entries: ReadonlyArray<ArchivePlanEntry>;
  excluded: ReadonlyArray<{ path: string; reason: string }>;
  entryCount: number;
  totalSourceBytes: number;
  limits: typeof OFFICE_ARCHIVE_LIMITS;
  limitations: string[];
  approvalRequired: true;
}

export interface OfficeArchiveApprovalBinding {
  schemaVersion: 1;
  planId: string;
  version: 1;
  identity: OfficeBatchIdentity;
  workspaceRoot: string;
  destination: string;
  manifestPath?: string;
  zipFormat: 'ZIP32';
  entryCount: number;
  totalSourceBytes: number;
  entries: ReadonlyArray<{ source: string; archivePath: string; sha256: string; sizeBytes: number }>;
  bindingSha256: string;
}

export interface OfficeArchiveApprovalPort {
  consume(approvalId: string, binding: OfficeArchiveApprovalBinding): Promise<{ status: 'approved'; bindingSha256: string }>;
}

export interface OfficeZipWorkerInput {
  tempZipPath: string;
  tempIdentity: ArchiveFileIdentity;
  entries: Array<{
    absolutePath: string;
    archivePath: string;
    sizeBytes: number;
    mtimeMs: number;
    sha256: string;
    sourceIdentity: ArchiveFileIdentity;
  }>;
  maxArchiveBytes: number;
}

export interface OfficeZipWorkerResult {
  entryCount: number;
  archiveBytes: number;
  archiveSha256: string;
  zipFormat: 'ZIP32';
  workerExitCode: number;
  compressedBytesTotal?: number;
}

export interface OfficeZipWorkerPort {
  createZip(input: OfficeZipWorkerInput, signal?: AbortSignal): Promise<OfficeZipWorkerResult>;
  close?(): Promise<void>;
}

export interface OfficeArchiveExecuteOptions {
  planId: string;
  identity: OfficeBatchIdentity;
  approvalId: string;
  signal?: AbortSignal;
}

export interface OfficeArchiveResult {
  schemaVersion: 1;
  planId: string;
  status: 'completed' | 'partial' | 'cancelled' | 'failed';
  code: string;
  destination: string;
  zipPublished: boolean;
  archiveSha256?: string;
  archiveBytes?: number;
  zipFormat: 'ZIP32';
  manifestPath?: string;
  manifestPublished: boolean;
  manifestSha256?: string;
  entryCount: number;
  entries: Array<{ source: string; archivePath: string; sizeBytes: number; sha256: string }>;
  excluded: Array<{ path: string; reason: string }>;
  recovery: 'recorded' | 'unknown' | 'not_needed';
  checkpointStatus: 'recorded' | 'persistence_failed' | 'not_needed';
  workerExitCode?: number | null;
  workerSignal?: string | null;
  cleanupCode?: string;
  residualTemporary?: string;
  persistenceError?: string;
  warnings: string[];
  limitations: string[];
  manifestMarkdown: string;
  manifestCsv: string;
}

interface StoredArchivePlan {
  plan: OfficeArchivePlan;
  guard: IoGuard;
  used: boolean;
  key: string;
  destinationAbs: string;
  manifestAbs?: string;
}

type Resolver = (value: string) => { absPath: string; relPath: string; isOutside: boolean };

function buildManifestMarkdown(
  plan: OfficeArchivePlan,
  outcome: {
    status: OfficeArchiveResult['status'];
    code: string;
    zipPublished: boolean;
    archiveSha256?: string;
    archiveBytes?: number;
    manifestPublished: boolean;
    recovery: OfficeArchiveResult['recovery'];
    checkpointStatus: OfficeArchiveResult['checkpointStatus'];
    residualTemporary?: string;
    persistenceError?: string;
    workerExitCode?: number | null;
  },
): string {
  const cell = (s: string): string => s.replace(/[\r\n|]/g, ' ').replace(/([\\`*_[\]])/g, '\\$1');
  const lines = [
    '# 流式 ZIP 归档与交接清单',
    '',
    `- 计划 ID：\`${plan.planId}\``,
    `- 目标归档：\`${cell(plan.destination)}\`（格式：${plan.zipFormat}）`,
    `- 状态：\`${outcome.status}\`（代码：\`${outcome.code}\`）`,
    `- 归档已发布：${outcome.zipPublished ? '是' : '否'}${outcome.archiveSha256 ? `（SHA-256：\`${outcome.archiveSha256}\`，大小：${outcome.archiveBytes ?? 0} 字节）` : ''}`,
    `- 恢复记录：\`${outcome.recovery}\` / \`${outcome.checkpointStatus}\`${outcome.persistenceError ? `（${cell(outcome.persistenceError)}）` : ''}`,
    ...(outcome.workerExitCode !== undefined ? [`- Worker 退出码：\`${String(outcome.workerExitCode)}\``] : []),
    ...(outcome.residualTemporary ? [`- 临时文件残留：\`${cell(outcome.residualTemporary)}\``] : []),
    '',
    '## 归档源文件清单',
    '',
    '| 归档内路径 | 源路径 | 字节数 | SHA-256 |',
    '|---|---|---|---|',
    ...plan.entries.map(e => `| ${[e.archivePath, e.source, String(e.sizeBytes), e.sha256].map(cell).join(' | ')} |`),
  ];
  if (plan.excluded.length > 0) {
    lines.push('', '## 已排除项', '', '| 路径 | 原因 |', '|---|---|');
    for (const item of plan.excluded) lines.push(`| ${cell(item.path)} | ${cell(item.reason)} |`);
  }
  lines.push('', '## 已知限制', '', ...plan.limitations.map(item => `- ${cell(item)}`));
  return lines.join('\n') + '\n';
}

function buildManifestCsv(plan: OfficeArchivePlan): string {
  const csv = (s: string): string => '"' + (/^\s*[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"';
  return [
    'archivePath,source,sizeBytes,sha256',
    ...plan.entries.map(e => [e.archivePath, e.source, String(e.sizeBytes), e.sha256].map(csv).join(',')),
  ].join('\n') + '\n';
}

export class OfficeArchiveService {
  private readonly plans = new Map<string, StoredArchivePlan>();
  private active = false;

  constructor(
    private readonly root: string,
    private readonly checkpoint: CheckpointManager,
    private readonly resolve: Resolver,
    private readonly approval?: OfficeArchiveApprovalPort,
    private readonly zipWorker?: OfficeZipWorkerPort,
  ) {}

  private checkNoLinks(value: string): void {
    if (!value) return;
    let probe = this.root;
    for (const segment of value.split('/')) {
      probe = path.join(probe, segment);
      try {
        if (fs.lstatSync(probe).isSymbolicLink()) fail('ARCHIVE_PATH_REDIRECTED');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }

  private resolveOutput(value: string, extensionPattern: RegExp, tempPrefix: string): { relative: string; absolute: string } {
    const relative = relativeName(value, true, false);
    if (!extensionPattern.test(relative)) fail('ARCHIVE_PATH_INVALID');
    const lexicalAbs = path.resolve(this.root, relative);
    const lexicalTemp = path.join(path.dirname(lexicalAbs), `${tempPrefix}${'0'.repeat(16)}.tmp`);
    if (lexicalAbs.length > OFFICE_ARCHIVE_LIMITS.outputPathChars || lexicalTemp.length > OFFICE_ARCHIVE_LIMITS.outputPathChars) {
      fail('ARCHIVE_PATH_TOO_LONG');
    }
    let resolved: { absPath: string; relPath: string; isOutside: boolean };
    try {
      resolved = this.resolve(relative);
    } catch (error: any) {
      if (error && error.code === 'PATH_TOO_LONG') fail('ARCHIVE_PATH_TOO_LONG');
      throw error;
    }
    if (resolved.isOutside || !samePath(lexicalAbs, resolved.absPath)) fail('ARCHIVE_PATH_REDIRECTED');
    this.checkNoLinks(relative);
    if (isWithin(this.checkpoint.getRecoveryRoot(), lexicalAbs) || isWithin(lexicalAbs, this.checkpoint.getRecoveryRoot())) {
      fail('ARCHIVE_PATH_EXCLUDED');
    }
    return { relative, absolute: lexicalAbs };
  }

  private resolveSource(value: string): { relative: string; absolute: string } {
    const relative = relativeName(value, false, true);
    const absolute = relative ? path.resolve(this.root, relative) : this.resolve('').absPath;
    const resolved = this.resolve(relative);
    if (resolved.isOutside || !samePath(absolute, resolved.absPath)) fail('ARCHIVE_PATH_REDIRECTED');
    if (relative) this.checkNoLinks(relative);
    return { relative, absolute };
  }

  async plan(binding: OfficeBatchIdentity, input: OfficeArchivePlanInput, signal?: AbortSignal): Promise<OfficeArchivePlan> {
    cancelled(signal);
    const key = identityKey(binding);
    const boundIdentity = { ...binding };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('ARCHIVE_INPUT_INVALID');
    if (Object.keys(input).some(k => !['sources', 'destination', 'manifestPath', 'maxFiles', 'maxFileBytes', 'maxTotalBytes'].includes(k))) {
      fail('ARCHIVE_INPUT_INVALID');
    }
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > OFFICE_ARCHIVE_LIMITS.sources) {
      fail('ARCHIVE_SOURCE_LIMIT');
    }
    const limit = (n: number | undefined, fallback: number): number => {
      if (n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > fallback)) fail('ARCHIVE_LIMIT_INVALID');
      return n ?? fallback;
    };
    const maxFiles = limit(input.maxFiles, OFFICE_ARCHIVE_LIMITS.files);
    const maxFileBytes = limit(input.maxFileBytes, OFFICE_ARCHIVE_LIMITS.fileBytes);
    const maxTotalBytes = limit(input.maxTotalBytes, OFFICE_ARCHIVE_LIMITS.totalSourceBytes);

    if (this.plans.size >= OFFICE_ARCHIVE_LIMITS.plans) {
      const consumed = [...this.plans].find(([, stored]) => stored.used);
      if (consumed) this.plans.delete(consumed[0]);
    }
    if (this.plans.size >= OFFICE_ARCHIVE_LIMITS.plans) fail('ARCHIVE_PLAN_LIMIT');

    const dest = this.resolveOutput(input.destination, /\.zip$/i, '.a9-archive-');
    const manifest = input.manifestPath !== undefined
      ? this.resolveOutput(input.manifestPath, /\.(?:md|txt|json)$/i, '.a9-archive-mf-')
      : undefined;
    if (manifest && manifest.relative.toLowerCase() === dest.relative.toLowerCase()) fail('ARCHIVE_PATH_CONFLICT');

    const recoveryRoot = this.checkpoint.getRecoveryRoot();
    const sourcesCopy = [...input.sources];
    const resolvedSources = sourcesCopy.map(s => this.resolveSource(s));
    const rootAnchor = captureAnchor(this.root);
    const destParentAnchor = captureNearestAnchor(path.dirname(dest.absolute));
    const manifestParentAnchor = manifest ? captureNearestAnchor(path.dirname(manifest.absolute)) : undefined;
    const guard = new IoGuard([rootAnchor, destParentAnchor, ...(manifestParentAnchor ? [manifestParentAnchor] : [])]);

    absent(dest.absolute, guard);
    if (manifest) absent(manifest.absolute, guard);

    const directoryAnchors = new Map<string, ReturnType<typeof captureAnchor>>();
    const excludedMap = new Map<string, { path: string; reason: string }>();
    const addExcluded = (relPath: string, reason: string) => {
      if (!excludedMap.has(relPath)) excludedMap.set(relPath, { path: relPath || '.', reason });
    };
    const seenExact = new Set<string>();
    const seenArchiveLower = new Set<string>();
    const discoveredFiles: Array<{ relative: string; absolute: string; dirAnchor: ReturnType<typeof captureAnchor> }> = [];
    let visited = 0;

    for (const src of resolvedSources) {
      cancelled(signal);
      if (src.relative) {
        const directExcluded = exclusionReason(src.relative, src.absolute, recoveryRoot, dest.relative, manifest?.relative);
        if (directExcluded) fail('ARCHIVE_PATH_EXCLUDED');
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(src.absolute);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') fail('ARCHIVE_SOURCE_MISSING');
        throw error;
      }
      if (st.isSymbolicLink()) fail('ARCHIVE_PATH_REDIRECTED');

      if (st.isFile()) {
        if (!src.relative) fail('ARCHIVE_PATH_INVALID');
        const parentDir = path.dirname(src.absolute);
        const parentAnchor = directoryAnchors.get(parentDir) ?? captureAnchor(parentDir);
        directoryAnchors.set(parentDir, parentAnchor);
        const keyLower = src.relative.toLowerCase();
        if (seenExact.has(src.relative)) continue;
        if (seenArchiveLower.has(keyLower)) fail('ARCHIVE_PATH_CONFLICT');
        seenExact.add(src.relative);
        seenArchiveLower.add(keyLower);
        if (discoveredFiles.length + 1 > maxFiles) fail('ARCHIVE_FILE_LIMIT');
        discoveredFiles.push({ relative: src.relative, absolute: src.absolute, dirAnchor: parentAnchor });
        continue;
      }

      if (!st.isDirectory()) fail('ARCHIVE_NOT_REGULAR_FILE');
      const startAnchor = directoryAnchors.get(src.absolute) ?? captureAnchor(src.absolute);
      directoryAnchors.set(src.absolute, startAnchor);
      const stack = [src.absolute];
      while (stack.length) {
        cancelled(signal);
        const dir = stack.pop()!;
        const dirAnchor = directoryAnchors.get(dir)!;
        const dirGuard = guard.with([dirAnchor]);
        dirGuard.checkInside(dir);
        const handle = fs.opendirSync(dir);
        const children: string[] = [];
        try {
          for (;;) {
            cancelled(signal);
            dirGuard.checkInside(dir);
            const entry = handle.readSync();
            if (!entry) break;
            if (++visited > OFFICE_ARCHIVE_LIMITS.entriesVisited) fail('ARCHIVE_SCAN_LIMIT');
            children.push(entry.name);
            if (visited % 32 === 0) await tick();
          }
        } finally {
          handle.closeSync();
        }
        children.sort(compare);
        const subdirs: string[] = [];
        for (const name of children) {
          cancelled(signal);
          const abs = path.join(dir, name);
          const rel = path.relative(this.root, abs).replace(/\\/g, '/');
          const ex = exclusionReason(rel, abs, recoveryRoot, dest.relative, manifest?.relative);
          if (ex) {
            addExcluded(rel, ex);
            continue;
          }
          dirGuard.check(abs);
          const childStat = fs.lstatSync(abs);
          if (childStat.isSymbolicLink()) {
            addExcluded(rel, 'reparse_or_symlink');
            continue;
          }
          if (childStat.isDirectory()) {
            directoryAnchors.set(abs, captureAnchor(abs));
            subdirs.push(abs);
            continue;
          }
          if (!childStat.isFile()) {
            addExcluded(rel, 'non_regular_file');
            continue;
          }
          relativeName(rel, false, false);
          if (Buffer.byteLength(rel, 'utf8') > OFFICE_ARCHIVE_LIMITS.archiveEntryUtf8Bytes) fail('ARCHIVE_ENTRY_PATH_TOO_LONG');
          if (seenExact.has(rel)) continue;
          const lower = rel.toLowerCase();
          if (seenArchiveLower.has(lower)) fail('ARCHIVE_PATH_CONFLICT');
          seenExact.add(rel);
          seenArchiveLower.add(lower);
          if (discoveredFiles.length + 1 > maxFiles) fail('ARCHIVE_FILE_LIMIT');
          discoveredFiles.push({ relative: rel, absolute: abs, dirAnchor });
          await tick();
        }
        stack.push(...subdirs.reverse());
      }
    }

    if (discoveredFiles.length === 0) fail('ARCHIVE_EMPTY_SOURCE');
    discoveredFiles.sort((a, b) => compare(a.relative, b.relative));

    const entries: ArchivePlanEntry[] = [];
    let totalSourceBytes = 0;
    for (const file of discoveredFiles) {
      cancelled(signal);
      if (Buffer.byteLength(file.relative, 'utf8') > OFFICE_ARCHIVE_LIMITS.archiveEntryUtf8Bytes) {
        fail('ARCHIVE_ENTRY_PATH_TOO_LONG');
      }
      const fileGuard = guard.with([file.dirAnchor]);
      const fact = await hashFile(file.absolute, fileGuard, maxFileBytes, signal);
      totalSourceBytes += fact.identity.size;
      if (totalSourceBytes > maxTotalBytes || totalSourceBytes > 0xfffffffe) fail('ARCHIVE_TOTAL_BYTE_LIMIT');
      entries.push({
        source: file.relative,
        archivePath: file.relative,
        sizeBytes: fact.identity.size,
        mtimeMs: fact.identity.mtimeMs,
        sha256: fact.sha256,
        sourceIdentity: fact.identity,
      });
    }

    guard.assertAnchors();
    for (const anchor of directoryAnchors.values()) assertAnchor(anchor);

    const fullGuard = new IoGuard([rootAnchor, destParentAnchor, ...(manifestParentAnchor ? [manifestParentAnchor] : []), ...directoryAnchors.values()]);
    const excluded = [...excludedMap.values()].sort((a, b) => compare(a.path, b.path));
    const plan = freeze<OfficeArchivePlan>({
      schemaVersion: 1,
      planId: crypto.randomBytes(16).toString('hex'),
      version: 1,
      identity: boundIdentity,
      destination: dest.relative,
      ...(manifest ? { manifestPath: manifest.relative } : {}),
      zipFormat: 'ZIP32',
      entries,
      excluded,
      entryCount: entries.length,
      totalSourceBytes,
      limits: OFFICE_ARCHIVE_LIMITS,
      limitations: [
        'ZIP32_ONLY_NO_ZIP64',
        'WINDOWS_EXPLORER_NOT_VERIFIED',
        'WINDOWS_HIDDEN_ATTRIBUTE_NOT_AVAILABLE',
        'TRUSTED_WORKSPACE_PATH_RACES_NOT_ATOMIC',
      ],
      approvalRequired: true,
    });

    if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > OFFICE_ARCHIVE_LIMITS.planBytes) {
      fail('ARCHIVE_PLAN_BYTE_LIMIT');
    }
    this.plans.set(plan.planId, {
      plan,
      key,
      guard: fullGuard,
      used: false,
      destinationAbs: dest.absolute,
      manifestAbs: manifest?.absolute,
    });
    return plan;
  }

  private async verifyPlanState(stored: StoredArchivePlan, signal?: AbortSignal): Promise<void> {
    cancelled(signal);
    stored.guard.assertAnchors();
    absent(stored.destinationAbs, stored.guard);
    if (stored.manifestAbs) absent(stored.manifestAbs, stored.guard);
    for (const entry of stored.plan.entries) {
      cancelled(signal);
      const resolved = this.resolveSource(entry.source);
      const fact = await hashFile(resolved.absolute, stored.guard, OFFICE_ARCHIVE_LIMITS.fileBytes, signal);
      if (fact.sha256 !== entry.sha256 || !sameFile(fact.identity, entry.sourceIdentity)) {
        fail('ARCHIVE_SOURCE_DRIFT');
      }
    }
  }

  async prepare(planId: string, binding: OfficeBatchIdentity, signal?: AbortSignal): Promise<OfficeArchiveApprovalBinding> {
    const stored = this.plans.get(planId);
    if (!stored) fail('ARCHIVE_PLAN_UNKNOWN');
    if (stored.used) fail('ARCHIVE_PLAN_CONSUMED');
    if (identityKey(binding) !== stored.key) fail('ARCHIVE_IDENTITY_MISMATCH');
    await this.verifyPlanState(stored, signal);
    const boundEntries = stored.plan.entries.map(e => ({
      source: e.source,
      archivePath: e.archivePath,
      sha256: e.sha256,
      sizeBytes: e.sizeBytes,
    }));
    const base = {
      schemaVersion: 1 as const,
      planId: stored.plan.planId,
      version: 1 as const,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      destination: stored.plan.destination,
      ...(stored.plan.manifestPath ? { manifestPath: stored.plan.manifestPath } : {}),
      zipFormat: 'ZIP32' as const,
      entryCount: stored.plan.entryCount,
      totalSourceBytes: stored.plan.totalSourceBytes,
      entries: boundEntries,
    };
    return freeze({ ...base, bindingSha256: digest(JSON.stringify(base)) });
  }

  async execute(options: OfficeArchiveExecuteOptions): Promise<OfficeArchiveResult> {
    if (this.active) fail('ARCHIVE_BUSY');
    const stored = this.plans.get(options.planId);
    if (!stored) fail('ARCHIVE_PLAN_UNKNOWN');
    if (stored.used) fail('ARCHIVE_PLAN_CONSUMED');
    if (identityKey(options.identity) !== stored.key) fail('ARCHIVE_IDENTITY_MISMATCH');
    if (!this.approval || typeof options.approvalId !== 'string' || !options.approvalId) fail('ARCHIVE_APPROVAL_REQUIRED');
    if (!this.zipWorker) fail('ARCHIVE_WORKER_UNAVAILABLE');

    const signal = options.signal;
    cancelled(signal);

    const boundEntries = stored.plan.entries.map(e => ({
      source: e.source,
      archivePath: e.archivePath,
      sha256: e.sha256,
      sizeBytes: e.sizeBytes,
    }));
    const base = {
      schemaVersion: 1 as const,
      planId: stored.plan.planId,
      version: 1 as const,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      destination: stored.plan.destination,
      ...(stored.plan.manifestPath ? { manifestPath: stored.plan.manifestPath } : {}),
      zipFormat: 'ZIP32' as const,
      entryCount: stored.plan.entryCount,
      totalSourceBytes: stored.plan.totalSourceBytes,
      entries: boundEntries,
    };
    const authorization = freeze({ ...base, bindingSha256: digest(JSON.stringify(base)) });

    this.active = true;
    stored.used = true;

    let tempAbs: string | undefined;
    let tempRel: string | undefined;
    let tempIdentity: ArchiveFileIdentity | undefined;
    let mfTempAbs: string | undefined;
    let mfTempIdentity: ArchiveFileIdentity | undefined;
    let guard = stored.guard;
    const turnId = stored.plan.identity.turnId;

    let status: OfficeArchiveResult['status'] = 'failed';
    let code = 'ARCHIVE_FAILED';
    let zipPublished = false;
    let archiveSha256: string | undefined;
    let archiveBytes: number | undefined;
    let manifestPublished = false;
    let manifestSha256: string | undefined;
    let recovery: OfficeArchiveResult['recovery'] = 'not_needed';
    let checkpointStatus: OfficeArchiveResult['checkpointStatus'] = 'not_needed';
    let workerExitCode: number | null | undefined;
    let workerSignal: string | null | undefined;
    let cleanupCode: string | undefined;
    let residualTemporary: string | undefined;
    let persistenceError: string | undefined;
    const warnings: string[] = [];

    try {
      cancelled(signal);
      const approved = await this.approval.consume(options.approvalId, authorization);
      if (!approved || approved.status !== 'approved' || approved.bindingSha256 !== authorization.bindingSha256) {
        fail('ARCHIVE_APPROVAL_REJECTED');
      }
      await this.verifyPlanState(stored, signal);

      // Prepare temp path name & pre-mutation checkpoint BEFORE creating any filesystem artifact.
      tempAbs = path.join(path.dirname(stored.destinationAbs), `.a9-archive-${crypto.randomBytes(8).toString('hex')}.tmp`);
      if (tempAbs.length > OFFICE_ARCHIVE_LIMITS.outputPathChars) fail('ARCHIVE_PATH_TOO_LONG');
      tempRel = path.relative(this.root, tempAbs).replace(/\\/g, '/');

      guard = this.checkpoint.createIoGuard([
        stored.destinationAbs,
        tempAbs,
        ...(stored.manifestAbs ? [stored.manifestAbs] : []),
      ]).with([() => { stored.guard.assertAnchors(); return undefined; }]);

      try {
        await this.checkpoint.recordPreMutationAsync(turnId, stored.plan.destination, { guard, signal });
        await this.checkpoint.recordPreMutationAsync(turnId, tempRel, { guard, signal });
        if (stored.plan.manifestPath) {
          await this.checkpoint.recordPreMutationAsync(turnId, stored.plan.manifestPath, { guard, signal });
        }
      } catch (err) {
        if (errorCode(err) === 'ARCHIVE_CANCELLED') throw err;
        fail('ARCHIVE_RECOVERY_UNAVAILABLE', { cause: errorCode(err) });
      }

      // Now create parent directories inside verified anchor & exclusively create temp file.
      cancelled(signal);
      guard.ensureDirectory(path.dirname(stored.destinationAbs));
      guard = guard.with([captureAnchor(path.dirname(stored.destinationAbs))]);
      if (stored.manifestAbs) {
        guard.ensureDirectory(path.dirname(stored.manifestAbs));
        guard = guard.with([captureAnchor(path.dirname(stored.manifestAbs))]);
      }

      guard.check(tempAbs);
      const tempFd = fs.openSync(tempAbs, 'wx');
      try {
        tempIdentity = identity(fs.fstatSync(tempFd));
      } finally {
        fs.closeSync(tempFd);
      }
      residualTemporary = tempRel;

      let readyForWorker = true;
      try {
        await this.checkpoint.recordPostMutationAsync(turnId, tempRel, 'create', {
          guard,
          fileHash: EMPTY_SHA256,
          skipNewBlob: true,
        });
        checkpointStatus = 'recorded';
        recovery = 'recorded';
      } catch (err) {
        persistenceError = err instanceof Error ? err.message : String(err);
        checkpointStatus = 'persistence_failed';
        recovery = 'unknown';
        code = 'ARCHIVE_CHECKPOINT_PERSIST_FAILED';
        status = 'failed';
        readyForWorker = false;
      }

      let workerResult: OfficeZipWorkerResult | undefined;
      if (readyForWorker) {
        try {
          const workerEntries = stored.plan.entries.map(e => ({
            absolutePath: this.resolveSource(e.source).absolute,
            archivePath: e.archivePath,
            sizeBytes: e.sizeBytes,
            mtimeMs: e.mtimeMs,
            sha256: e.sha256,
            sourceIdentity: e.sourceIdentity,
          }));
          workerResult = await this.zipWorker.createZip({
            tempZipPath: tempAbs,
            tempIdentity,
            entries: workerEntries,
            maxArchiveBytes: OFFICE_ARCHIVE_LIMITS.maxArchiveBytes,
          }, signal);
          workerExitCode = workerResult.workerExitCode;
        } catch (err: any) {
          workerExitCode = err?.workerExitCode ?? workerExitCode ?? null;
          workerSignal = err?.workerSignal ?? null;
          code = errorCode(err);
          status = code === 'ARCHIVE_CANCELLED' || signal?.aborted ? 'cancelled' : 'failed';
          if (status === 'cancelled') code = 'ARCHIVE_CANCELLED';
        }
      }

      if (workerResult) {
        if (signal?.aborted) {
          status = 'cancelled';
          code = 'ARCHIVE_CANCELLED';
        } else {
          try {
            guard.assertAnchors();
            const tempStat = fileStat(tempAbs, guard);
            if (tempStat.dev !== tempIdentity.dev || tempStat.ino !== tempIdentity.ino) {
              fail('ARCHIVE_TEMP_IDENTITY_CHANGED');
            }
            absent(stored.destinationAbs, guard);
            guard.check(tempAbs);
            guard.check(stored.destinationAbs);
            try {
              fs.linkSync(tempAbs, stored.destinationAbs);
            } catch (linkErr) {
              if (errorCode(linkErr) === 'EEXIST') fail('ARCHIVE_TARGET_EXISTS');
              throw linkErr;
            }
            zipPublished = true;
            archiveSha256 = workerResult.archiveSha256;
            archiveBytes = workerResult.archiveBytes;
          } catch (err) {
            code = errorCode(err);
            status = code === 'ARCHIVE_CANCELLED' ? 'cancelled' : 'failed';
          }
        }
      }

      if (zipPublished) {
        recovery = 'unknown';
        checkpointStatus = 'persistence_failed';
        let zipCheckpointOk = false;
        try {
          await this.checkpoint.recordPostMutationAsync(turnId, stored.plan.destination, 'create', {
            guard,
            fileHash: archiveSha256,
            skipNewBlob: true,
          });
          recovery = 'recorded';
          checkpointStatus = 'recorded';
          zipCheckpointOk = true;
        } catch (err) {
          persistenceError = err instanceof Error ? err.message : String(err);
          recovery = 'unknown';
          checkpointStatus = 'persistence_failed';
          status = 'partial';
          code = 'ARCHIVE_CHECKPOINT_PERSIST_FAILED';
          warnings.push('归档文件已独占发布，但恢复记录持久化失败。');
        }

        if (zipCheckpointOk) {
          if (stored.plan.manifestPath && stored.manifestAbs) {
            if (signal?.aborted) {
              status = 'partial';
              code = 'ARCHIVE_CANCELLED';
              warnings.push('归档已发布并记录；交接清单文件因取消未写入。');
            } else {
              try {
                const previewText = buildManifestMarkdown(stored.plan, {
                  status: 'completed',
                  code: 'ARCHIVE_OK',
                  zipPublished,
                  archiveSha256,
                  archiveBytes,
                  manifestPublished: true,
                  recovery,
                  checkpointStatus,
                  workerExitCode,
                });
                const mfBytes = stored.plan.manifestPath.toLowerCase().endsWith('.json')
                  ? Buffer.from(JSON.stringify({
                    schemaVersion: 1,
                    planId: stored.plan.planId,
                    destination: stored.plan.destination,
                    zipFormat: stored.plan.zipFormat,
                    archiveSha256,
                    archiveBytes,
                    entryCount: stored.plan.entryCount,
                    entries: boundEntries,
                    excluded: stored.plan.excluded,
                    limitations: stored.plan.limitations,
                  }, null, 2) + '\n', 'utf8')
                  : Buffer.from(previewText, 'utf8');
                mfTempAbs = path.join(path.dirname(stored.manifestAbs), `.a9-archive-mf-${crypto.randomBytes(8).toString('hex')}.tmp`);
                if (mfTempAbs.length > OFFICE_ARCHIVE_LIMITS.outputPathChars) fail('ARCHIVE_PATH_TOO_LONG');
                guard.check(mfTempAbs);
                const mfd = fs.openSync(mfTempAbs, 'wx');
                try {
                  mfTempIdentity = identity(fs.fstatSync(mfd));
                  fs.writeSync(mfd, mfBytes, 0, mfBytes.length, 0);
                  fs.fsyncSync(mfd);
                } finally {
                  fs.closeSync(mfd);
                }
                absent(stored.manifestAbs, guard);
                guard.check(mfTempAbs);
                guard.check(stored.manifestAbs);
                try {
                  fs.linkSync(mfTempAbs, stored.manifestAbs);
                } catch (linkErr) {
                  if (errorCode(linkErr) === 'EEXIST') fail('ARCHIVE_TARGET_EXISTS');
                  throw linkErr;
                }
                manifestPublished = true;
                manifestSha256 = digest(mfBytes);
                try {
                  await this.checkpoint.recordPostMutationAsync(turnId, stored.plan.manifestPath, 'create', {
                    guard,
                    fileHash: manifestSha256,
                    skipNewBlob: true,
                  });
                  status = 'completed';
                  code = 'ARCHIVE_OK';
                } catch (persistErr) {
                  persistenceError = persistErr instanceof Error ? persistErr.message : String(persistErr);
                  recovery = 'unknown';
                  checkpointStatus = 'persistence_failed';
                  status = 'partial';
                  code = 'ARCHIVE_CHECKPOINT_PERSIST_FAILED';
                  warnings.push('归档与交接清单均已写入，但清单恢复记录持久化失败。');
                }
              } catch (mfErr) {
                code = errorCode(mfErr);
                status = 'partial';
                warnings.push(`归档已发布并记录；交接清单文件写入失败（${code}）。`);
              }
            }
          } else {
            status = 'completed';
            code = 'ARCHIVE_OK';
          }
        }
      }
    } finally {
      if (mfTempAbs && mfTempIdentity) {
        try {
          guard.check(mfTempAbs);
          const currentMf = fileStat(mfTempAbs, guard);
          if (currentMf.dev === mfTempIdentity.dev && currentMf.ino === mfTempIdentity.ino) {
            fs.unlinkSync(mfTempAbs);
          }
        } catch (_ignored) { /* best-effort manifest staging cleanup */ }
      }
      if (tempAbs && tempRel && tempIdentity) {
        try {
          guard.check(tempAbs);
          const current = fileStat(tempAbs, guard);
          if (current.dev !== tempIdentity.dev || current.ino !== tempIdentity.ino) {
            fail('ARCHIVE_TEMP_IDENTITY_CHANGED');
          }
          fs.unlinkSync(tempAbs);
          residualTemporary = undefined;
          try {
            await this.checkpoint.recordPostMutationAsync(turnId, tempRel, 'delete', { guard });
          } catch (persistErr) {
            recovery = 'unknown';
            checkpointStatus = 'persistence_failed';
            persistenceError = persistenceError || (persistErr instanceof Error ? persistErr.message : String(persistErr));
            if (status === 'completed') {
              status = 'partial';
              code = 'ARCHIVE_CHECKPOINT_PERSIST_FAILED';
            }
          }
        } catch (cleanupErr) {
          recovery = 'unknown';
          cleanupCode = errorCode(cleanupErr);
          if (status === 'completed') {
            status = 'partial';
            code = cleanupCode;
          }
        }
      }
      this.active = false;
    }
    return this.buildResult(stored.plan, {
      status, code, zipPublished, archiveSha256, archiveBytes, manifestPublished, manifestSha256,
      recovery, checkpointStatus, workerExitCode, workerSignal, cleanupCode, residualTemporary,
      persistenceError, warnings,
    });
  }

  private buildResult(
    plan: OfficeArchivePlan,
    state: {
      status: OfficeArchiveResult['status'];
      code: string;
      zipPublished: boolean;
      archiveSha256?: string;
      archiveBytes?: number;
      manifestPublished: boolean;
      manifestSha256?: string;
      recovery: OfficeArchiveResult['recovery'];
      checkpointStatus: OfficeArchiveResult['checkpointStatus'];
      workerExitCode?: number | null;
      workerSignal?: string | null;
      cleanupCode?: string;
      residualTemporary?: string;
      persistenceError?: string;
      warnings: string[];
    },
  ): OfficeArchiveResult {
    const entries = plan.entries.map(e => ({
      source: e.source,
      archivePath: e.archivePath,
      sizeBytes: e.sizeBytes,
      sha256: e.sha256,
    }));
    const excluded = plan.excluded.map(e => ({ ...e }));
    const manifestMarkdown = buildManifestMarkdown(plan, state);
    const manifestCsv = buildManifestCsv(plan);
    return {
      schemaVersion: 1,
      planId: plan.planId,
      status: state.status,
      code: state.code,
      destination: plan.destination,
      zipPublished: state.zipPublished,
      ...(state.archiveSha256 ? { archiveSha256: state.archiveSha256 } : {}),
      ...(state.archiveBytes !== undefined ? { archiveBytes: state.archiveBytes } : {}),
      zipFormat: plan.zipFormat,
      ...(plan.manifestPath ? { manifestPath: plan.manifestPath } : {}),
      manifestPublished: state.manifestPublished,
      ...(state.manifestSha256 ? { manifestSha256: state.manifestSha256 } : {}),
      entryCount: plan.entryCount,
      entries,
      excluded,
      recovery: state.recovery,
      checkpointStatus: state.checkpointStatus,
      ...(state.workerExitCode !== undefined ? { workerExitCode: state.workerExitCode } : {}),
      ...(state.workerSignal !== undefined ? { workerSignal: state.workerSignal } : {}),
      ...(state.cleanupCode ? { cleanupCode: state.cleanupCode } : {}),
      ...(state.residualTemporary ? { residualTemporary: state.residualTemporary } : {}),
      ...(state.persistenceError ? { persistenceError: state.persistenceError } : {}),
      warnings: [...state.warnings],
      limitations: [...plan.limitations],
      manifestMarkdown,
      manifestCsv,
    };
  }
}
