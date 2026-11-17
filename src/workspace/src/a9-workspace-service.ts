/**
 * @module a9-workspace-service
 * @description A9 Full Access 工作区文件工具与服务实现 (PRD §5 / ADR-0089)
 *
 * 数据完整性合同（A9-03）：
 * - 写入使用真实目标编码字节（UTF-8 / UTF-8 BOM / UTF-16LE BOM / CP936），
 *   绝不写 UTF-8 字节却报告 GBK；
 * - edit 保持原编码、BOM、CRLF/LF 与末尾换行；
 * - 写入绑定读取基线（hash+mtime+size）；外部变化后拒绝覆盖并要求重新读取；
 * - 工作区外路径在返回值中醒目标记；
 * - canonical/real path 处理 junction/symlink，防止递归环；
 * - 大文件分段读取，搜索可取消且不同步加载超大文件；
 * - delete permanent:false 进入产品恢复区（可恢复），permanent:true 才真正删除。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  detectEncoding,
  decodeBuffer,
  encodeText,
  prepareGbkEncodeTableAsync,
  reencodePreservingOriginal,
  bomPrefixFor,
  EncodingWriteError,
  WritableEncoding,
} from './encoding';
import { atomicWrite } from './atomic';
import { officePath, createOfficeCopy } from './a9-office-files';
import { createWorkspaceIgnoreFilter, IgnoreFilter } from './a9-ignore';
import { CheckpointManager, CooperativeSlice, ExternalFactOperation } from './checkpoint-manager';
import {
  A9EditFeedbackV1,
  DEFAULT_EDIT_DIFF_MAX_BYTES,
  buildEditFeedback,
  unavailableEditFeedback,
} from './a9-edit-feedback';
import { WorkspaceError } from './types';
import { copyTreeAsync, removeTreeAsync } from './async-tree';
import { IoGuard, captureNearestAnchor, identityChanged, samePath } from './directory-identity';
import { OfficeBatchService, OfficeBatchApprovalPort, OfficeBatchIdentity, OfficeScanOptions,
  OfficeOrganizeActionInput, OfficeBatchExecuteOptions, OfficeMetadataScan, OfficeOrganizePlan, OfficeBatchResult } from './a9-office-batch';
import {
  OfficeArchiveService, OfficeArchiveApprovalPort, OfficeZipWorkerPort,
  OfficeArchivePlanInput, OfficeArchivePlan, OfficeArchiveApprovalBinding,
  OfficeArchiveExecuteOptions, OfficeArchiveResult,
} from './a9-office-archive';
import {
  OfficeTemplateService, OfficeTemplateWorkerPort, OfficeTemplateApprovalPort,
  TemplateInspectResult, TemplateRenderSampleInput, TemplateSamplePlan,
  TemplateSampleResult, TemplateSampleConfirmation, TemplateBatchPlanInput,
  TemplateBatchPlan, TemplateBatchResult, TemplateApprovalBinding,
} from './a9-office-template';
import {
  OfficeReportService, OfficeReportWorkerPort, OfficeReportApprovalPort,
  PresentationCreateInput, PresentationPlan, PresentationResult,
  HtmlReportCreateInput, HtmlReportPlan, HtmlReportResult, ReportApprovalBinding,
} from './a9-office-report';
import {
  OfficeMailService, MailSourceAdapter, OfficeMailApprovalPort,
  MailExtractPlanInput, MailExtractPlan, MailExtractApprovalBinding, MailExtractResult,
} from './a9-office-mail';
import {
  OfficeSkillsService, OfficeSkillsApprovalPort, OfficeSkillsInstallInput,
  OfficeSkillsInstallPlan, OfficeSkillsApprovalBinding, OfficeSkillsInstallResult,
} from './a9-office-skills';

/** list/search 的 skipped 明细中，reason=ignored 最多占用的条目数（计数 skippedTotal 不受限）。 */
const IGNORED_SKIP_DETAIL_LIMIT = 25;

export interface A9ListResult {
  path: string;
  totalEntries: number;
  truncated: boolean;
  outsideWorkspace: boolean;
  skipped: Array<{ path: string; reason: 'directory_unreadable' | 'ignored' }>;
  skippedTotal: number;
  entries: Array<{
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    sizeBytes?: number;
  }>;
}

export interface A9ReadResult {
  path: string;
  isText: boolean;
  encoding: string;
  startLine: number;
  linesRead: number;
  totalLines: number;
  content: string;
  truncated: boolean;
  outsideWorkspace: boolean;
  /** 当前内容哈希，供后续 write/edit 绑定基线。 */
  contentSha256: string;
  truncationReasons?: Array<'line_limit' | 'byte_limit'>;
}

export interface A9SearchResult {
  pattern: string;
  totalMatches: number;
  truncated: boolean;
  outsideWorkspace: boolean;
  filesScanned: number;
  skippedFiles: number;
  skipped: Array<{ path: string; reason: SearchSkippedReason }>;
  skippedTotal: number;
  truncationReasons: Array<'matches' | 'files'>;
  matches: Array<{
    filePath: string;
    lineNumber: number;
    lineText: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }>;
}

export type SearchSkippedReason =
  | 'directory_unreadable'
  | 'ignored'
  | 'stat_failed'
  | 'too_large'
  | 'binary_or_ambiguous'
  | 'read_failed';

export interface A9WriteResult {
  path: string;
  bytesWritten: number;
  encoding: string;
  created: boolean;
  outsideWorkspace: boolean;
}

export interface A9EditResult {
  path: string;
  replaced: boolean;
  encoding: string;
  eol: string;
  outsideWorkspace: boolean;
  diffSummary: string;
  noOp: boolean;
  /** Bounded preview computed from the actual re-encoded result. */
  feedback: A9EditFeedbackV1;
}

export interface A9DeleteResult {
  path: string;
  deleted: boolean;
  permanent: boolean;
  outsideWorkspace: boolean;
  /** permanent:false 时的恢复事实。 */
  recoverableVia?: string;
}

interface BaselineFact {
  sha256: string;
  mtimeMs: number;
  size: number;
  encoding?: WritableEncoding;
  bom?: boolean;
}

/** 读取内存与模型预览分别有界；文件大小不再阻断行范围读取。 */
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_READ_PREVIEW_BYTES = 128 * 1024;
const READ_TRUNCATION_NOTICE = '\n[preview truncated: byte limit]';
/** 搜索时单文件解码上限：更大的文件按能力缺失跳过并计数。 */
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
/** 搜索最多扫描的文件数，防止同步全库扫描。 */
const MAX_SEARCH_FILES = 20_000;
/** 轮前内容基线上限：文件数、单文件字节、总字节（超出部分显式标记不可恢复）。 */
const MAX_BASELINE_FILES = 2000;
// A9-19 P03：全树基线/变化收集在 Electron 主进程执行；每累计约 25ms 同步工作即让出一次事件循环，
// 使快照轮询与取消在扫描期间仍可响应。遍历顺序、忽略规则、上限与哈希完全不变。
const BASELINE_YIELD_SLICE_MS = 25;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface YieldController {
  checkpoint(force?: boolean, afterYield?: () => void): Promise<void>;
}

function createYieldController(): YieldController {
  let lastYieldAt = Date.now();
  return {
    async checkpoint(force = false, afterYield?: () => void): Promise<void> {
      if (force || Date.now() - lastYieldAt >= BASELINE_YIELD_SLICE_MS) {
        await yieldToEventLoop();
        // A setImmediate-only loop can run successive promise continuations
        // before the timers phase. Give cancellation timers a real timers
        // phase as well, while retaining the existing 25 ms slice contract.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        afterYield?.();
        lastYieldAt = Date.now();
      }
    },
  };
}

interface DirectoryScanIdentity {
  absPath: string;
  realPath: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
}

