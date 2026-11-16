/**
 * @module checkpoint-manager
 * @description A9 工作区 Checkpoint、Diff、撤销与删除恢复管理 (PRD §5 A9-F03 / ADR-0089)
 *
 * 合同：Checkpoint 不只存在内存——pre-mutation 原始内容写入产品恢复区
 * （content-addressed blob / 目录快照），轮清单持久化为版本化 JSON；
 * 撤销支持按文件与按 Turn，撤销前校验当前文件漂移；崩溃后可从磁盘恢复；
 * 恢复失败必须结构化报告，不允许静默吞错。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { buildContentDiffPreview } from './diff';
import { copyTreeAsync, forEachTreeFileAsync, hashDirectoryTreeAsync, removeTreeAsync } from './async-tree';
import { captureAnchor, captureNearestAnchor, DirectoryAnchor, IoGuard, assertAnchor, identityChanged } from './directory-identity';
import { WorkspaceError } from './types';

export const CHECKPOINT_SCHEMA_VERSION = 4;

/**
 * A9-61: cooperative work on the Electron main thread yields after this much
 * synchronous time or this many steps, whichever comes first. The step bound
 * keeps interleaving deterministic on fast machines; the time bound caps stalls.
 */
const CHECKPOINT_YIELD_SLICE_MS = 16;
const CHECKPOINT_YIELD_MAX_STEPS = 64;
/** A9-61: external facts of one Turn are made durable in atomic manifest writes of this size. */
export const EXTERNAL_FACT_BATCH_OPERATIONS = 256;
/** A9-61: a manifest rewritten during cooperative validation is re-validated, then falls back to sync. */
const COOPERATIVE_LOAD_ATTEMPTS = 3;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Counts cooperative steps and yields once a step or time bound is reached. */
export class CooperativeSlice {
  private started = Date.now();
  private steps = 0;

  async step(): Promise<void> {
    this.steps += 1;
    if (this.steps >= CHECKPOINT_YIELD_MAX_STEPS || Date.now() - this.started >= CHECKPOINT_YIELD_SLICE_MS) {
      await yieldToEventLoop();
      this.started = Date.now();
      this.steps = 0;
    }
  }
}

export interface ExternalFactOptions {
  originalBlobPath?: string;
  newBlobPath?: string;
  originalHash?: string;
  newHash?: string;
  unrecoverable?: boolean;
}

export interface ExternalDirectoryFactOptions {
  originalSnapshotPath?: string;
  originalTreeHash?: string;
  emptyTreeHash?: string;
}

/** One external fact of a Turn, applied in order exactly as the matching record* method would. */
export type ExternalFactOperation =
  | { kind: 'file'; path: string; action: 'created' | 'modified' | 'deleted'; options?: ExternalFactOptions }
  | { kind: 'directory'; path: string; action: 'created' | 'deleted' | 'present' | 'replaced_by_file'; options?: ExternalDirectoryFactOptions }
  | { kind: 'unrecoverable'; change: UnrecoverableExternalChange };

export interface FileChangeRecord {
  filePath: string;
  action: 'create' | 'modify' | 'delete';
  isDirectory: boolean;
  /** 轮初与轮后路径类型分开记录，支持同一 Turn 内 file↔directory 替换。 */
  originalKind?: 'absent' | 'file' | 'directory';
  newKind?: 'absent' | 'file' | 'directory';
  /** F2：外部变化无原始内容可恢复（基线未覆盖）时为 true；undo 保留现场并如实报告。 */
  unrecoverable?: boolean;
  originalHash?: string;
  /** 原始文件工件来自直接工具的 pre-mutation，或更早的 Shell-entry baseline。 */
  originalArtifactRole?: 'original' | 'baseline';
  /** 单文件原始内容 blob（恢复区内路径）。 */
  originalBlobPath?: string;
  /** 目录原始内容快照（恢复区内路径）。 */
  originalSnapshotPath?: string;
  /** 原始目录工件来自直接工具或更早的 Shell-entry baseline。 */
  originalSnapshotRole?: 'original' | 'baseline';
  /**
   * 轮内当前状态快照：路径在本轮内被新建后再次变更/删除时，捕获当时的
   * 实际内容用于恢复；不覆盖 original*（轮初语义）。
   */
  currentStateBlobPath?: string;
  currentStateSnapshotPath?: string;
  currentStateHash?: string;
  /** 目录快照/轮后目录状态的确定性树哈希。 */
  originalTreeHash?: string;
  currentStateTreeHash?: string;
  newTreeHash?: string;
  newHash?: string;
  newBlobPath?: string;
  /** undo 成功后持久化，重启或重复点击不会再次作用于文件系统。 */
  undoAppliedAt?: string;
  timestamp: string;
}

/** 外部（Shell/Git/项目脚本）造成的不可恢复变化标记。 */
export interface UnrecoverableExternalChange {
  path: string;
  kind: 'created' | 'modified' | 'deleted' | 'renamed' | 'outside' | 'too_large' | 'backup_failed';
  reason: string;
}

export interface TurnCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  turnId: string;
  createdAt: string;
  updatedAt: string;
  /** 1 = 文件/目录恢复工件都绑定 turnId + filePath + role。 */
  artifactBindingVersion?: 1 | 2;
  changes: Record<string, FileChangeRecord>;
  /** v3：显式标记为不可恢复的外部变化（不静默遗漏）。 */
  unrecoverable: Record<string, UnrecoverableExternalChange>;
  /** Durable Shell-entry baseline; pending collection makes undo fail closed after a crash. */
  externalBaseline?: PersistedExternalBaseline;
  /** ADR-0335: durable local guard; never grants authority over another root. */
  pairedTransfers?: Record<string, { schemaVersion: 1; path: string; closed: boolean }>;
}

export interface PersistedExternalBaseline {
  schemaVersion: 1;
  frozenAt: string;
  collectionStatus: 'pending' | 'awaiting_confirmation' | 'complete';
  collectedAt?: string;
  undoConfirmationId?: string;
  files: Record<string, { sha256: string; blobPath: string; size: number }>;
  directories: Record<string, { snapshotPath: string; treeHash: string }>;
  skipped: Array<{ path: string; reason: 'too_large' | 'backup_failed' | 'outside'; size?: number; mtimeMs?: number }>;
}

export interface UndoOutcome {
  restored: string[];
  errors: string[];
  /** 撤销时发现文件被外部修改、未覆盖的路径。 */
  drifted: string[];
}

export interface TurnReviewFile {
  path: string; action: FileChangeRecord['action']; originalKind?: FileChangeRecord['originalKind'];
  newKind?: FileChangeRecord['newKind']; undone: boolean; additions: number; deletions: number;
  diffText: string; diffTruncated: boolean;
}

export interface TurnReview {
  turnId: string;
  files: TurnReviewFile[];
  unrecoverable: Array<UnrecoverableExternalChange & { reasonCode?: string }>;
  externalBaselineStatus: 'none' | PersistedExternalBaseline['collectionStatus'];
}

class CheckpointDriftError extends Error {}

export class CheckpointManager {
  private readonly checkpoints = new Map<string, TurnCheckpoint>();
  /** A9-61: one cooperative cold load per Turn; concurrent readers share it. */
  private readonly checkpointLoads = new Map<string, Promise<TurnCheckpoint | undefined>>();
  /** Incremented whenever cached validation results become untrusted (e.g. new secret material). */
  private cacheGeneration = 0;
  /** Manifest bytes behind a failed cooperative validation; private, never serialized. */
  private readonly failedManifestBytes = new WeakMap<Error, string>();
  private readonly authorizedExternalUndoTurns = new Set<string>();
  private readonly workspaceRoot: string;
  private readonly recoveryRoot: string;
  private readonly blobsRoot: string;
  private readonly snapshotsRoot: string;
  private readonly manifestsRoot: string;
  private readonly containsSensitiveData: (value: string | Buffer) => boolean;
  private recoveryIgnoreChecked = false;
  private readonly recoveryBaseAnchor: DirectoryAnchor | undefined;
  private recoveryIdentityError: WorkspaceError | undefined;
  /** Only directories on the path being used are checked, not the whole store. */
  private readonly recoveryDirectoryAnchors = new Map<string, DirectoryAnchor>();
  private readonly recoveryDiagnostics: Array<{ code: string; detail: string }> = [];
  /** A9-67 F-022: an existing root whose identity could not be resolved is never treated as verified. */
  private readonly rootIdentityError: WorkspaceError | undefined;

