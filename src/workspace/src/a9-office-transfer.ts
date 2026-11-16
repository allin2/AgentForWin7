/** ADR-0335. Host-only, one file per plan (batch callers submit <=100 plans).
 * Runtime: existing Electron22/Node16 fs/crypto profile; no new dependencies.
 * Trusted workspace checks are not atomic against another process. fsync is
 * not a cross-volume/power-loss transaction. Restart only observes facts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CheckpointManager } from './checkpoint-manager';
import { captureAnchor, assertAnchor, DirectoryAnchor, IoGuard, samePath } from './directory-identity';

export interface TransferIdentity { conversationId: string; turnId: string }
export interface TransferEndpoint { workspaceId: string; relativePath: string; turnId: string }
export interface RegisteredTransferWorkspace {
  workspaceId: string;
  workspaceRoot: string;
  checkpoint: CheckpointManager;
}
/** Only the trusted host implements this port. Revalidation must check current
 * registration, including revocation/replacement, not just return a cached root. */
export interface RegisteredWorkspacePort {
  resolve(workspaceId: string): RegisteredTransferWorkspace | undefined;
  revalidate(workspace: RegisteredTransferWorkspace): void;
}
export interface TransferApprovalBinding {
  schemaVersion: 1; purpose: 'move' | 'undo'; planId: string;
  identity: TransferIdentity; source: TransferEndpoint; target: TransferEndpoint;
  sourceRoot: DirectoryAnchor; targetRoot: DirectoryAnchor;
  sourceSha256: string; digest: string;
}
export interface TransferApprovalPort {
  /** Atomically consume an exact, fresh one-use host approval. */
  consume(approvalId: string, binding: TransferApprovalBinding): boolean | Promise<boolean>;
}
export type TransferPhase = 'prepared' | 'target_published' | 'moved' | 'source_restored' | 'closed';
export interface TransferReceipt {
  schemaVersion: 1; transferId: string; source: TransferEndpoint; target: TransferEndpoint;
  conversationId: string; sourceSha256: string; sizeBytes: number;
  sourceRootDigest: string; targetRootDigest: string;
  phase: TransferPhase; createdAt: string; updatedAt: string;
}
interface FileFact { exists: boolean; sha256?: string; sizeBytes?: number; dev?: number; ino?: number; mtimeMs?: number; ctimeMs?: number }
interface Pair {
  source: RegisteredTransferWorkspace; target: RegisteredTransferWorkspace;
  sourceRoot: DirectoryAnchor; targetRoot: DirectoryAnchor;
  sourceParent: DirectoryAnchor; targetParent: DirectoryAnchor;
  sourcePath: string; targetPath: string; guard: IoGuard;
}
interface StoredPlan {
  planId: string; purpose: 'move' | 'undo'; identity: TransferIdentity;
  source: TransferEndpoint; target: TransferEndpoint; pair: Pair;
  sourceFact: FileFact; targetFact: FileFact; sourceSha256: string; sizeBytes: number;
  receipt?: TransferReceipt; used: boolean;
}
export interface TransferPlan { schemaVersion: 1; planId: string; purpose: 'move' | 'undo'; sourceSha256: string; sizeBytes: number }
export interface TransferResult { code: string; transferId: string; phase?: TransferPhase; targetPublished: boolean; sourceDeleted: boolean }
export interface TransferReconciliation {
  code: 'A9_TRANSFER_RECONCILED' | 'A9_TRANSFER_RECEIPTS_DISAGREE';
  transferId: string; phase?: TransferPhase;
  source: FileFact; target: FileFact; conflict: boolean;
  sourceReceipt?: TransferReceipt; targetReceipt?: TransferReceipt;
}
export class OfficeTransferError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'OfficeTransferError'; }
}
function fail(code: string): never { throw new OfficeTransferError(code); }
const hash = (bytes: Buffer | string): string => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown): string => JSON.stringify(value);
const MAX = 16 * 1024 * 1024;
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value) || value === '.' || value === '..') fail('A9_TRANSFER_ID_INVALID');
}
function identity(value: TransferIdentity): void {
  exact(value, ['conversationId', 'turnId']); identifier(value.conversationId); identifier(value.turnId);
}
function exact(value: unknown, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) fail('A9_TRANSFER_INPUT_INVALID');
}
function relative(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 240 || path.isAbsolute(value) || path.win32.isAbsolute(value)
    || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..'
      || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(part)
      || /^(\.agent_recovery|\.git)$/i.test(part))) fail('A9_TRANSFER_PATH_INVALID');
}
function endpoint(value: TransferEndpoint): void {
  exact(value, ['workspaceId', 'relativePath', 'turnId']);
  identifier(value.workspaceId); identifier(value.turnId); relative(value.relativePath);
}
function noLinks(absolute: string): void {
  const resolved = path.resolve(absolute);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let st: fs.Stats;
    try { st = fs.lstatSync(cursor); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      fail('A9_TRANSFER_PATH_UNKNOWN');
    }
    if (st.isSymbolicLink() || !samePath(fs.realpathSync.native(cursor), cursor)) fail('A9_TRANSFER_REPARSE');
  }
}
function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) fail('A9_TRANSFER_CANCELLED'); }
function frozen<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