function bindDirectoryScan(absPath: string): DirectoryScanIdentity {
  const realPath = fs.realpathSync(absPath);
  const stat = fs.statSync(absPath);
  // Callers already resolved canonical targets. A new redirect must not reuse
  // the old outsideWorkspace flag, even if it points to another readable tree.
  if (path.relative(absPath, realPath) !== '') {
    throw new WorkspaceError('DIRECTORY_READ_FAILED', '目录身份在扫描期间变化，请重新扫描。');
  }
  return { absPath, realPath, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function verifyDirectoryScan(identity: DirectoryScanIdentity): void {
  try {
    const current = bindDirectoryScan(identity.absPath);
    if (current.realPath === identity.realPath && current.dev === identity.dev &&
        current.ino === identity.ino && current.birthtimeMs === identity.birthtimeMs) return;
  } catch (_error) { /* Missing or unresolvable targets cannot retain their old identity. */ }
  throw new WorkspaceError('DIRECTORY_READ_FAILED', '目录身份已变化或无法确认，拒绝返回扫描结果。');
}

const MAX_BASELINE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BASELINE_TOTAL_BYTES = 40 * 1024 * 1024;

export interface TurnContentBaseline {
  turnId: string;
  frozenAt: string;
  files: Record<string, { sha256: string; blobPath: string; size: number }>;
  directories: Record<string, { snapshotPath: string; treeHash: string }>;
  /** F2：基线未覆盖的既有文件事实（size/mtime 供 rename 启发式；不保存内容）。 */
  skipped: Array<{ path: string; reason: 'too_large' | 'backup_failed' | 'outside'; size?: number; mtimeMs?: number }>;
}

export interface ExternalChangeReport {
  changes: Array<{ path: string; kind: 'created' | 'modified' | 'deleted' | 'renamed'; recoverable: boolean; restoredVia?: 'delete-new' | 'restore-original'; newHash?: string }>;
  unrecoverable: Array<{ path: string; kind: string; reason: string }>;
}

export class A9WorkspaceService {
  public readonly workspaceRoot: string;
  /** A9-67 F-022: set when the workspace root identity could not be resolved. */
  private readonly rootIdentityError: WorkspaceError | undefined;
  private readonly ignoreFilter: IgnoreFilter;
  private readonly checkpointManager: CheckpointManager;
  private readonly officeBatch: OfficeBatchService;
  private readonly officeArchive: OfficeArchiveService;
  private readonly officeTemplate: OfficeTemplateService;
  private readonly officeReport: OfficeReportService;
  private readonly officeMail: OfficeMailService;
  private readonly officeSkills: OfficeSkillsService;
  private readonly baselines = new Map<string, BaselineFact>();
  private readonly containsSensitiveData: (value: string | Buffer) => boolean;
  private readonly containsSensitiveFeedbackData: (value: string | Buffer) => boolean;
  /** A9-61: per-Turn tail of serialized external-change collections. */
  private readonly turnCollections = new Map<string, Promise<void>>();
  /** A9-61: one in-flight crash reconciliation per Turn; concurrent Undo requests share it. */
  private readonly turnReconciliations = new Map<string, Promise<{ report?: ExternalChangeReport; confirmationId: string } | undefined>>();

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

  constructor(
    workspaceRoot: string,
    options: { containsSensitiveData?: (value: string | Buffer) => boolean;
      containsSensitiveFeedbackData?: (value: string | Buffer) => boolean;
      officeBatchApproval?: OfficeBatchApprovalPort;
      officeArchiveApproval?: OfficeArchiveApprovalPort;
      officeArchiveWorker?: OfficeZipWorkerPort;
      officeTemplateApproval?: OfficeTemplateApprovalPort;
      officeTemplateWorker?: OfficeTemplateWorkerPort;
      officeTemplateSamples?: Map<string, any>;
      officeReportApproval?: OfficeReportApprovalPort;
      officeReportWorker?: OfficeReportWorkerPort;
      officeMailApproval?: OfficeMailApprovalPort;
      officeMailEmlAdapter?: MailSourceAdapter;
      officeSkillsApproval?: OfficeSkillsApprovalPort } = {},
  ) {
    // 规范化工作区根本身（macOS /var → /private/var、junction 等），
    // 否则 realpathSync 的文件会得到跨前缀的 ../../ 相对路径。
    let canonicalRoot = workspaceRoot;
    try {
      canonicalRoot = fs.realpathSync(workspaceRoot);
    } catch (error) {
      canonicalRoot = path.resolve(workspaceRoot);
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // A9-55 default workspace: the directory is created lazily, so a root
        // that does not exist yet stays valid. Its nearest existing ancestor is
        // still canonicalized so later paths agree with resolvePath.
        let probe = canonicalRoot;
        const suffix: string[] = [];
        for (;;) {
          const parent = path.dirname(probe);
          if (parent === probe) break;
          suffix.unshift(path.basename(probe));
          probe = parent;
          try {
            canonicalRoot = path.join(fs.realpathSync(probe), ...suffix);
            break;
          } catch (ancestorError) {
            const ancestorCode = (ancestorError as NodeJS.ErrnoException)?.code;
            if (ancestorCode !== 'ENOENT' && ancestorCode !== 'ENOTDIR') {
              this.rootIdentityError = ancestorCode === 'ENAMETOOLONG'
                ? new WorkspaceError('PATH_TOO_LONG', `工作区根路径超过当前系统允许的长度（${ancestorCode}）；请缩短路径后重试。`)
                : new WorkspaceError('PATH_IDENTITY_UNKNOWN', `无法确认工作区根目录的真实位置（${String(ancestorCode ?? 'UNKNOWN')}）；拒绝按字面路径继续。`);
              break;
            }
          }
        }
      } else {
        // A9-67 F-022: an existing root whose identity cannot be resolved
        // (EACCES/ELOOP/ENAMETOOLONG/...) is never reported as verified; each
        // operation fails closed with a stable path-free code.
        this.rootIdentityError = code === 'ENAMETOOLONG'
          ? new WorkspaceError('PATH_TOO_LONG', `工作区根路径超过当前系统允许的长度（${code}）；请缩短路径后重试。`)
          : new WorkspaceError('PATH_IDENTITY_UNKNOWN', `无法确认工作区根目录的真实位置（${String(code ?? 'UNKNOWN')}）；拒绝按字面路径继续。`);
      }
    }
    this.workspaceRoot = canonicalRoot;
    this.containsSensitiveData = options.containsSensitiveData ?? (() => false);
    this.containsSensitiveFeedbackData = options.containsSensitiveFeedbackData ?? this.containsSensitiveData;
    this.ignoreFilter = createWorkspaceIgnoreFilter(canonicalRoot);
    this.checkpointManager = new CheckpointManager(canonicalRoot, undefined, this.containsSensitiveData);
    this.officeBatch = new OfficeBatchService(canonicalRoot, this.checkpointManager, value => this.resolvePath(value), options.officeBatchApproval);
    this.officeArchive = new OfficeArchiveService(
      canonicalRoot,
      this.checkpointManager,
      value => this.resolvePath(value),
      options.officeArchiveApproval ?? (options.officeBatchApproval as unknown as OfficeArchiveApprovalPort | undefined),
      options.officeArchiveWorker,
    );
    this.officeTemplate = new OfficeTemplateService(
      canonicalRoot,
      this.checkpointManager,
      value => this.resolvePath(value),
      options.officeTemplateApproval ?? (options.officeBatchApproval as unknown as OfficeTemplateApprovalPort | undefined),
      options.officeTemplateWorker,
      options.officeTemplateSamples,
    );
    this.officeReport = new OfficeReportService(
      canonicalRoot,
      this.checkpointManager,
      value => this.resolvePath(value),
      options.officeReportApproval ?? (options.officeBatchApproval as unknown as OfficeReportApprovalPort | undefined),
      options.officeReportWorker,
    );
    this.officeMail = new OfficeMailService(
      canonicalRoot,
      this.checkpointManager,
      value => this.resolvePath(value),
      options.officeMailApproval ?? (options.officeBatchApproval as unknown as OfficeMailApprovalPort | undefined),
      options.officeMailEmlAdapter,
    );
    this.officeSkills = new OfficeSkillsService(
      canonicalRoot,
      this.checkpointManager,
      value => this.resolvePath(value),
      options.officeSkillsApproval ?? (options.officeBatchApproval as unknown as OfficeSkillsApprovalPort | undefined),
    );
    if (fs.existsSync(this.checkpointManager.getRecoveryRoot())) {
      this.checkpointManager.ensureRecoveryIgnore();
    }
  }

  getCheckpointManager(): CheckpointManager {
    return this.checkpointManager;
  }

  /** A9-70 P1: asynchronous, bounded read-only metadata; no model calls. */
  scanMetadata(targetPath = '', options: OfficeScanOptions = {}): Promise<OfficeMetadataScan> {
    return this.officeBatch.scan(targetPath, options);
  }

  /** Creates a memory-only immutable preview. This does not confer approval. */
  planOrganize(identity: OfficeBatchIdentity, actions: OfficeOrganizeActionInput[], signal?: AbortSignal): Promise<OfficeOrganizePlan> {
    return this.officeBatch.plan(identity, actions, signal);
  }

  /** Host-only entry. A trusted Core/Policy approval port is required at construction. */
  executeOrganize(options: OfficeBatchExecuteOptions): Promise<OfficeBatchResult> {
    return this.officeBatch.execute(options);
  }

  prepareOrganize(options: Omit<OfficeBatchExecuteOptions, 'approvalId'>): ReturnType<OfficeBatchService['prepare']> {
    return this.officeBatch.prepare(options);
  }

  /** A9-70 P2: read-only ZIP32 source manifest & output plan; no writes. */
  planArchive(identity: OfficeBatchIdentity, input: OfficeArchivePlanInput, signal?: AbortSignal): Promise<OfficeArchivePlan> {
    return this.officeArchive.plan(identity, input, signal);
  }

  prepareArchive(planId: string, identity: OfficeBatchIdentity, signal?: AbortSignal): Promise<OfficeArchiveApprovalBinding> {
    return this.officeArchive.prepare(planId, identity, signal);
  }

  executeArchive(options: OfficeArchiveExecuteOptions): Promise<OfficeArchiveResult> {
    return this.officeArchive.execute(options);
  }

  /** A9-70 P3: DOCX template inspection, sample rendering, viewer confirmation & batch output. */
  inspectTemplate(templatePath: string, signal?: AbortSignal): Promise<TemplateInspectResult> {
    return this.officeTemplate.inspect(templatePath, signal);
  }

  planTemplateSample(identity: OfficeBatchIdentity, input: TemplateRenderSampleInput, signal?: AbortSignal): Promise<TemplateSamplePlan> {
    return this.officeTemplate.planSample(identity, input, signal);
  }

  prepareTemplateSample(planId: string, identity: OfficeBatchIdentity, signal?: AbortSignal): Promise<TemplateApprovalBinding> {
    return this.officeTemplate.prepareSample(planId, identity, signal);
  }

  executeTemplateSample(options: { planId: string; identity: OfficeBatchIdentity; approvalId: string; signal?: AbortSignal }): Promise<TemplateSampleResult> {
    return this.officeTemplate.executeSample(options);
  }

  confirmTemplateSample(input: TemplateSampleConfirmation, signal?: AbortSignal) {
    return this.officeTemplate.confirmSample(input, signal);
  }

  listTemplateSamples(workspaceId: string, conversationId: string) {
    return this.officeTemplate.listSamples(workspaceId, conversationId);
  }

  planTemplateBatch(identity: OfficeBatchIdentity, input: TemplateBatchPlanInput, signal?: AbortSignal): Promise<TemplateBatchPlan> {
    return this.officeTemplate.planBatch(identity, input, signal);
  }

  prepareTemplateBatch(planId: string, identity: OfficeBatchIdentity, signal?: AbortSignal): Promise<TemplateApprovalBinding> {
    return this.officeTemplate.prepareBatch(planId, identity, signal);
  }

  executeTemplateBatch(options: { planId: string; identity: OfficeBatchIdentity; approvalId: string; signal?: AbortSignal }): Promise<TemplateBatchResult> {
    return this.officeTemplate.executeBatch(options);
  }

  /** A9-70 P4: PPTX structured layouts / template fill and escaped offline HTML dashboard. */
  planPresentation(identity: OfficeBatchIdentity, input: PresentationCreateInput, signal?: AbortSignal): Promise<PresentationPlan> {
    return this.officeReport.planPresentation(identity, input, signal);
  }

  preparePresentation(planId: string, identity: OfficeBatchIdentity, signal?: AbortSignal): Promise<ReportApprovalBinding> {
    return this.officeReport.preparePresentation(planId, identity, signal);
  }

  executePresentation(options: { planId: string; identity: OfficeBatchIdentity; approvalId: string; signal?: AbortSignal }): Promise<PresentationResult> {
    return this.officeReport.executePresentation(options);
  }

  planHtmlReport(identity: OfficeBatchIdentity, input: HtmlReportCreateInput, signal?: AbortSignal): Promise<HtmlReportPlan> {
    return this.officeReport.planHtmlReport(identity, input, signal);
  }

  prepareHtmlReport(planId: string, identity: OfficeBatchIdentity, signal?: AbortSignal): Promise<ReportApprovalBinding> {
    return this.officeReport.prepareHtmlReport(planId, identity, signal);
  }

  executeHtmlReport(options: { planId: string; identity: OfficeBatchIdentity; approvalId: string; signal?: AbortSignal }): Promise<HtmlReportResult> {
    return this.officeReport.executeHtmlReport(options);
  }

  /** A9-70 P5: Read-only MailSourceAdapter (Mock/SURROGATE & EML) + host-approved attachment extraction. */
  listMailSource(
    input: { source: 'mock' | 'eml'; folder?: string; cursor?: string; limit?: number; emlDir?: string; mockPath?: string },
    signal?: AbortSignal,
  ) {
    return this.officeMail.list(input, signal);
  }

  readMailMessage(
    input: { source: 'mock' | 'eml'; messageId: string; emlDir?: string; mockPath?: string },
    signal?: AbortSignal,
  ) {
    return this.officeMail.read(input, signal);
  }

  planMailExtract(identity: OfficeBatchIdentity, input: MailExtractPlanInput, signal?: AbortSignal): Promise<MailExtractPlan> {
    return this.officeMail.planExtract(identity, input, signal);
  }

  prepareMailExtract(planId: string, identity: OfficeBatchIdentity, signal?: AbortSignal): Promise<MailExtractApprovalBinding> {
    return this.officeMail.prepareExtract(planId, identity, signal);
  }

  executeMailExtract(options: { planId: string; identity: OfficeBatchIdentity; approvalId: string; signal?: AbortSignal }): Promise<MailExtractResult> {
    return this.officeMail.executeExtract(options);
  }

  /** A9-70 P6: Built-in office skill presets installer (refuses overwrite). */
  listBuiltinOfficeSkills() {
    return this.officeSkills.listBuiltin();
  }

  planInstallOfficeSkills(identity: OfficeBatchIdentity, input: OfficeSkillsInstallInput = {}, signal?: AbortSignal): Promise<OfficeSkillsInstallPlan> {
    return this.officeSkills.planInstall(identity, input, signal);
  }

  prepareInstallOfficeSkills(planId: string, identity: OfficeBatchIdentity, signal?: AbortSignal): Promise<OfficeSkillsApprovalBinding> {
    return this.officeSkills.prepareInstall(planId, identity, signal);
  }

  executeInstallOfficeSkills(options: { planId: string; identity: OfficeBatchIdentity; approvalId: string; signal?: AbortSignal }): Promise<OfficeSkillsInstallResult> {
    return this.officeSkills.executeInstall(options);
  }

  // -------------------------------------------------------------------------
  // 路径与基线
  // -------------------------------------------------------------------------

  private resolvePath(targetPath: string): { absPath: string; relPath: string; isOutside: boolean } {
    if (this.rootIdentityError) throw this.rootIdentityError;
    const absPath = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.workspaceRoot, targetPath);
    // Canonical/real path：解析 junction、symlink 与 reparse point 的真实位置。
    // A9-67 F-022: identity failures fail closed with stable, path-free codes.
    // ENOENT/ENOTDIR mean "not there yet"; anything else (ENAMETOOLONG, which
    // libuv also reports for Win32 ERROR_FILENAME_EXCED_RANGE 206, EACCES,
    // ELOOP, ...) means the canonical location is unknown, so a lexical path
    // must not be reported as a verified workspace-relative identity.
    const identityError = (error: unknown): WorkspaceError => {
      const code = String((error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN');
      return code === 'ENAMETOOLONG'
        ? new WorkspaceError('PATH_TOO_LONG', `路径超过当前系统允许的长度（${code}）；请缩短路径后重试。`)
        : new WorkspaceError('PATH_IDENTITY_UNKNOWN', `无法确认路径的真实位置（${code}）；拒绝按字面路径继续。`);
    };
    const present = (candidate: string): boolean => {
      try {
        fs.statSync(candidate);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw identityError(error);
      }
    };
    // 对不存在的路径解析其最近存在祖先，保留末段。
    let probe = absPath;
    const suffixSegments: string[] = [];
    while (!present(probe)) {
      suffixSegments.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    let realProbe: string;
    try {
      realProbe = fs.realpathSync(probe);
    } catch (error) {
      throw identityError(error);
    }
    const realPath = suffixSegments.length > 0 ? path.join(realProbe, ...suffixSegments) : realProbe;
    const relPath = path.relative(this.workspaceRoot, realPath).replace(/\\/g, '/');
    const isOutside = relPath.startsWith('..') || path.isAbsolute(relPath);
    return { absPath: realPath, relPath, isOutside };
  }

  private fileHash(absPath: string): { sha256: string; mtimeMs: number; size: number } {
    const stat = fs.statSync(absPath);
    const content = fs.readFileSync(absPath);
    return {
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  }

  private recordBaseline(
    relPath: string,
    absPath: string,
    binding?: { encoding: WritableEncoding; bom: boolean },
  ): void {
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      this.baselines.set(relPath, { ...this.fileHash(absPath), ...(binding || {}) });
    } else {
      this.baselines.delete(relPath);
    }
  }

  /**
   * 写入前的基线校验：已存在的文件必须有新鲜读取基线；基线与磁盘不一致时
   * 拒绝覆盖（BASELINE_DRIFT），从未读取时要求先读（READ_REQUIRED）。
   */
  private ensureWritableBaseline(absPath: string, relPath: string): BaselineFact | undefined {
    if (!fs.existsSync(absPath)) return undefined;
    if (!fs.statSync(absPath).isFile()) return undefined;
    const current = this.fileHash(absPath);
    const baseline = this.baselines.get(relPath);
    if (!baseline) {
      throw new WorkspaceError(
        'READ_REQUIRED',
        `文件 ${relPath} 已存在但尚未读取。请先 read 该文件建立基线，再执行写入。`,
      );
    }
    if (baseline.sha256 !== current.sha256 || baseline.size !== current.size) {
      throw new WorkspaceError(
        'BASELINE_DRIFT',
        `文件 ${relPath} 在上次读取后被外部修改（hash 或大小变化）。拒绝覆盖；请重新读取后再写入。`,
      );
    }
    return baseline;
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  async list(
    targetPath: string = '',
    options: { recursive?: boolean; maxEntries?: number; signal?: AbortSignal } = {},
  ): Promise<A9ListResult> {
    const { absPath, relPath, isOutside } = this.resolvePath(targetPath);
    const maxEntries = options.maxEntries || 500;
    const recursive = options.recursive || false;
    const signal = options.signal;
    const checkCanceled = () => {
      if (signal?.aborted) throw new Error('目录读取已取消');
    };
    const controller = createYieldController();
    checkCanceled();
    let stat: fs.Stats;
    let rootIdentity: DirectoryScanIdentity;
    try {
      rootIdentity = bindDirectoryScan(absPath);
      stat = await fs.promises.stat(absPath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error(`目录不存在: ${targetPath}`);
      throw new WorkspaceError('DIRECTORY_READ_FAILED', `无法读取目录 ${relPath || '.'}: ${error?.message || 'unknown error'}`);
    }
    if (!stat.isDirectory()) throw new Error(`路径不是目录: ${targetPath}`);
    verifyDirectoryScan(rootIdentity);

    const entries: A9ListResult['entries'] = [];
    const skipped: A9ListResult['skipped'] = [];
    let skippedTotal = 0;
    const recordSkipped = (directoryPath: string, reason: 'directory_unreadable' | 'ignored' = 'directory_unreadable'): void => {
      skippedTotal += 1;
      // 被规则忽略的项最多占用前 25 个明细位，避免挤掉真实读取失败。
      if (skipped.length < (reason === 'ignored' ? IGNORED_SKIP_DETAIL_LIMIT : 50)) skipped.push({ path: directoryPath || '.', reason });
    };
    let truncated = false;
    // canonical path 集合防止 junction/symlink 递归环。
    let rootRealPath: string;
    try {
      rootRealPath = await fs.promises.realpath(absPath);
    } catch (error: any) {
      checkCanceled();
      throw new WorkspaceError('DIRECTORY_READ_FAILED', `无法读取目录 ${relPath || '.'}: ${error?.message || 'unknown error'}`);
    }
    verifyDirectoryScan(rootIdentity);
    const visitedDirs = new Set<string>([rootRealPath]);

    const scan = async (currentDir: string, currentRel: string, depth: number, isRoot: boolean,
      identity: DirectoryScanIdentity): Promise<void> => {
      checkCanceled();
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const verifyCurrentDirectory = () => {
        checkCanceled();
        verifyDirectoryScan(rootIdentity);
        if (identity !== rootIdentity) verifyDirectoryScan(identity);
      };
      verifyCurrentDirectory();

      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(currentDir, { withFileTypes: true });
        checkCanceled();
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        checkCanceled();
      } catch (error: any) {
        if (signal?.aborted) throw new Error('目录读取已取消');
        verifyCurrentDirectory();
        if (isRoot) {
          throw new WorkspaceError('DIRECTORY_READ_FAILED', `无法读取目录 ${relPath || '.'}: ${error?.message || 'unknown error'}`);
        }
        recordSkipped(currentRel);
        return;
      }
      verifyCurrentDirectory();

      for (const dirent of dirents) {
        await controller.checkpoint(false, verifyCurrentDirectory);
        checkCanceled();
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }

        const itemRel = currentRel ? `${currentRel}/${dirent.name}` : dirent.name;
        if (!isOutside && this.ignoreFilter.isIgnored(itemRel, dirent.isDirectory())) {
          recordSkipped(itemRel, 'ignored');
          continue;
        }

        const itemAbs = path.join(currentDir, dirent.name);
        let type: 'file' | 'directory' | 'symlink' | 'other' = 'other';
        let sizeBytes: number | undefined;

        if (dirent.isDirectory()) type = 'directory';
        else if (dirent.isFile()) {
          type = 'file';
          try {
            sizeBytes = fs.statSync(itemAbs).size;
          } catch (_e) {
            // ignore
          }
        } else if (dirent.isSymbolicLink()) type = 'symlink';

        entries.push({ name: dirent.name, path: itemRel, type, sizeBytes });

        if (recursive && dirent.isDirectory() && depth < 10) {
          let realChild: string;
          let childIdentity: DirectoryScanIdentity;
          try {
            childIdentity = bindDirectoryScan(itemAbs);
            realChild = await fs.promises.realpath(itemAbs);
          } catch (error) {
            checkCanceled();
            if (error instanceof WorkspaceError && error.code === 'DIRECTORY_READ_FAILED') throw error;
            verifyCurrentDirectory();
            recordSkipped(itemRel);
            continue;
          }
          verifyCurrentDirectory();
          verifyDirectoryScan(childIdentity);
          if (!visitedDirs.has(realChild)) {
            visitedDirs.add(realChild);
            await scan(itemAbs, itemRel, depth + 1, false, childIdentity);
          }
        }
      }
      verifyCurrentDirectory();
    };

    await scan(absPath, relPath === '.' ? '' : relPath, 0, true, rootIdentity);
    verifyDirectoryScan(rootIdentity);

    return {
      path: relPath || '.',
      totalEntries: entries.length,
      truncated,
      outsideWorkspace: isOutside,
      skipped,
      skippedTotal,
      entries,
    };
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  async read(
    targetPath: string,
    options: { startLine?: number; maxLines?: number; encoding?: string; signal?: AbortSignal } = {},
  ): Promise<A9ReadResult> {
    const startLine = options.startLine ?? 1;
    const maxLines = options.maxLines ?? 200;
    if (!Number.isSafeInteger(startLine) || startLine < 1 ||
        !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 2000) {
      throw new TypeError('read requires a positive integer startLine and maxLines in 1..2000');
    }
    if (options.encoding !== undefined && !['utf-8', 'gbk', 'utf-16le', 'binary'].includes(options.encoding)) {
      throw new TypeError('read encoding must be utf-8, gbk, utf-16le or binary');
    }
    const checkCanceled = () => {
      if (options.signal?.aborted) throw new Error('文件读取已取消');
    };
    checkCanceled();
    const { absPath, relPath, isOutside } = this.resolvePath(targetPath);
    this.baselines.delete(relPath);
    const pathBefore = await fs.promises.stat(absPath);
    if (!pathBefore.isFile()) throw new Error(`路径不是文件: ${targetPath}`);
    checkCanceled();
    const handle = await fs.promises.open(absPath, 'r');
    let result: A9ReadResult;
    let baseline: BaselineFact;
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`路径不是文件: ${targetPath}`);
      if (before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size ||
          before.mtimeMs !== pathBefore.mtimeMs || before.ctimeMs !== pathBefore.ctimeMs) {
        throw new WorkspaceError('BASELINE_DRIFT', '文件在打开期间变化，请重读。');
      }
      if (!Number.isSafeInteger(before.size)) throw new Error('文件大小超出安全读取范围');
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let headerSize = 0;
      while (headerSize < Math.min(3, before.size)) {
        checkCanceled();
        const { bytesRead } = await handle.read(buffer, headerSize, Math.min(3, before.size) - headerSize, headerSize);
        if (!bytesRead) throw new WorkspaceError('BASELINE_DRIFT', '文件在读取期间被截断，请重读。');
        headerSize += bytesRead;
      }
      const header = buffer.subarray(0, headerSize);
      const automatic = options.encoding === undefined;
      // Probe entire streams, not a prefix: a long ASCII header may precede GBK.
      const encodings: Array<WritableEncoding | 'binary'> = options.encoding
        ? [options.encoding as WritableEncoding | 'binary']
        : header.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? ['utf-16le']
        : header.subarray(0, 2).equals(Buffer.from([0xfe, 0xff])) ? ['binary']
        : header.equals(Buffer.from([0xef, 0xbb, 0xbf])) ? ['utf-8'] : ['utf-8', 'gbk'];
      let finalResult: A9ReadResult | undefined;
      for (const encoding of encodings) {
        checkCanceled();
        let decoder: InstanceType<typeof TextDecoder> | undefined;
        if (encoding !== 'binary') {
          try { decoder = new TextDecoder(encoding, { fatal: true }); }
          catch { /* Unsupported decoder follows the explicit/automatic failure contract below. */ }
        }
        let valid = decoder !== undefined;
        let gbkPending = false;
        let gbkPairs = 0;
        let gbkValid = true;
        let line = 1;
        let linesRead = 0;
        let lineStarted = false;
        let pendingCR = '';
        let remaining = MAX_READ_PREVIEW_BYTES - Buffer.byteLength(READ_TRUNCATION_NOTICE, 'utf8');
        let byteLimited = false;
        const preview: string[] = [];
        const append = (text: string) => {
          if (byteLimited) return;
          const bytes = Buffer.from(text, 'utf8');
          let end = Math.min(bytes.length, remaining);
          if (end < bytes.length) {
            while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
            byteLimited = true;
          }
          preview.push(bytes.subarray(0, end).toString('utf8'));
          remaining -= end;
        };
        const consume = (text: string, final = false) => {
          text = pendingCR + text;
          pendingCR = !final && text.endsWith('\r') ? '\r' : '';
          if (pendingCR) text = text.slice(0, -1);
          // Each split is bounded by a decoded chunk, even for a gigabyte line.
          const parts = text.replace(/\r\n/g, '\n').split('\n');
          for (let index = 0; index < parts.length; index += 1) {
            if (line >= startLine && line - startLine < maxLines && !byteLimited) {
              if (!lineStarted) {
                const prefix = `${linesRead ? '\n' : ''}${line}: `;
                if (Buffer.byteLength(prefix, 'utf8') > remaining) byteLimited = true;
                else { append(prefix); linesRead += 1; lineStarted = true; }
              }
              append(parts[index]);
            }
            if (index < parts.length - 1) { line += 1; lineStarted = false; }
          }
        };
        const digest = crypto.createHash('sha256');
        let position = 0;
        while (position < before.size) {
          checkCanceled();
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
          if (!bytesRead) throw new WorkspaceError('BASELINE_DRIFT', '文件在读取期间被截断，请重读。');
          position += bytesRead;
          const chunk = buffer.subarray(0, bytesRead);
          digest.update(chunk);
          if (automatic && encoding !== 'utf-16le' && chunk.includes(0)) valid = false;
          if (automatic && encoding === 'gbk') {
            for (const byte of chunk) {
              if (gbkPending) {
                if (byte < 0x40 || byte > 0xfe || byte === 0x7f) gbkValid = false;
                gbkPending = false; gbkPairs += 1;
              } else if (byte > 0x7f) {
                if (byte < 0x81 || byte > 0xfe) gbkValid = false;
                gbkPending = true;
              }
            }
          }
          if (valid && decoder) {
            try { consume(decoder.decode(chunk, { stream: true })); }
            catch { valid = false; }
          }
        }
        if (valid && decoder) {
          try { consume(decoder.decode(), true); }
          catch { valid = false; }
        }
        if (automatic && encoding === 'gbk' && (!gbkValid || gbkPending || gbkPairs < 2)) valid = false;
        checkCanceled();
        const after = await handle.stat();
        const current = await fs.promises.stat(absPath);
        if (![after, current].every((stat) => stat.dev === before.dev && stat.ino === before.ino &&
            stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs)) {
          throw new WorkspaceError('BASELINE_DRIFT', '文件身份或内容在读取期间变化，请重读。');
        }
        const sha256 = digest.digest('hex');
        finalResult = {
          path: relPath, isText: false, encoding: 'binary', startLine: 1, linesRead: 0, totalLines: 0,
          content: `[Binary or ambiguous file: size ${before.size} bytes; specify a known text encoding to read]`,
          truncated: false, outsideWorkspace: isOutside, contentSha256: sha256,
        };
        if (valid) {
          const reasons: Array<'line_limit' | 'byte_limit'> = [];
          if (line - startLine >= maxLines) reasons.push('line_limit');
          if (byteLimited) reasons.push('byte_limit');
          finalResult = {
            ...finalResult, isText: true, encoding, startLine, linesRead, totalLines: line,
            content: preview.join('') + (byteLimited ? READ_TRUNCATION_NOTICE : ''),
            truncated: reasons.length > 0, truncationReasons: reasons,
          };
          break;
        }
        if (!automatic && encoding !== 'binary') {
          throw new WorkspaceError('ENCODING_AMBIGUOUS', `文件 ${relPath} 无法按 ${encoding} 严格解码；请确认编码后重读。`);
        }
      }
      checkCanceled();
      // Only complete, stable scans can become a write baseline, never a preview hash.
      result = finalResult!;
      const hasUtf8Bom = header.length >= 3 && header.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
      const hasUtf16LeBom = header.length >= 2 && header.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]));
      baseline = {
        sha256: result.contentSha256,
        mtimeMs: before.mtimeMs,
        size: before.size,
        ...(result.isText ? {
          encoding: result.encoding as WritableEncoding,
          bom: result.encoding === 'utf-8' ? hasUtf8Bom : result.encoding === 'utf-16le' ? hasUtf16LeBom : false,
        } : {}),
      };
    } finally {
      await handle.close();
    }
    checkCanceled();
    this.baselines.set(relPath, baseline);
    return result;
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  async search(
    pattern: string,
    options: { path?: string; isRegex?: boolean; maxMatches?: number; signal?: AbortSignal } = {},
  ): Promise<A9SearchResult> {
    const { absPath, isOutside } = this.resolvePath(options.path || '');
    const maxMatches = options.maxMatches || 200;
    const isRegex = options.isRegex || false;
    const controller = createYieldController();
    const checkCanceled = () => {
      if (options.signal?.aborted) throw new Error('搜索已被用户取消');
    };
    checkCanceled();

    let rootIdentity: DirectoryScanIdentity;
    try {
      rootIdentity = bindDirectoryScan(absPath);
      const rootStat = await fs.promises.stat(absPath);
      if (!rootStat.isDirectory()) throw new Error(`搜索路径不是目录: ${options.path || ''}`);
    } catch (error: any) {
      checkCanceled();
      if (error?.message?.startsWith('搜索路径不是目录:')) throw error;
      if (error?.code === 'ENOENT') throw new Error(`搜索路径不存在: ${options.path || ''}`);
      throw new WorkspaceError('DIRECTORY_READ_FAILED', `无法读取搜索目录: ${error?.message || 'unknown error'}`);
    }
    verifyDirectoryScan(rootIdentity);

    let regex: RegExp;
    try {
      regex = isRegex ? new RegExp(pattern, 'i') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch (e: any) {
      throw new Error(`搜索正则表达式无效: ${e.message}`);
    }

    const matches: A9SearchResult['matches'] = [];
    let truncated = false;
    const truncationReasons = new Set<'matches' | 'files'>();
    let filesScanned = 0;
    let skippedFiles = 0;
    const skipped: A9SearchResult['skipped'] = [];
    let skippedTotal = 0;
    const recordSkipped = (filePath: string, reason: SearchSkippedReason, countAsFile = true): void => {
      skippedTotal += 1;
      if (countAsFile) skippedFiles += 1;
      // 被规则忽略的项最多占用前 25 个明细位，避免挤掉真实读取失败。
      if (skipped.length < (reason === 'ignored' ? IGNORED_SKIP_DETAIL_LIMIT : 50)) skipped.push({ path: filePath || '.', reason });
    };
    // 迭代遍历 + canonical path 集合：可取消、无递归环、不整体加载。
    const queue: Array<{ dir: string; rel: string; identity: DirectoryScanIdentity }> = [
      { dir: absPath, rel: '', identity: rootIdentity },
    ];
    const visitedDirs = new Set<string>([rootIdentity.realPath]);
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      checkCanceled();
      if (matches.length >= maxMatches || filesScanned >= MAX_SEARCH_FILES) {
        truncated = true;
        if (matches.length >= maxMatches) truncationReasons.add('matches');
        if (filesScanned >= MAX_SEARCH_FILES) truncationReasons.add('files');
        break;
      }

      const { dir, rel, identity } = queue[queueIndex++];
      const verifyCurrentDirectory = () => {
        checkCanceled();
        verifyDirectoryScan(rootIdentity);
        if (identity !== rootIdentity) verifyDirectoryScan(identity);
      };
      verifyCurrentDirectory();
      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(dir, { withFileTypes: true });
        checkCanceled();
      } catch (error: any) {
        checkCanceled();
        verifyCurrentDirectory();
        if (!rel) {
          throw new WorkspaceError('DIRECTORY_READ_FAILED', `无法读取搜索目录: ${error?.message || 'unknown error'}`);
        }
        const unreadablePath = path.relative(this.workspaceRoot, dir).replace(/\\/g, '/') || '.';
        recordSkipped(unreadablePath, 'directory_unreadable', false);
        continue;
      }
      verifyCurrentDirectory();

      for (const dirent of dirents) {
        await controller.checkpoint(false, verifyCurrentDirectory);
        checkCanceled();
        if (matches.length >= maxMatches || filesScanned >= MAX_SEARCH_FILES) {
          truncated = true;
          if (matches.length >= maxMatches) truncationReasons.add('matches');
          if (filesScanned >= MAX_SEARCH_FILES) truncationReasons.add('files');
          break;
        }

        const fullPath = path.join(dir, dirent.name);
        const relPath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
        if (!isOutside && this.ignoreFilter.isIgnored(relPath, dirent.isDirectory())) {
          recordSkipped(relPath, 'ignored', false);
          continue;
        }

        if (dirent.isDirectory()) {
          let realChild: string;
          let childIdentity: DirectoryScanIdentity;
          try {
            childIdentity = bindDirectoryScan(fullPath);
            realChild = childIdentity.realPath;
          } catch (error) {
            checkCanceled();
            if (error instanceof WorkspaceError && error.code === 'DIRECTORY_READ_FAILED') throw error;
            recordSkipped(relPath, 'directory_unreadable', false);
            continue;
          }
          if (!visitedDirs.has(realChild)) {
            visitedDirs.add(realChild);
            queue.push({ dir: fullPath, rel: rel ? `${rel}/${dirent.name}` : dirent.name, identity: childIdentity });
          }
          continue;
        }
        if (!dirent.isFile()) continue;

        filesScanned += 1;
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(fullPath);
        } catch (_e) {
          recordSkipped(relPath, 'stat_failed');
          continue;
        }
        if (!stat.isFile()) {
          recordSkipped(relPath, 'stat_failed');
          continue;
        }
        if (stat.size > MAX_SEARCH_FILE_BYTES) {
          recordSkipped(relPath, 'too_large');
          continue;
        }
        try {
          const buf = fs.readFileSync(fullPath);
          const detection = detectEncoding(buf);
          if (detection.encoding === 'ambiguous') {
            recordSkipped(relPath, 'binary_or_ambiguous', false);
            continue;
          }
          const text = decodeBuffer(buf, detection.encoding as WritableEncoding);
          if (text === undefined) {
            recordSkipped(relPath, 'binary_or_ambiguous', false);
            continue;
          }

          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if ((i & 0xff) === 0) {
              await controller.checkpoint(false, verifyCurrentDirectory);
              checkCanceled();
            }
            if (regex.test(lines[i])) {
              matches.push({
                filePath: relPath,
                lineNumber: i + 1,
                lineText: lines[i],
                contextBefore: i > 0 ? [lines[i - 1]] : [],
                contextAfter: i < lines.length - 1 ? [lines[i + 1]] : [],
              });
              if (matches.length >= maxMatches) {
                truncated = true;
                truncationReasons.add('matches');
                break;
              }
            }
          }
        } catch (error) {
          checkCanceled();
          if (error instanceof WorkspaceError && error.code === 'DIRECTORY_READ_FAILED') throw error;
          recordSkipped(relPath, 'read_failed');
        }
        if (truncated) break;
      }
      verifyCurrentDirectory();
    }
    verifyDirectoryScan(rootIdentity);

    return {
      pattern,
      totalMatches: matches.length,
      truncated,
      outsideWorkspace: isOutside,
      filesScanned,
      skippedFiles,
      skipped,
      skippedTotal,
      truncationReasons: Array.from(truncationReasons),
      matches,
    };
  }

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  /** Office outputs create new files and participate in the existing undo chain. */
  async writeDocumentCopy(target: string, buffer: Buffer, options: { turnId: string }): Promise<A9WriteResult> {
    const resolved = officePath(this.workspaceRoot, target, true);
    this.checkpointManager.recordPreMutation(options.turnId, resolved.relative);
    const relative = createOfficeCopy(this.workspaceRoot, target, buffer);
    this.checkpointManager.recordPostMutation(options.turnId, relative, 'create');
    this.recordBaseline(relative, resolved.absolute);
    return { path: relative, bytesWritten: buffer.length, encoding: 'binary', created: true, outsideWorkspace: false };
  }

  /** Bind ownership before GBK preparation; validate in the caller's turn after await. */
  private bindEncodingMutationPath(
    targetPath: string,
    resolved: { absPath: string; relPath: string; isOutside: boolean },
  ): () => void {
    const guard = new IoGuard([
      captureNearestAnchor(this.workspaceRoot),
      captureNearestAnchor(path.dirname(resolved.absPath)),
    ]);
    return () => {
      guard.assertAnchors();
      guard.check(resolved.absPath);
      this.checkpointManager.validateRecoveryIdentity();
      const current = this.resolvePath(targetPath);
      if (!samePath(current.absPath, resolved.absPath) || current.relPath !== resolved.relPath ||
          current.isOutside !== resolved.isOutside) throw identityChanged('GBK mutation path');
    };
  }

  async write(
    targetPath: string,
    content: string,
    options: { encoding?: string; turnId?: string } = {},
  ): Promise<A9WriteResult> {
    const { absPath, relPath, isOutside } = this.resolvePath(targetPath);
    const turnId = options.turnId || 'turn-default';
    // A9-66 F-025: build the GBK reverse table cooperatively before the first
    // GBK write; done before every baseline check so no new await gap appears
    // between validation and the atomic write.
    const boundEncoding = this.baselines.get(relPath)?.encoding;
    if (options.encoding === 'gbk' || (!options.encoding && fs.existsSync(absPath) && boundEncoding !== 'utf-8' && boundEncoding !== 'utf-16le')) {
      const validatePath = this.bindEncodingMutationPath(targetPath, { absPath, relPath, isOutside });
      await prepareGbkEncodeTableAsync();
      validatePath();
    }
    const isNew = !fs.existsSync(absPath);

    if (!isNew) {
      // 覆盖已有文件必须绑定新鲜读取基线。
      this.ensureWritableBaseline(absPath, relPath);
    }

    this.checkpointManager.recordPreMutation(turnId, relPath);

    let buffer: Buffer;
    let encodingUsed: string;
    if (options.encoding && options.encoding !== 'utf-8') {
      encodingUsed = options.encoding;
      try {
        buffer = encodeText(content, options.encoding as WritableEncoding);
      } catch (err) {
        if (err instanceof EncodingWriteError) {
          throw new WorkspaceError('ENCODING_WRITE_UNSUPPORTED', err.message);
        }
        throw err;
      }
    } else if (!isNew) {
      // 未显式指定编码时保持原文件编码与 BOM。
      const raw = fs.readFileSync(absPath);
      const detection = detectEncoding(raw);
      const baseline = this.baselines.get(relPath);
      const boundEncoding = baseline && baseline.encoding;
      if (!boundEncoding && detection.encoding === 'ambiguous') {
        throw new WorkspaceError(
          'ENCODING_AMBIGUOUS',
          `文件 ${relPath} 的现有编码无法可靠识别；请显式指定 encoding 或先以 binary 查看。`,
        );
      }
      const encoding = boundEncoding || detection.encoding as WritableEncoding;
      const body = encodeText(content, encoding);
      const bom = bomPrefixFor(encoding, boundEncoding ? baseline!.bom === true : detection.bom);
      buffer = bom.length > 0 ? Buffer.concat([bom, body]) : body;
      encodingUsed = encoding;
    } else {
      // 新文件默认 UTF-8 无 BOM。
      buffer = encodeText(content, 'utf-8');
      encodingUsed = 'utf-8';
    }

    this.ensureParentDir(absPath);
    atomicWrite(absPath, buffer);

    this.checkpointManager.recordPostMutation(turnId, relPath, isNew ? 'create' : 'modify');
    const writtenBom = encodingUsed === 'utf-8'
      ? buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
      : encodingUsed === 'utf-16le' && buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]));
    this.recordBaseline(relPath, absPath, { encoding: encodingUsed as WritableEncoding, bom: writtenBom });

    return {
      path: relPath,
      bytesWritten: buffer.length,
      encoding: encodingUsed,
      created: isNew,
      outsideWorkspace: isOutside,
    };
  }

  // -------------------------------------------------------------------------
  // edit
  // -------------------------------------------------------------------------

  async edit(
    targetPath: string,
    oldText: string,
    newText: string,
    options: { turnId?: string } = {},
  ): Promise<A9EditResult> {
    const { absPath, relPath, isOutside } = this.resolvePath(targetPath);
    const turnId = options.turnId || 'turn-default';
    const boundEncoding = this.baselines.get(relPath)?.encoding;
    if (boundEncoding !== 'utf-8' && boundEncoding !== 'utf-16le') {
      const validatePath = this.bindEncodingMutationPath(targetPath, { absPath, relPath, isOutside });
      await prepareGbkEncodeTableAsync();
      validatePath();
    }

    if (!fs.existsSync(absPath)) {
      throw new Error(`待编辑文件不存在: ${targetPath}`);
    }
    // 编辑必须基于新鲜读取基线；外部变化后拒绝覆盖。
    const baseline = this.ensureWritableBaseline(absPath, relPath)!;

    const raw = fs.readFileSync(absPath);
    const detection = detectEncoding(raw);
    const encoding = baseline.encoding || (detection.encoding === 'ambiguous' ? undefined : detection.encoding as WritableEncoding);
    if (!encoding) {
      throw new WorkspaceError('ENCODING_AMBIGUOUS', `文件 ${relPath} 编码无法可靠识别，拒绝文本编辑以避免损坏原始字节。`);
    }
    const originalText = decodeBuffer(raw, encoding);
    if (originalText === undefined) {
      throw new WorkspaceError('ENCODING_AMBIGUOUS', `文件 ${relPath} 按 ${encoding} 解码失败，拒绝编辑。`);
    }

    const firstIndex = originalText.indexOf(oldText);
    if (firstIndex === -1) {
      throw new Error(`未在 ${relPath} 中找到匹配的 oldText，请重新读取文件并确认锚点内容。`);
    }

    const secondIndex = originalText.indexOf(oldText, firstIndex + oldText.length);
    if (secondIndex !== -1) {
      throw new Error(`oldText 在 ${relPath} 中存在多处匹配，请提供包含更多上下文的唯一文本块。`);
    }

    const replacedText = originalText.slice(0, firstIndex) + newText + originalText.slice(firstIndex + oldText.length);

    // 保持原编码、BOM、EOL 与末尾换行。
    let preserved: { buffer: Buffer; encoding: WritableEncoding; eol: string };
    try {
      const result = reencodePreservingOriginal(raw, originalText, replacedText, {
        encoding,
        bom: baseline.encoding ? baseline.bom === true : detection.bom,
      });
      preserved = { buffer: result.buffer, encoding: result.encoding, eol: result.eol };
    } catch (err) {
      if (err instanceof EncodingWriteError) {
        throw new WorkspaceError('ENCODING_WRITE_UNSUPPORTED', err.message);
      }
      throw err;
    }

    const noOp = raw.equals(preserved.buffer);
    let feedback: A9EditFeedbackV1;
    try {
      const afterText = decodeBuffer(preserved.buffer, preserved.encoding);
      if (afterText === undefined) throw new Error('re-encoded edit result could not be decoded');
      // Classify before clipping: a truncated credential cannot be redacted later.
      if (this.containsSensitiveFeedbackData(raw) || this.containsSensitiveFeedbackData(preserved.buffer) ||
          this.containsSensitiveFeedbackData(originalText) || this.containsSensitiveFeedbackData(afterText)) {
        feedback = { ...unavailableEditFeedback(raw, preserved.buffer), unavailableReason: 'A9_EDIT_FEEDBACK_SENSITIVE' };
      } else feedback = buildEditFeedback(
        raw,
        preserved.buffer,
        originalText,
        afterText,
        { maxDiffBytes: DEFAULT_EDIT_DIFF_MAX_BYTES },
      );
    } catch (_err) {
      // The edit already passed encoding and re-encoding; feedback failure must
      // never be reported as a failed write.
      feedback = unavailableEditFeedback(raw, preserved.buffer);
    }

    if (noOp) {
      return {
        path: relPath,
        replaced: false,
        encoding: preserved.encoding,
        eol: preserved.eol,
        outsideWorkspace: isOutside,
        diffSummary: `No change: anchor matched, but the re-encoded result is byte-identical (encoding ${preserved.encoding} preserved).`,
        noOp: true,
        feedback,
      };
    }

    this.checkpointManager.recordPreMutation(turnId, relPath);
    this.ensureParentDir(absPath);
    atomicWrite(absPath, preserved.buffer);

    this.checkpointManager.recordPostMutation(turnId, relPath, 'modify');
    this.recordBaseline(relPath, absPath, { encoding: preserved.encoding, bom: preserved.buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || preserved.buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) });

    return {
      path: relPath,
      replaced: true,
      encoding: preserved.encoding,
      eol: preserved.eol,
      outsideWorkspace: isOutside,
      diffSummary: `Replaced anchor of length ${oldText.length} with ${newText.length} characters (encoding ${preserved.encoding} preserved).`,
      noOp: false,
      feedback,
    };
  }

  // -------------------------------------------------------------------------
  // copy / move
  // -------------------------------------------------------------------------

  /**
   * A9-66 F-011: runs one destructive workspace side effect after its
   * recovery facts exist. Cancellation is honoured until the first filesystem
   * change; afterwards a failure or cancellation still tries to record the
   * actual post-state of every touched path before it is reported as incomplete.
   * The report states exactly which facts were and were not made durable.
   */
  private async runRecordedSideEffect(
    turnId: string,
    signal: AbortSignal | undefined,
    guard: IoGuard,
    effect: (onSideEffect: () => void) => Promise<void>,
    facts: () => Array<{ relPath: string; absPath: string }>,
    label: string,
  ): Promise<void> {
    if (signal?.aborted) throw new Error(`${label}已取消（未执行任何文件变更）`);
    let changed = false;
    try {
      await effect(() => { changed = true; });
    } catch (error) {
      if (!changed) throw error;
      const recorded: string[] = [];
      const notRecorded: string[] = [];
      for (const fact of facts()) {
        try {
          await this.checkpointManager.recordPostMutationAsync(turnId, fact.relPath, fs.existsSync(fact.absPath) ? 'modify' : 'delete', { guard });
          this.baselines.delete(fact.relPath);
          recorded.push(fact.relPath);
        } catch (recordError) {
          notRecorded.push(`${fact.relPath}: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new WorkspaceError('OPERATION_INCOMPLETE', notRecorded.length === 0
        ? `${label}未完成，部分文件已变化，变化事实已记入本轮 checkpoint（${reason}）`
        : `${label}未完成，部分文件已变化；变化事实${recorded.length ? '仅部分' : '未能'}记入本轮 checkpoint（${reason}）；`
          + `未能记录：${notRecorded.join('; ')}。不要假定撤销能覆盖这些变化。`);
    }
  }

  /** Post-effect fact recording; a persist failure is reported as unrecorded, never as recorded. */
  private async recordPostFacts(label: string, record: () => Promise<void>): Promise<void> {
    try {
      await record();
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'DIRECTORY_IDENTITY_CHANGED') {
        throw new WorkspaceError('OPERATION_INCOMPLETE',
          `${label}已执行，但目录身份在记录变化事实前已变化；变化事实未能记入 checkpoint，也未对新位置做任何读写。`);
      }
      throw new WorkspaceError('OPERATION_INCOMPLETE',
        `${label}已执行，但变化事实未能记入 checkpoint（${error instanceof Error ? error.message : String(error)}）。`);
    }
  }

  async copy(
    sourcePath: string,
    destinationPath: string,
    options: { overwrite?: boolean; turnId?: string; signal?: AbortSignal } = {},
  ): Promise<{ source: string; destination: string; copied: boolean; outsideWorkspace: boolean }> {
    const { absPath: srcAbs, relPath: srcRel, isOutside: srcOutside } = this.resolvePath(sourcePath);
    const { absPath: destAbs, relPath: destRel, isOutside: destOutside } = this.resolvePath(destinationPath);
    const turnId = options.turnId || 'turn-default';

    if (!fs.existsSync(srcAbs)) {
      throw new Error(`源文件/目录不存在: ${sourcePath}`);
    }

    const destExisted = fs.existsSync(destAbs);
    if (destExisted && !options.overwrite) {
      throw new Error(`目标已存在且 overwrite 未开启: ${destinationPath}`);
    }
    if (destExisted && fs.statSync(destAbs).isFile()) {
      // 覆盖已有目标必须绑定新鲜基线，撤销要能恢复原目标。
      this.ensureWritableBaseline(destAbs, destRel);
    }

    // Identity of the root, recovery store and both parent directories is bound
    // before the first await; every later I/O is checked against it.
    const guard = this.checkpointManager.createIoGuard([srcAbs, destAbs]);
    await this.checkpointManager.recordPreMutationAsync(turnId, destRel, { signal: options.signal, guard });

    await this.runRecordedSideEffect(turnId, options.signal, guard, async (onSideEffect) => {
      guard.ensureDirectory(path.dirname(destAbs));
      await copyTreeAsync(srcAbs, destAbs, { force: true, signal: options.signal, guard, onSideEffect });
    }, () => [{ relPath: destRel, absPath: destAbs }], '复制');

    await this.recordPostFacts('复制', () => this.checkpointManager.recordPostMutationAsync(turnId, destRel, destExisted ? 'modify' : 'create', { guard }));
    guard.check(destAbs);
    this.recordBaseline(destRel, destAbs);

    return {
      source: srcRel,
      destination: destRel,
      copied: true,
      outsideWorkspace: srcOutside || destOutside,
    };
  }

  async move(
    sourcePath: string,
    destinationPath: string,
    options: { overwrite?: boolean; turnId?: string; signal?: AbortSignal } = {},
  ): Promise<{ source: string; destination: string; moved: boolean; outsideWorkspace: boolean }> {
    const { absPath: srcAbs, relPath: srcRel, isOutside: srcOutside } = this.resolvePath(sourcePath);
    const { absPath: destAbs, relPath: destRel, isOutside: destOutside } = this.resolvePath(destinationPath);
    const turnId = options.turnId || 'turn-default';

    if (!fs.existsSync(srcAbs)) {
      throw new Error(`源文件/目录不存在: ${sourcePath}`);
    }

    const destExisted = fs.existsSync(destAbs);
    if (destExisted && !options.overwrite) {
      throw new Error(`目标已存在且 overwrite 未开启: ${destinationPath}`);
    }
    if (destExisted && fs.statSync(destAbs).isFile()) {
      this.ensureWritableBaseline(destAbs, destRel);
    }

    const guard = this.checkpointManager.createIoGuard([srcAbs, destAbs]);
    // 源与目标都要可撤销：源记 delete（保留原始内容），目标记 modify/create。
    await this.checkpointManager.recordPreMutationAsync(turnId, srcRel, { signal: options.signal, guard });
    await this.checkpointManager.recordPreMutationAsync(turnId, destRel, { signal: options.signal, guard });

    // rename is one atomic filesystem call; it either happened or it did not.
    if (options.signal?.aborted) throw new Error('移动已取消（未执行任何文件变更）');
    guard.ensureDirectory(path.dirname(destAbs));
    guard.check(srcAbs);
    guard.check(destAbs);
    fs.renameSync(srcAbs, destAbs);

    await this.recordPostFacts('移动', async () => {
      await this.checkpointManager.recordPostMutationAsync(turnId, srcRel, 'delete', { guard });
      await this.checkpointManager.recordPostMutationAsync(turnId, destRel, destExisted ? 'modify' : 'create', { guard });
    });
    this.baselines.delete(srcRel);
    guard.check(destAbs);
    this.recordBaseline(destRel, destAbs);

    return {
      source: srcRel,
      destination: destRel,
      moved: true,
      outsideWorkspace: srcOutside || destOutside,
    };
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  /**
   * 删除语义：permanent:false 时文件/目录进入产品恢复区（checkpoint 持久化，
   * 可按文件/按 Turn 撤销）；permanent:true 才执行不可恢复删除（调用方必须
   * 已获得用户确认）。非空目录必须显式 recursive:true。
   */
  async delete(
    targetPath: string,
    options: { recursive?: boolean; permanent?: boolean; turnId?: string; signal?: AbortSignal } = {},
  ): Promise<A9DeleteResult> {
    const { absPath, relPath, isOutside } = this.resolvePath(targetPath);
    const turnId = options.turnId || 'turn-default';

    if (!fs.existsSync(absPath)) {
      throw new Error(`待删除文件/目录不存在: ${targetPath}`);
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory() && !options.recursive) {
      const children = fs.readdirSync(absPath);
      if (children.length > 0) {
        throw new WorkspaceError(
          'INVALID_TOOL_INPUT',
          `目录 ${relPath} 非空。确认递归删除请设置 recursive:true（permanent:false 时内容仍可从恢复区找回）。`,
        );
      }
    }

    const guard = this.checkpointManager.createIoGuard([absPath]);
    // 副作用前先落恢复事实：permanent:false 的可恢复性由此保证。
    const record = await this.checkpointManager.recordPreMutationAsync(turnId, relPath, { signal: options.signal, guard });

    if (options.permanent !== true) {
      // permanent:false：内容已随 recordPreMutation 进入恢复区（blob/目录快照），
      // 此时移除原路径；undo 可整体恢复。
      if (stat.isDirectory()) {
        if (!record.originalSnapshotPath && !record.currentStateSnapshotPath) {
          throw new WorkspaceError('CHECKPOINT_PERSIST_FAILED', `目录 ${relPath} 的恢复快照未能建立，拒绝删除以保持可恢复性。`);
        }
      } else if (!record.originalBlobPath && !record.currentStateBlobPath && !record.newBlobPath) {
        throw new WorkspaceError('CHECKPOINT_PERSIST_FAILED', `文件 ${relPath} 的恢复内容未能建立，拒绝删除以保持可恢复性。`);
      }
    }

    await this.runRecordedSideEffect(turnId, options.signal, guard, async (onSideEffect) => {
      if (stat.isDirectory()) {
        await removeTreeAsync(absPath, { signal: options.signal, guard, onSideEffect });
      } else {
        guard.check(absPath);
        fs.unlinkSync(absPath);
        onSideEffect();
      }
    }, () => [{ relPath, absPath }], '删除');
    await this.recordPostFacts('删除', () => this.checkpointManager.recordPostMutationAsync(turnId, relPath, 'delete', { guard }));
    this.baselines.delete(relPath);

    if (options.permanent === true) {
      return {
        path: relPath,
        deleted: true,
        permanent: true,
        outsideWorkspace: isOutside,
      };
    }
    return {
      path: relPath,
      deleted: true,
      permanent: false,
      outsideWorkspace: isOutside,
      recoverableVia: `checkpoint ${turnId} (undo file or turn)`,
    };
  }

  // -------------------------------------------------------------------------
  // R3：Shell/Git/项目脚本外部变化的轮前基线与轮后收集
  // -------------------------------------------------------------------------

  /**
   * 冻结轮前内容基线（第一个潜在副作用前调用）：遵循 ignore；文件数/单文件/
   * 总量有界；超限或读取失败显式记入 skipped（后续变化将标记不可恢复）。
   */
  async freezeTurnBaseline(turnId: string, options: { signal?: AbortSignal } = {}): Promise<TurnContentBaseline> {
    const files: TurnContentBaseline['files'] = Object.create(null);
    const directories: TurnContentBaseline['directories'] = Object.create(null);
    const skipped: TurnContentBaseline['skipped'] = [];
    let totalBytes = 0;
    let fileCount = 0;

    const stack: string[] = [this.workspaceRoot];
    const visited = new Set<string>([this.safeRealPath(this.workspaceRoot)].filter((v): v is string => v !== undefined));
    let sliceStart = Date.now();
    while (stack.length > 0) {
      if (options.signal?.aborted) throw new Error('基线冻结已被取消');
      const dir = stack.pop()!;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_e) {
        if (dir === this.workspaceRoot) throw new Error('无法读取工作区根目录，拒绝建立不完整的轮前基线');
        const skippedPath = path.relative(this.workspaceRoot, dir).replace(/\\/g, '/');
        skipped.push({ path: skippedPath, reason: 'backup_failed' });
        continue;
      }
      for (const dirent of dirents) {
        if (Date.now() - sliceStart >= BASELINE_YIELD_SLICE_MS) {
          await yieldToEventLoop();
          if (options.signal?.aborted) throw new Error('基线冻结已被取消');
          sliceStart = Date.now();
        }
        const fullPath = path.join(dir, dirent.name);
        const rel = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
        if (rel.startsWith('.agent_recovery')) continue;
        if (this.ignoreFilter.isIgnored(rel, dirent.isDirectory())) continue;
        if (this.containsSensitiveData(rel)) {
          throw new Error('A9_CHECKPOINT_SECRET_BLOCKED: workspace path contains known secret material');
        }
        if (dirent.isDirectory()) {
          directories[rel] = this.checkpointManager.saveEmptyDirectoryBaseline(turnId, rel);
          const real = this.safeRealPath(fullPath);
          if (real && !visited.has(real)) {
            visited.add(real);
            stack.push(fullPath);
          } else if (!real) {
            // A9-67 F-029: an unresolvable directory is not scanned; keep the gap as a fact.
            skipped.push({ path: rel, reason: 'backup_failed' });
          }
        } else if (dirent.isFile()) {
          let stat: fs.Stats;
          try {
            stat = fs.statSync(fullPath);
          } catch (_e) {
            skipped.push({ path: rel, reason: 'backup_failed' });
            continue;
          }
          if (fileCount >= MAX_BASELINE_FILES) {
            skipped.push({ path: rel, reason: 'too_large', size: stat.size, mtimeMs: stat.mtimeMs });
            continue;
          }
          if (stat.size > MAX_BASELINE_FILE_BYTES || totalBytes + stat.size > MAX_BASELINE_TOTAL_BYTES) {
            skipped.push({ path: rel, reason: 'too_large', size: stat.size, mtimeMs: stat.mtimeMs });
            continue;
          }
          try {
            const content = this.readBaselineFile(fullPath);
            if (this.containsSensitiveData(content)) {
              throw new Error('A9_CHECKPOINT_SECRET_BLOCKED: workspace file contains known secret material');
            }
            const blobPath = this.checkpointManager.saveToRecovery(turnId, rel, content);
            const sha256 = crypto.createHash('sha256').update(content).digest('hex');
            files[rel] = { sha256, blobPath, size: stat.size };
            totalBytes += stat.size;
            fileCount += 1;
          } catch (error) {
            if (error instanceof Error && error.message.includes('A9_CHECKPOINT_SECRET_BLOCKED')) throw error;
            skipped.push({ path: rel, reason: 'backup_failed', size: stat.size, mtimeMs: stat.mtimeMs });
          }
        }
      }
    }

    const baseline = { turnId, frozenAt: new Date().toISOString(), files, directories, skipped };
    // A9-61: the mandatory round-trip validation yields; it still completes before any side effect.
    await this.checkpointManager.persistExternalBaselineAsync(turnId, {
      frozenAt: baseline.frozenAt,
      files: baseline.files,
      directories: baseline.directories,
      skipped: baseline.skipped,
    });
    return baseline;
  }

  /**
   * 轮后收集外部变化并写入同一份 checkpoint 记录（Diff/undo/SQLite/UI 共用）：
   * created → undo 删除；modified/deleted（有基线 blob）→ 恢复原内容；
   * rename = 同哈希的 delete+create 对；无基线/超限/失败 → 显式不可恢复标记。
   */
  async collectExternalChanges(
    turnId: string,
    baseline: TurnContentBaseline,
    options: { signal?: AbortSignal; requireUndoConfirmation?: boolean } = {},
  ): Promise<ExternalChangeReport> {
    // A9-61: collections of one Turn run one after another, so two collectors
    // never interleave fact batches or confirmation marks of the same Turn.
    const previous = this.turnCollections.get(turnId);
    const run = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.collectExternalChangesSerialized(turnId, baseline, options));
    const tail = run.then(() => undefined, () => undefined);
    this.turnCollections.set(turnId, tail);
    try {
      return await run;
    } finally {
      if (this.turnCollections.get(turnId) === tail) this.turnCollections.delete(turnId);
    }
  }

  private async collectExternalChangesSerialized(
    turnId: string,
    baseline: TurnContentBaseline,
    options: { signal?: AbortSignal; requireUndoConfirmation?: boolean },
  ): Promise<ExternalChangeReport> {
    const report: ExternalChangeReport = { changes: [], unrecoverable: [] };
    const current = new Map<string, { sha256: string; size: number; mtimeMs: number }>();
    const currentDirectories = new Set<string>();
    const stack: string[] = [this.workspaceRoot];
    const visited = new Set<string>([this.safeRealPath(this.workspaceRoot)].filter((v): v is string => v !== undefined));
    // A9-67 F-029: paths whose post-Turn state could not be observed.
    const unscanned: string[] = [];
    const unstatable = new Set<string>();
    let sliceStart = Date.now();
    while (stack.length > 0) {
      if (options.signal?.aborted) throw new Error('外部变化收集已被取消');
      const dir = stack.pop()!;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_e) {
        // A9-67 F-029: an unreadable directory is UNKNOWN, never "everything deleted".
        if (dir === this.workspaceRoot) throw new Error('无法读取工作区根目录，拒绝把未知状态记为外部变化');
        unscanned.push(path.relative(this.workspaceRoot, dir).replace(/\\/g, '/'));
        continue;
      }
      for (const dirent of dirents) {
        if (Date.now() - sliceStart >= BASELINE_YIELD_SLICE_MS) {
          await yieldToEventLoop();
          if (options.signal?.aborted) throw new Error('外部变化收集已被取消');
          sliceStart = Date.now();
        }
        const fullPath = path.join(dir, dirent.name);
        const rel = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
        if (rel.startsWith('.agent_recovery')) continue;
        if (this.ignoreFilter.isIgnored(rel, dirent.isDirectory())) continue;
        if (this.containsSensitiveData(rel)) {
          throw new Error('A9_CHECKPOINT_SECRET_BLOCKED: changed workspace path contains known secret material');
        }
        if (dirent.isDirectory()) {
          currentDirectories.add(rel);
          const real = this.safeRealPath(fullPath);
          if (real && !visited.has(real)) {
            visited.add(real);
            stack.push(fullPath);
          } else if (!real) {
            unscanned.push(rel);
          }
        } else if (dirent.isFile()) {
          let stat: fs.Stats;
          try {
            stat = fs.statSync(fullPath);
          } catch (_e) {
            unstatable.add(rel);
            continue;
          }
          try {
            current.set(rel, { sha256: this.hashFile(fullPath), size: stat.size, mtimeMs: stat.mtimeMs });
          } catch (_e) {
            // 内容当前不可读时仍保留 stat 事实，避免把仍存在的文件误判为删除。
            current.set(rel, { sha256: `unreadable:${stat.size}:${stat.mtimeMs}`, size: stat.size, mtimeMs: stat.mtimeMs });
          }
        }
      }
    }

    // F2：skipped = 冻结时已存在但基线未覆盖的文件（携带事实，不含内容）。
    const skippedFacts = new Map(baseline.skipped.map((item) => [item.path, item]));
    const skippedAncestor = (rel: string) => {
      for (let parent = path.posix.dirname(rel); parent !== '.' && parent !== '/' && parent !== ''; parent = path.posix.dirname(parent)) {
        const fact = skippedFacts.get(parent);
        if (fact) return fact;
      }
      return undefined;
    };
    const unobserved = (rel: string) => unstatable.has(rel)
      || unscanned.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
    const createdHashes = new Map<string, string>();
    const isContentHash = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
    // A9-61: facts are derived in the original order, then made durable in bounded batches.
    const operations: ExternalFactOperation[] = [];
    const slice = new CooperativeSlice();

    // 新建与修改。
    for (const [rel, fact] of current) {
      await slice.step();
      const before = Object.prototype.hasOwnProperty.call(baseline.files, rel)
        ? baseline.files[rel]
        : undefined;
      // A9-67 F-029: a file below a directory the baseline could not scan is a
      // baseline gap, never a recoverable "created" file whose undo deletes it.
      const skippedFact = skippedFacts.get(rel) ?? (before ? undefined : skippedAncestor(rel));
      if (!before && skippedFact) {
        // skipped 不含内容，只能比较冻结时保存的 stat 事实。事实完整且未变化时
        // 不制造虚假 Diff；事实缺失或 size/mtime 变化时保守标记不可恢复修改。
        const metadataUnchanged = skippedFact.size !== undefined && skippedFact.mtimeMs !== undefined
          && skippedFact.size === fact.size && skippedFact.mtimeMs === fact.mtimeMs;
        if (metadataUnchanged) continue;
        operations.push({ kind: 'file', path: rel, action: 'modified', options: {
          newHash: isContentHash(fact.sha256) ? fact.sha256 : undefined,
          unrecoverable: true,
        } });
        operations.push({ kind: 'unrecoverable', change: { path: rel, kind: 'modified', reason: `轮前基线未覆盖（${skippedFact.reason}），无法恢复原内容` } });
        report.unrecoverable.push({ path: rel, kind: 'modified', reason: skippedFact.reason });
        report.changes.push({ path: rel, kind: 'modified', recoverable: false, newHash: fact.sha256 });
        continue;
      }
      if (!before) {
        if (isContentHash(fact.sha256)) {
          createdHashes.set(fact.sha256, rel);
          operations.push({ kind: 'file', path: rel, action: 'created', options: { newHash: fact.sha256 } });
          report.changes.push({ path: rel, kind: 'created', recoverable: true, restoredVia: 'delete-new', newHash: fact.sha256 });
        } else {
          operations.push({ kind: 'file', path: rel, action: 'created', options: { unrecoverable: true } });
          operations.push({ kind: 'unrecoverable', change: { path: rel, kind: 'created', reason: '轮后文件不可读，无法绑定删除目标身份' } });
          report.unrecoverable.push({ path: rel, kind: 'created', reason: 'backup_failed' });
          report.changes.push({ path: rel, kind: 'created', recoverable: false, newHash: fact.sha256 });
        }
        continue;
      }
      if (before.sha256 !== fact.sha256) {
        operations.push({ kind: 'file', path: rel, action: 'modified', options: {
          originalBlobPath: before.blobPath,
          originalHash: before.sha256,
          newHash: isContentHash(fact.sha256) ? fact.sha256 : undefined,
          ...(!isContentHash(fact.sha256) ? { unrecoverable: true } : {}),
        } });
        if (isContentHash(fact.sha256)) {
          report.changes.push({ path: rel, kind: 'modified', recoverable: true, restoredVia: 'restore-original', newHash: fact.sha256 });
        } else {
          operations.push({ kind: 'unrecoverable', change: { path: rel, kind: 'modified', reason: '轮后文件不可读，无法绑定撤销目标身份' } });
          report.unrecoverable.push({ path: rel, kind: 'modified', reason: 'backup_failed' });
          report.changes.push({ path: rel, kind: 'modified', recoverable: false, newHash: fact.sha256 });
        }
      }
    }

    // 删除与重命名（同哈希 delete+create 对 → renamed；skipped 侧明确不可恢复）。
    for (const [rel, before] of Object.entries(baseline.files)) {
      await slice.step();
      if (current.has(rel)) continue;
      if (unobserved(rel)) {
        // A9-67 F-029: unreadable now is UNKNOWN, not deleted; never authorise a restore over it.
        operations.push({ kind: 'file', path: rel, action: 'modified', options: { originalBlobPath: before.blobPath, originalHash: before.sha256, unrecoverable: true } });
        operations.push({ kind: 'unrecoverable', change: { path: rel, kind: 'modified', reason: '轮后无法读取该路径，当前状态未知，不自动恢复' } });
        report.unrecoverable.push({ path: rel, kind: 'modified', reason: 'collect_unreadable' });
        report.changes.push({ path: rel, kind: 'modified', recoverable: false });
        continue;
      }
      const renamedTo = createdHashes.get(before.sha256);
      if (renamedTo && renamedTo !== rel) {
        operations.push({ kind: 'file', path: rel, action: 'deleted', options: { originalBlobPath: before.blobPath, originalHash: before.sha256 } });
        report.changes.push({ path: rel, kind: 'renamed', recoverable: true, restoredVia: 'restore-original' });
        report.changes.push({ path: renamedTo, kind: 'renamed', recoverable: true, restoredVia: 'delete-new' });
        continue;
      }
      operations.push({ kind: 'file', path: rel, action: 'deleted', options: { originalBlobPath: before.blobPath, originalHash: before.sha256 } });
      report.changes.push({ path: rel, kind: 'deleted', recoverable: true, restoredVia: 'restore-original' });
    }

    // 基线跳过的既有文件被删除/改名离开：明确不可恢复，undo 保留现场并报告。
    // First current path per size, in scan order: the same match the former linear find returned.
    const firstCurrentPathBySize = new Map<number, string>();
    for (const [candidate, fact] of current) {
      if (!firstCurrentPathBySize.has(fact.size)) firstCurrentPathBySize.set(fact.size, candidate);
    }
    for (const [rel, skippedFact] of skippedFacts) {
      await slice.step();
      // A skipped scan root is a directory fact, not a missing file.
      if (current.has(rel) || currentDirectories.has(rel)) continue;
      const sizeMatchPath = skippedFact.size !== undefined ? firstCurrentPathBySize.get(skippedFact.size) : undefined;
      const sizeMatchRename = sizeMatchPath !== undefined ? [sizeMatchPath] as const : undefined;
      const kind = sizeMatchRename ? 'renamed' : 'deleted';
      operations.push({ kind: 'file', path: rel, action: 'deleted', options: { unrecoverable: true } });
      operations.push({ kind: 'unrecoverable', change: { path: rel, kind, reason: `轮前基线未覆盖（${skippedFact.reason}），${kind === 'renamed' ? '疑似重命名' : '删除'}后原内容无法恢复` } });
      report.unrecoverable.push({ path: rel, kind, reason: skippedFact.reason });
      report.changes.push({ path: rel, kind, recoverable: false });
      if (sizeMatchRename) {
        // 重命名的新路径同样标记不可恢复（不可伪装为可恢复的 delete-new）。
        const newSide = sizeMatchRename[0];
        operations.push({ kind: 'file', path: newSide, action: 'modified', options: { unrecoverable: true } });
        operations.push({ kind: 'unrecoverable', change: { path: newSide, kind: 'renamed', reason: '疑似自基线未覆盖文件重命名而来，两侧均不可恢复' } });
        report.unrecoverable.push({ path: newSide, kind: 'renamed', reason: 'rename-from-skipped' });
      }
    }

    const emptyTreeHash = this.checkpointManager.emptyDirectoryTreeHash();
    const baselineDirectories = baseline.directories ?? {};
    // 目录事实最后写入；undo 会先移除轮内新建的深层对象，再恢复目录骨架和文件。
    for (const [rel, before] of Object.entries(baselineDirectories)) {
      await slice.step();
      if (currentDirectories.has(rel)) continue;
      if (unobserved(rel)) {
        operations.push({ kind: 'unrecoverable', change: { path: rel, kind: 'modified', reason: '轮后无法读取上级目录，目录状态未知，不自动恢复' } });
        report.unrecoverable.push({ path: rel, kind: 'modified', reason: 'collect_unreadable' });
        continue;
      }
      if (current.has(rel)) {
        operations.push({ kind: 'directory', path: rel, action: 'replaced_by_file', options: {
          originalSnapshotPath: before.snapshotPath,
          originalTreeHash: before.treeHash,
        } });
        report.changes.push({ path: rel, kind: 'modified', recoverable: true, restoredVia: 'restore-original' });
      } else {
        operations.push({ kind: 'directory', path: rel, action: 'deleted', options: {
          originalSnapshotPath: before.snapshotPath,
          originalTreeHash: before.treeHash,
        } });
        report.changes.push({ path: rel, kind: 'deleted', recoverable: true, restoredVia: 'restore-original' });
      }
    }
    for (const rel of currentDirectories) {
      await slice.step();
      if (Object.prototype.hasOwnProperty.call(baselineDirectories, rel)) continue;
      const gap = skippedFacts.get(rel) ?? skippedAncestor(rel);
      if (gap) {
        // An unscanned ancestor cannot prove a directory was newly created.
        // Persist only the existing unrecoverable fact; never grant delete-new.
        operations.push({ kind: 'unrecoverable', change: { path: rel, kind: 'modified', reason: `Directory baseline was not observed (${gap.reason}); preserve current state` } });
        report.unrecoverable.push({ path: rel, kind: 'modified', reason: gap.reason });
        report.changes.push({ path: rel, kind: 'modified', recoverable: false });
        continue;
      }
      operations.push({ kind: 'directory', path: rel, action: 'created', options: { emptyTreeHash } });
      report.changes.push({ path: rel, kind: baseline.files[rel] ? 'modified' : 'created', recoverable: true, restoredVia: 'delete-new' });
    }

    // Facts and the collected mark become durable together in the final atomic write.
    await this.checkpointManager.recordExternalFactsBatched(turnId, operations, {
      collected: { requireUndoConfirmation: options.requireUndoConfirmation === true },
    });
    return report;
  }

  /**
   * J5：首次显式 Undo 只把崩溃后的当前工作区与已持久化轮前基线对账，
   * 生成可检查 Diff 并把 pending 转成 complete；调用方须再次显式 Undo
   * 才能实际改写文件。这样不会静默覆盖崩溃后的人工作业。
   */
  reconcilePendingExternalBaseline(turnId: string): Promise<{
    report?: ExternalChangeReport;
    confirmationId: string;
  } | undefined> {
    const inflight = this.turnReconciliations.get(turnId);
    if (inflight) return inflight;
    const run = (async () => {
      try {
        // A9-61: cold manifest validation yields; later synchronous reads hit the validated cache.
        await this.checkpointManager.loadCheckpointAsync(turnId);
        return await this.reconcilePendingExternalBaselineOnce(turnId);
      } finally {
        this.turnReconciliations.delete(turnId);
      }
    })();
    this.turnReconciliations.set(turnId, run);
    return run;
  }

  private async reconcilePendingExternalBaselineOnce(turnId: string): Promise<{
    report?: ExternalChangeReport;
    confirmationId: string;
  } | undefined> {
    const awaiting = this.checkpointManager.getExternalUndoConfirmation(turnId);
    if (awaiting) return { confirmationId: awaiting };
    const persisted = this.checkpointManager.getPendingExternalBaseline(turnId);
    if (!persisted) return undefined;
    const report = await this.collectExternalChanges(turnId, {
      turnId,
      frozenAt: persisted.frozenAt,
      files: persisted.files,
      directories: persisted.directories,
      skipped: persisted.skipped,
    }, { requireUndoConfirmation: true });
    const confirmationId = this.checkpointManager.getExternalUndoConfirmation(turnId);
    if (!confirmationId) throw new Error('A9_CHECKPOINT_CONFIRMATION_NOT_PERSISTED');
    return { report, confirmationId };
  }

  private safeRealPath(target: string): string | undefined {
    try {
      return fs.realpathSync(target);
    } catch (_err) {
      return undefined;
    }
  }

  /** 可覆盖的基线读取汇点，生产默认按字节读取；测试用它稳定注入读取失败。 */
  protected readBaselineFile(target: string): Buffer {
    return fs.readFileSync(target);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** 探测一轮之内 Shell/外部工具造成的工作区变化（A9-F03 轮前/轮后基线）。 */
  async scanExternalChanges(
    baseline: Map<string, { size: number; mtimeMs: number }>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Array<{ path: string; kind: 'created' | 'modified' | 'deleted' }>> {
    const current = new Map<string, { size: number; mtimeMs: number }>();
    const stack: string[] = [this.workspaceRoot];
    const visited = new Set<string>([fs.realpathSync(this.workspaceRoot)]);
    while (stack.length > 0) {
      if (options.signal?.aborted) throw new Error('扫描已被取消');
      const dir = stack.pop()!;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_e) {
        continue;
      }
      for (const dirent of dirents) {
        const fullPath = path.join(dir, dirent.name);
        const rel = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
        if (this.ignoreFilter.isIgnored(rel, dirent.isDirectory())) continue;
        if (rel.startsWith('.agent_recovery')) continue;
        if (dirent.isDirectory()) {
          let real: string;
          try {
            real = fs.realpathSync(fullPath);
          } catch (_e) {
            continue;
          }
          if (!visited.has(real)) {
            visited.add(real);
            stack.push(fullPath);
          }
        } else if (dirent.isFile()) {
          try {
            const st = fs.statSync(fullPath);
            current.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
          } catch (_e) { /* unreadable */ }
        }
      }
    }
    const changes: Array<{ path: string; kind: 'created' | 'modified' | 'deleted' }> = [];
    for (const [rel, fact] of current) {
      const before = baseline.get(rel);
      if (!before) changes.push({ path: rel, kind: 'created' });
      else if (before.size !== fact.size || before.mtimeMs !== fact.mtimeMs) changes.push({ path: rel, kind: 'modified' });
    }
    for (const rel of baseline.keys()) {
      if (!current.has(rel)) changes.push({ path: rel, kind: 'deleted' });
    }
    return changes;
  }

  /** 建立轮前 stat 基线（供 scanExternalChanges 比对）。 */
  async snapshotStatBaseline(options: { signal?: AbortSignal } = {}): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const map = new Map<string, { size: number; mtimeMs: number }>();
    const stack: string[] = [this.workspaceRoot];
    const visited = new Set<string>([fs.realpathSync(this.workspaceRoot)]);
    while (stack.length > 0) {
      if (options.signal?.aborted) throw new Error('扫描已被取消');
      const dir = stack.pop()!;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_e) {
        continue;
      }
      for (const dirent of dirents) {
        const fullPath = path.join(dir, dirent.name);
        const rel = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
        if (rel.startsWith('.agent_recovery')) continue;
        if (this.ignoreFilter.isIgnored(rel, dirent.isDirectory())) continue;
        if (dirent.isDirectory()) {
          let real: string;
          try {
            real = fs.realpathSync(fullPath);
          } catch (_e) {
            continue;
          }
          if (!visited.has(real)) {
            visited.add(real);
            stack.push(fullPath);
          }
        } else if (dirent.isFile()) {
          try {
            const st = fs.statSync(fullPath);
            map.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
          } catch (_e) { /* unreadable */ }
        }
      }
    }
    return map;
  }

  private ensureParentDir(absPath: string): void {
    const parent = path.dirname(absPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
  }
}
