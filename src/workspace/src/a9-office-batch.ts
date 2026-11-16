/** A9-70 P1. Electron 22 / Node 16 built-ins only. Cooperative host work;
 * not a sandbox. Path checks cannot close races with another OS process.
 * No Hidden-attribute API, crash replay, ZIP, UI or model calls here.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CheckpointManager } from './checkpoint-manager';
import { IoGuard, captureAnchor, captureNearestAnchor, samePath, assertAnchor } from './directory-identity';

export const OFFICE_BATCH_LIMITS = Object.freeze({ files: 2000, entries: 8000, fileBytes: 16 * 1024 * 1024,
  totalHashBytes: 64 * 1024 * 1024, returnBytes: 512 * 1024, planBytes: 128 * 1024, actions: 100, plans: 16, outputPath: 240 });
export class OfficeBatchError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'OfficeBatchError'; }
}
function fail(code: string): never { throw new OfficeBatchError(code); }
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) fail('BATCH_CANCELLED'); }
function errorCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code || 'BATCH_IO_UNKNOWN').slice(0, 80);
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const digest = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
interface FileIdentity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; }
function identity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function fileStat(file: string, guard: IoGuard): fs.Stats {
  guard.check(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('BATCH_NOT_REGULAR_FILE');
  return stat;
}
/** Open/check/read/check through a verified descriptor, bounded even if a writer grows the file. */
async function hashFile(file: string, guard: IoGuard, max: number, signal?: AbortSignal): Promise<{ sha256: string; identity: FileIdentity }> {
  cancelled(signal);
  const before = fileStat(file, guard);
  if (before.size > max) fail('BATCH_FILE_BYTE_LIMIT');
  guard.check(file);
  const fd = fs.openSync(file, 'r');
  try {
    if (!sameFile(identity(before), identity(fs.fstatSync(fd)))) fail('BATCH_SOURCE_DRIFT');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      cancelled(signal); guard.check(file);
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!n) fail('BATCH_SOURCE_DRIFT');
      hash.update(buffer.subarray(0, n)); offset += n;
      await tick();
    }
    cancelled(signal);
    if (!sameFile(identity(before), identity(fs.fstatSync(fd))) || !sameFile(identity(before), identity(fileStat(file, guard)))) fail('BATCH_SOURCE_DRIFT');
    return { sha256: hash.digest('hex'), identity: identity(before) };
  } finally { fs.closeSync(fd); }
}
function absent(file: string, guard: IoGuard): void {
  guard.check(file);
  try { fs.lstatSync(file); } catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
  fail('BATCH_TARGET_EXISTS');
}
function excluded(relative: string): boolean {
  return relative.split('/').some(s => ['.git', '.agent_recovery'].includes(s.toLowerCase()) || /^_待清理隔离区_/.test(s)) || /^~\$/.test(path.basename(relative));
}
function relativeName(value: string, output = false): void {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\x00-\x1f:*?"<>|]/.test(value) || path.isAbsolute(value)) fail('BATCH_PATH_INVALID');
  if (value.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) fail('BATCH_PATH_INVALID');
  if (output && value.split('/').some(s => ['.git', '.agent_recovery'].includes(s.toLowerCase()) || /^~\$/.test(s))) fail('BATCH_PATH_INVALID');
  if (output && excluded(value) && !/^_待清理隔离区_\d{8}\//.test(value)) fail('BATCH_PATH_INVALID');
}
export interface OfficeBatchIdentity { workspaceId: string; conversationId: string; turnId: string; }
function validateIdentity(value: OfficeBatchIdentity): void {
  if (!value || Object.keys(value).sort().join(',') !== 'conversationId,turnId,workspaceId' ||
    Object.values(value).some(v => typeof v !== 'string' || !/^[\w.-]{1,128}$/.test(v))) fail('BATCH_IDENTITY_INVALID');
}
function identityKey(value: OfficeBatchIdentity): string { validateIdentity(value); return JSON.stringify([value.workspaceId, value.conversationId, value.turnId]); }
export interface OfficeScanOptions { hash?: 'none' | 'size_groups'; maxFiles?: number; maxFileBytes?: number; maxReturnBytes?: number; signal?: AbortSignal; }
export interface OfficeMetadata {
  path: string; type: 'file' | 'directory' | 'symlink' | 'other'; sizeBytes: number; mtimeMs: number; extension: string;
  sha256?: string; hashSkipped?: string;
}
export interface OfficeMetadataScan {
  schemaVersion: 1; entries: OfficeMetadata[]; skipped: Array<{ path: string; reason: string }>;
  status: 'completed' | 'cancelled'; truncated: boolean; truncationReasons: string[];
  limitations: string[];
}
export type OfficeOrganizeActionInput = { kind: 'move' | 'rename' | 'quarantine_duplicate' | 'skip_conflict'; source: string; destination?: string; duplicateOf?: string; };
export interface OfficeOrganizeAction extends OfficeOrganizeActionInput {
  actionId: string; sourceSha256: string; sourceIdentity: FileIdentity; duplicateSha256?: string; duplicateIdentity?: FileIdentity;
}
export interface OfficeOrganizePlan {
  schemaVersion: 1; planId: string; version: 1; identity: OfficeBatchIdentity; actions: ReadonlyArray<OfficeOrganizeAction>;
  exact_duplicates: ReadonlyArray<{ sha256: string; paths: string[] }>;
  version_candidates: ReadonlyArray<{ name: string; paths: string[] }>;
  approvalRequired: true;
}
export interface OfficeBatchApprovalBinding {
  schemaVersion: 1; planId: string; version: 1; identity: OfficeBatchIdentity; workspaceRoot: string;
  selectedActions: ReadonlyArray<OfficeOrganizeAction>; bindingSha256: string;
}
/** Supplied only by trusted host wiring. Core/Policy must consume a one-use,
 * target-bound UI authorization here; no model argument grants permission. */
export interface OfficeBatchApprovalPort {
  consume(approvalId: string, binding: OfficeBatchApprovalBinding): Promise<{ status: 'approved'; bindingSha256: string }>;
}
export interface OfficeBatchExecuteOptions {
  planId: string; identity: OfficeBatchIdentity; selectedActionIds: string[]; approvalId: string; signal?: AbortSignal;
}
export interface OfficeBatchOperationResult {
  actionId: string; source: string; destination?: string; status: 'succeeded' | 'skipped' | 'failed' | 'cancelled';
  kind: OfficeOrganizeActionInput['kind']; sourceSha256: string;
  code: string; targetPublished: boolean; sourceRemoved: boolean; recovery: 'recorded' | 'unknown' | 'not_needed';
  transfer?: 'hardlink' | 'exdev_copy';
  cleanupCode?: string; residualTemporary?: string;
}
export interface OfficeBatchResult {
  schemaVersion: 1; planId: string; status: 'completed' | 'cancelled' | 'stopped'; operations: OfficeBatchOperationResult[];
  manifestMarkdown: string; manifestCsv: string;
}
interface StoredPlan { plan: OfficeOrganizePlan; guard: IoGuard; used: boolean; key: string; }
type Resolver = (value: string) => { absPath: string; relPath: string; isOutside: boolean };

export class OfficeBatchService {
  private readonly plans = new Map<string, StoredPlan>();
  private active = false;
  constructor(private readonly root: string, private readonly checkpoint: CheckpointManager,
    private readonly resolve: Resolver, private readonly approval?: OfficeBatchApprovalPort) {}

  private filePath(value: string, output = false): string {
    relativeName(value, output);
    const absolute = path.resolve(this.root, value);
    const resolved = this.resolve(value);
    if (resolved.isOutside || !samePath(absolute, resolved.absPath)) fail('BATCH_PATH_REDIRECTED');
    // Reject links in every existing component, including links to inside the workspace.
    let probe = this.root;
    for (const segment of value.split('/')) {
      probe = path.join(probe, segment);
      try { if (fs.lstatSync(probe).isSymbolicLink()) fail('BATCH_PATH_REDIRECTED'); }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    if (output && (absolute.length > OFFICE_BATCH_LIMITS.outputPath ||
      path.join(path.dirname(absolute), '.a9-batch-0000000000000000.tmp').length > OFFICE_BATCH_LIMITS.outputPath)) fail('BATCH_PATH_TOO_LONG');
    return absolute;
  }

  async scan(target = '', options: OfficeScanOptions = {}): Promise<OfficeMetadataScan> {
    const limit = (n: number | undefined, fallback: number, minimum = 1): number => {
      if (n !== undefined && (!Number.isSafeInteger(n) || n < minimum || n > fallback)) fail('BATCH_LIMIT_INVALID');
      return n ?? fallback;
    };
    const maxFiles = limit(options.maxFiles, OFFICE_BATCH_LIMITS.files);
    const maxFileBytes = limit(options.maxFileBytes, OFFICE_BATCH_LIMITS.fileBytes);
    const maxReturn = limit(options.maxReturnBytes, OFFICE_BATCH_LIMITS.returnBytes, 1024);
    if (options.hash !== undefined && !['none', 'size_groups'].includes(options.hash)) fail('BATCH_HASH_MODE_INVALID');
    const start = target ? this.filePath(target) : this.resolve('').absPath;
    if (target && excluded(target)) fail('BATCH_PATH_EXCLUDED');
    const startAnchor = captureAnchor(start);
    const guard = new IoGuard([captureAnchor(this.root), startAnchor]);
    const directoryAnchors = new Map([[start, startAnchor]]);
    const observed = new Map<string, FileIdentity>();
    const result: OfficeMetadataScan = { schemaVersion: 1, entries: [], skipped: [], status: 'completed', truncated: false,
      truncationReasons: [], limitations: ['WINDOWS_HIDDEN_ATTRIBUTE_NOT_AVAILABLE', 'TRUSTED_WORKSPACE_PATH_RACES_NOT_ATOMIC'] };
    let bytes = 512, visited = 0, files = 0;
    const stop = (reason: string): void => { result.truncated = true; if (!result.truncationReasons.includes(reason)) result.truncationReasons.push(reason); };
    const add = (item: OfficeMetadata | { path: string; reason: string }): boolean => {
      const cost = Buffer.byteLength(JSON.stringify(item), 'utf8') + 256; // reserve hash/status fields
      if (bytes + cost > maxReturn) { stop('return_bytes'); return false; }
      bytes += cost;
      if ('reason' in item) result.skipped.push(item); else result.entries.push(item);
      return true;
    };
    const stack = [start];
    try {
      while (stack.length && !result.truncated) {
        cancelled(options.signal);
        const dir = stack.pop()!;
        const dirGuard = guard.with([directoryAnchors.get(dir)!]);
        dirGuard.checkInside(dir);
        const handle = fs.opendirSync(dir);
        const children: string[] = [];
        try {
          for (;;) {
            cancelled(options.signal); dirGuard.checkInside(dir);
            const entry = handle.readSync(); if (!entry) break;
            if (++visited > OFFICE_BATCH_LIMITS.entries) { stop('entries'); break; }
            children.push(entry.name);
            if (visited % 32 === 0) await tick();
          }
        } finally { handle.closeSync(); }
        children.sort(compare);
        const directories: string[] = [];
        for (const name of children) {
          cancelled(options.signal);
          const absolute = path.join(dir, name), relative = path.relative(this.root, absolute).replace(/\\/g, '/');
          if (excluded(relative)) { if (!add({ path: relative, reason: 'excluded' })) break; continue; }
          dirGuard.check(absolute);
          const stat = fs.lstatSync(absolute);
          if (stat.isSymbolicLink()) { if (!add({ path: relative, reason: 'reparse_or_symlink' })) break; continue; }
          const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
          if (type === 'file' && ++files > maxFiles) { stop('files'); break; }
          if (!add({ path: relative, type, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, extension: path.extname(name).toLowerCase() })) break;
          if (type === 'file') observed.set(relative, identity(stat));
          if (type === 'directory') { directoryAnchors.set(absolute, captureAnchor(absolute)); directories.push(absolute); }
          await tick(); dirGuard.check(absolute);
        }
        stack.push(...directories.reverse());
      }
      if (options.hash === 'size_groups') {
        const groups = new Map<number, OfficeMetadata[]>();
        for (const entry of result.entries.filter(e => e.type === 'file')) groups.set(entry.sizeBytes, [...(groups.get(entry.sizeBytes) || []), entry]);
        let hashedBytes = 0;
        for (const entry of result.entries.filter(e => e.type === 'file')) {
          cancelled(options.signal);
          if (groups.get(entry.sizeBytes)!.length < 2) { entry.hashSkipped = 'unique_size'; continue; }
          if (entry.sizeBytes > maxFileBytes) { entry.hashSkipped = 'file_bytes'; continue; }
          if (hashedBytes + entry.sizeBytes > OFFICE_BATCH_LIMITS.totalHashBytes) { entry.hashSkipped = 'total_hash_bytes'; continue; }
          const absolute = this.filePath(entry.path), currentGuard = guard.with([directoryAnchors.get(path.dirname(absolute))!]);
          const fact = await hashFile(absolute, currentGuard, maxFileBytes, options.signal);
          if (!sameFile(fact.identity, observed.get(entry.path)!)) fail('BATCH_SOURCE_DRIFT');
          entry.sha256 = fact.sha256; hashedBytes += entry.sizeBytes;
        }
      }
      guard.assertAnchors();
      for (const anchor of directoryAnchors.values()) assertAnchor(anchor);
    } catch (error) {
      if (errorCode(error) !== 'BATCH_CANCELLED') throw error;
      result.status = 'cancelled'; stop('cancelled');
    }
    result.entries.sort((a, b) => compare(a.path, b.path)); result.skipped.sort((a, b) => compare(a.path, b.path));
    return result;
  }

  async plan(binding: OfficeBatchIdentity, inputs: OfficeOrganizeActionInput[], signal?: AbortSignal): Promise<OfficeOrganizePlan> {
    const key = identityKey(binding);
    const boundIdentity = { ...binding };
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > OFFICE_BATCH_LIMITS.actions) fail('BATCH_ACTION_LIMIT');
    if (this.plans.size >= OFFICE_BATCH_LIMITS.plans) {
      const consumed = [...this.plans].find(([, stored]) => stored.used);
      if (consumed) this.plans.delete(consumed[0]); // evicted IDs remain unexecutable
    }
    if (this.plans.size >= OFFICE_BATCH_LIMITS.plans) fail('BATCH_PLAN_LIMIT');
    // Copy untrusted inputs before the first await.
    const requested: OfficeOrganizeActionInput[] = inputs.map(input => {
      if (!input || Object.keys(input).some(k => !['kind', 'source', 'destination', 'duplicateOf'].includes(k)) ||
        !['move', 'rename', 'quarantine_duplicate', 'skip_conflict'].includes(input.kind)) fail('BATCH_ACTION_INVALID');
      return { ...input };
    });
    const paths = requested.flatMap(a => [this.filePath(a.source), ...(a.destination ? [this.filePath(a.destination, true)] : []), ...(a.duplicateOf ? [this.filePath(a.duplicateOf)] : [])]);
    const guard = new IoGuard([captureAnchor(this.root), ...paths.map(p => captureNearestAnchor(path.dirname(p)))]);
    const seen = new Set<string>(), destinations = new Set<string>();
    let total = 0;
    const facts = new Map<string, { sha256: string; identity: FileIdentity }>();
    const read = async (name: string) => {
      if (facts.has(name)) return facts.get(name)!;
      const absolute = this.filePath(name), stat = fileStat(absolute, guard);
      total += stat.size; if (total > OFFICE_BATCH_LIMITS.totalHashBytes) fail('BATCH_TOTAL_BYTE_LIMIT');
      const fact = await hashFile(absolute, guard, OFFICE_BATCH_LIMITS.fileBytes, signal); facts.set(name, fact); return fact;
    };
    const actions: OfficeOrganizeAction[] = [];
    for (const input of requested) {
      cancelled(signal);
      const sourceKey = input.source.toLowerCase();
      if (seen.has(sourceKey) || excluded(input.source)) fail('BATCH_ACTION_CONFLICT');
      seen.add(sourceKey);
      if (input.kind !== 'skip_conflict') {
        if (!input.destination) fail('BATCH_ACTION_INVALID');
        const destinationKey = input.destination.toLowerCase();
        if (destinationKey === sourceKey || destinations.has(destinationKey)) fail('BATCH_ACTION_CONFLICT');
        destinations.add(destinationKey); absent(this.filePath(input.destination, true), guard);
      }
      const source = await read(input.source);
      const action: OfficeOrganizeAction = { ...input, actionId: `a${String(actions.length + 1).padStart(3, '0')}`, sourceSha256: source.sha256, sourceIdentity: source.identity };
      if (input.kind === 'quarantine_duplicate') {
        if (!input.duplicateOf || input.duplicateOf.toLowerCase() === sourceKey || excluded(input.duplicateOf) || !/^_待清理隔离区_\d{8}\//.test(input.destination!)) fail('BATCH_DUPLICATE_INVALID');
        const duplicate = await read(input.duplicateOf);
        if (duplicate.sha256 !== source.sha256) fail('BATCH_NOT_EXACT_DUPLICATE');
        action.duplicateSha256 = duplicate.sha256; action.duplicateIdentity = duplicate.identity;
      } else if (input.duplicateOf) fail('BATCH_ACTION_INVALID');
      actions.push(action);
    }
    if ([...destinations].some(d => seen.has(d)) || actions.some(a => a.duplicateOf && seen.has(a.duplicateOf.toLowerCase()) && actions.some(b => b.source === a.duplicateOf && b.kind !== 'skip_conflict'))) fail('BATCH_ACTION_CONFLICT');
    guard.assertAnchors();
    const byHash = new Map<string, string[]>(), byName = new Map<string, string[]>();
    for (const [name, fact] of facts) {
      byHash.set(fact.sha256, [...(byHash.get(fact.sha256) || []), name]);
      const parsed = path.parse(name);
      const stem = parsed.name.toLowerCase().replace(/(?:[ _-]*(?:v\d+|最终稿|终稿|副本|\d{8}))+$/g, '') + parsed.ext.toLowerCase();
      byName.set(stem, [...(byName.get(stem) || []), name]);
    }
    const plan = freeze<OfficeOrganizePlan>({ schemaVersion: 1, planId: crypto.randomBytes(16).toString('hex'), version: 1,
      identity: boundIdentity, actions,
      exact_duplicates: [...byHash].filter(([, p]) => p.length > 1).map(([sha256, p]) => ({ sha256, paths: p.sort(compare) })),
      version_candidates: [...byName].filter(([, p]) => p.length > 1 && new Set(p.map(n => facts.get(n)!.sha256)).size > 1).map(([name, p]) => ({ name, paths: p.sort(compare) })), approvalRequired: true });
    // Reserve room for operation rows plus both escaped inventory formats.
    if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > OFFICE_BATCH_LIMITS.planBytes) fail('BATCH_RETURN_BYTE_LIMIT');
    if (this.plans.size >= OFFICE_BATCH_LIMITS.plans) fail('BATCH_PLAN_LIMIT');
    this.plans.set(plan.planId, { plan, key, guard, used: false }); return plan;
  }

  private async verify(action: OfficeOrganizeAction, guard: IoGuard, signal?: AbortSignal): Promise<void> {
    for (const [name, hash, fact] of [[action.source, action.sourceSha256, action.sourceIdentity],
      ...(action.duplicateOf ? [[action.duplicateOf, action.duplicateSha256!, action.duplicateIdentity!]] : [])] as Array<[string, string, FileIdentity]>) {
      const current = await hashFile(this.filePath(name), guard, OFFICE_BATCH_LIMITS.fileBytes, signal);
      if (current.sha256 !== hash || !sameFile(current.identity, fact)) fail('BATCH_SOURCE_DRIFT');
    }
    if (action.kind !== 'skip_conflict') absent(this.filePath(action.destination!, true), guard);
  }

  /** Read-only host preview, regenerated before approval and on resume. */
  async prepare(options: Omit<OfficeBatchExecuteOptions, 'approvalId'>): Promise<OfficeBatchApprovalBinding> {
    const stored = this.plans.get(options.planId);
    if (!stored) fail('BATCH_PLAN_UNKNOWN');
    if (stored.used) fail('BATCH_PLAN_CONSUMED');
    if (identityKey(options.identity) !== stored.key) fail('BATCH_IDENTITY_MISMATCH');
    if (!Array.isArray(options.selectedActionIds) || !options.selectedActionIds.length ||
        new Set(options.selectedActionIds).size !== options.selectedActionIds.length ||
        options.selectedActionIds.some(id => !stored.plan.actions.some(a => a.actionId === id))) fail('BATCH_SELECTION_INVALID');
    const selected = stored.plan.actions.filter(a => options.selectedActionIds.includes(a.actionId));
    stored.guard.assertAnchors();
    for (const action of selected) await this.verify(action, stored.guard, options.signal);
    const base = { schemaVersion: 1 as const, planId: stored.plan.planId, version: 1 as const,
      identity: stored.plan.identity, workspaceRoot: this.root, selectedActions: selected };
    return freeze({ ...base, bindingSha256: digest(JSON.stringify(base)) });
  }

  async execute(options: OfficeBatchExecuteOptions): Promise<OfficeBatchResult> {
    if (this.active) fail('BATCH_BUSY');
    const stored = this.plans.get(options.planId);
    if (!stored) fail('BATCH_PLAN_UNKNOWN');
    if (stored.used) fail('BATCH_PLAN_CONSUMED');
    if (identityKey(options.identity) !== stored.key) fail('BATCH_IDENTITY_MISMATCH');
    if (!Array.isArray(options.selectedActionIds) || !options.selectedActionIds.length ||
      new Set(options.selectedActionIds).size !== options.selectedActionIds.length || options.selectedActionIds.some(id => !stored.plan.actions.some(a => a.actionId === id))) fail('BATCH_SELECTION_INVALID');
    if (!this.approval || typeof options.approvalId !== 'string' || !options.approvalId) fail('BATCH_APPROVAL_REQUIRED');
    const signal = options.signal, approvalId = options.approvalId;
    const selected = stored.plan.actions.filter(a => options.selectedActionIds.includes(a.actionId));
    const base = { schemaVersion: 1 as const, planId: stored.plan.planId, version: 1 as const, identity: stored.plan.identity, workspaceRoot: this.root, selectedActions: selected };
    const authorization = freeze({ ...base, bindingSha256: digest(JSON.stringify(base)) });
    this.active = true; stored.used = true; // claim before awaiting host or filesystem work
    const result: OfficeBatchResult = { schemaVersion: 1, planId: options.planId, status: 'completed', operations: [], manifestMarkdown: '', manifestCsv: '' };
    try {
      cancelled(signal); stored.guard.assertAnchors();
      const approved = await this.approval.consume(approvalId, authorization);
      if (!approved || approved.status !== 'approved' || approved.bindingSha256 !== authorization.bindingSha256) fail('BATCH_APPROVAL_REJECTED');
      // Preflight ALL selected actions before creating the recovery store or moving any file.
      for (const action of selected) await this.verify(action, stored.guard, signal);
      for (const action of selected) {
        const row: OfficeBatchOperationResult = { actionId: action.actionId, source: action.source, destination: action.destination,
          kind: action.kind, sourceSha256: action.sourceSha256,
          status: 'skipped', code: 'BATCH_NOT_SELECTED', targetPublished: false, sourceRemoved: false, recovery: 'not_needed' };
        result.operations.push(row);
        if (result.status !== 'completed') { row.code = 'BATCH_STOPPED'; continue; }
        try {
          cancelled(signal); stored.guard.assertAnchors();
          if (action.kind === 'skip_conflict') { row.code = 'BATCH_SKIP_CONFLICT'; continue; }
          await this.verify(action, stored.guard, signal);
          const source = this.filePath(action.source), destination = this.filePath(action.destination!, true);
          // Plans bind the parent identities without writing. Execution adds the existing recovery guard.
          const guard = this.checkpoint.createIoGuard([source, destination]).with([() => { stored.guard.assertAnchors(); return undefined; }]);
          await this.moveFile(action, source, destination, stored.plan.identity.turnId, guard, row, signal);
          row.status = 'succeeded'; row.code = 'BATCH_OK';
        } catch (error) {
          row.code = errorCode(error);
          row.status = row.code === 'BATCH_CANCELLED' ? 'cancelled' : row.code === 'BATCH_TARGET_EXISTS' || row.code === 'EBUSY' ? 'skipped' : 'failed';
          if (row.status === 'cancelled') result.status = 'cancelled';
          else if (row.status === 'failed' || row.recovery === 'unknown') result.status = 'stopped';
        }
      }
    } catch (error) {
      if (errorCode(error) !== 'BATCH_CANCELLED') throw error;
      result.status = 'cancelled';
      for (const action of selected) result.operations.push({ actionId: action.actionId, source: action.source, destination: action.destination,
        kind: action.kind, sourceSha256: action.sourceSha256,
        status: 'cancelled', code: 'BATCH_CANCELLED', targetPublished: false, sourceRemoved: false, recovery: 'not_needed' });
    } finally { this.active = false; }
    result.operations.sort((a, b) => compare(a.actionId, b.actionId));
    const cell = (s: string): string => s.replace(/[\r\n|]/g, ' ').replace(/([\\`*_[\]])/g, '\\$1');
    const csv = (s: string): string => '"' + (/^\s*[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"';
    result.manifestMarkdown = '# 文件整理与去重清单\n\n| 动作 | 类型 | 源 | 目标 | 源 SHA-256 | 结果 | 代码 | 恢复 | 临时残留 |\n|---|---|---|---|---|---|---|---|---|\n' + result.operations.map(r => `| ${[r.actionId, r.kind, r.source, r.destination || '', r.sourceSha256, r.status, r.code + (r.cleanupCode ? ` / ${r.cleanupCode}` : ''), r.recovery, r.residualTemporary || ''].map(cell).join(' | ')} |`).join('\n') + '\n';
    result.manifestCsv = ['actionId,kind,source,destination,sourceSha256,status,code,recovery,cleanupCode,residualTemporary', ...result.operations.map(r => [r.actionId, r.kind, r.source, r.destination || '', r.sourceSha256, r.status, r.code, r.recovery, r.cleanupCode || '', r.residualTemporary || ''].map(csv).join(','))].join('\n') + '\n';
    return result;
  }

  private async moveFile(action: OfficeOrganizeAction, source: string, destination: string, turnId: string,
    guard: IoGuard, row: OfficeBatchOperationResult, signal?: AbortSignal): Promise<void> {
    // Existing checkpoint preserves source bytes and absent destination before publication.
    const baseline = await this.checkpoint.recordPreMutationAsync(turnId, action.source, { guard, signal });
    if (baseline.unrecoverable || (!baseline.originalBlobPath && baseline.originalKind !== 'absent')) fail('BATCH_RECOVERY_UNAVAILABLE');
    await this.checkpoint.recordPreMutationAsync(turnId, action.destination!, { guard, signal });
    await this.verify(action, guard, signal);
    // Establish unchanged source post-state too: cancellation before unlink must
    // not leave a baseline with an unknown newHash or authorize undo of human edits.
    await this.checkpoint.recordPostMutationAsync(turnId, action.source, 'modify', { guard });
    guard.ensureDirectory(path.dirname(destination));
    guard = guard.with([captureAnchor(path.dirname(destination))]);
    const temporary = path.join(path.dirname(destination), `.a9-batch-${crypto.randomBytes(8).toString('hex')}.tmp`);
    if (temporary.length > OFFICE_BATCH_LIMITS.outputPath) fail('BATCH_PATH_TOO_LONG');
    // Checkpoint this temp as well: after interruption the facts can be inspected/undone;
    // a new service has no live plans and cannot replay a previous authorization.
    const tempRel = path.relative(this.root, temporary).replace(/\\/g, '/');
    await this.checkpoint.recordPreMutationAsync(turnId, tempRel, { guard, signal });
    let tempIdentity: FileIdentity | undefined;
    let sourceAfterStage: FileIdentity = action.sourceIdentity;
    let phaseFailed = false;
    try {
      cancelled(signal); guard.check(source); guard.check(temporary);
      try {
        fs.linkSync(source, temporary); row.residualTemporary = tempRel;
        tempIdentity = identity(fileStat(temporary, guard)); sourceAfterStage = identity(fileStat(source, guard)); row.transfer = 'hardlink';
      }
      catch (error) {
        if (errorCode(error) !== 'EXDEV') throw error;
        row.transfer = 'exdev_copy';
        await this.copyBytes(source, temporary, action, guard, signal, fact => { tempIdentity = fact; row.residualTemporary = tempRel; });
      }
      const tempNow = fileStat(temporary, guard);
      if (!tempIdentity || tempIdentity.dev !== tempNow.dev || tempIdentity.ino !== tempNow.ino) fail('BATCH_TEMP_IDENTITY_CHANGED');
      await this.checkpoint.recordPostMutationAsync(turnId, tempRel, 'create', { guard });
      const copied = await hashFile(temporary, guard, OFFICE_BATCH_LIMITS.fileBytes, signal);
      const current = await hashFile(source, guard, OFFICE_BATCH_LIMITS.fileBytes, signal);
      // link() legitimately changes ctime. Bind its new identity before the first yield.
      if (copied.sha256 !== action.sourceSha256 || current.sha256 !== action.sourceSha256 ||
        !sameFile(current.identity, sourceAfterStage)) fail('BATCH_SOURCE_DRIFT');
      if (!sameFile(identity(fileStat(source, guard)), current.identity)) fail('BATCH_SOURCE_DRIFT');
      if (!sameFile(identity(fileStat(temporary, guard)), copied.identity)) fail('BATCH_TEMP_IDENTITY_CHANGED');
      if (action.duplicateOf && !sameFile(identity(fileStat(this.filePath(action.duplicateOf), guard)), action.duplicateIdentity!)) fail('BATCH_SOURCE_DRIFT');
      cancelled(signal); absent(destination, guard); guard.check(temporary);
      fs.linkSync(temporary, destination); row.targetPublished = true; row.recovery = 'unknown';
      const sourceAtPublication = identity(fileStat(source, guard));
      await this.checkpoint.recordPostMutationAsync(turnId, action.destination!, 'create', { guard });
      row.recovery = 'recorded';
      // Source remains intact until the published destination has a durable recovery fact.
      cancelled(signal);
      const sourceBeforeDelete = await hashFile(source, guard, OFFICE_BATCH_LIMITS.fileBytes, signal);
      const targetBeforeDelete = await hashFile(destination, guard, OFFICE_BATCH_LIMITS.fileBytes, signal);
      if (sourceBeforeDelete.sha256 !== action.sourceSha256 || targetBeforeDelete.sha256 !== action.sourceSha256 ||
        !sameFile(sourceBeforeDelete.identity, sourceAtPublication) || targetBeforeDelete.identity.dev !== tempIdentity.dev ||
        targetBeforeDelete.identity.ino !== tempIdentity.ino) fail('BATCH_SOURCE_DRIFT');
      // Hashing the target yielded after hashing the source. Recheck both leaf
      // identities in this same JS turn before the destructive source step.
      if (!sameFile(identity(fileStat(source, guard)), sourceBeforeDelete.identity) ||
        !sameFile(identity(fileStat(destination, guard)), targetBeforeDelete.identity)) fail('BATCH_SOURCE_DRIFT');
      if (action.duplicateOf && !sameFile(identity(fileStat(this.filePath(action.duplicateOf), guard)), action.duplicateIdentity!)) fail('BATCH_SOURCE_DRIFT');
      cancelled(signal); guard.check(source); fs.unlinkSync(source); row.sourceRemoved = true; row.recovery = 'unknown';
      await this.checkpoint.recordPostMutationAsync(turnId, action.source, 'delete', { guard }); row.recovery = 'recorded';
    } catch (error) { phaseFailed = true; throw error; }
    finally {
      // Never remove an externally replaced temporary or touch a redirected parent.
      if (tempIdentity) {
        try {
          guard.check(temporary);
          const current = fileStat(temporary, guard);
          if (current.dev !== tempIdentity.dev || current.ino !== tempIdentity.ino) fail('BATCH_TEMP_IDENTITY_CHANGED');
          fs.unlinkSync(temporary);
          row.residualTemporary = undefined;
          await this.checkpoint.recordPostMutationAsync(turnId, tempRel, 'delete', { guard });
        } catch (error) { row.recovery = 'unknown'; row.cleanupCode = errorCode(error); if (!phaseFailed) throw error; }
      }
    }
  }

  private async copyBytes(source: string, target: string, action: OfficeOrganizeAction, guard: IoGuard,
    signal: AbortSignal | undefined, created: (fact: FileIdentity) => void): Promise<void> {
    guard.check(source); const input = fs.openSync(source, 'r');
    let output: number | undefined;
    try {
      if (!sameFile(identity(fs.fstatSync(input)), action.sourceIdentity)) fail('BATCH_SOURCE_DRIFT');
      guard.check(target); output = fs.openSync(target, 'wx'); created(identity(fs.fstatSync(output)));
      const buffer = Buffer.alloc(64 * 1024); let offset = 0;
      while (offset < action.sourceIdentity.size) {
        cancelled(signal); guard.check(source); guard.check(target);
        const currentTarget = fileStat(target, guard), openedTarget = fs.fstatSync(output);
        if (currentTarget.dev !== openedTarget.dev || currentTarget.ino !== openedTarget.ino) fail('BATCH_TEMP_IDENTITY_CHANGED');
        const n = fs.readSync(input, buffer, 0, Math.min(buffer.length, action.sourceIdentity.size - offset), offset);
        if (!n) fail('BATCH_SOURCE_DRIFT');
        let written = 0;
        while (written < n) { const count = fs.writeSync(output, buffer, written, n - written, offset + written); if (!count) fail('BATCH_COPY_INCOMPLETE'); written += count; }
        offset += n; await tick();
      }
      if (!sameFile(identity(fs.fstatSync(input)), action.sourceIdentity)) fail('BATCH_SOURCE_DRIFT');
      fs.fsyncSync(output);
    } finally { if (output !== undefined) fs.closeSync(output); fs.closeSync(input); }
  }
}