  constructor(
    workspaceRoot: string,
    recoveryRoot?: string,
    containsSensitiveData: (value: string | Buffer) => boolean = () => false,
  ) {
    let rootIdentityError: WorkspaceError | undefined;
    try {
      this.workspaceRoot = fs.realpathSync(workspaceRoot);
    } catch (error) {
      this.workspaceRoot = path.resolve(workspaceRoot);
      const code = (error as NodeJS.ErrnoException)?.code;
      // A root that does not exist yet (default workspace, lazily created) keeps the lexical path.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        rootIdentityError = new WorkspaceError('PATH_IDENTITY_UNKNOWN',
          `无法确认工作区根目录的真实位置（${String(code ?? 'UNKNOWN')}）；拒绝按字面路径继续。`);
      }
    }
    this.rootIdentityError = rootIdentityError;
    this.recoveryRoot = recoveryRoot ? path.resolve(recoveryRoot) : path.join(this.workspaceRoot, '.agent_recovery');
    this.blobsRoot = path.join(this.recoveryRoot, 'blobs');
    this.snapshotsRoot = path.join(this.recoveryRoot, 'snapshots');
    this.manifestsRoot = path.join(this.recoveryRoot, 'checkpoints');
    this.containsSensitiveData = containsSensitiveData;
    try {
      this.recoveryBaseAnchor = captureNearestAnchor(this.recoveryRoot, 'Recovery store');
      for (const dir of [this.recoveryRoot, this.blobsRoot, this.snapshotsRoot, this.manifestsRoot, path.join(this.recoveryRoot, 'transfers')]) {
        if (fs.existsSync(dir)) this.recoveryDirectoryAnchors.set(dir, captureAnchor(dir, 'Recovery directory'));
      }
    } catch (error) {
      this.recoveryIdentityError = error instanceof WorkspaceError ? error : identityChanged('Recovery store');
    }
  }

  private assertNotSensitive(value: string | Buffer, label: string): void {
    if (this.containsSensitiveData(value)) {
      throw new Error(`A9_CHECKPOINT_SECRET_BLOCKED: ${label} contains known secret material`);
    }
  }

  getRecoveryRoot(): string {
    return this.recoveryRoot;
  }

  getRecoveryDiagnostics(): Array<{ code: string; detail: string }> {
    return this.recoveryDiagnostics.slice();
  }

  /** Check an existing rule without changing it, or atomically add the default rule. */
  ensureRecoveryIgnore(): void {
    if (this.recoveryIgnoreChecked || !fs.existsSync(this.recoveryRoot)) return;
    this.recoveryIoGuard(this.recoveryRoot).checkInside(this.recoveryRoot);
    this.recoveryIgnoreChecked = true;
    const target = path.join(this.recoveryRoot, '.gitignore');
    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.recoveryDiagnostics.push({ code: 'A9_RECOVERY_GITIGNORE_UNVERIFIED', detail: 'Could not inspect recovery ignore rule' });
        return;
      }
    }
    if (existing) {
      if (!existing.isFile() || existing.size > 4096) {
        this.recoveryDiagnostics.push({ code: 'A9_RECOVERY_GITIGNORE_CUSTOM', detail: 'Existing recovery ignore rule is not the default rule' });
        return;
      }
      try {
        const raw = fs.readFileSync(target);
        const content = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        const rules = content.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
        if (!rules.includes('*') || rules.some((line) => line.startsWith('!'))) {
          this.recoveryDiagnostics.push({ code: 'A9_RECOVERY_GITIGNORE_CUSTOM', detail: 'Existing recovery ignore rule may expose recovery data' });
        }
      } catch (_error) {
        this.recoveryDiagnostics.push({ code: 'A9_RECOVERY_GITIGNORE_UNVERIFIED', detail: 'Could not read recovery ignore rule' });
      }
      return;
    }
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.writeFileSync(temporary, '*\n', { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, target);
    } catch (error) {
      this.recoveryDiagnostics.push({
        code: 'A9_RECOVERY_GITIGNORE_WRITE_FAILED',
        detail: `Could not write recovery ignore rule (${(error as NodeJS.ErrnoException).code || 'unknown'})`,
      });
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_cleanupError) { /* best effort */ }
    }
  }

  /**
   * Captures, in the current synchronous turn and before the first await of an
   * operation, the identity of the workspace root, the recovery store and the
   * nearest existing parent directory of every path the operation touches.
   * The returned guard is consulted right before each later filesystem call.
   */
  createIoGuard(involvedPaths: string[] = []): IoGuard {
    if (this.rootIdentityError) throw this.rootIdentityError;
    // The operation records recovery facts, so the store must exist (and be
    // bound) before any await; creating it is what recordPreMutation does anyway.
    this.ensureRecoveryDir(this.recoveryRoot);
    const anchors: DirectoryAnchor[] = [
      captureAnchor(this.workspaceRoot, '工作区根'),
      captureAnchor(this.recoveryRoot, '恢复区'),
    ];
    for (const involved of involvedPaths) {
      anchors.push(captureNearestAnchor(path.dirname(path.resolve(involved)), '目标父目录'));
    }
    // Resolve namespace anchors at each I/O, including namespaces first created
    // after this guard. IoGuard checks each anchor once; recursively validating
    // four overlapping directory chains here would multiply every tree step.
    return new IoGuard([...anchors, ...[this.blobsRoot, this.snapshotsRoot, this.manifestsRoot, path.join(this.recoveryRoot, 'transfers')]
      .map((dir) => () => this.recoveryDirectoryAnchors.get(dir))]);
  }

  private recoveryDirectoryChain(dir: string): string[] {
    const chain: string[] = [];
    let probe = path.resolve(dir);
    if (!this.isWithin(this.recoveryRoot, probe)) throw identityChanged('Recovery directory', 'OUTSIDE_STORE');
    for (;;) {
      chain.unshift(probe);
      if (probe === this.recoveryRoot) return chain;
      probe = path.dirname(probe);
    }
  }

  private recoveryIoGuard(dir: string): IoGuard {
    if (this.rootIdentityError) throw this.rootIdentityError;
    if (this.recoveryIdentityError) throw this.recoveryIdentityError;
    if (!this.recoveryBaseAnchor) throw identityChanged('Recovery store', 'UNBOUND');
    const anchors = this.recoveryDirectoryChain(dir)
      .map((entry) => this.recoveryDirectoryAnchors.get(entry)).filter((entry): entry is DirectoryAnchor => Boolean(entry));
    return new IoGuard([this.recoveryBaseAnchor, ...anchors]);
  }

  /** Pure validation, including absent directories: no lazy-root creation. */
  validateRecoveryIdentity(): void {
    for (const dir of [this.recoveryRoot, this.manifestsRoot, this.snapshotsRoot, this.blobsRoot, path.join(this.recoveryRoot, 'transfers')]) {
      const guard = this.recoveryIoGuard(dir);
      guard.assertAnchors();
      guard.checkInside(dir);
    }
  }

  private ensureRecoveryDir(dir: string): void {
    // Validate before mkdir as well as before file writes. A later rejection
    // must not leave directories or recovery bytes in a redirected store.
    const guard = this.recoveryIoGuard(dir);
    guard.ensureDirectory(dir);
    for (const entry of this.recoveryDirectoryChain(dir)) {
      const known = this.recoveryDirectoryAnchors.get(entry);
      if (known) assertAnchor(known, 'Recovery directory');
      else this.recoveryDirectoryAnchors.set(entry, captureAnchor(entry, 'Recovery directory'));
    }
    this.ensureRecoveryIgnore();
  }

  getWorkspaceRoot(): string { return this.workspaceRoot; }

  /** Host-only paired-transfer persistence. Writes acknowledge disk, never cache only. */
  setPairedTransfer(turnId: string, transferId: string, relative: string, closed: boolean): void {
    if (!/^transfer-[a-f0-9]{32}$/.test(transferId)) throw new Error('A9_TRANSFER_ID_INVALID');
    this.assertWorkspaceRelativePath(relative, 'paired transfer path');
    this.assertNotSensitive(relative, 'paired transfer path');
    const draft = this.cloneCheckpoint(this.startTurn(turnId));
    const markers = { ...draft.pairedTransfers };
    if (Object.keys(markers).length >= 100 && !markers[transferId]) throw new Error('A9_TRANSFER_LIMIT');
    markers[transferId] = { schemaVersion: 1, path: relative, closed };
    draft.pairedTransfers = markers;
    // Older readers reject v2 before restoring a file. Ordinary manifests stay v1.
    draft.artifactBindingVersion = 2;
    if (closed && draft.changes[relative]) draft.changes[relative].undoAppliedAt = new Date().toISOString();
    this.persist(draft);
    this.checkpoints.set(turnId, draft);
  }

  /** Original bytes come only from this root's validated checkpoint binding. */
  readPairedOriginal(turnId: string, transferId: string, relative: string, sha256: string): Buffer {
    this.validateRecoveryIdentity();
    const checkpoint = this.readValidatedCheckpoint(turnId);
    const marker = checkpoint?.pairedTransfers?.[transferId];
    const record = checkpoint?.changes[relative];
    if (!marker || marker.path !== relative || !record?.originalBlobPath || record.originalHash !== sha256) throw new Error('A9_TRANSFER_BASELINE_INVALID');
    const guard = this.recoveryIoGuard(path.dirname(record.originalBlobPath));
    guard.check(record.originalBlobPath);
    const stat = fs.lstatSync(record.originalBlobPath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('A9_TRANSFER_BASELINE_INVALID');
    guard.check(record.originalBlobPath);
    const bytes = fs.readFileSync(record.originalBlobPath);
    if (bytes.length > 16 * 1024 * 1024 || this.hashBytes(bytes) !== sha256) throw new Error('A9_TRANSFER_BASELINE_INVALID');
    return bytes;
  }

  /** Receipt names are opaque IDs, not paths; guarded by the existing recovery store. */
  writeTransferReceipt(transferId: string, json: string): void {
    if (!/^transfer-[a-f0-9]{32}$/.test(transferId) || Buffer.byteLength(json, 'utf8') > 16384) throw new Error('A9_TRANSFER_RECEIPT_INVALID');
    this.assertNotSensitive(json, 'transfer receipt');
    const dir = path.join(this.recoveryRoot, 'transfers');
    this.ensureRecoveryDir(dir);
    const guard = this.recoveryIoGuard(dir);
    guard.checkInside(dir);
    if (fs.readdirSync(dir).length >= 100 && !fs.existsSync(path.join(dir, transferId + '.json'))) throw new Error('A9_TRANSFER_LIMIT');
    const target = path.join(dir, transferId + '.json');
    guard.check(target);
    if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).nlink !== 1)) throw new Error('A9_TRANSFER_RECEIPT_INVALID');
    const tmp = target + '.tmp-' + crypto.randomBytes(8).toString('hex');
    let fd: number | undefined;
    try {
      guard.check(tmp); fd = fs.openSync(tmp, 'wx');
      guard.check(tmp); fs.writeFileSync(fd, json, 'utf8');
      guard.check(tmp); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      guard.check(target); fs.renameSync(tmp, target);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      guard.check(tmp);
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  readTransferReceipt(transferId: string): string | undefined {
    if (!/^transfer-[a-f0-9]{32}$/.test(transferId)) throw new Error('A9_TRANSFER_ID_INVALID');
    const dir = path.join(this.recoveryRoot, 'transfers');
    const guard = this.recoveryIoGuard(dir);
    guard.checkInside(dir);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 100) throw new Error('A9_TRANSFER_LIMIT');
    const target = path.join(dir, transferId + '.json');
    guard.check(target);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new Error('A9_TRANSFER_RECEIPT_INVALID');
    guard.check(target);
    return fs.readFileSync(target, 'utf8');
  }

  private assertSafeTurnId(turnId: string): void {
    if (!/^[a-zA-Z0-9._-]+$/.test(turnId)) {
      throw new Error(`checkpoint manifest contains unsafe turn id: ${turnId}`);
    }
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }

  private isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  private assertWorkspaceRelativePath(candidate: unknown, label: string): string {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
      throw new Error(`${label} must be a non-empty relative path`);
    }
    if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
      throw new Error(`${label} must stay inside the workspace`);
    }
    const winNormalized = path.win32.normalize(candidate);
    if (winNormalized === '.' || winNormalized === '..' || winNormalized.startsWith('..\\')) {
      throw new Error(`${label} escapes the workspace`);
    }
    const resolved = path.resolve(this.workspaceRoot, candidate);
    if (resolved === path.resolve(this.workspaceRoot) || !this.isWithin(this.workspaceRoot, resolved)) {
      throw new Error(`${label} escapes the workspace`);
    }
    if (this.isWithin(this.recoveryRoot, resolved)) throw new Error(`${label} targets the recovery store`);
    // Resolve the nearest existing ancestor as well, so a junction/symlink in
    // a tampered manifest cannot redirect undo outside the trusted workspace.
    let probe = resolved;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    if (fs.existsSync(probe) && !this.isWithin(fs.realpathSync(this.workspaceRoot), fs.realpathSync(probe))) {
      throw new Error(`${label} resolves outside the workspace`);
    }
    return candidate;
  }

  private assertRecoveryArtifact(candidate: unknown, root: string, label: string, kind: 'file' | 'directory'): string {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
      throw new Error(`${label} must be a recovery artifact path`);
    }
    const resolved = path.resolve(candidate);
    if (!this.isWithin(root, resolved)) throw new Error(`${label} is outside the recovery root`);
    if (!fs.existsSync(resolved)) throw new Error(`${label} is missing from the recovery root`);
    const canonicalRoot = fs.realpathSync(root);
    const canonicalArtifact = fs.realpathSync(resolved);
    if (!this.isWithin(canonicalRoot, canonicalArtifact)) {
      throw new Error(`${label} resolves outside the recovery root`);
    }
    const stat = fs.statSync(canonicalArtifact);
    if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())) {
      throw new Error(`${label} has the wrong artifact type`);
    }
    return canonicalArtifact;
  }

  private validateBlob(candidate: unknown, expectedHash: unknown, label: string): void {
    const blobPath = this.assertRecoveryArtifact(candidate, this.blobsRoot, label, 'file');
    const name = path.basename(blobPath);
    if (!/^[a-f0-9]{64}$/.test(name) || path.basename(path.dirname(blobPath)) !== name.slice(0, 2)) {
      throw new Error(`${label} is not a content-addressed blob path`);
    }
    if (expectedHash !== undefined && (typeof expectedHash !== 'string' || expectedHash !== name)) {
      throw new Error(`${label} does not match its declared SHA-256`);
    }
    if (this.hashFile(blobPath) !== name) throw new Error(`${label} content SHA-256 mismatch`);
  }

  private fileSnapshotPath(turnId: string, relPath: string, role: 'baseline' | 'original' | 'current' | 'new'): string {
    return path.join(this.snapshotsRoot, turnId, this.hashBytes(Buffer.from(relPath, 'utf8')), `${role}.bin`);
  }

  private storeBoundFile(
    content: Buffer,
    turnId: string,
    relPath: string,
    role: 'baseline' | 'original' | 'current' | 'new',
  ): string {
    this.assertSafeTurnId(turnId);
    this.assertNotSensitive(relPath, 'checkpoint path');
    this.assertNotSensitive(content, 'checkpoint file content');
    const target = this.fileSnapshotPath(turnId, relPath, role);
    this.ensureRecoveryDir(path.dirname(target));
    // A Turn-entry baseline is immutable. A later tool mutation in the same
    // Turn must not replace it with an already-modified intermediate state.
    if ((role === 'baseline' || role === 'original') && fs.existsSync(target)) return target;
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, content);
    if (this.hashBytes(fs.readFileSync(tmp)) !== this.hashBytes(content)) {
      fs.unlinkSync(tmp);
      throw new Error(`文件快照完整性校验失败: ${relPath}`);
    }
    fs.renameSync(tmp, target);
    return target;
  }

  private validateBoundFile(
    candidate: unknown,
    expectedHash: unknown,
    turnId: string,
    relPath: string,
    role: 'baseline' | 'original' | 'current' | 'new',
    label: string,
  ): void {
    const artifact = this.assertRecoveryArtifact(candidate, this.snapshotsRoot, label, 'file');
    const expectedPath = fs.realpathSync(this.fileSnapshotPath(turnId, relPath, role));
    if (artifact !== expectedPath) throw new Error(`${label} is not bound to its turn, file path and role`);
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error(`${label} content SHA-256 mismatch`);
    }
    // Hash and secret-scan the same bytes: one read, identical checks.
    const content = fs.readFileSync(artifact);
    if (this.hashBytes(content) !== expectedHash) throw new Error(`${label} content SHA-256 mismatch`);
    this.assertNotSensitive(content, `${label} content`);
  }

  private assertSnapshotNotSensitive(root: string, label: string): void {
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        this.assertNotSensitive(entry.name, `${label} path`);
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) this.assertNotSensitive(fs.readFileSync(full), `${label} content`);
      }
    }
  }

  private snapshotPath(turnId: string, relPath: string, role: 'baseline' | 'original' | 'current'): string {
    return path.join(this.snapshotsRoot, turnId, this.hashBytes(Buffer.from(relPath, 'utf8')), `${role}.dir`);
  }

  /** Shell 基线只保存目录存在性；文件内容由独立 file facts 保存，避免递归重复复制。 */
  saveEmptyDirectoryBaseline(turnId: string, relPath: string): { snapshotPath: string; treeHash: string } {
    this.assertSafeTurnId(turnId);
    this.assertWorkspaceRelativePath(relPath, 'directory baseline path');
    const target = this.snapshotPath(turnId, relPath, 'baseline');
    this.ensureRecoveryDir(path.dirname(target));
    if (fs.existsSync(target)) return { snapshotPath: target, treeHash: this.hashDirectoryTree(target) };
    fs.mkdirSync(target);
    return { snapshotPath: target, treeHash: this.hashDirectoryTree(target) };
  }

  emptyDirectoryTreeHash(): string {
    return crypto.createHash('sha256').update('D\0.\0').digest('hex');
  }

  private artifactMatches(target: string, isDirectory: boolean, expectedHash: string | undefined): boolean {
    if (!expectedHash || !fs.existsSync(target)) return false;
    const stat = fs.lstatSync(target);
    if (stat.isDirectory() !== isDirectory) return false;
    return isDirectory
      ? this.hashDirectoryTree(target) === expectedHash
      : stat.isFile() && this.hashFile(target) === expectedHash;
  }

  private restoreSwapPaths(checkpoint: TurnCheckpoint, relPath: string): {
    stage: string; backup: string; stageCleanup: string; backupCleanup: string;
  } {
    const identity = this.hashBytes(Buffer.from(relPath, 'utf8'));
    const swapRoot = path.join(this.recoveryRoot, 'undo-staging', checkpoint.turnId);
    return {
      stage: path.join(swapRoot, `${identity}.stage`),
      backup: path.join(swapRoot, `${identity}.backup`),
      stageCleanup: path.join(swapRoot, `${identity}.stage.cleanup`),
      backupCleanup: path.join(swapRoot, `${identity}.backup.cleanup`),
    };
  }

  /** Move a recovery artifact to a deterministic quarantine, then revalidate the moved object before deletion. */
  private cleanupSwapArtifactAtomically(
    source: string,
    quarantine: string,
    expectedKind: 'file' | 'directory',
    expectedHash: string,
  ): void {
    if (fs.existsSync(quarantine)) {
      if (fs.existsSync(source)) throw new CheckpointDriftError('恢复清理同时存在源对象与隔离对象，拒绝删除');
      if (!this.artifactMatches(quarantine, expectedKind === 'directory', expectedHash)) {
        throw new CheckpointDriftError('恢复清理隔离对象身份不匹配，已保留现场');
      }
      fs.rmSync(quarantine, { recursive: true, force: true });
      return;
    }
    if (!fs.existsSync(source)) return;
    fs.renameSync(source, quarantine);
    if (!this.artifactMatches(quarantine, expectedKind === 'directory', expectedHash)) {
      if (!fs.existsSync(source)) fs.renameSync(quarantine, source);
      throw new CheckpointDriftError('恢复清理对象在隔离后身份不匹配，已恢复现场');
    }
    fs.rmSync(quarantine, { recursive: true, force: true });
  }

  private hasPendingRestoreSwap(checkpoint: TurnCheckpoint, relPath: string): boolean {
    const paths = this.restoreSwapPaths(checkpoint, relPath);
    return fs.existsSync(paths.backup) || fs.existsSync(paths.backupCleanup);
  }

  /**
   * 撤销“轮内新建”时先把目标原子移入恢复区，再对被移动对象复核。
   * 这样外部写入无法在哈希检查与删除之间替换目标而被误删。
   */
  private removeCreatedArtifactAtomically(
    checkpoint: TurnCheckpoint,
    relPath: string,
    expectedKind: 'file' | 'directory',
    expectedHash: string,
  ): void {
    const absPath = path.resolve(this.workspaceRoot, relPath);
    const { backup } = this.restoreSwapPaths(checkpoint, relPath);
    this.ensureRecoveryDir(path.dirname(backup));

    // 崩溃发生在 target→backup 后：只删除仍与轮后身份一致的隔离对象。
    if (fs.existsSync(backup)) {
      if (fs.existsSync(absPath)) {
        throw new CheckpointDriftError('撤销删除存在未决隔离对象且目标已被重建，拒绝继续');
      }
      if (!this.artifactMatches(backup, expectedKind === 'directory', expectedHash)) {
        fs.renameSync(backup, absPath);
        throw new CheckpointDriftError('隔离对象与轮后身份不一致，已恢复现场');
      }
      fs.rmSync(backup, { recursive: true, force: true });
      return;
    }

    if (!fs.existsSync(absPath)) return;
    fs.renameSync(absPath, backup);
    if (!this.artifactMatches(backup, expectedKind === 'directory', expectedHash)) {
      if (!fs.existsSync(absPath)) fs.renameSync(backup, absPath);
      throw new CheckpointDriftError('目标在撤销删除前发生变化，已恢复现场');
    }
    fs.rmSync(backup, { recursive: true, force: true });
  }

  /**
   * 先在恢复区完成并校验副本，再以同卷 rename 交换目标。复制失败不会先
   * 删除/截断用户当前状态；遗留 backup/stage 允许崩溃后的下一次 undo 收敛。
   */
  private restoreArtifactAtomically(
    checkpoint: TurnCheckpoint,
    relPath: string,
    source: string,
    isDirectory: boolean,
    expectedHash: string,
    expectedCurrent: { kind: 'absent' } | { kind: 'file' | 'directory'; hash: string },
  ): void {
    const absPath = path.resolve(this.workspaceRoot, relPath);
    const { stage, backup, stageCleanup, backupCleanup } = this.restoreSwapPaths(checkpoint, relPath);
    const swapRoot = path.dirname(stage);
    this.ensureRecoveryDir(swapRoot);

    if (fs.existsSync(backupCleanup) && !fs.existsSync(absPath)) {
      throw new CheckpointDriftError('恢复清理隔离对象存在但已恢复目标消失，拒绝继续');
    }

    // 上次已完成交换但尚未来得及持久化 undoAppliedAt。
    if (this.artifactMatches(absPath, isDirectory, expectedHash)) {
      this.cleanupSwapArtifactAtomically(stage, stageCleanup, isDirectory ? 'directory' : 'file', expectedHash);
      if (expectedCurrent.kind === 'absent') {
        if (fs.existsSync(backup) || fs.existsSync(backupCleanup)) {
          throw new CheckpointDriftError('已恢复目标旁存在不应出现的未决备份，拒绝删除');
        }
      } else {
        this.cleanupSwapArtifactAtomically(backup, backupCleanup, expectedCurrent.kind, expectedCurrent.hash);
      }
      return;
    }
    if (fs.existsSync(backupCleanup)) {
      throw new CheckpointDriftError('恢复清理隔离对象存在但目标不是已验证原始状态，拒绝继续');
    }

    // 上次在 target→backup 与 stage→target 之间崩溃：优先完成已校验 stage；
    // stage 不完整则把原目标放回，绝不把半成品暴露为恢复成功。
    if (fs.existsSync(backup) && !fs.existsSync(absPath)) {
      if (expectedCurrent.kind === 'absent'
        || !this.artifactMatches(backup, expectedCurrent.kind === 'directory', expectedCurrent.hash)) {
        fs.renameSync(backup, absPath);
        throw new CheckpointDriftError('未决备份与轮后目标身份不一致，已恢复现场并拒绝继续');
      }
      if (this.artifactMatches(stage, isDirectory, expectedHash)) {
        fs.renameSync(stage, absPath);
        this.cleanupSwapArtifactAtomically(backup, backupCleanup, expectedCurrent.kind, expectedCurrent.hash);
        return;
      }
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      fs.renameSync(backup, absPath);
      throw new Error('检测到未完成的上次恢复；已还原撤销前状态，请重试');
    }
    if (fs.existsSync(backup)) {
      throw new Error(`恢复交换存在未决备份，拒绝覆盖当前目标: ${backup}`);
    }

    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    try {
      if (isDirectory) fs.cpSync(source, stage, { recursive: true });
      else {
        this.ensureRecoveryDir(path.dirname(stage));
        fs.copyFileSync(source, stage);
      }
      if (!this.artifactMatches(stage, isDirectory, expectedHash)) {
        throw new Error('恢复 staging 完整性校验失败');
      }
    } catch (error) {
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      throw error;
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const hadTarget = fs.existsSync(absPath);
    const currentChanged = expectedCurrent.kind === 'absent'
      ? hadTarget
      : !hadTarget || !this.artifactMatches(absPath, expectedCurrent.kind === 'directory', expectedCurrent.hash);
    if (currentChanged) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw new CheckpointDriftError('目标在恢复 staging 期间发生变化，拒绝覆盖');
    }
    let originalMoved = false;
    let stageInstalled = false;
    try {
      if (hadTarget) {
        fs.renameSync(absPath, backup);
        originalMoved = true;
        // 以被原子移走的对象为准再次校验，关闭“哈希通过后、rename 前”
        // 的 TOCTOU。校验失败时绝不安装旧快照。
        if (expectedCurrent.kind === 'absent'
          || !this.artifactMatches(backup, expectedCurrent.kind === 'directory', expectedCurrent.hash)) {
          throw new CheckpointDriftError('目标在恢复交换前发生变化，拒绝覆盖');
        }
      }
      if (fs.existsSync(absPath)) {
        throw new CheckpointDriftError('目标在恢复交换期间被重建，拒绝覆盖');
      }
      fs.renameSync(stage, absPath);
      stageInstalled = true;
      if (!this.artifactMatches(absPath, isDirectory, expectedHash)) {
        throw new Error('恢复后的目标完整性校验失败');
      }
    } catch (error) {
      // Remove only the object installed by this attempt. Preserve an object
      // that another actor replaced after installation.
      if (stageInstalled && fs.existsSync(absPath)
        && this.artifactMatches(absPath, isDirectory, expectedHash)) {
        fs.rmSync(absPath, { recursive: true, force: true });
      }
      if (originalMoved && fs.existsSync(backup) && !fs.existsSync(absPath)) fs.renameSync(backup, absPath);
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
    if (fs.existsSync(backup)) {
      if (expectedCurrent.kind === 'absent') {
        throw new CheckpointDriftError('恢复完成后备份身份发生变化，拒绝删除');
      }
      this.cleanupSwapArtifactAtomically(backup, backupCleanup, expectedCurrent.kind, expectedCurrent.hash);
    }
  }

  private validateCheckpoint(parsed: unknown, requestedTurnId: string): TurnCheckpoint {
    const steps = this.validateCheckpointSteps(parsed, requestedTurnId);
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
    }
  }

  /** Runs the same validation steps, yielding the event loop between bounded slices. */
  private async validateCheckpointCooperatively(parsed: unknown, requestedTurnId: string): Promise<TurnCheckpoint> {
    const steps = this.validateCheckpointSteps(parsed, requestedTurnId);
    const slice = new CooperativeSlice();
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
      await slice.step();
    }
  }

  /**
   * The single manifest validation implementation (A9-61). Each `yield` only
   * marks a boundary between independently validated entries; both the
   * synchronous and the cooperative drivers execute every check in order.
   */
  private *validateCheckpointSteps(parsed: unknown, requestedTurnId: string): Generator<void, TurnCheckpoint, void> {
    if (!this.isPlainRecord(parsed)) throw new Error('checkpoint manifest must be an object');
    if (Number(parsed.schemaVersion) !== CHECKPOINT_SCHEMA_VERSION) {
      throw new Error(`checkpoint manifest schema mismatch for ${requestedTurnId}`);
    }
    if (parsed.turnId !== requestedTurnId) throw new Error(`checkpoint manifest turn mismatch for ${requestedTurnId}`);
    if (parsed.artifactBindingVersion !== 1 && parsed.artifactBindingVersion !== 2) {
      throw new Error(`checkpoint manifest artifact binding is missing or unsupported for ${requestedTurnId}`);
    }
    this.assertSafeTurnId(requestedTurnId);
    for (const field of ['createdAt', 'updatedAt']) {
      const value = parsed[field];
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
        throw new Error(`checkpoint manifest ${field} is invalid`);
      }
    }
    if ((parsed.artifactBindingVersion === 2) !== (parsed.pairedTransfers !== undefined)) {
      throw new Error('A9_TRANSFER_METADATA_VERSION_INVALID');
    }
    if (parsed.pairedTransfers !== undefined) {
      if (!this.isPlainRecord(parsed.pairedTransfers) || Object.keys(parsed.pairedTransfers).length < 1 || Object.keys(parsed.pairedTransfers).length > 100) throw new Error('A9_TRANSFER_METADATA_INVALID');
      for (const [id, marker] of Object.entries(parsed.pairedTransfers)) {
        if (!/^transfer-[a-f0-9]{32}$/.test(id) || !this.isPlainRecord(marker)
          || Object.keys(marker).sort().join(',') !== 'closed,path,schemaVersion'
          || marker.schemaVersion !== 1 || typeof marker.closed !== 'boolean') throw new Error('A9_TRANSFER_METADATA_INVALID');
        const relative = this.assertWorkspaceRelativePath(marker.path, 'paired transfer path');
        this.assertNotSensitive(relative, 'paired transfer path');
        if (!this.isPlainRecord(parsed.changes) || !Object.prototype.hasOwnProperty.call(parsed.changes, relative)) throw new Error('A9_TRANSFER_METADATA_INVALID');
      }
    }
    if (!this.isPlainRecord(parsed.changes)) throw new Error('checkpoint manifest changes must be an object');
    const changes: Record<string, FileChangeRecord> = Object.create(null);
    for (const [key, raw] of Object.entries(parsed.changes)) {
      if (!this.isPlainRecord(raw)) throw new Error(`checkpoint change ${key} must be an object`);
      const filePath = this.assertWorkspaceRelativePath(raw.filePath, `checkpoint change ${key}.filePath`);
      this.assertNotSensitive(filePath, `checkpoint change ${key}.filePath`);
      if (filePath !== key) throw new Error(`checkpoint change key does not match filePath: ${key}`);
      if (!['create', 'modify', 'delete'].includes(String(raw.action))) throw new Error(`checkpoint change ${key} has invalid action`);
      if (typeof raw.isDirectory !== 'boolean') throw new Error(`checkpoint change ${key} has invalid isDirectory`);
      for (const kindField of ['originalKind', 'newKind']) {
        if (raw[kindField] !== undefined && !['absent', 'file', 'directory'].includes(String(raw[kindField]))) {
          throw new Error(`checkpoint change ${key}.${kindField} is invalid`);
        }
      }
      if (typeof raw.timestamp !== 'string' || !Number.isFinite(Date.parse(raw.timestamp))) {
        throw new Error(`checkpoint change ${key} has invalid timestamp`);
      }
      if (raw.unrecoverable !== undefined && typeof raw.unrecoverable !== 'boolean') {
        throw new Error(`checkpoint change ${key} has invalid unrecoverable flag`);
      }
      for (const hashField of ['originalHash', 'currentStateHash', 'newHash', 'originalTreeHash', 'currentStateTreeHash', 'newTreeHash']) {
        const value = raw[hashField];
        if (value !== undefined && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
          throw new Error(`checkpoint change ${key}.${hashField} is invalid`);
        }
      }
      if (raw.originalArtifactRole !== undefined && !['original', 'baseline'].includes(String(raw.originalArtifactRole))) {
        throw new Error(`checkpoint change ${key}.originalArtifactRole is invalid`);
      }
      if (raw.originalSnapshotRole !== undefined && !['original', 'baseline'].includes(String(raw.originalSnapshotRole))) {
        throw new Error(`checkpoint change ${key}.originalSnapshotRole is invalid`);
      }
      if (raw.undoAppliedAt !== undefined && (typeof raw.undoAppliedAt !== 'string' || !Number.isFinite(Date.parse(raw.undoAppliedAt)))) {
        throw new Error(`checkpoint change ${key}.undoAppliedAt is invalid`);
      }
      const originalKind = raw.originalKind ?? (raw.action === 'create' ? 'absent' : raw.isDirectory ? 'directory' : 'file');
      const newKind = raw.newKind ?? (raw.action === 'delete' ? 'absent' : raw.isDirectory ? 'directory' : 'file');
      if (originalKind === 'absent' && (raw.originalBlobPath !== undefined || raw.originalHash !== undefined
          || raw.originalSnapshotPath !== undefined || raw.originalTreeHash !== undefined)
        || originalKind === 'directory' && (raw.originalBlobPath !== undefined || raw.originalHash !== undefined)
        || originalKind === 'file' && (raw.originalSnapshotPath !== undefined || raw.originalTreeHash !== undefined)) {
        throw new Error(`checkpoint change ${key} mixes original directory and file artifacts`);
      }
      if (newKind === 'absent' && (raw.newBlobPath !== undefined || raw.newHash !== undefined || raw.newTreeHash !== undefined)
        || newKind === 'directory' && (raw.newBlobPath !== undefined || raw.newHash !== undefined)
        || newKind === 'file' && raw.newTreeHash !== undefined) {
        throw new Error(`checkpoint change ${key} mixes new directory and file artifacts`);
      }
      const bound = true;
      if (raw.originalBlobPath !== undefined) {
        const role = raw.originalArtifactRole === 'baseline' ? 'baseline' : 'original';
        if (bound) this.validateBoundFile(raw.originalBlobPath, raw.originalHash, requestedTurnId, filePath, role, `checkpoint change ${key}.originalBlobPath`);
        else this.validateBlob(raw.originalBlobPath, raw.originalHash, `checkpoint change ${key}.originalBlobPath`);
      }
      if (raw.newBlobPath !== undefined) {
        if (bound) this.validateBoundFile(raw.newBlobPath, raw.newHash, requestedTurnId, filePath, 'new', `checkpoint change ${key}.newBlobPath`);
        else this.validateBlob(raw.newBlobPath, raw.newHash, `checkpoint change ${key}.newBlobPath`);
      }
      if (raw.currentStateBlobPath !== undefined) {
        if (bound) this.validateBoundFile(raw.currentStateBlobPath, raw.currentStateHash, requestedTurnId, filePath, 'current', `checkpoint change ${key}.currentStateBlobPath`);
        else this.validateBlob(raw.currentStateBlobPath, raw.currentStateHash, `checkpoint change ${key}.currentStateBlobPath`);
      }
      for (const snapshotField of ['originalSnapshotPath', 'currentStateSnapshotPath']) {
        if (raw[snapshotField] !== undefined) {
          const snapshotPath = this.assertRecoveryArtifact(raw[snapshotField], this.snapshotsRoot, `checkpoint change ${key}.${snapshotField}`, 'directory');
          this.assertSnapshotNotSensitive(snapshotPath, `checkpoint change ${key}.${snapshotField}`);
          if (bound) {
            const role = snapshotField === 'originalSnapshotPath'
              ? (raw.originalSnapshotRole === 'baseline' ? 'baseline' : 'original')
              : 'current';
            const expectedSnapshotPath = fs.realpathSync(this.snapshotPath(requestedTurnId, filePath, role));
            if (snapshotPath !== expectedSnapshotPath) {
              throw new Error(`checkpoint change ${key}.${snapshotField} is not bound to its turn and file path`);
            }
          }
          const expectedTreeHash = snapshotField === 'originalSnapshotPath' ? raw.originalTreeHash : raw.currentStateTreeHash;
          if (expectedTreeHash !== undefined && this.hashDirectoryTree(snapshotPath) !== expectedTreeHash) {
            throw new Error(`checkpoint change ${key}.${snapshotField} tree SHA-256 mismatch`);
          }
        }
      }
      changes[key] = {
        ...(raw as unknown as FileChangeRecord),
        originalKind: originalKind as FileChangeRecord['originalKind'],
        newKind: newKind as FileChangeRecord['newKind'],
      };
      yield;
    }
    const unrecoverable = parsed.unrecoverable === undefined ? {} : parsed.unrecoverable;
    if (!this.isPlainRecord(unrecoverable)) throw new Error('checkpoint manifest unrecoverable must be an object');
    const normalizedUnrecoverable: Record<string, UnrecoverableExternalChange> = Object.create(null);
    for (const [key, raw] of Object.entries(unrecoverable)) {
      if (!this.isPlainRecord(raw) || raw.path !== key || typeof raw.reason !== 'string' || raw.reason.length === 0
        || !['created', 'modified', 'deleted', 'renamed', 'outside', 'too_large', 'backup_failed'].includes(String(raw.kind))) {
        throw new Error(`checkpoint unrecoverable entry is invalid: ${key}`);
      }
      if (raw.kind !== 'outside') this.assertWorkspaceRelativePath(raw.path, `checkpoint unrecoverable ${key}.path`);
      this.assertNotSensitive(raw.path, `checkpoint unrecoverable ${key}.path`);
      this.assertNotSensitive(raw.reason, `checkpoint unrecoverable ${key}.reason`);
      normalizedUnrecoverable[key] = raw as unknown as UnrecoverableExternalChange;
      yield;
    }
    let externalBaseline: PersistedExternalBaseline | undefined;
    if (parsed.externalBaseline !== undefined) {
      const baseline = parsed.externalBaseline;
      if (!this.isPlainRecord(baseline) || baseline.schemaVersion !== 1
        || !['pending', 'awaiting_confirmation', 'complete'].includes(String(baseline.collectionStatus))
        || typeof baseline.frozenAt !== 'string' || !Number.isFinite(Date.parse(baseline.frozenAt))
        || (baseline.collectedAt !== undefined
          && (typeof baseline.collectedAt !== 'string' || !Number.isFinite(Date.parse(baseline.collectedAt))))
        || (baseline.undoConfirmationId !== undefined
          && (typeof baseline.undoConfirmationId !== 'string' || !/^undo-[a-f0-9]{32}$/.test(baseline.undoConfirmationId)))
        || (baseline.collectionStatus === 'awaiting_confirmation') !== (baseline.undoConfirmationId !== undefined)
        || !this.isPlainRecord(baseline.files) || !this.isPlainRecord(baseline.directories)
        || !Array.isArray(baseline.skipped)) {
        throw new Error('checkpoint external baseline is invalid');
      }
      const files: PersistedExternalBaseline['files'] = Object.create(null);
      for (const [relPath, raw] of Object.entries(baseline.files)) {
        if (!this.isPlainRecord(raw) || raw.size === undefined || !Number.isSafeInteger(raw.size) || Number(raw.size) < 0) {
          throw new Error(`checkpoint external baseline file is invalid: ${relPath}`);
        }
        this.assertWorkspaceRelativePath(relPath, 'checkpoint external baseline file path');
        this.assertNotSensitive(relPath, 'checkpoint external baseline file path');
        this.validateBoundFile(raw.blobPath, raw.sha256, requestedTurnId, relPath, 'baseline', 'checkpoint external baseline file');
        files[relPath] = raw as unknown as PersistedExternalBaseline['files'][string];
        yield;
      }
      const directories: PersistedExternalBaseline['directories'] = Object.create(null);
      for (const [relPath, raw] of Object.entries(baseline.directories)) {
        if (!this.isPlainRecord(raw)) throw new Error(`checkpoint external baseline directory is invalid: ${relPath}`);
        this.assertWorkspaceRelativePath(relPath, 'checkpoint external baseline directory path');
        this.assertNotSensitive(relPath, 'checkpoint external baseline directory path');
        const artifact = this.assertRecoveryArtifact(raw.snapshotPath, this.snapshotsRoot, 'checkpoint external baseline directory', 'directory');
        const expectedPath = fs.realpathSync(this.snapshotPath(requestedTurnId, relPath, 'baseline'));
        if (artifact !== expectedPath || typeof raw.treeHash !== 'string'
          || this.hashDirectoryTree(artifact) !== raw.treeHash) {
          throw new Error(`checkpoint external baseline directory binding is invalid: ${relPath}`);
        }
        this.assertSnapshotNotSensitive(artifact, 'checkpoint external baseline directory');
        directories[relPath] = raw as unknown as PersistedExternalBaseline['directories'][string];
        yield;
      }
      const skipped: PersistedExternalBaseline['skipped'] = [];
      for (const raw of baseline.skipped as unknown[]) {
        if (!this.isPlainRecord(raw) || typeof raw.path !== 'string'
          || !['too_large', 'backup_failed', 'outside'].includes(String(raw.reason))) {
          throw new Error('checkpoint external baseline skipped fact is invalid');
        }
        this.assertWorkspaceRelativePath(raw.path, 'checkpoint external baseline skipped path');
        this.assertNotSensitive(raw.path, 'checkpoint external baseline skipped path');
        skipped.push(raw as unknown as PersistedExternalBaseline['skipped'][number]);
        yield;
      }
      externalBaseline = {
        ...(baseline as unknown as PersistedExternalBaseline), files, directories, skipped,
      };
    }
    return {
      ...(parsed as unknown as TurnCheckpoint),
      changes,
      unrecoverable: normalizedUnrecoverable,
      ...(externalBaseline ? { externalBaseline } : {}),
    };
  }

  private manifestPath(turnId: string): string {
    this.assertSafeTurnId(turnId);
    return path.join(this.manifestsRoot, `${turnId}.json`);
  }

  /** 加载（含崩溃后恢复）：优先内存，其次磁盘清单。 */
  loadCheckpoint(turnId: string): TurnCheckpoint | undefined {
    this.validateRecoveryIdentity();
    const memory = this.checkpoints.get(turnId);
    if (memory) return memory;
    const parsed = this.readValidatedCheckpoint(turnId);
    if (parsed) this.checkpoints.set(turnId, parsed);
    return parsed;
  }

  /** 从磁盘读取并完整校验清单，不写入缓存；清单不存在返回 undefined。 */
  private readValidatedCheckpoint(turnId: string): TurnCheckpoint | undefined {
    const manifestPath = this.manifestPath(turnId);
    if (!fs.existsSync(manifestPath)) return undefined;
    try {
      return this.validateCheckpoint(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), turnId);
    } catch (err) {
      throw new Error(`无法读取 Checkpoint 清单 ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Cooperative variant of readValidatedCheckpoint: same checks and errors; returns the bytes it validated. */
  private async readValidatedCheckpointCooperatively(turnId: string): Promise<{ raw: string; checkpoint: TurnCheckpoint } | undefined> {
    this.validateRecoveryIdentity();
    const manifestPath = this.manifestPath(turnId);
    if (!fs.existsSync(manifestPath)) return undefined;
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(manifestPath, 'utf8');
      return { raw, checkpoint: await this.validateCheckpointCooperatively(JSON.parse(raw), turnId) };
    } catch (err) {
      // Same message as readValidatedCheckpoint. The validated bytes are remembered privately
      // (never on the error object, which callers may serialize) for the stale-read retry.
      const failure = new Error(`无法读取 Checkpoint 清单 ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
      if (raw !== undefined) this.failedManifestBytes.set(failure, raw);
      throw failure;
    }
  }

  /**
   * A9-61: responsive cold load for startup recovery, Diff and Undo. Performs
   * the complete synchronous validation in yielded slices. The cache is
   * populated only after every check passed and only if neither the manifest
   * bytes nor the trusted secret generation changed meanwhile; a synchronous
   * load or mutation that completed first stays authoritative. Concurrent
   * callers for one Turn share a single validation.
   */
  loadCheckpointAsync(turnId: string): Promise<TurnCheckpoint | undefined> {
    try { this.validateRecoveryIdentity(); } catch (error) { return Promise.reject(error); }
    const memory = this.checkpoints.get(turnId);
    if (memory) return Promise.resolve(memory);
    try {
      this.manifestPath(turnId);
    } catch (error) {
      return Promise.reject(error);
    }
    const inflight = this.checkpointLoads.get(turnId);
    if (inflight) return inflight;
    const currentBytes = (): string | undefined => {
      try {
        return fs.readFileSync(this.manifestPath(turnId), 'utf8');
      } catch (_error) {
        return undefined;
      }
    };
    const load = (async () => {
      try {
        for (let attempt = 0; attempt < COOPERATIVE_LOAD_ATTEMPTS; attempt += 1) {
          const memory = this.checkpoints.get(turnId);
          if (memory) return memory;
          const generation = this.cacheGeneration;
          let loaded: { raw: string; checkpoint: TurnCheckpoint } | undefined;
          try {
            loaded = await this.readValidatedCheckpointCooperatively(turnId);
          } catch (error) {
            // A writer that replaced the manifest (and its mutable artifacts) while this
            // validation ran must not turn into a false rejection: validate the new bytes.
            // Stable invalid bytes still fail closed with the synchronous error.
            const raw = error instanceof Error ? this.failedManifestBytes.get(error) : undefined;
            if (raw !== undefined && attempt + 1 < COOPERATIVE_LOAD_ATTEMPTS && currentBytes() !== raw) continue;
            throw error;
          }
          const settled = this.checkpoints.get(turnId);
          if (settled) return settled;
          if (!loaded) return undefined;
          if (generation === this.cacheGeneration && currentBytes() === loaded.raw) {
            this.checkpoints.set(turnId, loaded.checkpoint);
            return loaded.checkpoint;
          }
          // Validated bytes or trust inputs are stale: never promote them.
        }
        return this.loadCheckpoint(turnId);
      } finally {
        this.checkpointLoads.delete(turnId);
      }
    })();
    this.checkpointLoads.set(turnId, load);
    return load;
  }

  /**
   * 返回崩溃时尚未完成轮后收集的 Shell 基线。返回副本，调用方不能修改
   * CheckpointManager 内部状态；清单仍须先通过完整的路径与工件绑定校验。
   */
  getPendingExternalBaseline(turnId: string): PersistedExternalBaseline | undefined {
    const baseline = this.loadCheckpoint(turnId)?.externalBaseline;
    if (!baseline || baseline.collectionStatus !== 'pending') return undefined;
    return {
      ...baseline,
      files: Object.fromEntries(Object.entries(baseline.files).map(([key, value]) => [key, { ...value }])),
      directories: Object.fromEntries(Object.entries(baseline.directories).map(([key, value]) => [key, { ...value }])),
      skipped: baseline.skipped.map((item) => ({ ...item })),
    };
  }

  getExternalUndoConfirmation(turnId: string): string | undefined {
    const baseline = this.loadCheckpoint(turnId)?.externalBaseline;
    return baseline?.collectionStatus === 'awaiting_confirmation' ? baseline.undoConfirmationId : undefined;
  }

  confirmExternalUndo(turnId: string, confirmationId: string): boolean {
    const checkpoint = this.loadCheckpoint(turnId);
    const baseline = checkpoint?.externalBaseline;
    if (!checkpoint || baseline?.collectionStatus !== 'awaiting_confirmation'
      || baseline.undoConfirmationId !== confirmationId) return false;
    // Consume the presented identity before touching user files, but keep the
    // durable state awaiting confirmation with a rotated identity. A crash
    // during undo therefore returns to preview-only behavior after restart.
    baseline.undoConfirmationId = `undo-${crypto.randomBytes(16).toString('hex')}`;
    this.persist(checkpoint);
    this.authorizedExternalUndoTurns.add(turnId);
    return true;
  }

  listPersistedTurns(): string[] {
    if (!fs.existsSync(this.manifestsRoot)) return [];
    return fs
      .readdirSync(this.manifestsRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5));
  }

  /**
   * 重新按当前已知秘密集合验证所有持久化 Turn；用于 Provider 密钥轮换后 fail-closed。
   * 校验结果不写入缓存，避免一次全量复核让全部历史清单常驻内存；之后按需重新加载。
   */
  revalidatePersistedTurns(): void {
    this.checkpoints.clear();
    this.cacheGeneration += 1;
    const turnIds = this.listPersistedTurns();
    for (const turnId of turnIds) {
      try {
        this.readValidatedCheckpoint(turnId);
      } catch (error) {
        if (error instanceof Error && error.message.includes('A9_CHECKPOINT_SECRET_BLOCKED')) throw error;
        // Existing malformed/legacy Turns remain individually quarantined;
        // only a newly recognized plaintext secret blocks Provider setup.
      }
    }
  }

  /** A9-61: revalidatePersistedTurns with the same checks, yielding between bounded slices. */
  async revalidatePersistedTurnsAsync(): Promise<void> {
    this.checkpoints.clear();
    this.cacheGeneration += 1;
    const turnIds = this.listPersistedTurns();
    for (const turnId of turnIds) {
      try {
        await this.readValidatedCheckpointCooperatively(turnId);
      } catch (error) {
        if (error instanceof Error && error.message.includes('A9_CHECKPOINT_SECRET_BLOCKED')) throw error;
      }
    }
  }

  private persist(checkpoint: TurnCheckpoint): void {
    checkpoint.updatedAt = new Date().toISOString();
    this.ensureRecoveryDir(this.manifestsRoot);
    const target = this.manifestPath(checkpoint.turnId);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
      // Secret checks happen at every caller-controlled path/content ingress.
      // Scanning the complete structural JSON here creates false positives for
      // short header values that happen to occur in schema labels or generated
      // recovery paths; no workspace file content is embedded in this JSON.
      fs.writeFileSync(tmp, serialized, 'utf8');
      fs.renameSync(tmp, target);
    } catch (err) {
      // 清单持久化失败必须暴露：撤销保证依赖磁盘事实，不能只在内存成立。
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_cleanupErr) { /* best effort */ }
      throw new Error(`Checkpoint 清单写入失败 (${target}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 开启一轮新的 Checkpoint 事务
   */
  startTurn(turnId: string): TurnCheckpoint {
    let checkpoint = this.loadCheckpoint(turnId);
    if (!checkpoint) {
      checkpoint = {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        turnId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifactBindingVersion: 1,
        changes: Object.create(null),
        unrecoverable: Object.create(null),
      };
      this.checkpoints.set(turnId, checkpoint);
      this.persist(checkpoint);
    }
    if (!checkpoint.unrecoverable) checkpoint.unrecoverable = Object.create(null);
    return checkpoint;
  }

  private hashBytes(content: Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private hashFile(filePath: string): string {
    const digest = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      let bytesRead = 0;
      do {
        bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      fs.closeSync(fd);
    }
    return digest.digest('hex');
  }

  /** 不跟随 symlink/junction 的确定性目录树哈希。 */
  private hashDirectoryTree(root: string): string {
    const digest = crypto.createHash('sha256');
    const visit = (absolute: string, relative: string): void => {
      const stat = fs.lstatSync(absolute);
      const normalized = relative.replace(/\\/g, '/');
      if (stat.isSymbolicLink()) {
        digest.update(`L\0${normalized}\0${fs.readlinkSync(absolute)}\0`);
        return;
      }
      if (stat.isDirectory()) {
        digest.update(`D\0${normalized}\0`);
        for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), path.join(relative, name));
        return;
      }
      if (stat.isFile()) {
        digest.update(`F\0${normalized}\0${stat.size}\0${this.hashBytes(fs.readFileSync(absolute))}\0`);
        return;
      }
      digest.update(`O\0${normalized}\0${stat.mode}\0${stat.size}\0`);
    };
    visit(root, '.');
    return digest.digest('hex');
  }

  private storeBlob(content: Buffer): string {
    const hash = this.hashBytes(content);
    const blobPath = path.join(this.blobsRoot, hash.slice(0, 2), hash);
    if (!fs.existsSync(blobPath)) {
      this.ensureRecoveryDir(path.dirname(blobPath));
      const tmp = `${blobPath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, blobPath);
    }
    return blobPath;
  }

  /** 递归快照目录到恢复区（用于目录删除/覆盖的恢复）。 */
  private snapshotDirectory(
    absDir: string,
    turnId: string,
    relPath: string,
    role: 'original' | 'current',
  ): { path: string; treeHash: string } {
    this.assertSafeTurnId(turnId);
    this.assertNotSensitive(relPath, 'checkpoint directory path');
    const inspect = (absolute: string, relative: string): void => {
      this.assertNotSensitive(relative, 'checkpoint directory entry path');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(absolute)) inspect(path.join(absolute, name), path.join(relative, name));
      } else if (stat.isFile()) {
        this.assertNotSensitive(fs.readFileSync(absolute), 'checkpoint directory file content');
      }
    };
    inspect(absDir, relPath);
    const target = this.snapshotPath(turnId, relPath, role);
    this.ensureRecoveryDir(path.dirname(target));
    if (role === 'original' && fs.existsSync(target)) {
      return { path: target, treeHash: this.hashDirectoryTree(target) };
    }
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(absDir, target, { recursive: true });
    const sourceTreeHash = this.hashDirectoryTree(absDir);
    if (this.hashDirectoryTree(target) !== sourceTreeHash) throw new Error(`目录快照完整性校验失败: ${relPath}`);
    return { path: target, treeHash: sourceTreeHash };
  }

  /**
   * A9-66 F-012: cooperative counterpart of snapshotDirectory. Secret checks,
   * copy and both tree hashes yield to the event loop and observe the signal.
   * The copy is staged under a unique name and only renamed onto the role path
   * after the integrity check, so a cancelled or failed attempt can never be
   * mistaken for a reusable original snapshot.
   */
  private async snapshotDirectoryAsync(
    absDir: string,
    turnId: string,
    relPath: string,
    role: 'original' | 'current',
    options: { signal?: AbortSignal; guard: IoGuard },
  ): Promise<{ path: string; treeHash: string }> {
    const { guard } = options;
    this.assertSafeTurnId(turnId);
    this.assertNotSensitive(relPath, 'checkpoint directory path');
    await forEachTreeFileAsync(absDir, relPath, (relative, content) => {
      if (content === undefined) this.assertNotSensitive(relative, 'checkpoint directory entry path');
      else this.assertNotSensitive(content, 'checkpoint directory file content');
    }, options);
    const target = this.snapshotPath(turnId, relPath, role);
    guard.check(target);
    this.ensureRecoveryDir(path.dirname(target));
    guard.check(target);
    if (role === 'original' && fs.existsSync(target)) {
      return { path: target, treeHash: await hashDirectoryTreeAsync(target, options) };
    }
    const staging = `${target}.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      await copyTreeAsync(absDir, staging, { force: false, ...options });
      const sourceTreeHash = await hashDirectoryTreeAsync(absDir, options);
      if (await hashDirectoryTreeAsync(staging, options) !== sourceTreeHash) {
        throw new Error(`目录快照完整性校验失败: ${relPath}`);
      }
      guard.check(target);
      if (fs.existsSync(target)) {
        // Only a previous 'current' snapshot may be replaced. An 'original'
        // appearing during this await came from a concurrent writer.
        if (role === 'original') throw new Error(`目录快照在建立期间被并发写入: ${relPath}`);
        await removeTreeAsync(target, { guard });
      }
      // Source validation happened before copy/hash awaited. Validate the
      // actual staging bytes against the current secret set, and repeat if
      // Provider revalidation revoked trust while this scan yielded. The
      // successful scan and promotion have no intervening event-loop turn.
      let secretsValidated = false;
      for (let attempt = 0; attempt < COOPERATIVE_LOAD_ATTEMPTS; attempt += 1) {
        const generation = this.cacheGeneration;
        this.assertNotSensitive(relPath, 'checkpoint directory path');
        await forEachTreeFileAsync(staging, relPath, (relative, content) => {
          this.assertNotSensitive(relative, 'checkpoint directory entry path');
          if (content !== undefined) this.assertNotSensitive(content, 'checkpoint directory file content');
        }, options);
        if (generation === this.cacheGeneration) { secretsValidated = true; break; }
      }
      if (!secretsValidated) throw new Error('A9_CHECKPOINT_SECRET_VALIDATION_STALE: secret validation changed during snapshot');
      // Promotion: identity is re-verified in the same turn as the rename.
      guard.assertAnchors();
      guard.check(staging);
      guard.check(target);
      fs.renameSync(staging, target);
      return { path: target, treeHash: sourceTreeHash };
    } catch (error) {
      try {
        await removeTreeAsync(staging, { guard });
      } catch (_cleanupError) {
        this.recoveryDiagnostics.push({
          code: 'A9_SNAPSHOT_STAGING_CLEANUP_FAILED',
          detail: 'A partial directory snapshot could not be removed; it is never used as a recovery artifact.',
        });
      }
      throw error;
    }
  }

  private isExternalTarget(targetPath: string): boolean {
    const resolved = path.resolve(this.workspaceRoot, targetPath);
    return resolved === path.resolve(this.workspaceRoot) || !this.isWithin(this.workspaceRoot, resolved);
  }

  /**
   * 在发生副作用前记录文件/目录内容基线。失败抛出结构化错误——
   * 无法建立可撤销基线时宁可拒绝变更，也不产生不可恢复副作用。
   * 对轮内已存在的记录，补充“当前状态”快照以支持后续变更/删除的恢复。
   */
  recordPreMutation(turnId: string, targetPath: string): FileChangeRecord {
    this.assertNotSensitive(targetPath, 'checkpoint mutation path');
    const checkpoint = this.startTurn(turnId);
    if (this.isExternalTarget(targetPath)) {
      checkpoint.unrecoverable[targetPath] = {
        path: targetPath,
        kind: 'outside',
        reason: '目标位于工作区外；为避免重启后从可篡改清单对外部路径执行恢复，仅记录事实，不提供自动 undo。',
      };
      this.persist(checkpoint);
      return { filePath: targetPath, action: 'modify', isDirectory: false, unrecoverable: true, timestamp: new Date().toISOString() };
    }
    const existing = checkpoint.changes[targetPath];

    const absPath = path.resolve(this.workspaceRoot, targetPath);
    const pathExists = fs.existsSync(absPath);
    const pathIsDirectory = pathExists && fs.statSync(absPath).isDirectory();

    if (existing) {
      // 轮初不存在的对象始终保持 create 语义；后续修改、删除或重命名
      // 不能把它转换成可恢复的轮前对象，否则 undo 会创建错对象。
      if (existing.action === 'create') {
        if (pathExists) {
          existing.isDirectory = pathIsDirectory;
          existing.newKind = pathIsDirectory ? 'directory' : 'file';
        }
        this.persist(checkpoint);
        return existing;
      }
      if (pathExists && pathIsDirectory) {
        if (!existing.originalSnapshotPath && !existing.currentStateSnapshotPath) {
          const snapshot = this.snapshotDirectory(absPath, turnId, targetPath, 'current');
          existing.currentStateSnapshotPath = snapshot.path;
          existing.currentStateTreeHash = snapshot.treeHash;
        }
        existing.isDirectory = true;
      } else if (pathExists) {
        if (!existing.originalBlobPath && !existing.newBlobPath && !existing.currentStateBlobPath) {
          const content = fs.readFileSync(absPath);
          existing.currentStateBlobPath = this.storeBoundFile(content, turnId, targetPath, 'current');
          existing.currentStateHash = this.hashBytes(content);
        }
      }
      this.persist(checkpoint);
      return existing;
    }

    let record: FileChangeRecord;
    if (pathExists) {
      if (pathIsDirectory) {
        const snapshot = this.snapshotDirectory(absPath, turnId, targetPath, 'original');
        record = {
          filePath: targetPath,
          action: 'modify',
          isDirectory: true,
          originalKind: 'directory',
          newKind: 'directory',
          originalSnapshotPath: snapshot.path,
          originalSnapshotRole: 'original',
          originalTreeHash: snapshot.treeHash,
          timestamp: new Date().toISOString(),
        };
      } else {
        const frozenOriginal = this.fileSnapshotPath(turnId, targetPath, 'original');
        const content = fs.existsSync(frozenOriginal)
          ? fs.readFileSync(frozenOriginal)
          : fs.readFileSync(absPath);
        const hash = this.hashBytes(content);
        record = {
          filePath: targetPath,
          action: 'modify',
          isDirectory: false,
          originalKind: 'file',
          newKind: 'file',
          originalHash: hash,
          originalArtifactRole: 'original',
          originalBlobPath: this.storeBoundFile(content, turnId, targetPath, 'original'),
          timestamp: new Date().toISOString(),
        };
      }
    } else {
      record = {
        filePath: targetPath,
        action: 'create',
        isDirectory: false,
        originalKind: 'absent',
        newKind: 'absent',
        timestamp: new Date().toISOString(),
      };
    }
    checkpoint.changes[targetPath] = record;
    this.persist(checkpoint);
    return record;
  }

  /**
   * A9-66 F-012: asynchronous recordPreMutation for directory targets. Files,
   * external targets and records that need no new snapshot keep the
   * synchronous O(1) path. The manifest decision is re-validated after the
   * snapshot await; any concurrent change fails closed before side effects.
   */
  async recordPreMutationAsync(
    turnId: string,
    targetPath: string,
    options: { signal?: AbortSignal; guard?: IoGuard } = {},
  ): Promise<FileChangeRecord> {
    this.assertNotSensitive(targetPath, 'checkpoint mutation path');
    const absPath = path.resolve(this.workspaceRoot, targetPath);
    const guard = options.guard ?? this.createIoGuard([absPath]);
    // Same turn as every synchronous read/write below: no await in between.
    guard.check(absPath);
    if (this.isExternalTarget(targetPath)) return this.recordPreMutation(turnId, targetPath);
    const isDirectory = () => fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
    if (!isDirectory()) return this.recordPreMutation(turnId, targetPath);
    const needsSnapshot = (record: FileChangeRecord | undefined): 'original' | 'current' | undefined => {
      if (!record) return 'original';
      return record.action !== 'create' && !record.originalSnapshotPath && !record.currentStateSnapshotPath
        ? 'current' : undefined;
    };
    const role = needsSnapshot(this.startTurn(turnId).changes[targetPath]);
    if (!role) return this.recordPreMutation(turnId, targetPath);
    const snapshot = await this.snapshotDirectoryAsync(absPath, turnId, targetPath, role, { signal: options.signal, guard });
    // Promotion of the snapshot into the manifest: identity first, same turn.
    guard.assertAnchors();
    guard.check(absPath);
    const checkpoint = this.startTurn(turnId);
    const existing = checkpoint.changes[targetPath];
    if (!isDirectory() || needsSnapshot(existing) !== role) {
      throw new WorkspaceError('CHECKPOINT_PERSIST_FAILED', `目录 ${targetPath} 的恢复快照建立期间状态变化，拒绝执行副作用。`);
    }
    if (existing) {
      existing.currentStateSnapshotPath = snapshot.path;
      existing.currentStateTreeHash = snapshot.treeHash;
      existing.isDirectory = true;
      this.persist(checkpoint);
      return existing;
    }
    const record: FileChangeRecord = {
      filePath: targetPath,
      action: 'modify',
      isDirectory: true,
      originalKind: 'directory',
      newKind: 'directory',
      originalSnapshotPath: snapshot.path,
      originalSnapshotRole: 'original',
      originalTreeHash: snapshot.treeHash,
      timestamp: new Date().toISOString(),
    };
    checkpoint.changes[targetPath] = record;
    this.persist(checkpoint);
    return record;
  }

  /**
   * A9-66 F-011: records post-state facts. The directory tree hash is computed
   * cooperatively; it intentionally takes no signal because facts of side
   * effects that already happened must be recorded even after cancellation.
   */
  async recordPostMutationAsync(
    turnId: string,
    targetPath: string,
    action: 'create' | 'modify' | 'delete',
    options: { guard?: IoGuard } = {},
  ): Promise<void> {
    const absPath = path.resolve(this.workspaceRoot, targetPath);
    const guard = options.guard ?? this.createIoGuard([absPath]);
    // Never observe or record facts through a redirected root/parent.
    guard.check(absPath);
    if (action !== 'delete' && !this.isExternalTarget(targetPath)) {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
        const directoryTreeHash = await hashDirectoryTreeAsync(absPath, { guard });
        guard.assertAnchors();
        guard.check(absPath);
        this.recordPostMutation(turnId, targetPath, action, { directoryTreeHash });
        return;
      }
    }
    guard.assertAnchors();
    this.recordPostMutation(turnId, targetPath, action);
  }

  /**
   * 记录已完成的文件变更后状态
   */
  recordPostMutation(
    turnId: string,
    targetPath: string,
    action: 'create' | 'modify' | 'delete',
    precomputed: { directoryTreeHash?: string } = {},
  ): void {
    this.assertNotSensitive(targetPath, 'checkpoint mutation path');
    const checkpoint = this.startTurn(turnId);
    if (this.isExternalTarget(targetPath)) {
      const existing = checkpoint.unrecoverable[targetPath];
      checkpoint.unrecoverable[targetPath] = {
        path: targetPath,
        kind: 'outside',
        reason: existing?.reason ?? '工作区外变化不提供自动 undo。',
      };
      this.persist(checkpoint);
      return;
    }
    const absPath = path.resolve(this.workspaceRoot, targetPath);
    const existing = checkpoint.changes[targetPath] ?? {
      filePath: targetPath,
      action,
      isDirectory: false,
      timestamp: new Date().toISOString(),
    };

    if (action === 'delete') {
      if (existing.action !== 'create') existing.action = 'delete';
      existing.newKind = 'absent';
      existing.newHash = undefined;
      existing.newBlobPath = undefined;
      existing.newTreeHash = undefined;
    } else if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      const content = fs.readFileSync(absPath);
      existing.newHash = this.hashBytes(content);
      // New content is needed only for Diff. If it contains a known secret,
      // retain the post-state hash for safe undo but never copy plaintext into
      // recovery storage.
      existing.newBlobPath = this.containsSensitiveData(content)
        ? undefined
        : this.storeBoundFile(content, turnId, targetPath, 'new');
      existing.newTreeHash = undefined;
      existing.isDirectory = false;
      existing.newKind = 'file';
    } else if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
      existing.newHash = undefined;
      existing.newBlobPath = undefined;
      existing.newTreeHash = precomputed.directoryTreeHash ?? this.hashDirectoryTree(absPath);
      existing.isDirectory = true;
      existing.newKind = 'directory';
    } else {
      existing.newHash = undefined;
      existing.newBlobPath = undefined;
      existing.newKind = 'absent';
    }

    checkpoint.changes[targetPath] = existing;
    this.persist(checkpoint);
  }

  /**
   * 撤销整轮 Turn 的所有文件修改。撤销前检查当前文件漂移：外部修改过的
   * 条目被跳过并计入 drifted，不盲目覆盖。
   */
  undoTurn(turnId: string): UndoOutcome {
    this.validateRecoveryIdentity();
    // Existing trusted cache semantics remain; cold loads validate v2 metadata.
    // setPairedTransfer durably updates this same manager before any transfer I/O.
    const checkpoint = this.loadCheckpoint(turnId);
    if (checkpoint?.pairedTransfers && Object.values(checkpoint.pairedTransfers).some(marker => !marker.closed)) {
      return { restored: [], errors: ['A9_TRANSFER_PAIRED_UNDO_REQUIRED'], drifted: [] };
    }
    if (!checkpoint) {
      return { restored: [], errors: [`未找到 Checkpoint: ${turnId}`], drifted: [] };
    }
    const authorizedExternalUndo = this.authorizedExternalUndoTurns.has(turnId);
    if (checkpoint.externalBaseline && checkpoint.externalBaseline.collectionStatus !== 'complete' && !authorizedExternalUndo) {
      return { restored: [], errors: ['Shell 轮后状态尚未完成收集或等待显式确认；拒绝把未知当前状态当作该 Turn 的变更自动覆盖'], drifted: [] };
    }
    const outcome: UndoOutcome = { restored: [], errors: [], drifted: [] };
    // 先移除轮内新建的深层对象，再自浅向深恢复目录骨架，最后恢复文件。
    // 这使 Shell file↔directory 替换和空目录变化可确定收敛。
    const depth = (value: string) => value.split(/[\\/]/).length;
    const paths = Object.keys(checkpoint.changes).sort((left, right) => {
      const leftKind = checkpoint.changes[left].originalKind;
      const rightKind = checkpoint.changes[right].originalKind;
      const rank = (kind: FileChangeRecord['originalKind']) => kind === 'absent' ? 0 : kind === 'directory' ? 1 : 2;
      const rankDelta = rank(leftKind) - rank(rightKind);
      if (rankDelta !== 0) return rankDelta;
      return leftKind === 'absent' ? depth(right) - depth(left) : depth(left) - depth(right);
    });
    try {
      for (const relPath of paths) this.undoOne(checkpoint, relPath, outcome);
    } finally {
      if (authorizedExternalUndo) this.authorizedExternalUndoTurns.delete(turnId);
    }
    if (authorizedExternalUndo) {
      if (outcome.errors.length === 0 && outcome.drifted.length === 0 && checkpoint.externalBaseline) {
        checkpoint.externalBaseline.collectionStatus = 'complete';
        checkpoint.externalBaseline.undoConfirmationId = undefined;
        this.persist(checkpoint);
      }
    }
    return outcome;
  }

  /** 按单文件撤销本轮变化。 */
  undoFile(turnId: string, relPath: string): UndoOutcome {
    this.validateRecoveryIdentity();
    // Existing trusted cache semantics remain; cold loads validate v2 metadata.
    // setPairedTransfer durably updates this same manager before any transfer I/O.
    const checkpoint = this.loadCheckpoint(turnId);
    if (checkpoint?.pairedTransfers && Object.values(checkpoint.pairedTransfers).some(marker => !marker.closed)) {
      return { restored: [], errors: ['A9_TRANSFER_PAIRED_UNDO_REQUIRED'], drifted: [] };
    }
    if (!checkpoint) {
      return { restored: [], errors: [`未找到 Checkpoint: ${turnId}`], drifted: [] };
    }
    const authorizedExternalUndo = this.authorizedExternalUndoTurns.has(turnId);
    if (checkpoint.externalBaseline && checkpoint.externalBaseline.collectionStatus !== 'complete' && !authorizedExternalUndo) {
      return { restored: [], errors: [`Shell 轮后状态尚未完成收集或等待显式确认；拒绝自动撤销 ${relPath}`], drifted: [] };
    }
    if (!checkpoint.changes[relPath]) {
      return { restored: [], errors: [`Checkpoint ${turnId} 中没有 ${relPath} 的记录`], drifted: [] };
    }
    const outcome: UndoOutcome = { restored: [], errors: [], drifted: [] };
    try {
      this.undoOne(checkpoint, relPath, outcome);
    } finally {
      if (authorizedExternalUndo) this.authorizedExternalUndoTurns.delete(turnId);
    }
    return outcome;
  }

  private undoOne(checkpoint: TurnCheckpoint, relPath: string, outcome: UndoOutcome): void {
    const record = checkpoint.changes[relPath];
    const absPath = path.resolve(this.workspaceRoot, relPath);
    try {
      if (record.undoAppliedAt) {
        outcome.restored.push(`${relPath} (此前已撤销，未重复执行)`);
        return;
      }
      const originalKind = record.originalKind ?? (record.action === 'create' ? 'absent' : record.isDirectory ? 'directory' : 'file');
      const newKind = record.newKind ?? (record.action === 'delete' ? 'absent' : record.isDirectory ? 'directory' : 'file');
      const newHash = newKind === 'directory' ? record.newTreeHash : newKind === 'file' ? record.newHash : undefined;
      if (originalKind === 'absent') {
        // 新建的文件/目录撤销为删除；漂移（外部改写）时不盲删。
        if (fs.existsSync(absPath)) {
          if (newKind === 'absent') {
            outcome.drifted.push(`${relPath} (轮后应不存在但同路径已被重建)`);
            return;
          }
          const drift = this.describeDrift(absPath, newKind, newHash);
          if (drift) {
            outcome.drifted.push(`${relPath} (${drift})`);
            return;
          }
          if (!newHash) {
            outcome.errors.push(`撤销 ${relPath} 失败: 新建对象缺少轮后完整性哈希`);
            return;
          }
          this.removeCreatedArtifactAtomically(checkpoint, relPath, newKind as 'file' | 'directory', newHash);
        }
        outcome.restored.push(`${relPath} (已移除新建文件)`);
        this.markUndoApplied(checkpoint, record);
        return;
      }

      // F2：无原始内容且标记不可恢复的修改 → 保留当前现场，绝不删除原文件。
      if (record.unrecoverable === true && !record.originalBlobPath && !record.originalSnapshotPath) {
        outcome.errors.push(`撤销 ${relPath} 失败: 该文件的轮前基线未覆盖（超限/读取失败），无法恢复原内容；当前内容已保留`);
        return;
      }

      // modify：恢复原始内容；当前状态与 post-mutation 哈希不一致时视为漂移。
      const originalStateHash = originalKind === 'directory' ? record.originalTreeHash : record.originalHash;
      if (originalStateHash && this.artifactMatches(absPath, originalKind === 'directory', originalStateHash)) {
        const { stage, backup, stageCleanup, backupCleanup } = this.restoreSwapPaths(checkpoint, relPath);
        if (fs.existsSync(backup) || fs.existsSync(backupCleanup)) {
          if (newKind === 'absent' || !newHash) {
            outcome.errors.push(`撤销 ${relPath} 失败: 已恢复目标旁存在身份不明的未决备份`);
            return;
          }
          this.cleanupSwapArtifactAtomically(backup, backupCleanup, newKind as 'file' | 'directory', newHash);
        }
        if (fs.existsSync(stage) || fs.existsSync(stageCleanup)) {
          this.cleanupSwapArtifactAtomically(
            stage, stageCleanup, originalKind as 'file' | 'directory', originalStateHash,
          );
        }
        outcome.restored.push(`${relPath} (检测到此前已完成恢复)`);
        this.markUndoApplied(checkpoint, record);
        return;
      }
      if (!this.hasPendingRestoreSwap(checkpoint, relPath)) {
        const drift = this.describeDrift(absPath, newKind, newHash);
        if (drift) {
          outcome.drifted.push(`${relPath} (${drift})`);
          return;
        }
      }
      if (newKind !== 'absent' && !newHash) {
        outcome.errors.push(`撤销 ${relPath} 失败: 轮后 ${newKind} 缺少完整性哈希`);
        return;
      }
      const expectedCurrent = newKind === 'absent'
        ? { kind: 'absent' as const }
        : { kind: newKind, hash: newHash! };
      if (originalKind === 'directory' && record.originalSnapshotPath) {
        if (!record.originalTreeHash || this.hashDirectoryTree(record.originalSnapshotPath) !== record.originalTreeHash) {
          outcome.errors.push(`撤销修改 ${relPath} 失败: 目录快照缺少或不匹配树哈希`);
          return;
        }
        this.restoreArtifactAtomically(checkpoint, relPath, record.originalSnapshotPath, true, record.originalTreeHash, expectedCurrent);
        outcome.restored.push(`${relPath} (已恢复原始目录)`);
      } else if (originalKind === 'file' && record.originalBlobPath) {
        if (!fs.existsSync(record.originalBlobPath)) {
          outcome.errors.push(`撤销修改 ${relPath} 失败: 原始内容 blob 缺失`);
          return;
        }
        if (!record.originalHash) {
          outcome.errors.push(`撤销修改 ${relPath} 失败: 原始内容缺少 SHA-256`);
          return;
        }
        this.restoreArtifactAtomically(checkpoint, relPath, record.originalBlobPath, false, record.originalHash, expectedCurrent);
        outcome.restored.push(`${relPath} (已恢复原始版本)`);
      } else {
        outcome.errors.push(`撤销 ${relPath} 失败: 轮前 ${originalKind} 恢复工件缺失`);
        return;
      }
      this.markUndoApplied(checkpoint, record);
    } catch (err: any) {
      if (err instanceof CheckpointDriftError) outcome.drifted.push(`${relPath} (${err.message})`);
      else outcome.errors.push(`撤销 ${relPath} 失败: ${err.message}`);
    }
  }

  private markUndoApplied(checkpoint: TurnCheckpoint, record: FileChangeRecord): void {
    record.undoAppliedAt = new Date().toISOString();
    this.persist(checkpoint);
  }

  private describeDrift(
    absPath: string,
    expectedKind: 'absent' | 'file' | 'directory',
    expectedHash: string | undefined,
  ): string | undefined {
    if (!fs.existsSync(absPath)) {
      return expectedKind === 'absent' ? undefined : '路径在变更后消失';
    }
    if (expectedKind === 'absent') return '轮后应不存在但同路径已被重建';
    const stat = fs.lstatSync(absPath);
    if (stat.isDirectory() !== (expectedKind === 'directory')) return '路径类型在变更后被外部替换';
    if (stat.isDirectory()) {
      if (!expectedHash) return '目录缺少轮后树哈希，拒绝自动覆盖';
      return this.hashDirectoryTree(absPath) === expectedHash ? undefined : '目录在变更后被外部修改';
    }
    if (!expectedHash) return '文件缺少轮后 SHA-256，状态不确定，拒绝自动覆盖';
    const current = this.hashFile(absPath);
    return current === expectedHash ? undefined : '文件在变更后被外部修改';
  }

  /**
   * 记录外部（Shell/Git/脚本）造成的可恢复变化：created → undo 删除；
   * modified/deleted → 用提供的内容 blob 恢复原始内容。
   */
  recordExternalFact(
    turnId: string,
    relPath: string,
    action: 'created' | 'modified' | 'deleted',
    options: ExternalFactOptions = {},
  ): void {
    this.assertNotSensitive(relPath, 'checkpoint external path');
    const checkpoint = this.startTurn(turnId);
    this.applyExternalFact(checkpoint, relPath, action, options);
    this.persist(checkpoint);
  }

  private applyExternalFact(
    checkpoint: TurnCheckpoint,
    relPath: string,
    action: 'created' | 'modified' | 'deleted',
    options: ExternalFactOptions,
  ): void {
    const existing = checkpoint.changes[relPath];
    const record: FileChangeRecord = existing ?? {
      filePath: relPath,
      action: 'create',
      isDirectory: false,
      originalKind: 'absent',
      newKind: 'absent',
      timestamp: new Date().toISOString(),
    };
    if (action === 'created') {
      record.action = 'create';
      record.originalKind = 'absent';
      record.newKind = 'file';
      record.newBlobPath = options.newBlobPath ?? record.newBlobPath;
      record.newHash = options.newHash ?? record.newHash;
    } else if (action === 'modified') {
      const preserveCreate = options.unrecoverable !== true && Boolean(existing)
        && (record.originalKind === 'absent' || record.action === 'create');
      if (!preserveCreate) {
        record.action = 'modify';
        record.originalKind = 'file';
      }
      record.newKind = 'file';
      const baselineEarlier = checkpoint.externalBaseline
        && Date.parse(checkpoint.externalBaseline.frozenAt) <= Date.parse(record.timestamp);
      if (options.originalBlobPath && (!record.originalBlobPath || baselineEarlier)) {
        record.originalBlobPath = options.originalBlobPath;
        record.originalHash = options.originalHash;
        record.originalArtifactRole = 'baseline';
      }
      record.newBlobPath = options.newBlobPath ?? record.newBlobPath;
      record.newHash = options.newHash ?? record.newHash;
    } else {
      const preserveCreate = options.unrecoverable !== true && Boolean(existing)
        && (record.originalKind === 'absent' || record.action === 'create');
      if (!preserveCreate) {
        record.action = 'delete';
        record.originalKind = 'file';
      }
      record.newKind = 'absent';
      const baselineEarlier = checkpoint.externalBaseline
        && Date.parse(checkpoint.externalBaseline.frozenAt) <= Date.parse(record.timestamp);
      if (options.originalBlobPath && (!record.originalBlobPath || baselineEarlier)) {
        record.originalBlobPath = options.originalBlobPath;
        record.originalHash = options.originalHash;
        record.originalArtifactRole = 'baseline';
      }
    }
    if (options.unrecoverable === true) record.unrecoverable = true;
    checkpoint.changes[relPath] = record;
  }

  /**
   * A9-61: record an ordered list of external facts for exactly one Turn with
   * bounded physical writes. Every batch is applied to a private copy of the
   * current checkpoint and the copy replaces the cache only after its atomic
   * manifest write succeeded, so memory never acknowledges an undurable fact.
   * No state is held across an await: each batch starts from the latest cached
   * checkpoint, so concurrent same-Turn writers are preserved, not overwritten.
   * The collected mark, when requested, is written in the same atomic write as
   * the final facts. A failed batch throws and leaves the baseline pending.
   */
  async recordExternalFactsBatched(
    turnId: string,
    operations: ExternalFactOperation[],
    options: { collected?: { requireUndoConfirmation: boolean }; batchSize?: number } = {},
  ): Promise<{ persistCount: number; undoConfirmationId?: string }> {
    const batchSize = options.batchSize ?? EXTERNAL_FACT_BATCH_OPERATIONS;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('external fact batch size must be a positive integer');
    let persistCount = 0;
    let undoConfirmationId: string | undefined;
    const batches = Math.max(1, Math.ceil(operations.length / batchSize));
    for (let batch = 0; batch < batches; batch += 1) {
      if (batch > 0) await yieldToEventLoop();
      await this.loadCheckpointAsync(turnId);
      // From here to the cache swap there is no await.
      const draft = this.cloneCheckpoint(this.startTurn(turnId));
      for (const operation of operations.slice(batch * batchSize, (batch + 1) * batchSize)) {
        if (operation.kind === 'file') {
          this.assertNotSensitive(operation.path, 'checkpoint external path');
          this.applyExternalFact(draft, operation.path, operation.action, operation.options ?? {});
        } else if (operation.kind === 'directory') {
          this.assertNotSensitive(operation.path, 'checkpoint external directory path');
          this.applyExternalDirectoryFact(draft, operation.path, operation.action, operation.options ?? {});
        } else {
          this.assertNotSensitive(operation.change.path, 'checkpoint unrecoverable path');
          this.assertNotSensitive(operation.change.reason, 'checkpoint unrecoverable reason');
          draft.unrecoverable[operation.change.path] = operation.change;
        }
      }
      if (batch === batches - 1 && options.collected) {
        undoConfirmationId = this.applyCollectedMark(draft, options.collected.requireUndoConfirmation);
      }
      if (operations.length === 0 && !options.collected) break;
      this.persist(draft);
      this.checkpoints.set(turnId, draft);
      persistCount += 1;
    }
    return { persistCount, ...(undoConfirmationId ? { undoConfirmationId } : {}) };
  }

  /** Copy whose mutable records are private; immutable artifact facts stay shared. */
  private cloneCheckpoint(checkpoint: TurnCheckpoint): TurnCheckpoint {
    const changes: Record<string, FileChangeRecord> = Object.create(null);
    for (const [key, record] of Object.entries(checkpoint.changes)) changes[key] = { ...record };
    const unrecoverable: Record<string, UnrecoverableExternalChange> = Object.create(null);
    for (const [key, change] of Object.entries(checkpoint.unrecoverable ?? {})) unrecoverable[key] = { ...change };
    return {
      ...checkpoint,
      changes,
      unrecoverable,
      ...(checkpoint.externalBaseline ? { externalBaseline: { ...checkpoint.externalBaseline } } : {}),
    };
  }

  /** Persist the complete bounded Shell-entry baseline before execution starts. */
  persistExternalBaseline(turnId: string, baseline: Omit<PersistedExternalBaseline, 'schemaVersion' | 'collectionStatus'>): void {
    const checkpoint = this.startTurn(turnId);
    if (checkpoint.externalBaseline?.collectionStatus === 'complete') {
      throw new Error(`Shell external baseline is already complete for ${turnId}`);
    }
    checkpoint.externalBaseline = {
      schemaVersion: 1,
      collectionStatus: 'pending',
      frozenAt: baseline.frozenAt,
      files: baseline.files,
      directories: baseline.directories,
      skipped: baseline.skipped,
    };
    // Round-trip validation on the next load is not enough: persist must fail
    // before side effects if any artifact binding is malformed.
    this.persist(checkpoint);
    this.checkpoints.delete(turnId);
    this.loadCheckpoint(turnId);
  }

  /**
   * A9-61: persistExternalBaseline whose mandatory round-trip validation
   * yields between bounded slices. The pending manifest is durable before
   * validation starts; the method resolves only after the persisted bytes
   * passed every binding/secret check, so no side effect can start earlier.
   */
  async persistExternalBaselineAsync(
    turnId: string,
    baseline: Omit<PersistedExternalBaseline, 'schemaVersion' | 'collectionStatus'>,
  ): Promise<void> {
    const checkpoint = this.startTurn(turnId);
    if (checkpoint.externalBaseline?.collectionStatus === 'complete') {
      throw new Error(`Shell external baseline is already complete for ${turnId}`);
    }
    checkpoint.externalBaseline = {
      schemaVersion: 1,
      collectionStatus: 'pending',
      frozenAt: baseline.frozenAt,
      files: baseline.files,
      directories: baseline.directories,
      skipped: baseline.skipped,
    };
    this.persist(checkpoint);
    this.checkpoints.delete(turnId);
    if (!await this.loadCheckpointAsync(turnId)) {
      throw new Error(`Shell external baseline manifest is missing after persistence for ${turnId}`);
    }
  }

  markExternalBaselineCollected(turnId: string, requireUndoConfirmation = false): string | undefined {
    const checkpoint = this.startTurn(turnId);
    const undoConfirmationId = this.applyCollectedMark(checkpoint, requireUndoConfirmation);
    this.persist(checkpoint);
    return undoConfirmationId;
  }

  private applyCollectedMark(checkpoint: TurnCheckpoint, requireUndoConfirmation: boolean): string | undefined {
    if (!checkpoint.externalBaseline) throw new Error(`Shell external baseline is missing for ${checkpoint.turnId}`);
    checkpoint.externalBaseline.collectionStatus = requireUndoConfirmation ? 'awaiting_confirmation' : 'complete';
    checkpoint.externalBaseline.collectedAt = new Date().toISOString();
    checkpoint.externalBaseline.undoConfirmationId = requireUndoConfirmation
      ? `undo-${crypto.randomBytes(16).toString('hex')}`
      : undefined;
    return checkpoint.externalBaseline.undoConfirmationId;
  }

  /** 记录 Shell 扫描发现的目录存在性/类型变化；目录内容由子路径事实恢复。 */
  recordExternalDirectoryFact(
    turnId: string,
    relPath: string,
    action: 'created' | 'deleted' | 'present' | 'replaced_by_file',
    options: ExternalDirectoryFactOptions = {},
  ): void {
    this.assertNotSensitive(relPath, 'checkpoint external directory path');
    const checkpoint = this.startTurn(turnId);
    this.applyExternalDirectoryFact(checkpoint, relPath, action, options);
    this.persist(checkpoint);
  }

  private applyExternalDirectoryFact(
    checkpoint: TurnCheckpoint,
    relPath: string,
    action: 'created' | 'deleted' | 'present' | 'replaced_by_file',
    options: ExternalDirectoryFactOptions,
  ): void {
    const existing = checkpoint.changes[relPath];
    const record: FileChangeRecord = existing ?? {
      filePath: relPath,
      action: action === 'created' ? 'create' : action === 'deleted' ? 'delete' : 'modify',
      isDirectory: true,
      originalKind: action === 'created' ? 'absent' : 'directory',
      newKind: action === 'deleted' ? 'absent' : action === 'replaced_by_file' ? 'file' : 'directory',
      timestamp: new Date().toISOString(),
    };
    if (action !== 'created' && record.originalKind === 'absent' && options.originalSnapshotPath) {
      record.action = 'modify';
      record.originalKind = 'directory';
    }
    if (options.originalSnapshotPath && !record.originalSnapshotPath && !record.originalBlobPath) {
      record.originalSnapshotPath = options.originalSnapshotPath;
      record.originalTreeHash = options.originalTreeHash;
      record.originalSnapshotRole = 'baseline';
    } else if (options.originalSnapshotPath && record.originalSnapshotPath) {
      const baselineEarlier = checkpoint.externalBaseline
        && Date.parse(checkpoint.externalBaseline.frozenAt) <= Date.parse(record.timestamp);
      if (baselineEarlier) {
        record.originalSnapshotPath = options.originalSnapshotPath;
        record.originalTreeHash = options.originalTreeHash;
        record.originalSnapshotRole = 'baseline';
      }
    }
    if (action === 'deleted') {
      record.newKind = 'absent';
      record.newHash = undefined;
      record.newBlobPath = undefined;
      record.newTreeHash = undefined;
    } else if (action !== 'replaced_by_file') {
      record.newKind = 'directory';
      record.newHash = undefined;
      record.newBlobPath = undefined;
      record.newTreeHash = options.emptyTreeHash;
    }
    record.isDirectory = true;
    checkpoint.changes[relPath] = record;
  }

  /** 显式标记不可恢复的外部变化（不静默遗漏）。 */
  recordUnrecoverableExternal(turnId: string, change: UnrecoverableExternalChange): void {
    this.assertNotSensitive(change.path, 'checkpoint unrecoverable path');
    this.assertNotSensitive(change.reason, 'checkpoint unrecoverable reason');
    const checkpoint = this.startTurn(turnId);
    checkpoint.unrecoverable[change.path] = change;
    this.persist(checkpoint);
  }

  /** 读取外部变化报告（含可恢复与不可恢复），供 Diff/SQLite/UI 共用。 */
  getExternalChanges(turnId: string): {
    recoverable: Array<{ path: string; action: 'create' | 'modify' | 'delete' }>;
    unrecoverable: UnrecoverableExternalChange[];
  } {
    const checkpoint = this.loadCheckpoint(turnId);
    if (!checkpoint) return { recoverable: [], unrecoverable: [] };
    return {
      recoverable: Object.values(checkpoint.changes).map((r) => ({ path: r.filePath, action: r.action })),
      unrecoverable: Object.values(checkpoint.unrecoverable ?? {}),
    };
  }

  /**
   * 获取指定 Turn 的变更清单和 Diff
   */
  getTurnDiff(turnId: string): Array<{ path: string; action: string; diffText: string }> {
    const checkpoint = this.loadCheckpoint(turnId);
    if (!checkpoint) return [];

    return Object.entries(checkpoint.changes).map(([relPath, record]) => {
      const { diff } = this.recordDiffPreview(record);
      return { path: relPath, action: record.action, diffText: diff.unifiedDiff };
    });
  }

  private recordDiffPreview(record: FileChangeRecord): { diff: ReturnType<typeof buildContentDiffPreview> } {
    const original = record.originalBlobPath && fs.existsSync(record.originalBlobPath)
      ? fs.readFileSync(record.originalBlobPath) : null;
    const next = record.newBlobPath && fs.existsSync(record.newBlobPath)
      ? fs.readFileSync(record.newBlobPath) : null;
    if (original) this.assertNotSensitive(original, 'checkpoint original preview content');
    if (next) this.assertNotSensitive(next, 'checkpoint next preview content');
    return { diff: buildContentDiffPreview(original, next) };
  }

  private reviewFile(relPath: string, record: FileChangeRecord, diff: ReturnType<typeof buildContentDiffPreview>): TurnReviewFile {
    const directory = record.isDirectory || record.originalKind === 'directory' || record.newKind === 'directory';
    const lines = directory ? [] : diff.unifiedDiff.split('\n');
    return {
      path: relPath,
      action: record.action,
      originalKind: record.originalKind,
      newKind: record.newKind,
      undone: Boolean(record.undoAppliedAt),
      additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      diffText: diff.unifiedDiff,
      diffTruncated: diff.truncated,
    };
  }

  /**
   * A9-61: getTurnDiff + getTurnReview for one Turn with one cooperative cold
   * load and one preview per record, yielding between records. Results are
   * identical to calling the two synchronous methods.
   */
  async getTurnDiffAndReviewAsync(turnId: string): Promise<{
    diff: Array<{ path: string; action: string; diffText: string }>;
    review: TurnReview | null;
  }> {
    const generation = this.cacheGeneration;
    const assertCurrent = (): void => {
      if (generation !== this.cacheGeneration) throw new Error('A9_CHECKPOINT_VALIDATION_STALE: preview trust changed');
    };
    const checkpoint = await this.loadCheckpointAsync(turnId);
    assertCurrent();
    if (!checkpoint) return { diff: [], review: null };
    const slice = new CooperativeSlice();
    const diff: Array<{ path: string; action: string; diffText: string }> = [];
    const files: TurnReviewFile[] = [];
    for (const [relPath, record] of Object.entries(checkpoint.changes)) {
      const preview = this.recordDiffPreview(record).diff;
      this.assertNotSensitive(relPath, 'checkpoint diff path');
      diff.push({ path: relPath, action: record.action, diffText: preview.unifiedDiff });
      files.push(this.reviewFile(relPath, record, preview));
      await slice.step();
      assertCurrent();
    }
    return { diff, review: this.turnReviewFrom(turnId, checkpoint, files) };
  }

  /** A9-24: read-only projection for the change inspector. */
  getTurnReview(turnId: string): TurnReview | null {
    const checkpoint = this.loadCheckpoint(turnId);
    if (!checkpoint) return null;
    const files = Object.entries(checkpoint.changes)
      .map(([relPath, record]) => this.reviewFile(relPath, record, this.recordDiffPreview(record).diff));
    return this.turnReviewFrom(turnId, checkpoint, files);
  }

  private turnReviewFrom(turnId: string, checkpoint: TurnCheckpoint, files: TurnReviewFile[]): TurnReview {
    return {
      turnId,
      files,
      unrecoverable: Object.values(checkpoint.unrecoverable ?? {}).map((item) => {
        const skippedFact = checkpoint.externalBaseline?.skipped.find((fact) => fact.path === item.path);
        const reasonCode = skippedFact?.reason
          || (['too_large', 'outside', 'backup_failed'].includes(item.kind) ? item.kind : undefined)
          || /（([a-z_]+)）/.exec(item.reason)?.[1];
        return { ...item, ...(reasonCode ? { reasonCode } : {}) };
      }),
      externalBaselineStatus: checkpoint.externalBaseline?.collectionStatus ?? 'none',
    };
  }

  getTurnChanges(turnId: string): FileChangeRecord[] {
    const checkpoint = this.loadCheckpoint(turnId);
    return checkpoint ? Object.values(checkpoint.changes).map((r) => ({ ...r })) : [];
  }

  /** 供删除恢复区使用的显式接口：把文件内容存入恢复区并返回路径。 */
  saveToRecovery(turnId: string, relPath: string, content: Buffer): string {
    return this.storeBoundFile(content, turnId, relPath, 'baseline');
  }
}
