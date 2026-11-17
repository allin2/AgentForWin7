/** A9-70 P3. DOCX template inspection, mapping, normal/boundary samples & confirmed batch output.
 * Worker uses locked docxtemplater 3.71.1 + pizzip 3.3.0. Host owns SHA binding,
 * sample confirmation gate, exclusive publication, path validation and checkpoints.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CheckpointManager } from './checkpoint-manager';
import { IoGuard, captureAnchor, captureNearestAnchor, samePath } from './directory-identity';
import { OfficeBatchIdentity } from './a9-office-batch';
import { readOfficeFile, officePath } from './a9-office-files';

export const OFFICE_TEMPLATE_LIMITS = Object.freeze({
  maxTemplateBytes: 4 * 1024 * 1024,
  maxDataFileBytes: 2 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxTotalOutputBytes: 128 * 1024 * 1024,
  maxRecords: 200,
  maxFieldChars: 16384,
  outputPathChars: 240,
  maxPlans: 16,
  maxSamples: 16,
});

const SAFE_TAG_RE = /^(?:\.|[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*)$/u;
const SAFE_FIELD_RE = /^[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*$/u;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const EMPTY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export class OfficeTemplateError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'OfficeTemplateError';
  }
}

function fail(code: string, details?: Record<string, unknown>): never {
  throw new OfficeTemplateError(code, details);
}

function errorCode(error: unknown): string {
  if (error instanceof OfficeTemplateError) return error.code;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code) return code;
  return 'TEMPLATE_FAILED';
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail('TEMPLATE_CANCELLED');
}

const digest = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (v as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return v;
  });
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
function fileIdentity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function fileStat(file: string, guard: IoGuard): fs.Stats {
  guard.check(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('TEMPLATE_NOT_REGULAR_FILE');
  return stat;
}
function absent(file: string, guard: IoGuard): void {
  guard.check(file);
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  fail('TEMPLATE_TARGET_EXISTS');
}

function validateIdentity(value: OfficeBatchIdentity): void {
  if (!value || Object.keys(value).sort().join(',') !== 'conversationId,turnId,workspaceId'
    || Object.values(value).some(v => typeof v !== 'string' || !/^[\w.-]{1,128}$/.test(v))) {
    fail('TEMPLATE_IDENTITY_INVALID');
  }
}
function identityKey(value: OfficeBatchIdentity): string {
  validateIdentity(value);
  return JSON.stringify([value.workspaceId, value.conversationId, value.turnId]);
}

function relativeName(value: string, allowEmpty = false): string {
  if (typeof value !== 'string') fail('TEMPLATE_PATH_INVALID');
  const norm = value === '.' ? '' : value.replace(/\/+$/, '');
  if (allowEmpty && norm === '') return '';
  if (!norm || norm.length > 4096 || /[\\\x00-\x1f:*?"<>|]/.test(norm)
    || path.isAbsolute(norm) || path.win32.isAbsolute(norm)) {
    fail('TEMPLATE_PATH_INVALID');
  }
  const segments = norm.split('/');
  if (segments.some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)
    || ['.git', '.agent_recovery'].includes(s.toLowerCase()) || /^~\$/.test(s)
    || /^_待清理隔离区_/.test(s) || /^\.a9-(?:archive|batch|transfer|tpl)-/i.test(s))) {
    fail('TEMPLATE_PATH_INVALID');
  }
  return norm;
}

function validateScalarText(text: string): void {
  if (text.length > OFFICE_TEMPLATE_LIMITS.maxFieldChars || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(text)) {
    fail('TEMPLATE_VALUE_INVALID');
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('TEMPLATE_VALUE_INVALID');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('TEMPLATE_VALUE_INVALID');
    }
  }
}

export interface TemplateFieldNode {
  name: string;
  path: string;
  kind: 'scalar' | 'loop';
  occurrences: number;
  parts: string[];
  inverted?: boolean;
  children?: TemplateFieldNode[];
}

export interface TemplateInspectResult {
  schemaVersion: 1;
  format: 'docx' | 'pptx';
  path: string;
  templateSha256: string;
  bytes: number;
  fields: TemplateFieldNode[];
  templatedFiles: string[];
  supportedFeatures: string[];
  limitations: string[];
  warnings: string[];
}

export interface TemplateWorkerRenderItem {
  tempPath: string;
  tempIdentity: FileIdentity;
  data: Record<string, unknown>;
}

export interface OfficeTemplateWorkerPort {
  inspectTemplate(buffer: Buffer, format?: 'docx' | 'pptx', signal?: AbortSignal): Promise<Omit<TemplateInspectResult, 'path' | 'templateSha256' | 'bytes'>>;
  renderBatch(
    input: { format?: 'docx' | 'pptx'; templateBuffer: Buffer; items: TemplateWorkerRenderItem[]; maxOutputBytes?: number },
    signal?: AbortSignal,
  ): Promise<{ schemaVersion: 1; format: string; items: Array<{ tempPath: string; bytes: number; sha256: string }> }>;
  close?(): Promise<void>;
}

export interface TemplateLoopMapping {
  source: string;
  fields: Record<string, string>;
}
export type TemplateFieldMapping = Record<string, string | TemplateLoopMapping>;

export interface TemplateOutputRule {
  directory: string;
  filenamePattern: string;
}

export interface TemplateRenderSampleInput {
  templatePath: string;
  templateSha256: string;
  mapping: TemplateFieldMapping;
  normalRecord: Record<string, unknown>;
  boundaryRecord: Record<string, unknown>;
  normalOutputPath: string;
  boundaryOutputPath: string;
  outputRule: TemplateOutputRule;
  viewerEnvironment: string;
  records?: Array<Record<string, unknown>>;
  dataPath?: string;
}

export interface TemplateSamplePlan {
  schemaVersion: 1;
  planId: string;
  identity: OfficeBatchIdentity;
  templatePath: string;
  templateSha256: string;
  mapping: TemplateFieldMapping;
  normalOutputPath: string;
  boundaryOutputPath: string;
  outputRule: TemplateOutputRule;
  viewerEnvironment: string;
  dataBoundAtSample: boolean;
  dataSha256: string;
  dataPath?: string;
  dataFileSha256?: string;
  recordCount?: number;
  approvalRequired: true;
}

export interface TemplateSampleResult {
  schemaVersion: 1;
  planId: string;
  sampleId: string;
  status: 'completed' | 'partial' | 'cancelled' | 'failed';
  code: string;
  templatePath: string;
  templateSha256: string;
  normalOutputPath: string;
  normalSampleSha256?: string;
  normalBytes?: number;
  boundaryOutputPath: string;
  boundarySampleSha256?: string;
  boundaryBytes?: number;
  viewerEnvironment: string;
  confirmedInViewer: boolean;
  sampleConfirmationRequired: true;
  dataBoundAtSample: boolean;
  dataSha256: string;
  recovery: 'recorded' | 'unknown' | 'not_needed';
  warnings: string[];
  limitations: string[];
}

export interface TemplateSampleConfirmation {
  workspaceId: string;
  conversationId: string;
  sampleId: string;
  viewerEnvironment: string;
  normalSampleSha256: string;
  boundarySampleSha256: string;
}

export interface TemplateBatchPlanInput {
  sampleId: string;
  templatePath?: string;
  templateSha256?: string;
  mapping?: TemplateFieldMapping;
  outputRule?: TemplateOutputRule;
  records?: Array<Record<string, unknown>>;
  dataPath?: string;
}

export interface TemplateBatchPlan {
  schemaVersion: 1;
  planId: string;
  identity: OfficeBatchIdentity;
  sampleId: string;
  viewerEnvironment: string;
  templatePath: string;
  templateSha256: string;
  normalOutputPath: string;
  normalSampleSha256: string;
  boundaryOutputPath: string;
  boundarySampleSha256: string;
  mapping: TemplateFieldMapping;
  outputRule: TemplateOutputRule;
  dataSha256: string;
  recordCount: number;
  outputs: ReadonlyArray<{ index: number; outputPath: string }>;
  approvalRequired: true;
}

export interface TemplateBatchResult {
  schemaVersion: 1;
  planId: string;
  sampleId: string;
  status: 'completed' | 'partial' | 'cancelled' | 'failed';
  code: string;
  templatePath: string;
  templateSha256: string;
  viewerEnvironment: string;
  outputs: Array<{ index: number; outputPath: string; status: 'succeeded' | 'failed' | 'cancelled'; sha256?: string; bytes?: number }>;
  recovery: 'recorded' | 'unknown' | 'not_needed';
  checkpointStatus: 'recorded' | 'persistence_failed' | 'not_needed';
  persistenceError?: string;
  cleanupCode?: string;
  residualTemporaries?: string[];
  warnings: string[];
  limitations: string[];
}

export interface TemplateApprovalBinding {
  schemaVersion: 1;
  purpose: 'sample' | 'batch';
  planId: string;
  identity: OfficeBatchIdentity;
  workspaceRoot: string;
  templatePath: string;
  templateSha256: string;
  mapping: TemplateFieldMapping;
  outputRule: TemplateOutputRule;
  viewerEnvironment: string;
  dataSha256: string;
  outputs: ReadonlyArray<string>;
  sampleId?: string;
  bindingSha256: string;
}

export interface OfficeTemplateApprovalPort {
  consume(approvalId: string, binding: TemplateApprovalBinding): Promise<{ status: 'approved'; bindingSha256: string }>;
}

interface StoredSampleState {
  sampleId: string;
  workspaceId: string;
  conversationId: string;
  templatePath: string;
  templateSha256: string;
  mapping: TemplateFieldMapping;
  outputRule: TemplateOutputRule;
  viewerEnvironment: string;
  normalOutputPath: string;
  normalSampleSha256: string;
  boundaryOutputPath: string;
  boundarySampleSha256: string;
  dataBoundAtSample: boolean;
  dataSha256: string;
  boundBatchDataSha256?: string;
  dataPath?: string;
  dataFileSha256?: string;
  boundRecords?: Array<Record<string, unknown>>;
  confirmedInViewer: boolean;
  confirmedAt?: string;
}

interface StoredSamplePlan {
  plan: TemplateSamplePlan;
  key: string;
  used: boolean;
  guard: IoGuard;
  normalAbs: string;
  boundaryAbs: string;
  normalMapped: Record<string, unknown>;
  boundaryMapped: Record<string, unknown>;
  boundRecords?: Array<Record<string, unknown>>;
}

interface StoredBatchPlan {
  plan: TemplateBatchPlan;
  key: string;
  used: boolean;
  guard: IoGuard;
  items: Array<{ index: number; outputPath: string; outputAbs: string; mappedData: Record<string, unknown> }>;
}

type Resolver = (value: string) => { absPath: string; relPath: string; isOutside: boolean };

function assertSafeFieldPath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || !SAFE_FIELD_RE.test(value)) {
    fail('TEMPLATE_MAPPING_INVALID');
  }
  if (value.split('.').some(s => FORBIDDEN_SEGMENTS.has(s))) fail('TEMPLATE_MAPPING_INVALID');
}

function readSourcePath(record: Record<string, unknown>, sourcePath: string): unknown {
  const segments = sourcePath.split('.');
  let cur: unknown = record;
  for (const seg of segments) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setNestedTarget(target: Record<string, unknown>, targetPath: string, value: unknown): void {
  const segments = targetPath.split('.');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (FORBIDDEN_SEGMENTS.has(seg)) fail('TEMPLATE_MAPPING_INVALID');
    const existing = cur[seg];
    if (existing === undefined) {
      cur[seg] = {};
    } else if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      fail('TEMPLATE_MAPPING_CONFLICT');
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (FORBIDDEN_SEGMENTS.has(leaf)) fail('TEMPLATE_MAPPING_INVALID');
  if (Object.prototype.hasOwnProperty.call(cur, leaf) && typeof cur[leaf] === 'object' && cur[leaf] !== null && !Array.isArray(cur[leaf])) {
    fail('TEMPLATE_MAPPING_CONFLICT');
  }
  cur[leaf] = value;
}

function normalizeScalarValue(val: unknown): string | number | boolean {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') {
    validateScalarText(val);
    return val;
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) fail('TEMPLATE_VALUE_INVALID');
    return val;
  }
  if (typeof val === 'boolean') return val;
  fail('TEMPLATE_VALUE_INVALID');
}

function validateAndNormalizeMapping(fields: TemplateFieldNode[], rawMapping: unknown): TemplateFieldMapping {
  if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) fail('TEMPLATE_MAPPING_INVALID');
  const mapping = rawMapping as Record<string, unknown>;
  const fieldByName = new Map(fields.map(f => [f.name, f]));
  for (const key of Object.keys(mapping)) {
    assertSafeFieldPath(key);
    if (!fieldByName.has(key)) fail('TEMPLATE_MAPPING_INVALID');
  }
  const normalized: TemplateFieldMapping = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(mapping, field.name)) fail('TEMPLATE_MAPPING_INCOMPLETE');
    const entry = mapping[field.name];
    if (field.kind === 'scalar') {
      assertSafeFieldPath(entry);
      normalized[field.name] = entry;
    } else {
      const children = field.children || [];
      if (typeof entry === 'string') {
        assertSafeFieldPath(entry);
        const childMap: Record<string, string> = {};
        for (const child of children) {
          if (child.kind !== 'scalar') fail('TEMPLATE_NESTED_LOOP_UNSUPPORTED');
          if (child.name !== '.') childMap[child.name] = child.name;
        }
        normalized[field.name] = { source: entry, fields: childMap };
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const obj = entry as Record<string, unknown>;
        if (Object.keys(obj).some(k => !['source', 'fields'].includes(k))) fail('TEMPLATE_MAPPING_INVALID');
        assertSafeFieldPath(obj.source);
        if (!obj.fields || typeof obj.fields !== 'object' || Array.isArray(obj.fields)) fail('TEMPLATE_MAPPING_INVALID');
        const rawChildFields = obj.fields as Record<string, unknown>;
        const childMap: Record<string, string> = {};
        const childByName = new Map(children.map(c => [c.name, c]));
        for (const ck of Object.keys(rawChildFields)) {
          assertSafeFieldPath(ck);
          if (!childByName.has(ck)) fail('TEMPLATE_MAPPING_INVALID');
        }
        for (const child of children) {
          if (child.kind !== 'scalar') fail('TEMPLATE_NESTED_LOOP_UNSUPPORTED');
          if (child.name === '.') continue;
          if (!Object.prototype.hasOwnProperty.call(rawChildFields, child.name)) fail('TEMPLATE_MAPPING_INCOMPLETE');
          assertSafeFieldPath(rawChildFields[child.name]);
          childMap[child.name] = rawChildFields[child.name] as string;
        }
        normalized[field.name] = { source: obj.source, fields: childMap };
      } else {
        fail('TEMPLATE_MAPPING_INVALID');
      }
    }
  }
  return normalized;
}

function mapRecord(fields: TemplateFieldNode[], mapping: TemplateFieldMapping, record: unknown): Record<string, unknown> {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('TEMPLATE_RECORD_INVALID');
  const rec = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const mapSpec = mapping[field.name];
    if (field.kind === 'scalar') {
      const val = readSourcePath(rec, mapSpec as string);
      setNestedTarget(out, field.name, normalizeScalarValue(val));
    } else {
      const loopSpec = mapSpec as TemplateLoopMapping;
      const arr = readSourcePath(rec, loopSpec.source);
      if (arr === undefined || arr === null) {
        setNestedTarget(out, field.name, []);
        continue;
      }
      const children = field.children || [];
      if (children.length === 0 && typeof arr === 'boolean') {
        setNestedTarget(out, field.name, arr);
        continue;
      }
      if (!Array.isArray(arr) || arr.length > 2000) fail('TEMPLATE_RECORD_INVALID');
      const mappedItems = arr.map((item) => {
        if (children.length === 1 && children[0].name === '.') {
          return normalizeScalarValue(item);
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail('TEMPLATE_RECORD_INVALID');
        const itemOut: Record<string, unknown> = {};
        for (const child of children) {
          if (child.name === '.') continue;
          const srcKey = loopSpec.fields[child.name];
          const val = readSourcePath(item as Record<string, unknown>, srcKey);
          setNestedTarget(itemOut, child.name, normalizeScalarValue(val));
        }
        return itemOut;
      });
      setNestedTarget(out, field.name, mappedItems);
    }
  }
  return out;
}

function validateOutputRule(rawRule: unknown): TemplateOutputRule {
  if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) fail('TEMPLATE_OUTPUT_RULE_INVALID');
  const rule = rawRule as Record<string, unknown>;
  if (Object.keys(rule).some(k => !['directory', 'filenamePattern'].includes(k))) fail('TEMPLATE_OUTPUT_RULE_INVALID');
  const directory = relativeName(String(rule.directory ?? ''), true);
  const pattern = rule.filenamePattern;
  if (typeof pattern !== 'string' || !pattern || pattern.length > 180 || !/\.docx$/i.test(pattern)) {
    fail('TEMPLATE_OUTPUT_RULE_INVALID');
  }
  if (/[\\/\x00-\x1f:*?"<>|]/.test(pattern)) fail('TEMPLATE_OUTPUT_RULE_INVALID');
  const placeholders = [...pattern.matchAll(/\{([^}]+)\}/g)];
  const stripped = pattern.replace(/\{[^}]+\}/g, 'x');
  if (/[{}]/.test(stripped)) fail('TEMPLATE_OUTPUT_RULE_INVALID');
  for (const m of placeholders) {
    const token = m[1];
    if (token !== 'index') assertSafeFieldPath(token);
  }
  return { directory, filenamePattern: pattern };
}

function expandOutputPath(rule: TemplateOutputRule, record: Record<string, unknown>, index: number): string {
  const name = rule.filenamePattern.replace(/\{([^}]+)\}/g, (_all, token: string) => {
    if (token === 'index') return String(index + 1);
    const val = readSourcePath(record, token);
    if (val === undefined || val === null) fail('TEMPLATE_OUTPUT_RULE_VALUE_MISSING');
    const text = String(val).trim();
    if (!text) fail('TEMPLATE_OUTPUT_RULE_VALUE_MISSING');
    validateScalarText(text);
    return text;
  });
  if (!/\.docx$/i.test(name) || name.length > 180) fail('TEMPLATE_OUTPUT_NAME_INVALID');
  const combined = rule.directory ? `${rule.directory}/${name}` : name;
  return relativeName(combined, false);
}

export class OfficeTemplateService {
  private readonly samplePlans = new Map<string, StoredSamplePlan>();
  private readonly batchPlans = new Map<string, StoredBatchPlan>();
  private readonly samples: Map<string, StoredSampleState>;
  private active = false;

  constructor(
    private readonly root: string,
    private readonly checkpoint: CheckpointManager,
    private readonly resolve: Resolver,
    private readonly approval?: OfficeTemplateApprovalPort,
    private readonly worker?: OfficeTemplateWorkerPort,
    sharedSamples?: Map<string, StoredSampleState>,
  ) {
    this.samples = sharedSamples ?? new Map<string, StoredSampleState>();
  }

  private checkNoLinks(value: string): void {
    if (!value) return;
    let probe = this.root;
    for (const seg of value.split('/')) {
      probe = path.join(probe, seg);
      try {
        if (fs.lstatSync(probe).isSymbolicLink()) fail('TEMPLATE_PATH_REDIRECTED');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }

  private resolveOutputDocx(value: string): { relative: string; absolute: string } {
    const relative = relativeName(value, false);
    if (!/\.docx$/i.test(relative)) fail('TEMPLATE_PATH_INVALID');
    const lexicalAbs = path.resolve(this.root, relative);
    const tempSample = path.join(path.dirname(lexicalAbs), `.a9-tpl-${'0'.repeat(16)}.tmp`);
    if (lexicalAbs.length > OFFICE_TEMPLATE_LIMITS.outputPathChars || tempSample.length > OFFICE_TEMPLATE_LIMITS.outputPathChars) {
      fail('TEMPLATE_PATH_TOO_LONG');
    }
    let resolved: { absPath: string; relPath: string; isOutside: boolean };
    try {
      resolved = this.resolve(relative);
    } catch (error: any) {
      if (error && error.code === 'PATH_TOO_LONG') fail('TEMPLATE_PATH_TOO_LONG');
      throw error;
    }
    if (resolved.isOutside || !samePath(lexicalAbs, resolved.absPath)) fail('TEMPLATE_PATH_REDIRECTED');
    this.checkNoLinks(relative);
    return { relative, absolute: lexicalAbs };
  }

  private loadRecordsInput(
    recordsArg: unknown,
    dataPathArg: unknown,
  ): { records: Array<Record<string, unknown>>; dataPath?: string; dataFileSha256?: string } {
    if (recordsArg !== undefined && dataPathArg !== undefined) fail('TEMPLATE_DATA_INPUT_AMBIGUOUS');
    if (dataPathArg !== undefined) {
      if (typeof dataPathArg !== 'string') fail('TEMPLATE_DATA_INVALID');
      const rel = relativeName(dataPathArg, false);
      if (!/\.json$/i.test(rel)) fail('TEMPLATE_DATA_INVALID');
      const resolved = officePath(this.root, rel, false);
      const st = fs.lstatSync(resolved.absolute);
      if (!st.isFile() || st.isSymbolicLink()) fail('TEMPLATE_DATA_INVALID');
      if (st.size > OFFICE_TEMPLATE_LIMITS.maxDataFileBytes) fail('TEMPLATE_DATA_BYTE_LIMIT');
      const raw = fs.readFileSync(resolved.absolute);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch (_err) {
        fail('TEMPLATE_DATA_INVALID');
      }
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > OFFICE_TEMPLATE_LIMITS.maxRecords) {
        fail('TEMPLATE_DATA_INVALID');
      }
      if (parsed.some(r => !r || typeof r !== 'object' || Array.isArray(r))) fail('TEMPLATE_DATA_INVALID');
      return {
        records: parsed as Array<Record<string, unknown>>,
        dataPath: resolved.relative,
        dataFileSha256: digest(raw),
      };
    }
    if (!Array.isArray(recordsArg) || !recordsArg.length || recordsArg.length > OFFICE_TEMPLATE_LIMITS.maxRecords) {
      fail('TEMPLATE_DATA_INVALID');
    }
    if (recordsArg.some(r => !r || typeof r !== 'object' || Array.isArray(r))) fail('TEMPLATE_DATA_INVALID');
    return { records: recordsArg as Array<Record<string, unknown>> };
  }

  async inspect(templatePath: string, signal?: AbortSignal): Promise<TemplateInspectResult> {
    if (!this.worker) fail('TEMPLATE_WORKER_UNAVAILABLE');
    cancelled(signal);
    const rel = relativeName(templatePath, false);
    if (!/\.docx$/i.test(rel)) fail('A9_OFFICE_FORMAT_UNSUPPORTED');
    const file = await readOfficeFile(this.root, rel, signal);
    const inspected = await this.worker.inspectTemplate(file.buffer, 'docx', signal);
    return {
      ...inspected,
      path: file.path,
      templateSha256: file.sha256,
      bytes: file.bytes,
    };
  }

  async planSample(binding: OfficeBatchIdentity, input: TemplateRenderSampleInput, signal?: AbortSignal): Promise<TemplateSamplePlan> {
    if (!this.worker) fail('TEMPLATE_WORKER_UNAVAILABLE');
    cancelled(signal);
    const key = identityKey(binding);
    const boundIdentity = { ...binding };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('TEMPLATE_INPUT_INVALID');
    const allowed = ['templatePath', 'templateSha256', 'mapping', 'normalRecord', 'boundaryRecord',
      'normalOutputPath', 'boundaryOutputPath', 'outputRule', 'viewerEnvironment', 'records', 'dataPath'];
    if (Object.keys(input).some(k => !allowed.includes(k))) fail('TEMPLATE_INPUT_INVALID');
    if (typeof input.viewerEnvironment !== 'string' || !input.viewerEnvironment.trim() || input.viewerEnvironment.length > 128) {
      fail('TEMPLATE_VIEWER_REQUIRED');
    }
    if (!/^[a-f0-9]{64}$/.test(String(input.templateSha256 || ''))) fail('TEMPLATE_SOURCE_INVALID');

    if (this.samplePlans.size >= OFFICE_TEMPLATE_LIMITS.maxPlans) {
      const used = [...this.samplePlans].find(([, s]) => s.used);
      if (used) this.samplePlans.delete(used[0]);
    }
    if (this.samplePlans.size >= OFFICE_TEMPLATE_LIMITS.maxPlans) fail('TEMPLATE_PLAN_LIMIT');

    const tplRel = relativeName(input.templatePath, false);
    if (!/\.docx$/i.test(tplRel)) fail('A9_OFFICE_FORMAT_UNSUPPORTED');
    const templateFile = await readOfficeFile(this.root, tplRel, signal);
    if (templateFile.sha256 !== input.templateSha256) fail('TEMPLATE_SOURCE_DRIFT');

    const inspected = await this.worker.inspectTemplate(templateFile.buffer, 'docx', signal);
    const mapping = validateAndNormalizeMapping(inspected.fields, input.mapping);
    const outputRule = validateOutputRule(input.outputRule);

    const normalMapped = mapRecord(inspected.fields, mapping, input.normalRecord);
    const boundaryMapped = mapRecord(inspected.fields, mapping, input.boundaryRecord);

    const normalOut = this.resolveOutputDocx(input.normalOutputPath);
    const boundaryOut = this.resolveOutputDocx(input.boundaryOutputPath);
    if (normalOut.relative.toLowerCase() === boundaryOut.relative.toLowerCase()
      || normalOut.relative.toLowerCase() === templateFile.path.toLowerCase()
      || boundaryOut.relative.toLowerCase() === templateFile.path.toLowerCase()) {
      fail('TEMPLATE_PATH_CONFLICT');
    }

    const rootAnchor = captureAnchor(this.root);
    const normalParent = captureNearestAnchor(path.dirname(normalOut.absolute));
    const boundaryParent = captureNearestAnchor(path.dirname(boundaryOut.absolute));
    const guard = new IoGuard([rootAnchor, normalParent, boundaryParent]);
    absent(normalOut.absolute, guard);
    absent(boundaryOut.absolute, guard);

    let dataBoundAtSample = false;
    let boundRecords: Array<Record<string, unknown>> | undefined;
    let dataPath: string | undefined;
    let dataFileSha256: string | undefined;
    let dataSha256: string;

    if (input.records !== undefined || input.dataPath !== undefined) {
      const loaded = this.loadRecordsInput(input.records, input.dataPath);
      dataBoundAtSample = true;
      boundRecords = loaded.records;
      dataPath = loaded.dataPath;
      dataFileSha256 = loaded.dataFileSha256;
      const seenOut = new Set<string>([
        templateFile.path.toLowerCase(),
        normalOut.relative.toLowerCase(),
        boundaryOut.relative.toLowerCase(),
      ]);
      loaded.records.forEach((rec, idx) => {
        mapRecord(inspected.fields, mapping, rec);
        const target = expandOutputPath(outputRule, rec, idx);
        const resolvedOut = this.resolveOutputDocx(target);
        if (seenOut.has(resolvedOut.relative.toLowerCase())) fail('TEMPLATE_OUTPUT_CONFLICT');
        seenOut.add(resolvedOut.relative.toLowerCase());
        const outGuard = guard.with([captureNearestAnchor(path.dirname(resolvedOut.absolute))]);
        absent(resolvedOut.absolute, outGuard);
      });
      dataSha256 = digest(canonicalJson({
        normalRecord: input.normalRecord,
        boundaryRecord: input.boundaryRecord,
        records: loaded.records,
        ...(dataPath ? { dataPath, dataFileSha256 } : {}),
      }));
    } else {
      dataSha256 = digest(canonicalJson({
        normalRecord: input.normalRecord,
        boundaryRecord: input.boundaryRecord,
      }));
    }

    const plan = freeze<TemplateSamplePlan>({
      schemaVersion: 1,
      planId: crypto.randomBytes(16).toString('hex'),
      identity: boundIdentity,
      templatePath: templateFile.path,
      templateSha256: templateFile.sha256,
      mapping,
      normalOutputPath: normalOut.relative,
      boundaryOutputPath: boundaryOut.relative,
      outputRule,
      viewerEnvironment: input.viewerEnvironment.trim(),
      dataBoundAtSample,
      dataSha256,
      ...(dataPath ? { dataPath, dataFileSha256 } : {}),
      ...(boundRecords ? { recordCount: boundRecords.length } : {}),
      approvalRequired: true,
    });
    this.samplePlans.set(plan.planId, {
      plan,
      key,
      used: false,
      guard,
      normalAbs: normalOut.absolute,
      boundaryAbs: boundaryOut.absolute,
      normalMapped,
      boundaryMapped,
      boundRecords,
    });
    return plan;
  }

  async prepareSample(planId: string, binding: OfficeBatchIdentity, signal?: AbortSignal): Promise<TemplateApprovalBinding> {
    const stored = this.samplePlans.get(planId);
    if (!stored) fail('TEMPLATE_PLAN_UNKNOWN');
    if (stored.used) fail('TEMPLATE_PLAN_CONSUMED');
    if (identityKey(binding) !== stored.key) fail('TEMPLATE_IDENTITY_MISMATCH');
    cancelled(signal);
    stored.guard.assertAnchors();
    const freshTemplate = await readOfficeFile(this.root, stored.plan.templatePath, signal);
    if (freshTemplate.sha256 !== stored.plan.templateSha256) fail('TEMPLATE_SOURCE_DRIFT');
    if (stored.plan.dataPath) {
      const freshData = this.loadRecordsInput(undefined, stored.plan.dataPath);
      if (freshData.dataFileSha256 !== stored.plan.dataFileSha256) fail('TEMPLATE_DATA_DRIFT');
    }
    absent(stored.normalAbs, stored.guard);
    absent(stored.boundaryAbs, stored.guard);
    const base = {
      schemaVersion: 1 as const,
      purpose: 'sample' as const,
      planId: stored.plan.planId,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      templatePath: stored.plan.templatePath,
      templateSha256: stored.plan.templateSha256,
      mapping: stored.plan.mapping,
      outputRule: stored.plan.outputRule,
      viewerEnvironment: stored.plan.viewerEnvironment,
      dataSha256: stored.plan.dataSha256,
      outputs: [stored.plan.normalOutputPath, stored.plan.boundaryOutputPath],
    };
    return freeze({ ...base, bindingSha256: digest(canonicalJson(base)) });
  }

  async executeSample(options: {
    planId: string;
    identity: OfficeBatchIdentity;
    approvalId: string;
    signal?: AbortSignal;
  }): Promise<TemplateSampleResult> {
    if (!this.worker) fail('TEMPLATE_WORKER_UNAVAILABLE');
    if (this.active) fail('TEMPLATE_BUSY');
    const stored = this.samplePlans.get(options.planId);
    if (!stored) fail('TEMPLATE_PLAN_UNKNOWN');
    if (stored.used) fail('TEMPLATE_PLAN_CONSUMED');
    if (identityKey(options.identity) !== stored.key) fail('TEMPLATE_IDENTITY_MISMATCH');
    if (!this.approval || typeof options.approvalId !== 'string' || !options.approvalId) fail('TEMPLATE_APPROVAL_REQUIRED');
    const signal = options.signal;
    cancelled(signal);

    const base = {
      schemaVersion: 1 as const,
      purpose: 'sample' as const,
      planId: stored.plan.planId,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      templatePath: stored.plan.templatePath,
      templateSha256: stored.plan.templateSha256,
      mapping: stored.plan.mapping,
      outputRule: stored.plan.outputRule,
      viewerEnvironment: stored.plan.viewerEnvironment,
      dataSha256: stored.plan.dataSha256,
      outputs: [stored.plan.normalOutputPath, stored.plan.boundaryOutputPath],
    };
    const authorization = freeze({ ...base, bindingSha256: digest(canonicalJson(base)) });
    this.active = true;
    stored.used = true;

    let guard = stored.guard;
    const turnId = stored.plan.identity.turnId;
    const temps: Array<{ abs: string; rel: string; id: FileIdentity; destAbs: string; destRel: string }> = [];
    let status: TemplateSampleResult['status'] = 'failed';
    let code = 'TEMPLATE_FAILED';
    let recovery: TemplateSampleResult['recovery'] = 'not_needed';
    let normalSampleSha256: string | undefined;
    let normalBytes: number | undefined;
    let boundarySampleSha256: string | undefined;
    let boundaryBytes: number | undefined;
    let sampleId = '';
    const warnings: string[] = [];

    try {
      cancelled(signal);
      const approved = await this.approval.consume(options.approvalId, authorization);
      if (!approved || approved.status !== 'approved' || approved.bindingSha256 !== authorization.bindingSha256) {
        fail('TEMPLATE_APPROVAL_REJECTED');
      }
      stored.guard.assertAnchors();
      const freshTemplate = await readOfficeFile(this.root, stored.plan.templatePath, signal);
      if (freshTemplate.sha256 !== stored.plan.templateSha256) fail('TEMPLATE_SOURCE_DRIFT');
      if (stored.plan.dataPath) {
        const freshData = this.loadRecordsInput(undefined, stored.plan.dataPath);
        if (freshData.dataFileSha256 !== stored.plan.dataFileSha256) fail('TEMPLATE_DATA_DRIFT');
      }
      absent(stored.normalAbs, stored.guard);
      absent(stored.boundaryAbs, stored.guard);

      const pairs = [
        { destAbs: stored.normalAbs, destRel: stored.plan.normalOutputPath, data: stored.normalMapped },
        { destAbs: stored.boundaryAbs, destRel: stored.plan.boundaryOutputPath, data: stored.boundaryMapped },
      ];

      guard = this.checkpoint.createIoGuard([stored.normalAbs, stored.boundaryAbs]).with([() => { stored.guard.assertAnchors(); return undefined; }]);
      for (const pair of pairs) {
        const tempAbs = path.join(path.dirname(pair.destAbs), `.a9-tpl-${crypto.randomBytes(8).toString('hex')}.tmp`);
        if (tempAbs.length > OFFICE_TEMPLATE_LIMITS.outputPathChars) fail('TEMPLATE_PATH_TOO_LONG');
        const tempRel = path.relative(this.root, tempAbs).replace(/\\/g, '/');
        await this.checkpoint.recordPreMutationAsync(turnId, pair.destRel, { guard, signal });
        await this.checkpoint.recordPreMutationAsync(turnId, tempRel, { guard, signal });
        guard.ensureDirectory(path.dirname(pair.destAbs));
        guard = guard.with([captureAnchor(path.dirname(pair.destAbs))]);
        guard.check(tempAbs);
        const fd = fs.openSync(tempAbs, 'wx');
        let id: FileIdentity;
        try {
          id = fileIdentity(fs.fstatSync(fd));
        } finally {
          fs.closeSync(fd);
        }
        temps.push({ abs: tempAbs, rel: tempRel, id, destAbs: pair.destAbs, destRel: pair.destRel });
      }

      const rendered = await this.worker.renderBatch({
        format: 'docx',
        templateBuffer: freshTemplate.buffer,
        items: [
          { tempPath: temps[0].abs, tempIdentity: temps[0].id, data: stored.normalMapped },
          { tempPath: temps[1].abs, tempIdentity: temps[1].id, data: stored.boundaryMapped },
        ],
        maxOutputBytes: OFFICE_TEMPLATE_LIMITS.maxOutputBytes,
      }, signal);

      if (signal?.aborted) {
        status = 'cancelled';
        code = 'TEMPLATE_CANCELLED';
      } else {
        guard.assertAnchors();
        for (let i = 0; i < temps.length; i++) {
          const item = temps[i];
          const stat = fileStat(item.abs, guard);
          if (stat.dev !== item.id.dev || stat.ino !== item.id.ino) fail('TEMPLATE_TEMP_IDENTITY_CHANGED');
          absent(item.destAbs, guard);
        }
        for (let i = 0; i < temps.length; i++) {
          const item = temps[i];
          const meta = rendered.items[i];
          guard.check(item.abs);
          guard.check(item.destAbs);
          try {
            fs.linkSync(item.abs, item.destAbs);
          } catch (linkErr) {
            if (errorCode(linkErr) === 'EEXIST') fail('TEMPLATE_TARGET_EXISTS');
            throw linkErr;
          }
          recovery = 'unknown';
          await this.checkpoint.recordPostMutationAsync(turnId, item.destRel, 'create', {
            guard,
            fileHash: meta.sha256,
            skipNewBlob: true,
          });
          recovery = 'recorded';
          if (i === 0) {
            normalSampleSha256 = meta.sha256;
            normalBytes = meta.bytes;
          } else {
            boundarySampleSha256 = meta.sha256;
            boundaryBytes = meta.bytes;
          }
        }

        if (this.samples.size >= OFFICE_TEMPLATE_LIMITS.maxSamples) {
          const oldestKey = this.samples.keys().next().value;
          if (oldestKey) this.samples.delete(oldestKey);
        }
        sampleId = `tpl-sample-${crypto.randomBytes(12).toString('hex')}`;
        this.samples.set(sampleId, {
          sampleId,
          workspaceId: stored.plan.identity.workspaceId,
          conversationId: stored.plan.identity.conversationId,
          templatePath: stored.plan.templatePath,
          templateSha256: stored.plan.templateSha256,
          mapping: stored.plan.mapping,
          outputRule: stored.plan.outputRule,
          viewerEnvironment: stored.plan.viewerEnvironment,
          normalOutputPath: stored.plan.normalOutputPath,
          normalSampleSha256: normalSampleSha256!,
          boundaryOutputPath: stored.plan.boundaryOutputPath,
          boundarySampleSha256: boundarySampleSha256!,
          dataBoundAtSample: stored.plan.dataBoundAtSample,
          dataSha256: stored.plan.dataSha256,
          ...(stored.plan.dataPath ? { dataPath: stored.plan.dataPath, dataFileSha256: stored.plan.dataFileSha256 } : {}),
          ...(stored.boundRecords ? { boundRecords: stored.boundRecords } : {}),
          confirmedInViewer: false,
        });
        status = 'completed';
        code = 'TEMPLATE_SAMPLE_READY';
      }
    } catch (err) {
      code = errorCode(err);
      status = code === 'TEMPLATE_CANCELLED' || code === 'A9_OFFICE_CANCELLED' || signal?.aborted ? 'cancelled' : 'failed';
      if (status === 'cancelled') code = 'TEMPLATE_CANCELLED';
      if (normalSampleSha256 && !boundarySampleSha256) status = 'partial';
    } finally {
      for (const t of temps) {
        try {
          guard.check(t.abs);
          const cur = fileStat(t.abs, guard);
          if (cur.dev === t.id.dev && cur.ino === t.id.ino) fs.unlinkSync(t.abs);
        } catch (_ignored) {
          recovery = 'unknown';
        }
      }
      this.active = false;
    }

    return {
      schemaVersion: 1,
      planId: stored.plan.planId,
      sampleId,
      status,
      code,
      templatePath: stored.plan.templatePath,
      templateSha256: stored.plan.templateSha256,
      normalOutputPath: stored.plan.normalOutputPath,
      ...(normalSampleSha256 ? { normalSampleSha256, normalBytes } : {}),
      boundaryOutputPath: stored.plan.boundaryOutputPath,
      ...(boundarySampleSha256 ? { boundarySampleSha256, boundaryBytes } : {}),
      viewerEnvironment: stored.plan.viewerEnvironment,
      confirmedInViewer: false,
      sampleConfirmationRequired: true,
      dataBoundAtSample: stored.plan.dataBoundAtSample,
      dataSha256: stored.plan.dataSha256,
      recovery,
      warnings,
      limitations: [
        '不承诺字体缺失、长文本、跨页表格或文本框溢出时仍保持原分页与版式。',
        '请操作员在指定查看环境检查普通与边界样张并确认后，再执行批量生成。',
      ],
    };
  }

  /** Trusted host-only confirmation after operator inspects samples in viewerEnvironment. */
  async confirmSample(input: TemplateSampleConfirmation, signal?: AbortSignal): Promise<{
    ok: true;
    sampleId: string;
    confirmedInViewer: true;
    viewerEnvironment: string;
    templateSha256: string;
    normalSampleSha256: string;
    boundarySampleSha256: string;
  }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('TEMPLATE_CONFIRM_INVALID');
    const sample = this.samples.get(input.sampleId);
    if (!sample) fail('TEMPLATE_SAMPLE_UNKNOWN');
    if (sample.workspaceId !== input.workspaceId || sample.conversationId !== input.conversationId) {
      fail('TEMPLATE_IDENTITY_MISMATCH');
    }
    if (input.viewerEnvironment !== sample.viewerEnvironment) fail('TEMPLATE_VIEWER_MISMATCH');
    if (input.normalSampleSha256 !== sample.normalSampleSha256 || input.boundarySampleSha256 !== sample.boundarySampleSha256) {
      fail('TEMPLATE_SAMPLE_DRIFT');
    }
    const freshTemplate = await readOfficeFile(this.root, sample.templatePath, signal);
    if (freshTemplate.sha256 !== sample.templateSha256) {
      sample.confirmedInViewer = false;
      fail('TEMPLATE_SOURCE_DRIFT');
    }
    const freshNormal = await readOfficeFile(this.root, sample.normalOutputPath, signal);
    if (freshNormal.sha256 !== sample.normalSampleSha256) {
      sample.confirmedInViewer = false;
      fail('TEMPLATE_SAMPLE_DRIFT');
    }
    const freshBoundary = await readOfficeFile(this.root, sample.boundaryOutputPath, signal);
    if (freshBoundary.sha256 !== sample.boundarySampleSha256) {
      sample.confirmedInViewer = false;
      fail('TEMPLATE_SAMPLE_DRIFT');
    }
    if (sample.dataPath) {
      const freshData = this.loadRecordsInput(undefined, sample.dataPath);
      if (freshData.dataFileSha256 !== sample.dataFileSha256) {
        sample.confirmedInViewer = false;
        fail('TEMPLATE_DATA_DRIFT');
      }
    }
    sample.confirmedInViewer = true;
    sample.confirmedAt = new Date().toISOString();
    return {
      ok: true,
      sampleId: sample.sampleId,
      confirmedInViewer: true,
      viewerEnvironment: sample.viewerEnvironment,
      templateSha256: sample.templateSha256,
      normalSampleSha256: sample.normalSampleSha256,
      boundarySampleSha256: sample.boundarySampleSha256,
    };
  }

  listSamples(workspaceId: string, conversationId: string): Array<{
    sampleId: string;
    templatePath: string;
    templateSha256: string;
    normalOutputPath: string;
    normalSampleSha256: string;
    boundaryOutputPath: string;
    boundarySampleSha256: string;
    viewerEnvironment: string;
    confirmedInViewer: boolean;
    confirmedAt?: string;
    outputRule: TemplateOutputRule;
    dataBoundAtSample: boolean;
  }> {
    return [...this.samples.values()]
      .filter(s => s.workspaceId === workspaceId && s.conversationId === conversationId)
      .map(s => ({
        sampleId: s.sampleId,
        templatePath: s.templatePath,
        templateSha256: s.templateSha256,
        normalOutputPath: s.normalOutputPath,
        normalSampleSha256: s.normalSampleSha256,
        boundaryOutputPath: s.boundaryOutputPath,
        boundarySampleSha256: s.boundarySampleSha256,
        viewerEnvironment: s.viewerEnvironment,
        confirmedInViewer: s.confirmedInViewer,
        ...(s.confirmedAt ? { confirmedAt: s.confirmedAt } : {}),
        outputRule: { ...s.outputRule },
        dataBoundAtSample: s.dataBoundAtSample,
      }));
  }

  private async verifySampleStillValid(sample: StoredSampleState, signal?: AbortSignal): Promise<{ templateBuffer: Buffer; fields: TemplateFieldNode[] }> {
    if (!this.worker) fail('TEMPLATE_WORKER_UNAVAILABLE');
    if (!sample.confirmedInViewer) fail('TEMPLATE_SAMPLE_NOT_CONFIRMED');
    const freshTemplate = await readOfficeFile(this.root, sample.templatePath, signal);
    if (freshTemplate.sha256 !== sample.templateSha256) {
      sample.confirmedInViewer = false;
      fail('TEMPLATE_SOURCE_DRIFT');
    }
    const freshNormal = await readOfficeFile(this.root, sample.normalOutputPath, signal);
    if (freshNormal.sha256 !== sample.normalSampleSha256) {
      sample.confirmedInViewer = false;
      fail('TEMPLATE_SAMPLE_DRIFT');
    }
    const freshBoundary = await readOfficeFile(this.root, sample.boundaryOutputPath, signal);
    if (freshBoundary.sha256 !== sample.boundarySampleSha256) {
      sample.confirmedInViewer = false;
      fail('TEMPLATE_SAMPLE_DRIFT');
    }
    if (sample.dataPath) {
      const freshData = this.loadRecordsInput(undefined, sample.dataPath);
      if (freshData.dataFileSha256 !== sample.dataFileSha256) {
        sample.confirmedInViewer = false;
        fail('TEMPLATE_DATA_DRIFT');
      }
    }
    const inspected = await this.worker.inspectTemplate(freshTemplate.buffer, 'docx', signal);
    return { templateBuffer: freshTemplate.buffer, fields: inspected.fields };
  }

  async planBatch(binding: OfficeBatchIdentity, input: TemplateBatchPlanInput, signal?: AbortSignal): Promise<TemplateBatchPlan> {
    if (!this.worker) fail('TEMPLATE_WORKER_UNAVAILABLE');
    cancelled(signal);
    const key = identityKey(binding);
    const boundIdentity = { ...binding };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('TEMPLATE_INPUT_INVALID');
    const allowed = ['sampleId', 'templatePath', 'templateSha256', 'mapping', 'outputRule', 'records', 'dataPath'];
    if (Object.keys(input).some(k => !allowed.includes(k)) || typeof input.sampleId !== 'string' || !input.sampleId) {
      fail('TEMPLATE_INPUT_INVALID');
    }
    if (this.batchPlans.size >= OFFICE_TEMPLATE_LIMITS.maxPlans) {
      const used = [...this.batchPlans].find(([, s]) => s.used);
      if (used) this.batchPlans.delete(used[0]);
    }
    if (this.batchPlans.size >= OFFICE_TEMPLATE_LIMITS.maxPlans) fail('TEMPLATE_PLAN_LIMIT');

    const sample = this.samples.get(input.sampleId);
    if (!sample) fail('TEMPLATE_SAMPLE_UNKNOWN');
    if (sample.workspaceId !== binding.workspaceId || sample.conversationId !== binding.conversationId) {
      fail('TEMPLATE_IDENTITY_MISMATCH');
    }
    if (!sample.confirmedInViewer) fail('TEMPLATE_SAMPLE_NOT_CONFIRMED');

    if (input.templatePath !== undefined && relativeName(input.templatePath, false) !== sample.templatePath) {
      fail('TEMPLATE_BINDING_CHANGED');
    }
    if (input.templateSha256 !== undefined && input.templateSha256 !== sample.templateSha256) {
      fail('TEMPLATE_BINDING_CHANGED');
    }
    if (input.outputRule !== undefined) {
      const normalizedRule = validateOutputRule(input.outputRule);
      if (canonicalJson(normalizedRule) !== canonicalJson(sample.outputRule)) fail('TEMPLATE_BINDING_CHANGED');
    }

    const { fields } = await this.verifySampleStillValid(sample, signal);

    if (input.mapping !== undefined) {
      const normalizedMapping = validateAndNormalizeMapping(fields, input.mapping);
      if (canonicalJson(normalizedMapping) !== canonicalJson(sample.mapping)) fail('TEMPLATE_BINDING_CHANGED');
    }

    let records: Array<Record<string, unknown>>;
    let batchDataSha256 = sample.dataSha256;
    if (sample.dataBoundAtSample) {
      if (input.dataPath !== undefined && relativeName(input.dataPath, false) !== sample.dataPath) {
        fail('TEMPLATE_BINDING_CHANGED');
      }
      if (input.records !== undefined) {
        const loaded = this.loadRecordsInput(input.records, undefined);
        if (canonicalJson(loaded.records) !== canonicalJson(sample.boundRecords)) {
          sample.confirmedInViewer = false;
          fail('TEMPLATE_BINDING_CHANGED');
        }
      }
      if (sample.dataPath) {
        const freshData = this.loadRecordsInput(undefined, sample.dataPath);
        if (freshData.dataFileSha256 !== sample.dataFileSha256) {
          sample.confirmedInViewer = false;
          fail('TEMPLATE_DATA_DRIFT');
        }
        records = freshData.records;
      } else {
        records = sample.boundRecords!;
      }
    } else {
      const loaded = this.loadRecordsInput(input.records, input.dataPath);
      records = loaded.records;
      batchDataSha256 = digest(canonicalJson({
        sampleDataSha256: sample.dataSha256,
        records: loaded.records,
        ...(loaded.dataPath ? { dataPath: loaded.dataPath, dataFileSha256: loaded.dataFileSha256 } : {}),
      }));
      if (sample.boundBatchDataSha256 && batchDataSha256 !== sample.boundBatchDataSha256) {
        sample.confirmedInViewer = false;
        fail('TEMPLATE_BINDING_CHANGED');
      }
    }

    const rootAnchor = captureAnchor(this.root);
    const parentAnchors = new Map<string, ReturnType<typeof captureNearestAnchor>>();
    const seenOut = new Set<string>([
      sample.templatePath.toLowerCase(),
      sample.normalOutputPath.toLowerCase(),
      sample.boundaryOutputPath.toLowerCase(),
    ]);
    const items: StoredBatchPlan['items'] = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const mappedData = mapRecord(fields, sample.mapping, rec);
      const outputPath = expandOutputPath(sample.outputRule, rec, i);
      const resolved = this.resolveOutputDocx(outputPath);
      if (seenOut.has(resolved.relative.toLowerCase())) fail('TEMPLATE_OUTPUT_CONFLICT');
      seenOut.add(resolved.relative.toLowerCase());
      const parentDir = path.dirname(resolved.absolute);
      if (!parentAnchors.has(parentDir)) parentAnchors.set(parentDir, captureNearestAnchor(parentDir));
      items.push({ index: i, outputPath: resolved.relative, outputAbs: resolved.absolute, mappedData });
    }
    const guard = new IoGuard([rootAnchor, ...parentAnchors.values()]);
    for (const item of items) absent(item.outputAbs, guard);

    const plan = freeze<TemplateBatchPlan>({
      schemaVersion: 1,
      planId: crypto.randomBytes(16).toString('hex'),
      identity: boundIdentity,
      sampleId: sample.sampleId,
      viewerEnvironment: sample.viewerEnvironment,
      templatePath: sample.templatePath,
      templateSha256: sample.templateSha256,
      normalOutputPath: sample.normalOutputPath,
      normalSampleSha256: sample.normalSampleSha256,
      boundaryOutputPath: sample.boundaryOutputPath,
      boundarySampleSha256: sample.boundarySampleSha256,
      mapping: sample.mapping,
      outputRule: sample.outputRule,
      dataSha256: batchDataSha256,
      recordCount: items.length,
      outputs: items.map(item => ({ index: item.index, outputPath: item.outputPath })),
      approvalRequired: true,
    });
    this.batchPlans.set(plan.planId, { plan, key, used: false, guard, items });
    return plan;
  }

  async prepareBatch(planId: string, binding: OfficeBatchIdentity, signal?: AbortSignal): Promise<TemplateApprovalBinding> {
    const stored = this.batchPlans.get(planId);
    if (!stored) fail('TEMPLATE_PLAN_UNKNOWN');
    if (stored.used) fail('TEMPLATE_PLAN_CONSUMED');
    if (identityKey(binding) !== stored.key) fail('TEMPLATE_IDENTITY_MISMATCH');
    const sample = this.samples.get(stored.plan.sampleId);
    if (!sample) fail('TEMPLATE_SAMPLE_UNKNOWN');
    await this.verifySampleStillValid(sample, signal);
    stored.guard.assertAnchors();
    for (const item of stored.items) absent(item.outputAbs, stored.guard);

    const base = {
      schemaVersion: 1 as const,
      purpose: 'batch' as const,
      planId: stored.plan.planId,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      templatePath: stored.plan.templatePath,
      templateSha256: stored.plan.templateSha256,
      mapping: stored.plan.mapping,
      outputRule: stored.plan.outputRule,
      viewerEnvironment: stored.plan.viewerEnvironment,
      dataSha256: stored.plan.dataSha256,
      outputs: stored.plan.outputs.map(o => o.outputPath),
      sampleId: stored.plan.sampleId,
    };
    return freeze({ ...base, bindingSha256: digest(canonicalJson(base)) });
  }

  async executeBatch(options: {
    planId: string;
    identity: OfficeBatchIdentity;
    approvalId: string;
    signal?: AbortSignal;
  }): Promise<TemplateBatchResult> {
    if (!this.worker) fail('TEMPLATE_WORKER_UNAVAILABLE');
    if (this.active) fail('TEMPLATE_BUSY');
    const stored = this.batchPlans.get(options.planId);
    if (!stored) fail('TEMPLATE_PLAN_UNKNOWN');
    if (stored.used) fail('TEMPLATE_PLAN_CONSUMED');
    if (identityKey(options.identity) !== stored.key) fail('TEMPLATE_IDENTITY_MISMATCH');
    if (!this.approval || typeof options.approvalId !== 'string' || !options.approvalId) fail('TEMPLATE_APPROVAL_REQUIRED');
    const sample = this.samples.get(stored.plan.sampleId);
    if (!sample) fail('TEMPLATE_SAMPLE_UNKNOWN');
    const signal = options.signal;
    cancelled(signal);

    const base = {
      schemaVersion: 1 as const,
      purpose: 'batch' as const,
      planId: stored.plan.planId,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      templatePath: stored.plan.templatePath,
      templateSha256: stored.plan.templateSha256,
      mapping: stored.plan.mapping,
      outputRule: stored.plan.outputRule,
      viewerEnvironment: stored.plan.viewerEnvironment,
      dataSha256: stored.plan.dataSha256,
      outputs: stored.plan.outputs.map(o => o.outputPath),
      sampleId: stored.plan.sampleId,
    };
    const authorization = freeze({ ...base, bindingSha256: digest(canonicalJson(base)) });

    this.active = true;
    stored.used = true;

    let guard = stored.guard;
    const turnId = stored.plan.identity.turnId;
    const temps: Array<{ index: number; abs: string; rel: string; id: FileIdentity; destAbs: string; destRel: string }> = [];
    const outputs: TemplateBatchResult['outputs'] = stored.items.map(i => ({
      index: i.index,
      outputPath: i.outputPath,
      status: 'failed',
    }));
    let status: TemplateBatchResult['status'] = 'failed';
    let code = 'TEMPLATE_FAILED';
    let recovery: TemplateBatchResult['recovery'] = 'not_needed';
    let checkpointStatus: TemplateBatchResult['checkpointStatus'] = 'not_needed';
    let persistenceError: string | undefined;
    let cleanupCode: string | undefined;
    const residualTemporaries: string[] = [];
    const warnings: string[] = [];

    try {
      cancelled(signal);
      const approved = await this.approval.consume(options.approvalId, authorization);
      if (!approved || approved.status !== 'approved' || approved.bindingSha256 !== authorization.bindingSha256) {
        fail('TEMPLATE_APPROVAL_REJECTED');
      }
      const { templateBuffer } = await this.verifySampleStillValid(sample, signal);
      if (!sample.dataBoundAtSample) sample.boundBatchDataSha256 = stored.plan.dataSha256;
      stored.guard.assertAnchors();
      for (const item of stored.items) absent(item.outputAbs, stored.guard);

      guard = this.checkpoint.createIoGuard(stored.items.map(i => i.outputAbs)).with([() => { stored.guard.assertAnchors(); return undefined; }]);
      for (const item of stored.items) {
        const tempAbs = path.join(path.dirname(item.outputAbs), `.a9-tpl-${crypto.randomBytes(8).toString('hex')}.tmp`);
        if (tempAbs.length > OFFICE_TEMPLATE_LIMITS.outputPathChars) fail('TEMPLATE_PATH_TOO_LONG');
        const tempRel = path.relative(this.root, tempAbs).replace(/\\/g, '/');
        await this.checkpoint.recordPreMutationAsync(turnId, item.outputPath, { guard, signal });
        await this.checkpoint.recordPreMutationAsync(turnId, tempRel, { guard, signal });
        guard.ensureDirectory(path.dirname(item.outputAbs));
        guard = guard.with([captureAnchor(path.dirname(item.outputAbs))]);
        guard.check(tempAbs);
        const fd = fs.openSync(tempAbs, 'wx');
        let id: FileIdentity;
        try {
          id = fileIdentity(fs.fstatSync(fd));
        } finally {
          fs.closeSync(fd);
        }
        temps.push({ index: item.index, abs: tempAbs, rel: tempRel, id, destAbs: item.outputAbs, destRel: item.outputPath });
        residualTemporaries.push(tempRel);
      }

      const rendered = await this.worker.renderBatch({
        format: 'docx',
        templateBuffer,
        items: temps.map((t, idx) => ({ tempPath: t.abs, tempIdentity: t.id, data: stored.items[idx].mappedData })),
        maxOutputBytes: OFFICE_TEMPLATE_LIMITS.maxOutputBytes,
      }, signal);

      if (signal?.aborted) {
        status = 'cancelled';
        code = 'TEMPLATE_CANCELLED';
        for (const o of outputs) o.status = 'cancelled';
      } else {
        guard.assertAnchors();
        for (const t of temps) {
          const stat = fileStat(t.abs, guard);
          if (stat.dev !== t.id.dev || stat.ino !== t.id.ino) fail('TEMPLATE_TEMP_IDENTITY_CHANGED');
          absent(t.destAbs, guard);
        }
        let publishedCount = 0;
        for (let i = 0; i < temps.length; i++) {
          const t = temps[i];
          const meta = rendered.items[i];
          guard.check(t.abs);
          guard.check(t.destAbs);
          try {
            fs.linkSync(t.abs, t.destAbs);
          } catch (linkErr) {
            if (errorCode(linkErr) === 'EEXIST') {
              code = 'TEMPLATE_TARGET_EXISTS';
              status = publishedCount > 0 ? 'partial' : 'failed';
              break;
            }
            throw linkErr;
          }
          publishedCount += 1;
          outputs[i] = { index: t.index, outputPath: t.destRel, status: 'succeeded', sha256: meta.sha256, bytes: meta.bytes };
          recovery = 'unknown';
          checkpointStatus = 'persistence_failed';
          try {
            await this.checkpoint.recordPostMutationAsync(turnId, t.destRel, 'create', {
              guard,
              fileHash: meta.sha256,
              skipNewBlob: true,
            });
            recovery = 'recorded';
            checkpointStatus = 'recorded';
          } catch (persistErr) {
            persistenceError = persistErr instanceof Error ? persistErr.message : String(persistErr);
            recovery = 'unknown';
            checkpointStatus = 'persistence_failed';
            status = 'partial';
            code = 'TEMPLATE_CHECKPOINT_PERSIST_FAILED';
            warnings.push('部分输出已发布，但恢复记录持久化失败。');
            break;
          }
        }
        if (publishedCount === temps.length && checkpointStatus === 'recorded') {
          status = 'completed';
          code = 'TEMPLATE_BATCH_OK';
        }
      }
    } catch (err) {
      code = errorCode(err);
      status = code === 'TEMPLATE_CANCELLED' || code === 'A9_OFFICE_CANCELLED' || signal?.aborted ? 'cancelled' : 'failed';
      if (status === 'cancelled') {
        code = 'TEMPLATE_CANCELLED';
        for (const o of outputs) if (o.status !== 'succeeded') o.status = 'cancelled';
      }
      if (outputs.some(o => o.status === 'succeeded') && status === 'failed') status = 'partial';
    } finally {
      const remaining: string[] = [];
      for (const t of temps) {
        try {
          guard.check(t.abs);
          const cur = fileStat(t.abs, guard);
          if (cur.dev !== t.id.dev || cur.ino !== t.id.ino) fail('TEMPLATE_TEMP_IDENTITY_CHANGED');
          fs.unlinkSync(t.abs);
        } catch (cleanupErr) {
          remaining.push(t.rel);
          cleanupCode = cleanupCode || errorCode(cleanupErr);
          recovery = 'unknown';
          if (status === 'completed') {
            status = 'partial';
            code = cleanupCode;
          }
        }
      }
      residualTemporaries.splice(0, residualTemporaries.length, ...remaining);
      this.active = false;
    }

    return {
      schemaVersion: 1,
      planId: stored.plan.planId,
      sampleId: stored.plan.sampleId,
      status,
      code,
      templatePath: stored.plan.templatePath,
      templateSha256: stored.plan.templateSha256,
      viewerEnvironment: stored.plan.viewerEnvironment,
      outputs,
      recovery,
      checkpointStatus,
      ...(persistenceError ? { persistenceError } : {}),
      ...(cleanupCode ? { cleanupCode } : {}),
      ...(residualTemporaries.length ? { residualTemporaries } : {}),
      warnings,
      limitations: [
        '不承诺字体缺失、长文本、跨页表格或文本框溢出时仍保持原分页与版式。',
        '视觉保真依据操作员在指定查看环境对普通/边界样张的确认。',
      ],
    };
  }
}