export class OfficeTransferService {
  private readonly plans = new Map<string, StoredPlan>();
  private busy = false;
  constructor(private readonly workspaces: RegisteredWorkspacePort, private readonly approvals: TransferApprovalPort) {}

  private resolve(source: TransferEndpoint, target: TransferEndpoint): Pair {
    endpoint(source); endpoint(target);
    const a = this.workspaces.resolve(source.workspaceId), b = this.workspaces.resolve(target.workspaceId);
    if (!a || !b || a.workspaceId !== source.workspaceId || b.workspaceId !== target.workspaceId) fail('A9_TRANSFER_UNREGISTERED');
    this.workspaces.revalidate(a); this.workspaces.revalidate(b);
    for (const w of [a, b]) {
      if (!path.isAbsolute(w.workspaceRoot) || !samePath(w.workspaceRoot, w.checkpoint.getWorkspaceRoot())) fail('A9_TRANSFER_REGISTRATION_INVALID');
      noLinks(w.workspaceRoot); noLinks(w.checkpoint.getRecoveryRoot()); w.checkpoint.validateRecoveryIdentity();
    }
    const ar = captureAnchor(a.workspaceRoot), br = captureAnchor(b.workspaceRoot);
    if (a.workspaceId === b.workspaceId || within(ar.real, br.real) || within(br.real, ar.real)) fail('A9_TRANSFER_ROOT_OVERLAP');
    const ap = path.resolve(a.workspaceRoot, source.relativePath), bp = path.resolve(b.workspaceRoot, target.relativePath);
    for (const p of [ap, bp]) { if (p.length > 240) fail('A9_TRANSFER_PATH_TOO_LONG'); noLinks(p); }
    // Recovery namespaces may be customized outside their workspace; neither
    // user path may overlap either namespace (in either direction).
    for (const w of [a, b]) for (const p of [ap, bp]) {
      const rr = w.checkpoint.getRecoveryRoot();
      if (within(rr, p) || within(p, rr)) fail('A9_TRANSFER_RECOVERY_OVERLAP');
    }
    for (const [w, e, file] of [[a, source, ap], [b, target, bp]] as const) {
      const recovery = w.checkpoint.getRecoveryRoot();
      const candidates = [path.join(recovery, 'snapshots', e.turnId, '0'.repeat(64), 'original.bin.tmp-9999999999-9999999999999'),
        path.join(recovery, 'checkpoints', e.turnId + '.json.tmp-9999999999-9999999999999'),
        path.join(recovery, 'transfers', 'transfer-' + '0'.repeat(32) + '.json.tmp-' + '0'.repeat(16)),
        path.join(path.dirname(file), '.a9-transfer-' + '0'.repeat(32))];
      if (candidates.some(p => p.length > 240)) fail('A9_TRANSFER_PATH_TOO_LONG');
    }
    const pa = captureAnchor(path.dirname(ap)), pb = captureAnchor(path.dirname(bp));
    const guard = new IoGuard([ar, br, pa, pb]);
    return { source: a, target: b, sourceRoot: ar, targetRoot: br, sourceParent: pa, targetParent: pb, sourcePath: ap, targetPath: bp, guard };
  }
  private check(pair: Pair): void {
    this.workspaces.revalidate(pair.source); this.workspaces.revalidate(pair.target);
    const a = this.workspaces.resolve(pair.source.workspaceId), b = this.workspaces.resolve(pair.target.workspaceId);
    if (!a || !b || a.checkpoint !== pair.source.checkpoint || b.checkpoint !== pair.target.checkpoint
      || a.workspaceRoot !== pair.source.workspaceRoot || b.workspaceRoot !== pair.target.workspaceRoot) fail('A9_TRANSFER_REGISTRATION_CHANGED');
    pair.guard.assertAnchors();
    for (const w of [pair.source, pair.target]) { noLinks(w.checkpoint.getRecoveryRoot()); w.checkpoint.validateRecoveryIdentity(); }
    noLinks(pair.sourcePath); noLinks(pair.targetPath);
  }
  private fact(pair: Pair, target: string): FileFact {
    this.check(pair); pair.guard.check(target);
    let st: fs.Stats;
    try { st = fs.lstatSync(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
      fail('A9_TRANSFER_FILE_UNKNOWN');
    }
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX) fail('A9_TRANSFER_FILE_INVALID');
    pair.guard.check(target); const fd = fs.openSync(target, 'r');
    try {
      const before = fs.fstatSync(fd);
      if (before.ino !== st.ino || before.dev !== st.dev) fail('A9_TRANSFER_FILE_CHANGED');
      const digest = crypto.createHash('sha256'), buf = Buffer.alloc(64 * 1024);
      let count = 0;
      for (;;) { this.check(pair); pair.guard.check(target); const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; count += n; if (count > MAX) fail('A9_TRANSFER_FILE_INVALID'); digest.update(buf.subarray(0, n)); }
      const after = fs.fstatSync(fd); pair.guard.check(target); const leaf = fs.lstatSync(target);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || leaf.ino !== before.ino || leaf.dev !== before.dev || count !== before.size) fail('A9_TRANSFER_FILE_CHANGED');
      return { exists: true, sha256: digest.digest('hex'), sizeBytes: count, dev: leaf.dev, ino: leaf.ino, mtimeMs: leaf.mtimeMs, ctimeMs: leaf.ctimeMs };
    } finally { fs.closeSync(fd); }
  }
  private store(p: Omit<StoredPlan, 'planId' | 'used'>): TransferPlan {
    if (this.plans.size >= 100) fail('A9_TRANSFER_PLAN_LIMIT');
    const planId = 'plan-' + crypto.randomBytes(16).toString('hex');
    this.plans.set(planId, { ...p, planId, used: false });
    return Object.freeze({ schemaVersion: 1, planId, purpose: p.purpose, sourceSha256: p.sourceSha256, sizeBytes: p.sizeBytes });
  }
  /** Read-only; single exact move. Max100 live plans; discardPlan releases one. */
  plan(input: { source: TransferEndpoint; target: TransferEndpoint }, who: TransferIdentity): TransferPlan {
    exact(input, ['source', 'target']); identity(who);
    const source = frozen(input.source), target = frozen(input.target), pair = this.resolve(source, target);
    const sourceFact = this.fact(pair, pair.sourcePath), targetFact = this.fact(pair, pair.targetPath);
    if (!sourceFact.exists) fail('A9_TRANSFER_SOURCE_MISSING');
    if (targetFact.exists) fail('A9_TRANSFER_TARGET_EXISTS');
    return this.store({ purpose: 'move', identity: frozen(who), source, target, pair, sourceFact, targetFact, sourceSha256: sourceFact.sha256!, sizeBytes: sourceFact.sizeBytes! });
  }
  discardPlan(planId: string): void { this.plans.delete(planId); }
  private get(planId: string, who: TransferIdentity): StoredPlan {
    identity(who);
    const p = this.plans.get(planId);
    if (!p || p.used || (who.conversationId !== p.identity.conversationId || who.turnId !== p.identity.turnId)) fail('A9_TRANSFER_PLAN_STALE');
    this.check(p.pair);
    if (json(this.fact(p.pair, p.pair.sourcePath)) !== json(p.sourceFact)
      || json(this.fact(p.pair, p.pair.targetPath)) !== json(p.targetFact)) fail('A9_TRANSFER_DRIFT');
    if (p.receipt) {
      const r = this.readPair(p.pair, p.receipt.transferId);
      if (!r.agree || json(r.a) !== json(p.receipt)) fail('A9_TRANSFER_RECEIPTS_DISAGREE');
    }
    return p;
  }
  getApprovalBinding(planId: string, who: TransferIdentity): TransferApprovalBinding {
    const p = this.get(planId, who);
    const data = { schemaVersion: 1 as const, purpose: p.purpose, planId, identity: p.identity, source: p.source, target: p.target,
      sourceRoot: p.pair.sourceRoot, targetRoot: p.pair.targetRoot, sourceSha256: p.sourceSha256 };
    return frozen({ ...data, digest: hash(json({ ...data, sourceFact: p.sourceFact, targetFact: p.targetFact, receipt: p.receipt })) });
  }
  private parse(raw: string | undefined, id: string): TransferReceipt | undefined {
    if (raw === undefined) return undefined;
    if (Buffer.byteLength(raw, 'utf8') > 16384) fail('A9_TRANSFER_RECEIPT_INVALID');
    let r: TransferReceipt;
    try { r = JSON.parse(raw); } catch { return fail('A9_TRANSFER_RECEIPT_INVALID'); }
    exact(r, ['schemaVersion', 'transferId', 'source', 'target', 'conversationId', 'sourceSha256', 'sizeBytes', 'sourceRootDigest', 'targetRootDigest', 'phase', 'createdAt', 'updatedAt']);
    endpoint(r.source); endpoint(r.target); identifier(r.conversationId);
    if (r.schemaVersion !== 1 || r.transferId !== id || !/^transfer-[a-f0-9]{32}$/.test(id)
      || ![r.sourceSha256, r.sourceRootDigest, r.targetRootDigest].every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))
      || !Number.isSafeInteger(r.sizeBytes) || r.sizeBytes < 0 || r.sizeBytes > MAX
      || !['prepared', 'target_published', 'moved', 'source_restored', 'closed'].includes(r.phase)
      || ![r.createdAt, r.updatedAt].every(x => typeof x === 'string' && x.length <= 32 && Number.isFinite(Date.parse(x)))) fail('A9_TRANSFER_RECEIPT_INVALID');
    return r;
  }
  private readPair(pair: Pair, id: string): { a?: TransferReceipt; b?: TransferReceipt; agree: boolean } {
    this.check(pair);
    const a = this.parse(pair.source.checkpoint.readTransferReceipt(id), id), b = this.parse(pair.target.checkpoint.readTransferReceipt(id), id);
    for (const r of [a, b]) if (r && (r.source.workspaceId !== pair.source.workspaceId || r.target.workspaceId !== pair.target.workspaceId
      || r.sourceRootDigest !== hash(json(pair.sourceRoot)) || r.targetRootDigest !== hash(json(pair.targetRoot))
      || path.resolve(pair.source.workspaceRoot, r.source.relativePath) !== pair.sourcePath
      || path.resolve(pair.target.workspaceRoot, r.target.relativePath) !== pair.targetPath)) fail('A9_TRANSFER_RECEIPT_BINDING_INVALID');
    return { a, b, agree: !!a && !!b && json(a) === json(b) };
  }
  private persist(pair: Pair, receipt: TransferReceipt, phase: TransferPhase): TransferReceipt {
    const next = { ...receipt, phase, updatedAt: new Date().toISOString() };
    for (const w of [pair.source, pair.target]) {
      this.check(pair); w.checkpoint.writeTransferReceipt(receipt.transferId, json(next));
      if (json(this.parse(w.checkpoint.readTransferReceipt(receipt.transferId), receipt.transferId)) !== json(next)) fail('A9_TRANSFER_RECEIPT_READBACK_FAILED');
    }
    return next;
  }
  /** Lookup requires both host-selected IDs. Receipt roots never authorize paths. */
  reconcile(transferId: string, sourceWorkspaceId: string, targetWorkspaceId: string): TransferReconciliation {
    identifier(sourceWorkspaceId); identifier(targetWorkspaceId);
    const w = this.workspaces.resolve(sourceWorkspaceId);
    if (!w) fail('A9_TRANSFER_UNREGISTERED');
    this.workspaces.revalidate(w); noLinks(w.workspaceRoot); w.checkpoint.validateRecoveryIdentity();
    const seed = this.parse(w.checkpoint.readTransferReceipt(transferId), transferId);
    if (!seed || seed.source.workspaceId !== sourceWorkspaceId || seed.target.workspaceId !== targetWorkspaceId) fail('A9_TRANSFER_RECEIPT_BINDING_INVALID');
    const pair = this.resolve(seed.source, seed.target), records = this.readPair(pair, transferId);
    const source = this.fact(pair, pair.sourcePath), target = this.fact(pair, pair.targetPath);
    return { code: records.agree ? 'A9_TRANSFER_RECONCILED' : 'A9_TRANSFER_RECEIPTS_DISAGREE', transferId,
      ...(records.agree ? { phase: seed.phase } : {}), source, target,
      conflict: [source, target].some(f => f.exists && f.sha256 !== seed.sourceSha256), sourceReceipt: records.a, targetReceipt: records.b };
  }
  planUndo(transferId: string, sourceWorkspaceId: string, targetWorkspaceId: string, who: TransferIdentity): TransferPlan {
    identity(who);
    const facts = this.reconcile(transferId, sourceWorkspaceId, targetWorkspaceId), r = facts.sourceReceipt!;
    if (facts.code !== 'A9_TRANSFER_RECONCILED') fail('A9_TRANSFER_RECEIPTS_DISAGREE');
    if (r.conversationId !== who.conversationId) fail('A9_TRANSFER_PLAN_STALE');
    if (facts.conflict) fail('A9_TRANSFER_UNDO_CONFLICT');
    const pair = this.resolve(r.source, r.target);
    // Both missing is recoverable only from the source root's own checkpoint.
    const baseline = pair.source.checkpoint.readPairedOriginal(r.source.turnId, r.transferId, r.source.relativePath, r.sourceSha256);
    if (baseline.length !== r.sizeBytes) fail('A9_TRANSFER_RECEIPT_INVALID');
    return this.store({ purpose: 'undo', identity: frozen(who), source: r.source, target: r.target, pair,
      sourceFact: facts.source, targetFact: facts.target, sourceSha256: r.sourceSha256, sizeBytes: r.sizeBytes, receipt: r });
  }
  private async publish(pair: Pair, target: string, bytes: Buffer, expected: string, signal?: AbortSignal, published: () => void = () => {}): Promise<void> {
    const tmp = path.join(path.dirname(target), '.a9-transfer-' + crypto.randomBytes(16).toString('hex'));
    if (tmp.length > 240) fail('A9_TRANSFER_PATH_TOO_LONG');
    this.check(pair); pair.guard.check(tmp); let fd: number | undefined = fs.openSync(tmp, 'wx');
    const owned = fs.fstatSync(fd);
    try {
      const digest = crypto.createHash('sha256');
      for (let i = 0; i < bytes.length; i += 65536) {
        cancelled(signal); this.check(pair); pair.guard.check(tmp);
        const chunk = bytes.subarray(i, Math.min(bytes.length, i + 65536));
        let offset = 0;
        while (offset < chunk.length) { const n = fs.writeSync(fd, chunk, offset, chunk.length - offset); if (!n) fail('A9_TRANSFER_COPY_FAILED'); offset += n; }
        digest.update(chunk); await new Promise<void>(resolve => setImmediate(resolve));
      }
      cancelled(signal); this.check(pair); pair.guard.check(tmp); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      if (digest.digest('hex') !== expected || this.fact(pair, tmp).sha256 !== expected) fail('A9_TRANSFER_HASH_MISMATCH');
      this.check(pair); pair.guard.check(target); fs.linkSync(tmp, target); published(); // exclusive, same directory; no overwrite fallback
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      this.check(pair); pair.guard.check(tmp);
      const st = fs.lstatSync(tmp);
      if (st.ino !== owned.ino || st.dev !== owned.dev || !st.isFile()) fail('A9_TRANSFER_TEMP_CHANGED');
      pair.guard.check(tmp); fs.unlinkSync(tmp);
    }
  }
  execute(planId: string, who: TransferIdentity, approvalId: string, signal?: AbortSignal): Promise<TransferResult> {
    return this.run('move', planId, who, approvalId, signal);
  }
  executeUndo(planId: string, who: TransferIdentity, approvalId: string, signal?: AbortSignal): Promise<TransferResult> {
    return this.run('undo', planId, who, approvalId, signal);
  }
  private async run(purpose: 'move' | 'undo', planId: string, who: TransferIdentity, approvalId: string, signal?: AbortSignal): Promise<TransferResult> {
    cancelled(signal); if (this.busy) fail('A9_TRANSFER_BUSY');
    const p = this.get(planId, who); if (p.purpose !== purpose) fail('A9_TRANSFER_PLAN_STALE');
    const binding = this.getApprovalBinding(planId, who);
    this.busy = true; let targetPublished = p.targetFact.exists, sourceDeleted = !p.sourceFact.exists;
    let r = p.receipt; const transferId = r?.transferId ?? 'transfer-' + crypto.randomBytes(16).toString('hex');
    try {
      p.used = true;
      if (!await this.approvals.consume(approvalId, binding)) fail('A9_TRANSFER_APPROVAL_REJECTED');
      cancelled(signal);
      // Fresh full validation after approval's asynchronous boundary.
      p.used = false;
      try { this.get(planId, who); } finally { p.used = true; }
      const pair = p.pair, a = pair.source.checkpoint, b = pair.target.checkpoint;
      const guards = [a.createIoGuard([pair.sourcePath]), b.createIoGuard([pair.targetPath])];
      const check = () => { cancelled(signal); this.check(pair); guards.forEach(g => g.assertAnchors()); };
      if (purpose === 'move') {
        check(); const original = a.recordPreMutation(p.source.turnId, p.source.relativePath);
        if (original.originalHash !== p.sourceSha256 || original.originalKind !== 'file') fail('A9_TRANSFER_BASELINE_INVALID');
        check(); const dest = b.recordPreMutation(p.target.turnId, p.target.relativePath);
        if (dest.originalKind !== 'absent') fail('A9_TRANSFER_BASELINE_INVALID');
        check(); a.setPairedTransfer(p.source.turnId, transferId, p.source.relativePath, false);
        check(); b.setPairedTransfer(p.target.turnId, transferId, p.target.relativePath, false);
        const now = new Date().toISOString();
        r = { schemaVersion: 1, transferId, source: p.source, target: p.target, conversationId: who.conversationId,
          sourceSha256: p.sourceSha256, sizeBytes: p.sizeBytes, sourceRootDigest: hash(json(pair.sourceRoot)), targetRootDigest: hash(json(pair.targetRoot)), phase: 'prepared', createdAt: now, updatedAt: now };
        check(); r = this.persist(pair, r, 'prepared');
        check(); const bytes = a.readPairedOriginal(p.source.turnId, transferId, p.source.relativePath, p.sourceSha256);
        await this.publish(pair, pair.targetPath, bytes, p.sourceSha256, signal, () => { targetPublished = true; });
        check(); b.recordPostMutation(p.target.turnId, p.target.relativePath, 'create');
        check(); r = this.persist(pair, r, 'target_published');
        check(); if (json(this.fact(pair, pair.sourcePath)) !== json(p.sourceFact) || this.fact(pair, pair.targetPath).sha256 !== p.sourceSha256) fail('A9_TRANSFER_DRIFT');
        check(); pair.guard.check(pair.sourcePath); fs.unlinkSync(pair.sourcePath); sourceDeleted = true;
        check(); a.recordPostMutation(p.source.turnId, p.source.relativePath, 'delete');
        check(); r = this.persist(pair, r, 'moved');
      } else {
        check();
        if (!this.fact(pair, pair.sourcePath).exists) {
          const bytes = a.readPairedOriginal(p.source.turnId, transferId, p.source.relativePath, p.sourceSha256);
          await this.publish(pair, pair.sourcePath, bytes, p.sourceSha256, signal, () => { sourceDeleted = false; });
        }
        check(); if (this.fact(pair, pair.sourcePath).sha256 !== p.sourceSha256) fail('A9_TRANSFER_UNDO_CONFLICT');
        sourceDeleted = false; r = this.persist(pair, r!, 'source_restored');
        check(); const target = this.fact(pair, pair.targetPath);
        if (target.exists) {
          if (target.sha256 !== p.sourceSha256 || json(target) !== json(p.targetFact)) fail('A9_TRANSFER_UNDO_CONFLICT');
          check(); if (this.fact(pair, pair.sourcePath).sha256 !== p.sourceSha256) fail('A9_TRANSFER_UNDO_CONFLICT');
          check(); pair.guard.check(pair.targetPath); fs.unlinkSync(pair.targetPath);
        }
        targetPublished = false;
        check(); r = this.persist(pair, r!, 'closed');
        check(); a.setPairedTransfer(p.source.turnId, transferId, p.source.relativePath, true);
        check(); b.setPairedTransfer(p.target.turnId, transferId, p.target.relativePath, true);
      }
      return { code: purpose === 'move' ? 'A9_TRANSFER_MOVED' : 'A9_TRANSFER_UNDONE', transferId, phase: r!.phase, targetPublished, sourceDeleted };
    } catch (error) {
      const code = error instanceof OfficeTransferError ? error.code : 'A9_TRANSFER_IO_FAILED';
      return { code, transferId, phase: r?.phase, targetPublished, sourceDeleted };
    } finally { this.plans.delete(planId); this.busy = false; }
  }
}
