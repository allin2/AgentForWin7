/**
 * @module a9-persistence
 * @description A9 SQLite 状态、迁移、Checkpoint、审批、后台进程事实、事件、
 * 中断恢复、保留策略与单写锁 (PRD §8 A9-ST02~ST04 / ADR-0089)
 *
 * 合同：
 * - 打开流程 fail-closed：未知 schema 拒绝覆盖；损坏库进入受限诊断模式；
 * - A8 白名单迁移（只读导入工作区与非敏感设置），迁移前备份；
 * - 重启只把活动任务标记为 interrupted，绝不自动重放模型/Shell/Git/审批；
 * - 日志默认保留 90 天并受空间上限约束；
 * - 同一工作区单写锁（跨窗口/多实例）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SqliteDatabase } from './sqlite-event-ledger';
import { reportCleanupFailure } from './cleanup-diagnostics';

export const A9_SCHEMA_VERSION = 4 as const;
export const A9_DEFAULT_RETENTION_DAYS = 90;
export const A9_MAX_ACTIVE_CONVERSATIONS = 16;

export type A9PermissionModeValue = 'full_access' | 'review' | 'read_only';
export type A9ConversationStateValue = 'active' | 'archived';
export type A9ConversationActivityValue = 'idle' | 'running' | 'waiting_approval' | 'waiting_input' | 'interrupted';
export type A9ConversationTitleSource = 'auto' | 'manual' | 'legacy';

export interface A9ConversationInbox {
  version: 1;
  settledAt: string | null;
  activeSince: string | null;
  lastVisitedAt: string | null;
}

/** 清理路径中的 close() 失败不能覆盖主错误，但必须留下结构化诊断。 */
function closeQuietly(database: SqliteDatabase | undefined, operation: string): void {
  try {
    database?.close();
  } catch (error) {
    reportCleanupFailure('A9_DB_CLOSE_FAILED', operation, error);
  }
}

export interface A9PersistenceDiagnostic {
  code: string;
  detail: string;
  count?: number;
  table?: string;
  rowId?: string;
}

const MAX_PERSISTENCE_DIAGNOSTICS = 32;

class PersistenceDiagnosticBuffer {
  private readonly entries: A9PersistenceDiagnostic[] = [];

  add(entry: A9PersistenceDiagnostic): void {
    const existing = this.entries.find((item) => item.code === entry.code);
    if (existing && entry.code === 'A9_PERSISTED_JSON_INVALID') {
      existing.count = Math.min(100_000, (existing.count ?? 0) + 1);
      return;
    }
    if (this.entries.length >= MAX_PERSISTENCE_DIAGNOSTICS) return;
    this.entries.push({ ...entry });
  }

  snapshot(): A9PersistenceDiagnostic[] { return this.entries.map((entry) => ({ ...entry })); }
}

interface SafeParseContext {
  buffer: PersistenceDiagnosticBuffer;
  table: string;
  rowId: string | number;
}

function a9PersistenceError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

export interface A9ManagedOwnershipRecord {
  schemaVersion: 1;
  owner: { workspace: string; conversationId: string; taskId: string; turnId: string; toolCallId: string };
  requestId: string;
  ownershipState: 'owned' | 'release_intent' | 'released' | 'release_unknown';
  releaseId?: string;
  recoveryStatus?: 'running_unknown' | 'identity_mismatch' | 'exited';
}

export interface A9ConversationRecord {
  sessionId: string;
  workspacePath: string;
  title: string;
  titleSource: A9ConversationTitleSource;
  state: A9ConversationStateValue;
  activity: A9ConversationActivityValue;
  createdAt: string;
  updatedAt: string;
  lastActivatedAt: string;
}

export interface A9OpenOptions {
  databasePath: string;
  /** A8 的真实物理库；只读打开，绝不 attach 或写回。 */
  a8DatabasePath?: string;
  /** 打开函数由宿主注入（生产为 Electron ABI 的 better-sqlite3，测试为真实 adapter）。 */
  openDatabase: (databasePath: string, options?: { readonly?: boolean }) => SqliteDatabase;
  dataRoot: string;
  retentionDays?: number;
}

export type A9OpenOutcome =
  | { status: 'ready'; manager: A9PersistenceManager; backupPath?: string; backupSha256?: string; importedA8Workspaces: number; diagnostics?: A9PersistenceDiagnostic[] }
  | { status: 'schema_refused'; reason: string; foundVersion?: number }
  | { status: 'diagnostics'; error: string; hint: string };

export type A9SchemaV4Profile = 'canonical' | 'win7_19_legacy';

interface A9EventRow {
  id?: number;
  session_id: string;
  turn_id: string | null;
  kind: 'model' | 'tool';
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface A9TaskContinueInput {
  conversationId: string;
  taskId: string;
  interruptedTurnId: string;
  recoveryRevision: string;
}
export interface A9TaskRecovery extends A9TaskContinueInput {
  originalGoal: string;
  confirmedSteps: string[];
  changedPaths: string[];
  verification: string;
  unknownResults: Array<{ toolName: string; callId: string; status: 'result_unknown'; paths: string[] }>;
  answeredQuestion?: {
    questionId: string;
    revision: number;
    prompt: string;
    answer: string;
  };
}

export interface A9PendingQuestionFact {
  schemaVersion: 1;
  questionId: string;
  revision: number;
  workspace: string;
  conversationId: string;
  taskId: string;
  turnId: string;
  callId: string;
  prompt: string;
  options: string[];
  recovered: boolean;
}

export interface A9QuestionReplyFact {
  conversationId: string;
  questionId: string;
  revision: number;
  decision: 'answered' | 'cancelled';
  answer?: string;
}

export interface A9QuestionResolution extends A9QuestionReplyFact {
  schemaVersion: 1;
  workspace: string;
  taskId: string;
  turnId: string;
  resolvedAt: string;
  duplicate: boolean;
}

export class A9PersistenceManager {
  private readonly diagnosticBuffer = new PersistenceDiagnosticBuffer();
  private snapshotRevisions?: Map<string, number> | null;

  private constructor(
    readonly db: SqliteDatabase,
    private readonly databasePath: string,
    private readonly retentionDays: number,
  ) {}

  getDiagnostics(): A9PersistenceDiagnostic[] { return this.diagnosticBuffer.snapshot(); }

  addDiagnostic(diagnostic: A9PersistenceDiagnostic): void { this.diagnosticBuffer.add(diagnostic); }

  /** Connection-local counters keep unrelated writes out of the snapshot cache keys. */
  readSnapshotRevisions(workspace: string, sessionId: string, managedWorkspace: string) {
    const db = this.db as SqliteDatabase & {
      inTransaction?: boolean;
      function?: (name: string, fn: (...args: string[]) => void) => void;
    };
    if (db.inTransaction !== false || typeof db.function !== 'function') return null;
    if (this.snapshotRevisions === undefined) {
      const revisions = new Map<string, number>();
      try {
        db.function('a9_snapshot_changed', (projection, key) => {
          const id = projection + key;
          revisions.set(id, (revisions.get(id) ?? 0) + 1);
        });
        const sources = [
          { table: 'a9_sessions', id: 'session_id', projection: 'directory:', key: (row: string) => row + '.workspace_path' },
          ...[{ table: 'a9_tasks', id: 'task_id' }, { table: 'a9_runs', id: 'run_id' },
            { table: 'a9_approvals', id: 'approval_id' }].map(source => ({
            ...source, projection: 'directory:',
            key: (row: string) => `(SELECT workspace_path FROM a9_sessions WHERE session_id = ${row}.session_id)`,
          })),
          { table: 'a9_events', id: 'id', projection: 'directory:',
            key: (row: string) => `CASE WHEN ${row}.event_type IN ('approval_required', 'question_pending', 'question_resolved')
              THEN (SELECT workspace_path FROM a9_sessions WHERE session_id = ${row}.session_id) END` },
          { table: 'a9_events', id: 'id', projection: 'managedEvents:',
            key: (row: string) => `CASE WHEN ${row}.event_type IN ('managed_process_ownership', 'managed_process_disposition')
              THEN COALESCE((SELECT a9_snapshot_workspace_key(CAST(workspace_path AS TEXT))
                FROM a9_managed_processes WHERE handle_id = CASE WHEN json_valid(${row}.payload_json)
                  THEN CASE WHEN json_type(${row}.payload_json, '$.handleId') = 'text'
                    THEN json_extract(${row}.payload_json, '$.handleId') END END), '') END` },
          // Ownership validity also depends on its session/task/turn origin. Only origin
          // columns referenced by an ownership event invalidate managed projections.
          // A disposition record's trust is its session's workspace binding (ADR-0344), so
          // session origin edits also invalidate when the session holds a disposition record.
          ...[{ table: 'a9_sessions', id: 'session_id', columns: ['session_id', 'workspace_path', 'state'], match: '',
            eventTypes: "'managed_process_ownership', 'managed_process_disposition'" },
            { table: 'a9_tasks', id: 'task_id', columns: ['task_id', 'session_id'],
              match: `AND CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$.owner.taskId') END = {row}.task_id` },
            { table: 'a9_turns', id: 'turn_id', columns: ['turn_id', 'task_id', 'session_id'], match: 'AND e.turn_id = {row}.turn_id' },
          ].map(source => ({
            table: source.table, id: source.id, columns: source.columns, projection: 'managedEvents:',
            key: (row: string) => `CASE WHEN EXISTS (SELECT 1 FROM a9_events e WHERE e.session_id = ${row}.session_id
              AND e.event_type IN (${source.eventTypes ?? "'managed_process_ownership'"}) ${source.match.replace('{row}', row)}) THEN '' END`,
          })),
          { table: 'a9_checkpoints', id: 'turn_id', projection: 'checkpoints:', key: (row: string) => row + '.session_id' },
          { table: 'a9_managed_processes', id: 'handle_id', projection: 'managed:',
            key: (row: string) => `a9_snapshot_workspace_key(CAST(${row}.workspace_path AS TEXT))` },
        ] as Array<{ table: string; id: string; projection: string; key: (row: string) => string; columns?: string[] }>;
        db.function('a9_snapshot_workspace_key', (workspace): string =>
          process.platform === 'win32' ? path.win32.resolve(workspace).toLowerCase() : workspace);
        db.transaction(() => {
          for (const [index, source] of sources.entries()) {
            // REPLACE can remove a row without firing DELETE triggers.
            for (const [operation, changedId] of [['INSERT', '1'], ['UPDATE', `OLD.${source.id} IS NOT NEW.${source.id}`]]) {
              db.exec(`CREATE TEMP TRIGGER a9_snapshot_${index}_REPLACE_${operation}
                BEFORE ${operation} ON main.${source.table} WHEN ${changedId} BEGIN
                  SELECT a9_snapshot_changed('${source.projection}', key)
                    FROM (SELECT ${source.key('previous')} AS key FROM main.${source.table} previous
                      WHERE previous.${source.id} = NEW.${source.id}) WHERE key IS NOT NULL;
                END`);
            }
            for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
              const keys = operation === 'UPDATE' ? [source.key('OLD'), source.key('NEW')]
                : [source.key(operation === 'INSERT' ? 'NEW' : 'OLD')];
              const columns = operation === 'UPDATE' && source.columns
                ? ` OF ${source.columns.join(', ')}` : '';
              const changed = operation === 'UPDATE' && source.columns
                ? ` WHEN ${source.columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}` : '';
              db.exec(`CREATE TEMP TRIGGER a9_snapshot_${index}_${operation}
                AFTER ${operation}${columns} ON main.${source.table}${changed} BEGIN
                  ${keys.map(key => `SELECT a9_snapshot_changed('${source.projection}', key)
                    FROM (SELECT ${key} AS key) WHERE key IS NOT NULL;`).join('\n')}
                END`);
            }
          }
        })();
        this.snapshotRevisions = revisions;
      } catch (_error) {
        this.snapshotRevisions = null;
        this.addDiagnostic({ code: 'A9_SNAPSHOT_REVISION_UNAVAILABLE', detail: 'Snapshot cache disabled: connection-local revision setup failed.' });
      }
    }
    if (!this.snapshotRevisions) return null;
    const revisions = this.snapshotRevisions;
    let dataVersion: number;
    try {
      dataVersion = readDataVersion(db);
    } catch (_error) {
      this.snapshotRevisions = null;
      this.addDiagnostic({ code: 'A9_SNAPSHOT_REVISION_UNAVAILABLE', detail: 'Snapshot cache disabled: SQLite data_version is unavailable.' });
      return null;
    }
    const managedKey = process.platform === 'win32' ? path.win32.resolve(managedWorkspace).toLowerCase() : managedWorkspace;
    return {
      checkpoints: `${dataVersion}:${revisions.get('checkpoints:' + sessionId) ?? 0}`,
      directory: `${dataVersion}:${revisions.get('directory:' + workspace) ?? 0}`,
      managed: `${dataVersion}:${revisions.get('managed:' + managedKey) ?? 0}:${revisions.get('managedEvents:' + managedKey) ?? 0}:${revisions.get('managedEvents:') ?? 0}`,
    };
  }

  /**
   * 打开/迁移 A9 数据库。任何失败都返回结构化结果，不覆盖旧库。
   */
  static open(options: A9OpenOptions): A9OpenOutcome {
    let externalA8Db: SqliteDatabase | undefined;
    if (options.a8DatabasePath
      && path.resolve(options.a8DatabasePath) !== path.resolve(options.databasePath)
      && !fs.existsSync(options.a8DatabasePath)) {
      return {
        status: 'diagnostics',
        error: 'Explicit A8 database does not exist',
        hint: '显式 A8 物理库路径不存在；为避免静默漏迁移，产品进入受限诊断模式。',
      };
    }
    if (options.a8DatabasePath
      && path.resolve(options.a8DatabasePath) !== path.resolve(options.databasePath)
      && fs.existsSync(options.a8DatabasePath)) {
      try {
        externalA8Db = options.openDatabase(options.a8DatabasePath, { readonly: true });
        if (!a8TablesPresentStrict(externalA8Db)) {
          externalA8Db.close();
          return {
            status: 'diagnostics',
            error: 'Explicit A8 database does not contain the required a8_workspaces table',
            hint: '显式 A8 物理库身份不匹配；为避免静默漏迁移，产品进入受限诊断模式。',
          };
        }
      } catch (err) {
        closeQuietly(externalA8Db, 'open.cleanup')
        return {
          status: 'diagnostics',
          error: err instanceof Error ? err.message : String(err),
          hint: 'A8 物理数据库无法只读探测；为避免静默漏迁移，产品进入受限诊断模式。',
        };
      }
    }
    // 现有数据库必须先用只读连接探测。尤其是未来 schema，不能在拒绝前切换
    // journal_mode、创建 WAL/SHM sidecar，或触发任何其他写入。
    if (fs.existsSync(options.databasePath)) {
      let probeDb: SqliteDatabase | undefined;
      try {
        probeDb = options.openDatabase(options.databasePath, { readonly: true });
        const probedVersion = readSchemaVersion(probeDb);
        if (probedVersion === A9_SCHEMA_VERSION) classifyA9SchemaV4(probeDb);
        if (probedVersion === undefined && a9BusinessTablesPresent(probeDb)) {
          closeQuietly(externalA8Db, 'open.cleanup')
          return {
            status: 'diagnostics',
            error: 'A9 schema metadata is missing while A9 business tables already exist',
            hint: '数据库缺少有效 a9_meta，拒绝把未知/损坏结构标记为当前版本；原始文件保持未修改。',
          };
        }
        if (probedVersion !== undefined && probedVersion > A9_SCHEMA_VERSION) {
          closeQuietly(externalA8Db, 'open.cleanup')
          return {
            status: 'schema_refused',
            reason: `数据库 schema 版本 ${probedVersion} 高于本应用支持的 ${A9_SCHEMA_VERSION}；拒绝覆盖，请使用更新版本的应用打开。`,
            foundVersion: probedVersion,
          };
        }
      } catch (err) {
        closeQuietly(externalA8Db, 'open.cleanup')
        return {
          status: 'diagnostics',
          error: err instanceof Error ? err.message : String(err),
          hint: 'schema 探测失败，数据库可能损坏；进入受限诊断模式。',
        };
      } finally {
        closeQuietly(probeDb, 'open.cleanup')
      }
    }

    let db: SqliteDatabase;
    try {
      db = options.openDatabase(options.databasePath);
    } catch (err) {
      closeQuietly(externalA8Db, 'open.cleanup')
      return {
        status: 'diagnostics',
        error: err instanceof Error ? err.message : String(err),
        hint: '数据库无法打开（可能已损坏或被占用）。产品进入受限诊断模式；原始文件保持未修改。',
      };
    }

    // 写连接打开后再次检查，避免只读探测与迁移之间数据库被替换。
    let existingVersion: number | undefined;
    let existingSchemaProfile: A9SchemaV4Profile | undefined;
    try {
      existingVersion = readSchemaVersion(db);
      if (existingVersion === A9_SCHEMA_VERSION) existingSchemaProfile = classifyA9SchemaV4(db);
      if (existingVersion === undefined && a9BusinessTablesPresent(db)) {
        throw new Error('A9 schema metadata is missing while A9 business tables already exist');
      }
    } catch (err) {
      closeQuietly(db, 'open.cleanup')
      closeQuietly(externalA8Db, 'open.cleanup')
      return {
        status: 'diagnostics',
        error: err instanceof Error ? err.message : String(err),
        hint: 'schema 探测失败，数据库可能损坏；进入受限诊断模式。',
      };
    }

    if (existingVersion !== undefined && existingVersion > A9_SCHEMA_VERSION) {
      closeQuietly(db, 'open.cleanup')
      closeQuietly(externalA8Db, 'open.cleanup')
      return {
        status: 'schema_refused',
        reason: `数据库 schema 版本 ${existingVersion} 高于本应用支持的 ${A9_SCHEMA_VERSION}；拒绝覆盖，请使用更新版本的应用打开。`,
        foundVersion: existingVersion,
      };
    }

    // 迁移前备份（只针对旧 A9 schema 或 A8 导入；当前 schema 重开无需重复备份）。
    let backupPath: string | undefined;
    let backupSha256: string | undefined;
    let backupDataVersion: number | undefined;
    let embeddedA8Data = false;
    try {
      embeddedA8Data = a8TablesPresent(db);
    } catch (err) {
      closeQuietly(db, 'open.cleanup')
      closeQuietly(externalA8Db, 'open.cleanup')
      return {
        status: 'diagnostics',
        error: err instanceof Error ? err.message : 'A9_SQLITE_PROBE_FAILED: A8 table probe failed',
        hint: 'A8 表探测失败（锁定、损坏或权限不足）；产品进入受限诊断模式。',
      };
    }
    const hasA8Data = embeddedA8Data || Boolean(externalA8Db);
    const requiresMigrationBackup = embeddedA8Data
      || (existingVersion !== undefined && existingVersion < A9_SCHEMA_VERSION)
      || existingSchemaProfile === 'win7_19_legacy';
    if (requiresMigrationBackup && fs.existsSync(options.databasePath)) {
      try {
        const dataVersionBefore = readDataVersion(db);
        const backup = backupDatabase(db, options.dataRoot, options.openDatabase);
        backupPath = backup.path;
        backupSha256 = backup.sha256;
        backupDataVersion = readDataVersion(db);
        if (backupDataVersion !== dataVersionBefore) {
          throw new Error('A9_SCHEMA_CONCURRENT_MODIFICATION: 数据库在迁移备份期间被其他连接修改。');
        }
      } catch (err) {
        closeQuietly(db, 'open.cleanup')
        closeQuietly(externalA8Db, 'open.cleanup')
        return {
          status: 'diagnostics',
          error: err instanceof Error ? err.message : String(err),
          hint: '迁移前备份无法创建；原数据库未执行 schema 迁移。产品进入受限诊断模式。',
        };
      }
    }

    const manager = new A9PersistenceManager(db, options.databasePath, options.retentionDays ?? A9_DEFAULT_RETENTION_DAYS);
    let importedA8Workspaces = 0;
    try {
      const initializeSchema = db.transaction(() => {
        if (existingSchemaProfile === 'win7_19_legacy') {
          if (backupDataVersion === undefined || readDataVersion(db) !== backupDataVersion) {
            throw new Error('A9_SCHEMA_CONCURRENT_MODIFICATION: 数据库在迁移备份后被其他连接修改。');
          }
          if (classifyA9SchemaV4(db) !== 'win7_19_legacy') {
            throw new Error('A9_SCHEMA_CONCURRENT_MODIFICATION: WIN7-19 schema v4 指纹在迁移前发生变化。');
          }
        }
        manager.migrateSchema(existingVersion, existingSchemaProfile);
        manager.createSchema();
        assertA9CurrentSchema(db);
        if (hasA8Data) importedA8Workspaces = manager.importA8Whitelist(externalA8Db ?? db);
      });
      initializeSchema();
    } catch (err) {
      closeQuietly(db, 'open.cleanup')
      closeQuietly(externalA8Db, 'open.cleanup')
      return {
        status: 'diagnostics',
        error: err instanceof Error ? err.message : String(err),
        hint: 'A9 schema 迁移失败；已回滚且迁移前备份保持可用。产品进入受限诊断模式，禁止继续执行任务。',
      };
    }

    // 只有 schema 创建/迁移和 A8 白名单导入整体成功后才切换 WAL；失败路径
    // 不应仅因 journal mode 预写而改变原库身份。
    const openDiagnostics: A9PersistenceDiagnostic[] = [];
    try {
      const actual = String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase();
      if (actual !== 'wal') {
        openDiagnostics.push({
          code: 'A9_SQLITE_WAL_UNAVAILABLE',
          detail: `WAL request failed; actual journal mode=${actual || 'unknown'}`,
        });
      }
    } catch (_err) {
      let actual = 'unknown';
      try { actual = String(db.pragma('journal_mode', { simple: true })).toLowerCase() || 'unknown'; } catch (_probeError) { /* keep unknown */ }
      openDiagnostics.push({
        code: 'A9_SQLITE_WAL_UNAVAILABLE',
        detail: `WAL request failed; actual journal mode=${actual}`,
      });
    }
    for (const diagnostic of openDiagnostics) manager.addDiagnostic(diagnostic);

    closeQuietly(externalA8Db, 'open.cleanup')

    manager.markInterruptionsOnRestart();
    return {
      status: 'ready',
      manager,
      ...(backupPath ? { backupPath, backupSha256 } : {}),
      importedA8Workspaces,
      ...(openDiagnostics.length > 0 ? { diagnostics: manager.getDiagnostics() } : {}),
    };
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS a9_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS a9_workspaces (
        workspace_path TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('full_access','review','read_only')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS a9_sessions (
        session_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '新对话',
        title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto','manual','legacy')),
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activated_at TEXT NOT NULL,
        draft_ciphertext TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_a9_sessions_workspace ON a9_sessions (workspace_path, state, last_activated_at);

      CREATE TABLE IF NOT EXISTS a9_workspace_conversation_state (
        workspace_path TEXT PRIMARY KEY,
        active_session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS a9_tasks (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','completed','failed','cancelled','interrupted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS a9_turns (
        turn_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','completed','completed_with_warnings','blocked','failed','cancelled','interrupted')),
        outcome_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS a9_runs (
        run_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','completed','failed','cancelled','interrupted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS a9_checkpoints (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_a9_checkpoints_session ON a9_checkpoints (session_id, created_at);

      CREATE TABLE IF NOT EXISTS a9_approvals (
        approval_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        tool_name TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('pending','approved','denied','interrupted')),
        decided_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS a9_managed_processes (
        handle_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        pid INTEGER,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_probe_status TEXT,
        pid_reuse_possible INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS a9_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('model','tool')),
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_a9_events_session ON a9_events (session_id, id);

      CREATE TABLE IF NOT EXISTS a9_workspace_locks (
        workspace_path TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );

      -- 查询性能索引（H-P1-03）：纯加法、非唯一、BINARY 升序；不属于 v4 必需索引合同，
      -- 旧库在重开时由 IF NOT EXISTS 补建，表签名与 schema 版本不变。
      CREATE INDEX IF NOT EXISTS idx_a9_tasks_session_status ON a9_tasks (session_id, status);
      CREATE INDEX IF NOT EXISTS idx_a9_runs_session_status ON a9_runs (session_id, status);
      CREATE INDEX IF NOT EXISTS idx_a9_approvals_session_decision ON a9_approvals (session_id, decision);
      CREATE INDEX IF NOT EXISTS idx_a9_turns_session_task ON a9_turns (session_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_a9_events_created ON a9_events (created_at);
      CREATE INDEX IF NOT EXISTS idx_a9_events_session_type ON a9_events (session_id, event_type);
    `);
    this.ensureEventTypeIndex();

    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT schema_version FROM a9_meta WHERE id = 1').get() as any;
    if (!existing) {
      this.db.prepare('INSERT INTO a9_meta (id, schema_version, created_at, updated_at) VALUES (1, ?, ?, ?)')
        .run(A9_SCHEMA_VERSION, now, now);
    } else if (existing.schema_version < A9_SCHEMA_VERSION) {
      this.db.prepare('UPDATE a9_meta SET schema_version = ?, updated_at = ? WHERE id = 1')
        .run(A9_SCHEMA_VERSION, now);
    }
  }

  private ensureEventTypeIndex(): void {
    const schemaObject = this.db.prepare('SELECT type, tbl_name FROM sqlite_master WHERE name = ? COLLATE NOCASE');
    for (let suffix = 0; ; suffix += 1) {
      const name = 'idx_a9_events_type_id' + (suffix ? '_' + suffix : '');
      const existing = schemaObject.get(name) as { type: string; tbl_name: string } | undefined;
      if (!existing) {
        this.db.exec(`CREATE INDEX ${name} ON a9_events (event_type, id)`);
        return;
      }
      if (existing.type !== 'index' || existing.tbl_name !== 'a9_events') continue;
      const index = (this.db.prepare('PRAGMA index_list(a9_events)').all() as any[])
        .find(row => String(row.name).toLowerCase() === name);
      const keys = (this.db.prepare(`PRAGMA index_xinfo(${name})`).all() as any[])
        .filter(row => row.key === 1);
      if (index?.unique === 0 && index.partial === 0 && keys.length === 2
        && keys[0].name === 'event_type' && keys[1].name === 'id'
        && keys.every(key => key.coll === 'BINARY' && key.desc === 0)) return;
    }
  }

  /** A9 v3 增加 failed Turn；v4 引入对话目录、活动对话和草稿密文。 */
  private migrateSchema(existingVersion: number | undefined, existingProfile?: A9SchemaV4Profile): void {
    if (existingVersion === A9_SCHEMA_VERSION && existingProfile === 'win7_19_legacy') {
      this.repairWin719SchemaV4();
      return;
    }
    if (existingVersion === undefined || existingVersion >= A9_SCHEMA_VERSION) return;
    let version = existingVersion;
    if (version < 3 && tablePresent(this.db, 'a9_turns')) {
      const turnIndexSql = (this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'a9_turns' AND sql IS NOT NULL",
      ).all() as any[])
        .map((row) => row.sql)
        .filter((sql): sql is string => typeof sql === 'string' && sql.length > 0);
      this.db.exec(`
          ALTER TABLE a9_turns RENAME TO a9_turns_pre_v3;
          CREATE TABLE a9_turns (
            turn_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active','completed','completed_with_warnings','blocked','failed','cancelled','interrupted')),
            outcome_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at)
          SELECT turn_id, task_id, session_id, status, outcome_json, created_at, updated_at
          FROM a9_turns_pre_v3;
          DROP TABLE a9_turns_pre_v3;
      `);
      for (const indexSql of turnIndexSql) this.db.exec(indexSql);
      this.db.prepare('UPDATE a9_meta SET schema_version = 3, updated_at = ? WHERE id = 1')
        .run(new Date().toISOString());
      version = 3;
    }
    if (version >= 4) return;

    const now = new Date().toISOString();
    if (tablePresent(this.db, 'a9_sessions')) {
      const sessionColumnRows = this.db.prepare('PRAGMA table_info(a9_sessions)').all() as any[];
      const sessionColumnNames = sessionColumnRows.map((row) => row.name);
      const expectedLegacyColumns = ['session_id', 'workspace_path', 'created_at', 'updated_at', 'metadata_json'];
      if (sessionColumnNames.length !== expectedLegacyColumns.length
        || sessionColumnNames.some((name, index) => name !== expectedLegacyColumns[index])) {
        throw new Error('A9 legacy schema has unexpected a9_sessions columns');
      }
      const sessionColumns = new Set(sessionColumnNames);
      const sessionIndexSql = (this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'a9_sessions' AND sql IS NOT NULL",
      ).all() as any[])
        .map((row) => row.sql)
        .filter((sql): sql is string => typeof sql === 'string' && sql.length > 0);
      const metadataExpression = sessionColumns.has('metadata_json') ? "COALESCE(metadata_json, '{}')" : "'{}'";
      this.db.exec(`
          ALTER TABLE a9_sessions RENAME TO a9_sessions_pre_v4;
          CREATE TABLE a9_sessions (
            session_id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '新对话',
            title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto','manual','legacy')),
            state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_activated_at TEXT NOT NULL,
            draft_ciphertext TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}'
          );
          INSERT INTO a9_sessions
            (session_id, workspace_path, title, title_source, state, created_at, updated_at, last_activated_at, draft_ciphertext, metadata_json)
          SELECT session_id, workspace_path, '历史对话', 'legacy', 'active', created_at, updated_at,
            COALESCE(updated_at, created_at, '${now}'), NULL, ${metadataExpression}
          FROM a9_sessions_pre_v4;
          DROP TABLE a9_sessions_pre_v4;
      `);
      for (const indexSql of sessionIndexSql) this.db.exec(indexSql);
    } else {
      this.db.exec(`
          CREATE TABLE a9_sessions (
            session_id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '新对话',
            title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto','manual','legacy')),
            state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_activated_at TEXT NOT NULL,
            draft_ciphertext TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}'
          );
      `);
    }
    this.db.exec(`
        DROP INDEX IF EXISTS idx_a9_sessions_workspace;
        CREATE INDEX idx_a9_sessions_workspace ON a9_sessions (workspace_path, state, last_activated_at);
        CREATE TABLE IF NOT EXISTS a9_workspace_conversation_state (
          workspace_path TEXT PRIMARY KEY,
          active_session_id TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
    `);
    if (tablePresent(this.db, 'a9_approvals')) {
      this.db.exec(`
          ALTER TABLE a9_approvals RENAME TO a9_approvals_pre_v4;
          CREATE TABLE a9_approvals (
            approval_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            turn_id TEXT,
            tool_name TEXT NOT NULL,
            binding_json TEXT NOT NULL,
            decision TEXT NOT NULL CHECK (decision IN ('pending','approved','denied','interrupted')),
            decided_at TEXT,
            created_at TEXT NOT NULL
          );
          INSERT INTO a9_approvals
          SELECT approval_id, session_id, turn_id, tool_name, binding_json, decision, decided_at, created_at
          FROM a9_approvals_pre_v4;
          DROP TABLE a9_approvals_pre_v4;
      `);
    }
    this.db.prepare('UPDATE a9_meta SET schema_version = 4, updated_at = ? WHERE id = 1').run(now);
  }

  private repairWin719SchemaV4(): void {
    const now = new Date().toISOString();
    this.db.exec(`
      DROP INDEX idx_a9_sessions_workspace;
      ALTER TABLE a9_sessions RENAME TO a9_sessions_win7_19_v4;
      CREATE TABLE a9_sessions (
        session_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '新对话',
        title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto','manual','legacy')),
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activated_at TEXT NOT NULL,
        draft_ciphertext TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
    this.db.prepare(`
      INSERT INTO a9_sessions
        (session_id, workspace_path, title, title_source, state, created_at, updated_at,
         last_activated_at, draft_ciphertext, metadata_json)
      SELECT session_id, workspace_path, title, title_source, state, created_at, updated_at,
        COALESCE(last_activated_at, updated_at, created_at, ?), draft_ciphertext, metadata_json
      FROM a9_sessions_win7_19_v4
    `).run(now);
    this.db.exec(`
      DROP TABLE a9_sessions_win7_19_v4;
      CREATE INDEX idx_a9_sessions_workspace
        ON a9_sessions (workspace_path, state, last_activated_at);
    `);
  }

  /**
   * A8 白名单迁移：只读导入工作区列表与非敏感设置；凭据、活动任务、Review
   * 提案一律不迁移（A9-ST03）。
   */
  private importA8Whitelist(db: SqliteDatabase): number {
    assertA8WorkspaceSchema(db);
    const workspaces = db.prepare('SELECT schema_version, canonical_path, comparison_key FROM a8_workspaces').all() as any[];
    let imported = 0;
    const importAll = this.db.transaction(() => {
      const now = new Date().toISOString();
      const seenComparisonKeys = new Set<string>();
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO a9_workspaces (workspace_path, display_name, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const row of workspaces) {
        const canonicalPath = row.canonical_path;
        if (Number(row.schema_version) !== 1
          || typeof canonicalPath !== 'string' || canonicalPath.length === 0
          || (!path.isAbsolute(canonicalPath) && !path.win32.isAbsolute(canonicalPath))
          || row.comparison_key !== canonicalPath.toLocaleLowerCase('en-US').replace(/\\/g, '/')) {
          throw new Error('A8 workspace row invariants are invalid');
        }
        const windowsIdentity = row.comparison_key.toLocaleLowerCase('en-US').replace(/\\/g, '/');
        if (seenComparisonKeys.has(windowsIdentity)) {
          throw new Error('A8 workspace rows contain a duplicate Windows comparison identity');
        }
        seenComparisonKeys.add(windowsIdentity);
        // A8 工作区未选择过 A9 模式：不设默认 Full Access，交由首次选择流程。
        insert.run(canonicalPath, displayNameFor(canonicalPath), 'review', now, now);
        imported += 1;
      }
    });
    importAll();
    return imported;
  }

  // ---------------------------------------------------------------------
  // 工作区与模式（fail-closed：无默认 Full Access）
  // ---------------------------------------------------------------------

  getWorkspaceMode(workspacePath: string): A9PermissionModeValue | undefined {
    const row = this.db.prepare('SELECT permission_mode FROM a9_workspaces WHERE workspace_path = ?').get(workspacePath) as any;
    if (!row) return undefined;
    const mode = row.permission_mode;
    if (mode === 'full_access' || mode === 'review' || mode === 'read_only') return mode;
    return undefined;
  }

  setWorkspaceMode(workspacePath: string, mode: A9PermissionModeValue): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT workspace_path FROM a9_workspaces WHERE workspace_path = ?').get(workspacePath);
    if (existing) {
      this.db.prepare('UPDATE a9_workspaces SET permission_mode = ?, updated_at = ? WHERE workspace_path = ?').run(mode, now, workspacePath);
    } else {
      this.db.prepare(
        'INSERT INTO a9_workspaces (workspace_path, display_name, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(workspacePath, displayNameFor(workspacePath), mode, now, now);
    }
  }

  // ---------------------------------------------------------------------
  // 会话 / 任务 / Turn / Run
  // ---------------------------------------------------------------------

  saveSession(sessionId: string, workspacePath: string, metadata: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT session_id FROM a9_sessions WHERE session_id = ?').get(sessionId);
    if (existing) {
      this.db.prepare('UPDATE a9_sessions SET workspace_path = ?, updated_at = ?, metadata_json = ? WHERE session_id = ?')
        .run(workspacePath, now, JSON.stringify({ ...this.getConversationMetadata(sessionId), ...metadata }), sessionId);
    } else {
      this.db.prepare(`
        INSERT INTO a9_sessions
          (session_id, workspace_path, title, title_source, state, created_at, updated_at, last_activated_at, draft_ciphertext, metadata_json)
        VALUES (?, ?, '新对话', 'auto', 'active', ?, ?, ?, NULL, ?)
      `).run(sessionId, workspacePath, now, now, now, JSON.stringify(metadata));
    }
  }

  /**
   * 首次开启 v4 时确定性保留旧的“工作区派生 Session”；无旧事实时创建新对话。
   */
  ensureActiveConversation(workspacePath: string, legacySessionId: string, newSessionId: string): A9ConversationRecord {
    const active = this.db.prepare(`
      SELECT s.session_id FROM a9_workspace_conversation_state w
      JOIN a9_sessions s ON s.session_id = w.active_session_id
      WHERE w.workspace_path = ? AND s.workspace_path = ? AND s.state = 'active'
    `).get(workspacePath, workspacePath) as any;
    if (active?.session_id) return this.activateConversation(workspacePath, active.session_id);

    if (this.sessionHasFacts(legacySessionId)) {
      this.saveSession(legacySessionId, workspacePath, { migratedFromWorkspaceSession: true });
      this.db.prepare(`
        UPDATE a9_sessions
        SET title = '历史对话', title_source = 'legacy', updated_at = ?
        WHERE session_id = ?
      `).run(new Date().toISOString(), legacySessionId);
      return this.activateConversation(workspacePath, legacySessionId);
    }
    const mostRecent = this.db.prepare(`
      SELECT session_id FROM a9_sessions
      WHERE workspace_path = ? AND state = 'active'
      ORDER BY last_activated_at DESC, created_at DESC LIMIT 1
    `).get(workspacePath) as any;
    if (mostRecent?.session_id) return this.activateConversation(workspacePath, mostRecent.session_id);
    return this.createConversation(newSessionId, workspacePath);
  }

  createConversation(sessionId: string, workspacePath: string): A9ConversationRecord {
    const activeCount = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM a9_sessions WHERE workspace_path = ? AND state = 'active'
    `).get(workspacePath) as any)?.n ?? 0;
    if (Number(activeCount) >= A9_MAX_ACTIVE_CONVERSATIONS) {
      throw a9PersistenceError('A9_CONVERSATION_LIMIT', `每个工作区最多 ${A9_MAX_ACTIVE_CONVERSATIONS} 个未归档对话。`);
    }
    const now = new Date().toISOString();
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO a9_sessions
          (session_id, workspace_path, title, title_source, state, created_at, updated_at, last_activated_at, draft_ciphertext, metadata_json)
        VALUES (?, ?, '新对话', 'auto', 'active', ?, ?, ?, NULL, '{}')
      `).run(sessionId, workspacePath, now, now, now);
      this.setActiveConversation(workspacePath, sessionId, now);
    });
    create();
    return this.requireConversation(sessionId);
  }

  activateConversation(workspacePath: string, sessionId: string): A9ConversationRecord {
    const row = this.requireConversation(sessionId);
    if (row.workspacePath !== workspacePath || row.state !== 'active') {
      throw a9PersistenceError('A9_CONVERSATION_NOT_ACTIVE', '对话不属于当前工作区或已归档。');
    }
    const now = new Date().toISOString();
    const activate = this.db.transaction(() => {
      this.db.prepare('UPDATE a9_sessions SET last_activated_at = ?, updated_at = ? WHERE session_id = ?')
        .run(now, now, sessionId);
      this.setActiveConversation(workspacePath, sessionId, now);
    });
    activate();
    return this.requireConversation(sessionId);
  }

  renameConversation(sessionId: string, title: string, workspacePath: string): A9ConversationRecord {
    if (typeof title !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(title)) {
      throw a9PersistenceError('A9_CONVERSATION_TITLE_INVALID', '对话名称不能为空或包含控制字符。');
    }
    const normalized = normalizeConversationTitle(title, 80);
    if (!normalized) throw a9PersistenceError('A9_CONVERSATION_TITLE_INVALID', '对话名称不能为空或包含控制字符。');
    const conversation = this.requireConversation(sessionId);
    if (!sameWorkspacePath(conversation.workspacePath, workspacePath)) {
      throw a9PersistenceError('A9_CONVERSATION_WORKSPACE_MISMATCH', '对话不属于当前工作区。');
    }
    this.db.prepare(`
      UPDATE a9_sessions SET title = ?, title_source = 'manual', updated_at = ? WHERE session_id = ?
    `).run(normalized, new Date().toISOString(), sessionId);
    return this.requireConversation(sessionId);
  }

  maybeSetAutomaticTitle(sessionId: string, title: string): A9ConversationRecord {
    const normalized = normalizeConversationTitle(title, 40) || '新对话';
    this.requireConversation(sessionId);
    this.db.prepare(`
      UPDATE a9_sessions SET title = ?, updated_at = ?
      WHERE session_id = ? AND title_source = 'auto' AND title = '新对话'
    `).run(normalized, new Date().toISOString(), sessionId);
    return this.requireConversation(sessionId);
  }

  archiveConversation(sessionId: string, fallbackSessionId?: string): A9ConversationRecord | null {
    const row = this.requireConversation(sessionId);
    if (this.getActiveConversationId(row.workspacePath) !== sessionId) {
      throw a9PersistenceError('A9_CONVERSATION_NOT_CURRENT', '只能归档当前对话。');
    }
    const archive = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare("UPDATE a9_sessions SET state = 'archived', updated_at = ? WHERE session_id = ?")
        .run(now, sessionId);
      const next = this.db.prepare(`
        SELECT session_id FROM a9_sessions
        WHERE workspace_path = ? AND state = 'active' AND session_id <> ?
        ORDER BY last_activated_at DESC, created_at DESC LIMIT 1
      `).get(row.workspacePath, sessionId) as any;
      if (next?.session_id) {
        this.setActiveConversation(row.workspacePath, next.session_id, now);
        return this.requireConversation(next.session_id);
      }
      if (fallbackSessionId) {
        this.db.prepare(`
          INSERT INTO a9_sessions
            (session_id, workspace_path, title, title_source, state, created_at, updated_at, last_activated_at, draft_ciphertext, metadata_json)
          VALUES (?, ?, '新对话', 'auto', 'active', ?, ?, ?, NULL, '{}')
        `).run(fallbackSessionId, row.workspacePath, now, now, now);
        this.setActiveConversation(row.workspacePath, fallbackSessionId, now);
        return this.requireConversation(fallbackSessionId);
      }
      this.db.prepare('DELETE FROM a9_workspace_conversation_state WHERE workspace_path = ?').run(row.workspacePath);
      return null;
    });
    return archive();
  }

  restoreConversation(sessionId: string, workspacePath: string): A9ConversationRecord {
    const row = this.requireConversation(sessionId);
    if (!sameWorkspacePath(row.workspacePath, workspacePath)) {
      throw a9PersistenceError('A9_CONVERSATION_WORKSPACE_MISMATCH', '对话不属于当前工作区。');
    }
    const activeCount = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM a9_sessions WHERE workspace_path = ? AND state = 'active'
    `).get(row.workspacePath) as any)?.n ?? 0;
    if (row.state === 'archived' && Number(activeCount) >= A9_MAX_ACTIVE_CONVERSATIONS) {
      throw a9PersistenceError('A9_CONVERSATION_LIMIT', `每个工作区最多 ${A9_MAX_ACTIVE_CONVERSATIONS} 个未归档对话。`);
    }
    const now = new Date().toISOString();
    const restore = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE a9_sessions SET state = 'active', last_activated_at = ?, updated_at = ? WHERE session_id = ?
      `).run(now, now, sessionId);
      this.setActiveConversation(row.workspacePath, sessionId, now);
    });
    restore();
    return this.requireConversation(sessionId);
  }

  /** Bounded directory; does not open runtimes or restore execution. */
  listWorkspacePaths(): string[] {
    return (this.db.prepare('SELECT workspace_path, MAX(updated_at) AS recent FROM a9_sessions GROUP BY workspace_path ORDER BY recent DESC LIMIT 64').all() as any[])
      .map(row => row.workspace_path);
  }

  /** All reservations, including archived sessions and mode-only workspaces. */
  listReservedWorkspacePaths(): string[] {
    return (this.db.prepare('SELECT workspace_path FROM a9_workspaces UNION SELECT workspace_path FROM a9_sessions').all() as any[])
      .map(row => row.workspace_path);
  }

  getWorkspaceWorkdir(workspacePath: string): Record<string, unknown> | null {
    for (const item of this.listConversations(workspacePath)) {
      const workdir = this.getConversationMetadata(item.sessionId).workdir as any;
      if (workdir?.version === 1 && workdir.origin === 'auto') return workdir;
    }
    return null;
  }

  assertWorkdirChangeAllowed(sessionId: string, source: string, target?: string): void {
    const record = this.requireConversation(sessionId);
    if (!sameWorkspacePath(record.workspacePath, source)) {
      throw a9PersistenceError('A9_CONVERSATION_WORKSPACE_MISMATCH', '对话不属于当前工作区。');
    }
    if (this.listConversations(source).some(item => ['running', 'waiting_approval', 'waiting_input'].includes(item.activity))
      || this.listManagedProcesses(source).some(item => item.cleanupRequired || ['starting', 'running', 'running_unknown', 'identity_mismatch'].includes(item.lastProbeStatus || ''))) {
      throw a9PersistenceError('A9_CONVERSATION_BUSY', '请先结束任务及托管进程。');
    }
    if (target && !sameWorkspacePath(source, target)
      && this.listConversations(target).filter(item => item.state === 'active').length >= A9_MAX_ACTIVE_CONVERSATIONS) {
      throw a9PersistenceError('A9_CONVERSATION_LIMIT', '目标工作区未归档对话已达上限。');
    }
  }

  /** Caller has closed both affected runtimes. Never rewrite historical facts. */
  changeWorkdir(sessionId: string, source: string, target: string, rename: boolean): void {
    this.db.transaction(() => {
      this.assertWorkdirChangeAllowed(sessionId, source, target);
      if (this.db.prepare('SELECT 1 FROM a9_workspace_locks WHERE workspace_path IN (?, ?) LIMIT 1').get(source, target)) {
        throw a9PersistenceError('A9_WORKSPACE_LOCKED', '路径更新要求先关闭 Runtime。');
      }
      const now = new Date().toISOString();
      // Round 20 (P1): every binding change closes the conversation's current segment at the
      // newest event id. AUTOINCREMENT ids are never reused, so every event written from now
      // on lies above this bound and belongs to the new binding.
      // Round 21 (P1): retention may delete the newest events, lowering MAX(id); the bound is the
      // AUTOINCREMENT high-water mark (`sqlite_sequence`, never lowered by DELETE), and never
      // below the conversation's previous segment, so segments stay monotonic.
      const seqRow = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'a9_events'").get() as { seq?: number } | undefined;
      const maxRow = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM a9_events').get() as { m?: number } | undefined;
      const currentEventSeq = Math.max(Number(seqRow?.seq ?? 0), Number(maxRow?.m ?? 0));
      const segmentBound = (history: A9WorkspaceHistoryEntry[]) => Math.max(currentEventSeq,
        history.length ? Number(history[history.length - 1].maxEventId) : 0);
      const historyOf = (workdir: unknown): A9WorkspaceHistoryEntry[] => {
        const segments = parseWorkspaceHistory((workdir as { workspaceHistory?: unknown } | undefined)?.workspaceHistory);
        if (segments === 'damaged') {
          throw a9PersistenceError('A9_WORKDIR_HISTORY_CORRUPT', '对话的工作区历史已损坏，无法安全更新路径。');
        }
        return segments ?? [];
      };
      // Round 23 (P1): a conversation with no segments yet that was rebound before (a legacy
      // build's `origin: 'linked'`, a Round 19 scalar `previousWorkspace`) or whose metadata is
      // damaged may have written its events so far in an earlier workspace; the boundary is
      // unknown. They are closed in one unknown segment (fail-closed for every workspace) instead
      // of being attributed to `source`. No timestamp heuristic: a wrong bound would misattribute.
      const withUnknownPrior = (id: string, workdir: unknown, history: A9WorkspaceHistoryEntry[]): A9WorkspaceHistoryEntry[] => {
        if (history.length) return history;
        const value = (workdir ?? {}) as { origin?: unknown; previousWorkspace?: unknown };
        const metadataDamaged = (this.db.prepare('SELECT json_valid(metadata_json) AS valid FROM a9_sessions WHERE session_id = ?')
          .get(id) as { valid?: number | null } | undefined)?.valid === 0;
        return metadataDamaged || value.origin === 'linked' || typeof value.previousWorkspace === 'string'
          ? [{ workspace: A9_UNKNOWN_PRIOR_WORKSPACE, maxEventId: segmentBound(history) }] : history;
      };
      if (rename) {
        if (this.listReservedWorkspacePaths().some(value => value.toLowerCase() === target.toLowerCase())) {
          throw a9PersistenceError('A9_WORKDIR_NAME_CONFLICT', '目录名已被预留。');
        }
        // Round 20 (P1): the default directory keeps its facts under the source path (ADR-0343),
        // so every conversation renamed with it records that its events up to now were written
        // in `source`; segments of any conversation that name `source` note the later name.
        const sessions = this.db.prepare(`SELECT session_id, workspace_path, metadata_json FROM a9_sessions
          WHERE workspace_path = ? OR (json_valid(metadata_json)
            AND json_type(metadata_json, '$.workdir.workspaceHistory') = 'array')`).all(source) as Array<{
          session_id: string; workspace_path: string; metadata_json: string }>;
        const histories = new Map<string, { workdir: Record<string, unknown>; history: A9WorkspaceHistoryEntry[] }>();
        for (const session of sessions) {
          const moved = session.workspace_path === source;
          const workdir = (this.getConversationMetadata(session.session_id).workdir ?? {}) as Record<string, unknown>;
          // A damaged history of a conversation outside `source` stays as it is (readers treat it
          // as ambiguous, fail-closed); a moved conversation's damaged history refuses the rename.
          if (!moved && parseWorkspaceHistory(workdir.workspaceHistory) === 'damaged') continue;
          const history = (moved ? withUnknownPrior(session.session_id, workdir, historyOf(workdir)) : historyOf(workdir)).map(entry => sameWorkspacePath(entry.renamedTo ?? entry.workspace, source)
            ? { ...entry, renamedTo: target } : entry);
          if (moved) history.push({ workspace: source, renamedTo: target, maxEventId: segmentBound(history) });
          histories.set(session.session_id, { workdir, history });
        }
        this.db.prepare('UPDATE a9_workspaces SET workspace_path = ?, display_name = ?, updated_at = ? WHERE workspace_path = ?')
          .run(target, displayNameFor(target), now, source);
        this.db.prepare('UPDATE a9_sessions SET workspace_path = ?, updated_at = ? WHERE workspace_path = ?').run(target, now, source);
        this.db.prepare('UPDATE a9_workspace_conversation_state SET workspace_path = ?, updated_at = ? WHERE workspace_path = ?').run(target, now, source);
        const updateMetadata = this.db.prepare('UPDATE a9_sessions SET metadata_json = ? WHERE session_id = ?');
        for (const [id, { workdir, history }] of histories) {
          if (!history.length) continue;
          updateMetadata.run(JSON.stringify({ ...this.getConversationMetadata(id), workdir: { ...workdir, workspaceHistory: history } }), id);
        }
      } else {
        // Round 19 (P1): the source workspace is kept so this conversation's older ownership
        // records (and their damage) stay evidence of that workspace after the rebind.
        // Round 20 (P1): the scalar is only kept for compatibility. The ordered segments keep
        // every earlier workspace across repeated rebinds (A -> B -> C), each bounded by event id.
        const workdir = this.getConversationMetadata(sessionId).workdir;
        const previous = withUnknownPrior(sessionId, workdir, historyOf(workdir));
        const workspaceHistory = [...previous, { workspace: source, maxEventId: segmentBound(previous) }];
        this.saveSession(sessionId, target, { workdir: { version: 1, origin: 'linked', previousWorkspace: source, workspaceHistory, createdAt: null } });
        const remaining = this.listConversations(source).find(item => item.state === 'active');
        if (remaining) this.setActiveConversation(source, remaining.sessionId, now);
        else this.db.prepare('DELETE FROM a9_workspace_conversation_state WHERE workspace_path = ?').run(source);
        this.setActiveConversation(target, sessionId, now);
        // saveSession merges all unrelated metadata; no history is migrated.
      }
    })();
  }

  listConversations(workspacePath: string, options: { includeDraftPresence?: boolean } = {}):
    Array<A9ConversationRecord & { hasPersistedDraft?: boolean }> {
    return (this.db.prepare(`
      SELECT s.session_id, s.workspace_path, s.title, s.title_source, s.state,
        s.created_at, s.updated_at, s.last_activated_at,
        ${options.includeDraftPresence ? "typeof(s.draft_ciphertext) = 'text' AND length(CAST(s.draft_ciphertext AS BLOB)) > 0 AS has_draft," : ''}
        CASE
          WHEN EXISTS (SELECT 1 FROM a9_approvals a WHERE a.session_id = s.session_id AND a.decision = 'pending') THEN 'waiting_approval'
          WHEN EXISTS (SELECT 1 FROM a9_events e WHERE e.session_id = s.session_id AND e.event_type = 'question_pending'
            AND NOT EXISTS (SELECT 1 FROM a9_events r WHERE r.session_id = e.session_id
              AND r.event_type = 'question_resolved'
              AND json_extract(r.payload_json, '$.questionId') = json_extract(e.payload_json, '$.questionId')
              AND json_extract(r.payload_json, '$.revision') = json_extract(e.payload_json, '$.revision'))) THEN 'waiting_input'
          WHEN EXISTS (SELECT 1 FROM a9_tasks t WHERE t.session_id = s.session_id AND t.status = 'active') THEN 'running'
          WHEN EXISTS (SELECT 1 FROM a9_tasks t WHERE t.session_id = s.session_id AND t.status = 'interrupted') THEN 'interrupted'
          ELSE 'idle'
        END AS activity
      FROM a9_sessions s WHERE s.workspace_path = ?
      ORDER BY CASE WHEN s.state = 'active' THEN 0 ELSE 1 END,
        s.last_activated_at DESC, s.updated_at DESC
    `).all(workspacePath) as any[]).map(row => ({
      ...conversationFromRow(row),
      ...(options.includeDraftPresence ? { hasPersistedDraft: row.has_draft === 1 } : {}),
    }));
  }

  getActiveConversationId(workspacePath: string): string | null {
    const row = this.db.prepare(`
      SELECT s.session_id FROM a9_workspace_conversation_state w
      JOIN a9_sessions s ON s.session_id = w.active_session_id
      WHERE w.workspace_path = ? AND s.workspace_path = ? AND s.state = 'active'
    `).get(workspacePath, workspacePath) as any;
    return typeof row?.session_id === 'string' ? row.session_id : null;
  }

  setConversationDraftCiphertext(sessionId: string, ciphertext: string | null): void {
    this.requireConversation(sessionId);
    this.db.prepare('UPDATE a9_sessions SET draft_ciphertext = ?, updated_at = ? WHERE session_id = ?')
      .run(ciphertext, new Date().toISOString(), sessionId);
  }

  getConversationDraftCiphertext(sessionId: string): string | null {
    const row = this.db.prepare('SELECT draft_ciphertext FROM a9_sessions WHERE session_id = ?').get(sessionId) as any;
    if (!row) throw a9PersistenceError('A9_CONVERSATION_NOT_FOUND', '未找到对话。');
    return typeof row.draft_ciphertext === 'string' ? row.draft_ciphertext : null;
  }

  getConversationMetadata(sessionId: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT metadata_json FROM a9_sessions WHERE session_id = ?').get(sessionId) as any;
    if (!row) throw a9PersistenceError('A9_CONVERSATION_NOT_FOUND', '未找到对话。');
    return safeParse(typeof row.metadata_json === 'string' ? row.metadata_json : '{}', { buffer: this.diagnosticBuffer, table: 'a9_sessions', rowId: sessionId });
  }

  mergeConversationMetadata(sessionId: string, patch: Record<string, unknown>): void {
    const metadata = { ...this.getConversationMetadata(sessionId), ...patch };
    this.db.prepare('UPDATE a9_sessions SET metadata_json = ?, updated_at = ? WHERE session_id = ?')
      .run(JSON.stringify(metadata), new Date().toISOString(), sessionId);
  }

  getConversationInbox(sessionId: string): A9ConversationInbox {
    return parseConversationInbox(this.getConversationMetadata(sessionId).inbox);
  }

  /** Inbox timestamps never change the conversation's sorting timestamp. */
  mergeConversationInbox(sessionId: string, workspacePath: string,
    patch: Partial<Omit<A9ConversationInbox, 'version'>>): A9ConversationInbox {
    const conversation = this.requireConversation(sessionId);
    if (!sameWorkspacePath(conversation.workspacePath, workspacePath)) {
      throw a9PersistenceError('A9_CONVERSATION_WORKSPACE_MISMATCH', '对话不属于当前工作区。');
    }
    if (conversation.state === 'archived') {
      throw a9PersistenceError('A9_CONVERSATION_ARCHIVED', '已归档对话不能修改收件箱状态。');
    }
    const metadata = this.getConversationMetadata(sessionId);
    const previous = metadata.inbox;
    const inbox = { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
      ...parseConversationInbox(previous), ...patch, version: 1 };
    this.db.prepare('UPDATE a9_sessions SET metadata_json = ? WHERE session_id = ?')
      .run(JSON.stringify({ ...metadata, inbox }), sessionId);
    return parseConversationInbox(inbox);
  }

  private buildConversationInboxSummary(
    row: {
      created_at: string;
      completed_at?: string | null;
      started_at?: string | null;
      ended_at?: string | null;
      approval_at?: string | null;
      pending_at?: string | null;
    },
    inbox: A9ConversationInbox,
  ): {
    settledAt: string | null; lastVisitedAt: string | null; lastCompletedAt: string | null; lastActivityAt: string;
  } {
    const activity = [row.started_at, row.ended_at, row.approval_at, row.pending_at,
      inbox.activeSince, inbox.lastVisitedAt].filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
    activity.sort((left, right) => Date.parse(right) - Date.parse(left));
    return {
      settledAt: inbox.settledAt,
      lastVisitedAt: inbox.lastVisitedAt,
      lastCompletedAt: row.completed_at || null,
      lastActivityAt: activity[0] || row.created_at,
    };
  }

  getConversationInboxSummary(sessionId: string): {
    settledAt: string | null; lastVisitedAt: string | null; lastCompletedAt: string | null; lastActivityAt: string;
  } {
    const inbox = this.getConversationInbox(sessionId);
    // runs 的三个聚合合并为对 idx_a9_runs_session_status 的单次范围读取；语义与逐项子查询一致。
    const row = this.db.prepare(`
      SELECT s.created_at, r.completed_at, r.started_at, r.ended_at,
        (SELECT MAX(created_at) FROM a9_approvals WHERE session_id = s.session_id AND decision = 'pending') AS approval_at,
        (SELECT MAX(created_at) FROM a9_events WHERE session_id = s.session_id
          AND event_type IN ('approval_required', 'question_pending')) AS pending_at
      FROM a9_sessions s
      LEFT JOIN (
        SELECT session_id,
          MAX(CASE WHEN status = 'completed' THEN updated_at END) AS completed_at,
          MAX(created_at) AS started_at,
          MAX(CASE WHEN status <> 'active' THEN updated_at END) AS ended_at
        FROM a9_runs WHERE session_id = ? GROUP BY session_id
      ) r ON r.session_id = s.session_id
      WHERE s.session_id = ?
    `).get(sessionId, sessionId) as any;
    return this.buildConversationInboxSummary(row, inbox);
  }

  /**
   * 批量读取工作区下全部会话的收件箱摘要，消除快照路径上的 1 + 2N 查询。
   * 返回值与畸形 metadata_json 诊断行为与逐条 getConversationInboxSummary 等价。
   */
  listConversationInboxSummaries(workspacePath: string): Map<string, {
    settledAt: string | null; lastVisitedAt: string | null; lastCompletedAt: string | null; lastActivityAt: string;
  }> {
    const rows = this.db.prepare(`
      WITH ws AS (
        SELECT session_id, created_at, metadata_json, state, last_activated_at, updated_at
        FROM a9_sessions WHERE workspace_path = ?
      )
      SELECT ws.session_id, ws.created_at, ws.metadata_json,
        r.completed_at, r.started_at, r.ended_at,
        a.approval_at, e.pending_at
      FROM ws
      LEFT JOIN (
        SELECT session_id,
          MAX(CASE WHEN status = 'completed' THEN updated_at END) AS completed_at,
          MAX(created_at) AS started_at,
          MAX(CASE WHEN status <> 'active' THEN updated_at END) AS ended_at
        FROM a9_runs WHERE session_id IN (SELECT session_id FROM ws) GROUP BY session_id
      ) r ON r.session_id = ws.session_id
      LEFT JOIN (
        SELECT session_id, MAX(created_at) AS approval_at
        FROM a9_approvals WHERE decision = 'pending' AND session_id IN (SELECT session_id FROM ws) GROUP BY session_id
      ) a ON a.session_id = ws.session_id
      LEFT JOIN (
        SELECT session_id, MAX(created_at) AS pending_at
        FROM a9_events WHERE event_type IN ('approval_required', 'question_pending')
          AND session_id IN (SELECT session_id FROM ws) GROUP BY session_id
      ) e ON e.session_id = ws.session_id
      ORDER BY CASE WHEN ws.state = 'active' THEN 0 ELSE 1 END,
        ws.last_activated_at DESC, ws.updated_at DESC
    `).all(workspacePath) as any[];
    const summaries = new Map<string, {
      settledAt: string | null; lastVisitedAt: string | null; lastCompletedAt: string | null; lastActivityAt: string;
    }>();
    for (const row of rows) {
      const metadata = safeParse(typeof row.metadata_json === 'string' ? row.metadata_json : '{}', {
        buffer: this.diagnosticBuffer,
        table: 'a9_sessions',
        rowId: row.session_id,
      });
      const inbox = parseConversationInbox(metadata.inbox);
      summaries.set(row.session_id, this.buildConversationInboxSummary(row, inbox));
    }
    return summaries;
  }

  private requireConversation(sessionId: string): A9ConversationRecord {
    const row = this.db.prepare(`
      SELECT s.*,
        CASE
          WHEN EXISTS (SELECT 1 FROM a9_approvals a WHERE a.session_id = s.session_id AND a.decision = 'pending') THEN 'waiting_approval'
          WHEN EXISTS (SELECT 1 FROM a9_events e WHERE e.session_id = s.session_id AND e.event_type = 'question_pending'
            AND NOT EXISTS (SELECT 1 FROM a9_events r WHERE r.session_id = e.session_id
              AND r.event_type = 'question_resolved'
              AND json_extract(r.payload_json, '$.questionId') = json_extract(e.payload_json, '$.questionId')
              AND json_extract(r.payload_json, '$.revision') = json_extract(e.payload_json, '$.revision'))) THEN 'waiting_input'
          WHEN EXISTS (SELECT 1 FROM a9_tasks t WHERE t.session_id = s.session_id AND t.status = 'active') THEN 'running'
          WHEN EXISTS (SELECT 1 FROM a9_tasks t WHERE t.session_id = s.session_id AND t.status = 'interrupted') THEN 'interrupted'
          ELSE 'idle'
        END AS activity
      FROM a9_sessions s WHERE s.session_id = ?
    `).get(sessionId) as any;
    if (!row) throw a9PersistenceError('A9_CONVERSATION_NOT_FOUND', '未找到对话。');
    return conversationFromRow(row);
  }

  private setActiveConversation(workspacePath: string, sessionId: string, now: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO a9_workspace_conversation_state (workspace_path, active_session_id, updated_at)
      VALUES (?, ?, ?)
    `).run(workspacePath, sessionId, now);
  }

  private sessionHasFacts(sessionId: string): boolean {
    for (const table of ['a9_tasks', 'a9_turns', 'a9_runs', 'a9_checkpoints', 'a9_approvals', 'a9_events']) {
      const row = this.db.prepare(`SELECT 1 AS present FROM ${table} WHERE session_id = ? LIMIT 1`).get(sessionId);
      if (row) return true;
    }
    return false;
  }

  upsertTask(taskId: string, sessionId: string, status: 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted'): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT task_id FROM a9_tasks WHERE task_id = ?').get(taskId);
    if (existing) {
      this.db.prepare('UPDATE a9_tasks SET status = ?, updated_at = ? WHERE task_id = ?').run(status, now, taskId);
    } else {
      this.db.prepare('INSERT INTO a9_tasks (task_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, sessionId, status, now, now);
    }
  }

  upsertTurn(
    turnId: string,
    taskId: string,
    sessionId: string,
    status: 'active' | 'completed' | 'completed_with_warnings' | 'blocked' | 'failed' | 'cancelled' | 'interrupted',
    outcome: Record<string, unknown> = {},
  ): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT turn_id FROM a9_turns WHERE turn_id = ?').get(turnId);
    if (existing) {
      this.db.prepare('UPDATE a9_turns SET status = ?, outcome_json = ?, updated_at = ? WHERE turn_id = ?')
        .run(status, JSON.stringify(outcome), now, turnId);
    } else {
      this.db.prepare('INSERT INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(turnId, taskId, sessionId, status, JSON.stringify(outcome), now, now);
    }
  }

  upsertRun(runId: string, turnId: string, sessionId: string, status: 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted'): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT run_id FROM a9_runs WHERE run_id = ?').get(runId);
    if (existing) {
      this.db.prepare('UPDATE a9_runs SET status = ?, updated_at = ? WHERE run_id = ?').run(status, now, runId);
    } else {
      this.db.prepare('INSERT INTO a9_runs (run_id, turn_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(runId, turnId, sessionId, status, now, now);
    }
  }

  /**
   * 重启恢复：把所有 active 任务/Turn/Run 标记为 interrupted，返回事实清单。
   * 只记录事实，不自动重放任何模型、Shell、Git 或审批动作。
   */
  markInterruptionsOnRestart(): Array<{ kind: 'task' | 'turn' | 'run'; id: string }> {
    const now = new Date().toISOString();
    const interrupted: Array<{ kind: 'task' | 'turn' | 'run'; id: string }> = [];
    const tasks = this.db.prepare("SELECT task_id FROM a9_tasks WHERE status = 'active'").all() as any[];
    for (const row of tasks) {
      this.db.prepare('UPDATE a9_tasks SET status = ?, updated_at = ? WHERE task_id = ?').run('interrupted', now, row.task_id);
      interrupted.push({ kind: 'task', id: row.task_id });
    }
    const turns = this.db.prepare("SELECT turn_id FROM a9_turns WHERE status = 'active'").all() as any[];
    for (const row of turns) {
      this.db.prepare('UPDATE a9_turns SET status = ?, updated_at = ? WHERE turn_id = ?').run('interrupted', now, row.turn_id);
      interrupted.push({ kind: 'turn', id: row.turn_id });
    }
    const runs = this.db.prepare("SELECT run_id FROM a9_runs WHERE status = 'active'").all() as any[];
    for (const row of runs) {
      this.db.prepare('UPDATE a9_runs SET status = ?, updated_at = ? WHERE run_id = ?').run('interrupted', now, row.run_id);
      interrupted.push({ kind: 'run', id: row.run_id });
    }
    // 重启前的审批不得重放。保留历史行，但终态标记为 interrupted。
    this.db.prepare(`
      UPDATE a9_approvals SET decision = 'interrupted', decided_at = ? WHERE decision = 'pending'
    `).run(now);
    return interrupted;
  }

  /** A9-32: derive recovery from durable lifecycle/tool facts, never assistant prose. */
  getTaskRecovery(workspacePath: string, sessionId: string, taskId: string): A9TaskRecovery | null {
    const conversation = this.requireConversation(sessionId);
    const active = this.db.prepare('SELECT active_session_id FROM a9_workspace_conversation_state WHERE workspace_path = ?').get(workspacePath) as any;
    if (conversation.workspacePath !== workspacePath || conversation.state !== 'active' || active?.active_session_id !== sessionId) {
      throw a9PersistenceError('A9_CONTINUE_IDENTITY_MISMATCH', '继续仅允许当前工作区的活动对话。');
    }
    const task = this.db.prepare('SELECT * FROM a9_tasks WHERE task_id = ? AND session_id = ?').get(taskId, sessionId) as any;
    if (!task) throw a9PersistenceError('A9_CONTINUE_IDENTITY_MISMATCH', '任务不属于当前对话。');
    const turn = this.db.prepare('SELECT * FROM a9_turns WHERE task_id = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId, sessionId) as any;
    if (!turn || turn.status !== 'interrupted' || task.status !== 'interrupted') return null;
    const rows = this.db.prepare("SELECT e.id, e.turn_id, e.event_type, e.payload_json FROM a9_events e JOIN a9_turns t ON t.turn_id = e.turn_id WHERE e.session_id = ? AND t.task_id = ? AND e.event_type IN ('tool_start','tool_end','external.changes') ORDER BY e.id LIMIT 1001").all(sessionId, taskId) as any[];
    if (rows.length > 1000) throw a9PersistenceError('A9_RECOVERY_FACTS_LIMIT', '恢复事实超出有界窗口，禁止省略未知结果后继续。');
    const started = new Map<string, any>();
    const confirmedSteps: string[] = [];
    const changes: string[] = [];
    const sideEffects = new Set(['write','edit','copy','move','delete','shell','start_process','stop_process']);
    for (const row of rows) {
      const payload = safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: row.id }) as any;
      const data = payload.data || payload;
      if (row.event_type === 'tool_start' && typeof data.callId === 'string') started.set(`${row.turn_id}:${data.callId}`, data);
      if (row.event_type === 'tool_end' && typeof data.callId === 'string') {
        const key = `${row.turn_id}:${data.callId}`;
        // A side effect that ended with unconfirmed process-tree cleanup may still change files: keep it unknown.
        if (!(data.residueRisk === true && sideEffects.has(started.get(key)?.toolName))) started.delete(key);
        // Record only audited completion identity/status. Raw output/commands are not authorization.
        confirmedSteps.push(`${String(data.toolName || 'tool').slice(0, 40)}: ${data.error || data.residueRisk || /"error"\s*:/.test(String(data.result || '')) ? 'result_unknown' : 'recorded'}`);
      }
      if (row.event_type === 'external.changes' && Array.isArray(data.changes)) {
        for (const change of data.changes) if (typeof change.path === 'string') changes.push(change.path.slice(0, 512));
      }
    }
    const unknownResults = [...started.values()].filter((data) => sideEffects.has(data.toolName)).map((data) => ({
      toolName: String(data.toolName), callId: String(data.callId), status: 'result_unknown' as const,
      paths: ['path','source','destination'].map((key) => data.args?.[key]).filter((value) => typeof value === 'string').map((value: string) => value.slice(0, 512)),
    }));
    const request = this.db.prepare("SELECT id, payload_json FROM a9_events WHERE session_id = ? AND event_type = 'conversation.request' AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.interruptedTurnId') IS NULL AND json_extract(payload_json, '$.taskId') = ? ORDER BY id LIMIT 1").get(sessionId, taskId) as any;
    const checkpoint = this.db.prepare('SELECT payload_json FROM a9_checkpoints WHERE session_id = ? AND turn_id = ?').get(sessionId, turn.turn_id) as any;
    const checkpointPayload = checkpoint ? safeParse(checkpoint.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_checkpoints', rowId: turn.turn_id }) as any : {};
    if (Array.isArray(checkpointPayload.externalChanges)) {
      for (const change of checkpointPayload.externalChanges) if (typeof change.path === 'string') changes.push(change.path.slice(0, 512));
    }
    const requestPayload = request ? safeParse(request.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: request.id }) as any : {};
    const originalGoal = typeof requestPayload.requestPrompt === 'string' ? requestPayload.requestPrompt.slice(0, 2000) : '';
    if (!originalGoal) throw a9PersistenceError('A9_RECOVERY_GOAL_UNAVAILABLE', '原用户目标不可核验，请输入新的任务要求。');
    const answeredQuestionRow = this.db.prepare(`SELECT id, payload_json FROM a9_events e WHERE e.session_id = ?
      AND e.event_type = 'question_pending'
      AND EXISTS (SELECT 1 FROM a9_events r WHERE r.session_id = e.session_id
        AND r.event_type = 'question_resolved'
        AND json_extract(r.payload_json, '$.questionId') = json_extract(e.payload_json, '$.questionId')
        AND json_extract(r.payload_json, '$.revision') = json_extract(e.payload_json, '$.revision')
        AND json_extract(r.payload_json, '$.decision') = 'answered')
      ORDER BY e.id DESC LIMIT 1`).get(sessionId) as any;
    const answeredQuestionPayload = answeredQuestionRow ? safeParse(answeredQuestionRow.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: answeredQuestionRow.id }) as any : null;
    const answerRow = answeredQuestionPayload ? this.db.prepare(`SELECT id, payload_json FROM a9_events WHERE session_id = ?
      AND event_type = 'question_resolved'
      AND json_extract(payload_json, '$.questionId') = ?
      AND json_extract(payload_json, '$.revision') = ?
      AND json_extract(payload_json, '$.decision') = 'answered'
      ORDER BY id DESC LIMIT 1`).get(sessionId, answeredQuestionPayload.questionId, answeredQuestionPayload.revision) as any : null;
    const answerPayload = answerRow ? safeParse(answerRow.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: answerRow.id }) as any : null;
    const recoveryRevision = crypto.createHash('sha256').update(JSON.stringify({ workspacePath, sessionId, task, turn, rows, checkpoint }), 'utf8').digest('hex');
    return { conversationId: sessionId, taskId, interruptedTurnId: turn.turn_id, recoveryRevision, originalGoal,
      confirmedSteps: confirmedSteps.slice(-12), changedPaths: [...new Set(changes)].slice(-12),
      verification: checkpointPayload.verification === 'verified' ? 'historical_verified' : 'not_verified', unknownResults,
      ...(answeredQuestionPayload && typeof answerPayload?.answer === 'string'
        ? { answeredQuestion: {
          questionId: answeredQuestionPayload.questionId,
          revision: answeredQuestionPayload.revision,
          prompt: answeredQuestionPayload.prompt,
          answer: answerPayload.answer,
        } }
        : {}) };
  }

  listTaskRecoveries(workspacePath: string, sessionId: string): A9TaskRecovery[] {
    const rows = this.db.prepare("SELECT task_id FROM a9_tasks WHERE session_id = ? AND status = 'interrupted' ORDER BY updated_at DESC LIMIT 20").all(sessionId) as any[];
    return rows.map((row) => this.getTaskRecovery(workspacePath, sessionId, row.task_id)).filter((fact): fact is A9TaskRecovery => fact !== null);
  }

  findTaskContinuation(workspacePath: string, input: A9TaskContinueInput): { turnId: string; taskId: string; duplicate: boolean } | null {
    const owner = this.db.prepare('SELECT s.workspace_path, t.session_id FROM a9_tasks t JOIN a9_sessions s ON s.session_id = t.session_id WHERE t.task_id = ?').get(input.taskId) as any;
    const conversation = this.requireConversation(input.conversationId);
    const active = this.db.prepare('SELECT active_session_id FROM a9_workspace_conversation_state WHERE workspace_path = ?').get(workspacePath) as any;
    if (!owner || owner.workspace_path !== workspacePath || owner.session_id !== input.conversationId || conversation.state !== 'active' || active?.active_session_id !== input.conversationId) {
      throw a9PersistenceError('A9_CONTINUE_IDENTITY_MISMATCH', '继续身份不匹配。');
    }
    const row = this.db.prepare(`SELECT turn_id FROM a9_events WHERE session_id = ? AND event_type = 'task_continue_requested'
      AND json_extract(payload_json, '$.schemaVersion') = 1 AND json_extract(payload_json, '$.taskId') = ?
      AND json_extract(payload_json, '$.interruptedTurnId') = ? AND json_extract(payload_json, '$.recoveryRevision') = ? LIMIT 1`)
      .get(input.conversationId, input.taskId, input.interruptedTurnId, input.recoveryRevision) as any;
    // Event retention must not erase a committed key while its Turn still exists.
    const durable = row || this.db.prepare(`SELECT turn_id FROM a9_turns WHERE session_id = ? AND task_id = ?
      AND ((json_extract(outcome_json, '$.interruptedTurnId') = ? AND json_extract(outcome_json, '$.recoveryRevision') = ?)
        OR (json_extract(outcome_json, '$.continuation.interruptedTurnId') = ? AND json_extract(outcome_json, '$.continuation.recoveryRevision') = ?))
      ORDER BY created_at LIMIT 1`).get(input.conversationId, input.taskId, input.interruptedTurnId, input.recoveryRevision, input.interruptedTurnId, input.recoveryRevision) as any;
    return durable ? { turnId: durable.turn_id, taskId: input.taskId, duplicate: true } : null;
  }

  /** The workspace writer owns this transaction; intent, new Turn and request commit together. */
  requestTaskContinuation(workspacePath: string, input: A9TaskContinueInput, turnId: string, requestPrompt: string): { turnId: string; taskId: string; duplicate: boolean } {
    return this.db.transaction(() => {
      const duplicate = this.findTaskContinuation(workspacePath, input);
      if (duplicate) return duplicate;
      const fact = this.getTaskRecovery(workspacePath, input.conversationId, input.taskId);
      if (!fact || fact.interruptedTurnId !== input.interruptedTurnId || fact.recoveryRevision !== input.recoveryRevision) {
        throw a9PersistenceError('A9_CONTINUE_REVISION_MISMATCH', '恢复事实已变化，请刷新中断卡。');
      }
      const busy = this.db.prepare(`SELECT 1 FROM a9_tasks WHERE session_id = ? AND status = 'active'
        UNION ALL SELECT 1 FROM a9_approvals WHERE session_id = ? AND decision = 'pending' LIMIT 1`).get(input.conversationId, input.conversationId);
      if (busy) throw a9PersistenceError('A9_TURN_ALREADY_ACTIVE', '当前对话仍有活动任务或待审批。');
      this.upsertTurn(turnId, input.taskId, input.conversationId, 'active', { schemaVersion: 1, interruptedTurnId: input.interruptedTurnId, recoveryRevision: input.recoveryRevision });
      this.upsertRun(`run-${turnId}`, turnId, input.conversationId, 'active');
      this.upsertTask(input.taskId, input.conversationId, 'active');
      this.recordModelEvent(input.conversationId, turnId, 'task_continue_requested', { schemaVersion: 1, ...input, continuationTurnId: turnId });
      return { turnId, taskId: input.taskId, duplicate: false };
    })();
  }

  listInterruptions(sessionId?: string): Array<{ kind: 'task' | 'turn' | 'run'; id: string; sessionId: string }> {
    const result: Array<{ kind: 'task' | 'turn' | 'run'; id: string; sessionId: string }> = [];
    const suffix = sessionId ? ' AND session_id = ?' : '';
    const args = sessionId ? [sessionId] : [];
    for (const row of this.db.prepare(`SELECT task_id, session_id FROM a9_tasks WHERE status = 'interrupted'${suffix}`).all(...args) as any[]) {
      result.push({ kind: 'task', id: row.task_id, sessionId: row.session_id });
    }
    for (const row of this.db.prepare(`SELECT turn_id, session_id FROM a9_turns WHERE status = 'interrupted'${suffix}`).all(...args) as any[]) {
      result.push({ kind: 'turn', id: row.turn_id, sessionId: row.session_id });
    }
    for (const row of this.db.prepare(`SELECT run_id, session_id FROM a9_runs WHERE status = 'interrupted'${suffix}`).all(...args) as any[]) {
      result.push({ kind: 'run', id: row.run_id, sessionId: row.session_id });
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Checkpoint / 审批 / 后台进程事实
  // ---------------------------------------------------------------------

  saveCheckpoint(checkpoint: { turnId: string; sessionId: string; payload: Record<string, unknown> }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO a9_checkpoints (turn_id, session_id, created_at, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(checkpoint.turnId, checkpoint.sessionId, now, JSON.stringify(checkpoint.payload));
  }

  getCheckpoint(turnId: string): { turnId: string; sessionId: string; createdAt: string; payload: Record<string, unknown> } | null {
    const row = this.db.prepare('SELECT * FROM a9_checkpoints WHERE turn_id = ?').get(turnId) as any;
    if (!row) return null;
    return {
      turnId: row.turn_id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      payload: safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_checkpoints', rowId: row.turn_id }),
    };
  }

  listCheckpoints(sessionId: string): Array<{ turnId: string; createdAt: string }> {
    return (this.db.prepare('SELECT turn_id, created_at FROM a9_checkpoints WHERE session_id = ? ORDER BY created_at ASC, turn_id ASC').all(sessionId) as any[])
      .map((r) => ({ turnId: r.turn_id, createdAt: r.created_at }));
  }

  listRecentCheckpoints(sessionId: string, limit: number): { checkpoints: Array<{ turnId: string; createdAt: string }>; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS total FROM a9_checkpoints WHERE session_id = ?').get(sessionId) as { total: number }).total;
    const rows = this.db.prepare(`
      SELECT turn_id, created_at FROM a9_checkpoints WHERE session_id = ?
      ORDER BY created_at DESC, turn_id DESC LIMIT ?
    `).all(sessionId, limit) as Array<{ turn_id: string; created_at: string }>;
    return { checkpoints: rows.reverse().map((row) => ({ turnId: row.turn_id, createdAt: row.created_at })), total };
  }

  listCheckpointPage(sessionId: string, options: { before?: { createdAt: string; turnId: string }; limit: number }): {
    checkpoints: Array<{ turnId: string; createdAt: string }>;
    total: number;
    hasMore: boolean;
    nextBefore: { createdAt: string; turnId: string } | null;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) AS total FROM a9_checkpoints WHERE session_id = ?').get(sessionId) as { total: number }).total;
    const beforeClause = options.before
      ? 'AND (created_at < ? OR (created_at = ? AND turn_id < ?))' : '';
    const args: Array<string | number> = [sessionId];
    if (options.before) args.push(options.before.createdAt, options.before.createdAt, options.before.turnId);
    args.push(options.limit + 1);
    const rows = this.db.prepare(`
      SELECT turn_id, created_at FROM a9_checkpoints WHERE session_id = ? ${beforeClause}
      ORDER BY created_at DESC, turn_id DESC LIMIT ?
    `).all(...args) as Array<{ turn_id: string; created_at: string }>;
    const hasMore = rows.length > options.limit;
    if (hasMore) rows.pop();
    const oldest = rows[rows.length - 1];
    return {
      checkpoints: rows.reverse().map((row) => ({ turnId: row.turn_id, createdAt: row.created_at })),
      total,
      hasMore,
      nextBefore: hasMore && oldest ? { createdAt: oldest.created_at, turnId: oldest.turn_id } : null,
    };
  }

  /**
   * Reconcile durable workspace checkpoint manifests after a crash. Only an
   * interrupted Turn already bound to the same workspace may gain the missing
   * SQLite projection; completed/foreign/unknown Turns are ignored. The
   * workspace manifest remains the source of file-level undo facts.
   */
  /**
   * Turns of this workspace that a restart marked interrupted before their final
   * checkpoint row was written. Startup recovery reads only these manifests
   * instead of loading the whole checkpoint history (A9-21 M1).
   */
  findInterruptedWorkspaceTurnsNeedingCheckpoint(workspacePath: string): string[] {
    const rows = this.db.prepare(`
      SELECT t.turn_id
      FROM a9_turns t
      JOIN a9_sessions s ON s.session_id = t.session_id
      LEFT JOIN a9_checkpoints c ON c.turn_id = t.turn_id
      WHERE t.status = 'interrupted'
        AND s.workspace_path = ?
        AND c.turn_id IS NULL
      ORDER BY t.created_at ASC, t.turn_id ASC
    `).all(workspacePath) as Array<{ turn_id: string }>;
    return rows.map((row) => row.turn_id);
  }

  reconcileInterruptedWorkspaceCheckpoints(workspacePath: string, turnIds: string[]): string[] {
    const candidates = Array.from(new Set(turnIds.filter((turnId) => typeof turnId === 'string' && turnId.length > 0)));
    const recovered: string[] = [];
    const reconcile = this.db.transaction(() => {
      const find = this.db.prepare(`
        SELECT t.turn_id, t.session_id
        FROM a9_turns t
        JOIN a9_sessions s ON s.session_id = t.session_id
        LEFT JOIN a9_checkpoints c ON c.turn_id = t.turn_id
        WHERE t.turn_id = ? AND t.status = 'interrupted'
          AND s.workspace_path = ? AND c.turn_id IS NULL
      `);
      const insert = this.db.prepare(`
        INSERT INTO a9_checkpoints (turn_id, session_id, created_at, payload_json)
        VALUES (?, ?, ?, ?)
      `);
      for (const turnId of candidates) {
        const row = find.get(turnId, workspacePath) as any;
        if (!row) continue;
        const now = new Date().toISOString();
        insert.run(turnId, row.session_id, now, JSON.stringify({
          schemaVersion: 1,
          outcome: 'interrupted',
          verification: 'not_applicable',
          finalMessage: 'Turn interrupted before its final SQLite checkpoint was committed. Workspace undo facts were recovered from the durable manifest.',
          toolCallsExecuted: 0,
          externalChanges: [],
          recoveredFromWorkspaceManifest: true,
        }));
        recovered.push(turnId);
      }
    });
    reconcile();
    return recovered;
  }

  /**
   * Rebuilds the local conversation surface from persisted facts. This is a
   * read-only projection: callers may render it after restart, but must never
   * replay the prompt, model request, tools, approvals, or side effects.
   */
  listConversationFacts(sessionId: string, limit?: number): Array<{
    taskId: string;
    turnId: string | null;
    requestPrompt: string;
    outcome: string;
    verification: string;
    finalMessage: string;
    createdAt: string;
    updatedAt: string;
    providerContextGeneration?: number;
  }> {
    const cappedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.floor(limit as number), 1000))
      : undefined;
    const taskRows = this.db.prepare(
      'SELECT task_id, status, created_at, updated_at FROM a9_tasks WHERE session_id = ?',
    ).all(sessionId) as any[];
    const tasks = new Map(taskRows.map((row) => [row.task_id, row]));
    const requestRows = this.db.prepare(`
      SELECT id, payload_json, created_at FROM a9_events
      WHERE session_id = ? AND kind = 'model' AND event_type = 'conversation.request' AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.interruptedTurnId') IS NULL
      ORDER BY id DESC${cappedLimit ? ' LIMIT ?' : ''}
    `).all(...(cappedLimit ? [sessionId, cappedLimit] : [sessionId])) as any[];
    const checkpointRows = this.db.prepare(`
      SELECT c.turn_id, c.created_at, c.payload_json, t.task_id, t.status, t.outcome_json AS turn_payload
      FROM a9_checkpoints c
      LEFT JOIN a9_turns t ON t.turn_id = c.turn_id
      WHERE c.session_id = ?
      ORDER BY c.created_at DESC, c.turn_id DESC${cappedLimit ? ' LIMIT ?' : ''}
    `).all(...(cappedLimit ? [sessionId, cappedLimit] : [sessionId])) as any[];

    const facts = new Map<string, any>();
    for (const row of requestRows.reverse()) {
      const payload = safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: row.id }) as any;
      if (!payload.taskId || typeof payload.requestPrompt !== 'string') continue;
      const task = tasks.get(payload.taskId);
      facts.set(payload.taskId, {
        taskId: payload.taskId,
        turnId: null,
        requestPrompt: payload.requestPrompt,
        outcome: task?.status === 'interrupted' ? 'interrupted' : task?.status || 'running',
        verification: 'not_applicable',
        finalMessage: '',
        createdAt: row.created_at,
        updatedAt: task?.updated_at || row.created_at,
      });
    }
    for (const row of checkpointRows.reverse()) {
      const payload = safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_checkpoints', rowId: row.turn_id }) as any;
      const taskId = row.task_id || `legacy:${row.turn_id}`;
      const existing = facts.get(taskId);
      facts.set(taskId, {
        taskId,
        turnId: row.turn_id,
        requestPrompt: existing?.requestPrompt || (!this.isContinuationTurn(row.turn_payload, row.turn_id) && typeof payload.requestPrompt === 'string' ? payload.requestPrompt : ''),
        outcome: payload.outcome || row.status || 'completed',
        verification: payload.verification || 'not_applicable',
        finalMessage: typeof payload.finalMessage === 'string' ? payload.finalMessage : '',
        createdAt: existing?.createdAt || row.created_at,
        updatedAt: row.created_at,
        ...(Number.isSafeInteger(payload.providerContextGeneration)
          ? { providerContextGeneration: payload.providerContextGeneration }
          : {}),
      });
    }
    const sorted = Array.from(facts.values())
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return cappedLimit ? sorted.slice(-cappedLimit) : sorted;
  }

  /**
   * A9-66 F-007: bounded, cooperative counterpart of listConversationFacts for
   * provider-context restoration. It reproduces the synchronous method's
   * merge exactly (request events by ascending id, then checkpoints by
   * ascending created_at/turn_id; later rows replace earlier facts of the same
   * task; ties keep first-insertion order; the same localeCompare ordering) but
   * reads the session in bounded SQL statements (existing-key pages over
   * a9_events, keyset pages over a9_checkpoints) and yields to the event loop
   * with setImmediate between statements. No statement returns more than
   * `batchRows` payload rows. SQLite metadata scans/sorts are not constant work.
   *
   * Instead of a fully sorted list it returns what restoration consumes: the
   * newest `maxRecent` complete rounds of the requested provider generation (in
   * ascending order) plus the exact complete and visible round counts, so
   * includedRounds/includedChars/omittedRounds/visibleRounds can be computed
   * identically to buildPersistedTextContext(listConversationFacts(...)).
   * The merge retains row references and ordering/completeness metadata per
   * task, not historical prompt/reply strings. Only the selected recent rows
   * are materialized. Metadata still scales with retained tasks/requests;
   * payload memory is one bounded row batch plus the selected recent rounds.
   */
  async scanConversationFactsAsync(sessionId: string, options: {
    providerContextGeneration: number; maxRecent?: number; batchRows?: number;
    signal?: { readonly aborted: boolean };
  }): Promise<{
    visibleRounds: number; completeRounds: number;
    recent: ReturnType<A9PersistenceManager['listConversationFacts']>;
  }> {
    const batchRows = options.batchRows ?? 256;
    const maxRecent = options.maxRecent ?? 20;
    if (!Number.isSafeInteger(batchRows) || batchRows < 1 || batchRows > 4096
        || !Number.isSafeInteger(maxRecent) || maxRecent < 1 || maxRecent > 1000) {
      throw a9PersistenceError('A9_PAYLOAD_INVALID', 'Invalid conversation scan batch');
    }
    const assertOpen = () => {
      if (options.signal?.aborted) throw a9PersistenceError('A9_CONTEXT_RESTORE_CANCELLED', 'Conversation context scan cancelled');
      if ((this.db as unknown as { open?: boolean }).open === false) {
        throw a9PersistenceError('A9_CONTEXT_RESTORE_INTERRUPTED', 'Database closed during conversation context scan');
      }
    };
    const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
    assertOpen();
    const facts = new Map<string, any>();
    const requestStatement = this.db.prepare(`
      SELECT id, created_at, CASE WHEN kind = 'model' AND event_type = 'conversation.request'
        AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.interruptedTurnId') IS NULL
        THEN payload_json END AS payload_json FROM a9_events
      WHERE session_id = ? AND id > ? AND id <= ?
      ORDER BY id ASC LIMIT ?
    `);
    const bounds = this.db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM a9_events WHERE session_id = ?').get(sessionId) as any;
    if (bounds && typeof bounds.lo === 'number' && typeof bounds.hi === 'number') {
      let low = bounds.lo - 1;
      while (low < bounds.hi) {
        assertOpen();
        const rows = requestStatement.all(sessionId, low, bounds.hi, batchRows) as any[];
        for (const row of rows) {
          if (row.payload_json === null) continue;
          const payload = safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: row.id }) as any;
          if (!payload.taskId || typeof payload.requestPrompt !== 'string') continue;
          facts.set(payload.taskId, {
            taskId: payload.taskId,
            turnId: null,
            promptRef: payload.requestPrompt.length ? { eventId: row.id } : undefined,
            hasFinal: false,
            createdAt: row.created_at,
          });
        }
        if (rows.length) low = rows[rows.length - 1].id;
        await yieldTurn();
        if (rows.length < batchRows) break;
      }
    }
    const checkpointFirst = this.db.prepare(`
      SELECT c.turn_id, c.created_at, c.payload_json, t.task_id, t.status, t.outcome_json AS turn_payload
      FROM a9_checkpoints c
      LEFT JOIN a9_turns t ON t.turn_id = c.turn_id
      WHERE c.session_id = ?
      ORDER BY c.created_at ASC, c.turn_id ASC LIMIT ?`);
    const checkpointNext = this.db.prepare(`
      SELECT c.turn_id, c.created_at, c.payload_json, t.task_id, t.status, t.outcome_json AS turn_payload
      FROM a9_checkpoints c
      LEFT JOIN a9_turns t ON t.turn_id = c.turn_id
      WHERE c.session_id = ? AND (c.created_at > ? OR (c.created_at = ? AND c.turn_id > ?))
      ORDER BY c.created_at ASC, c.turn_id ASC LIMIT ?`);
    let cursor: { createdAt: string; turnId: string } | undefined;
    for (;;) {
      assertOpen();
      const rows = (cursor
        ? checkpointNext.all(sessionId, cursor.createdAt, cursor.createdAt, cursor.turnId, batchRows)
        : checkpointFirst.all(sessionId, batchRows)) as any[];
      for (const row of rows) {
        const payload = safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_checkpoints', rowId: row.turn_id }) as any;
        const taskId = row.task_id || `legacy:${row.turn_id}`;
        const existing = facts.get(taskId);
        facts.set(taskId, {
          taskId,
          turnId: row.turn_id,
          promptRef: existing?.promptRef || (!this.isContinuationTurn(row.turn_payload, row.turn_id)
            && typeof payload.requestPrompt === 'string' && payload.requestPrompt.length
            ? { turnId: row.turn_id } : undefined),
          hasFinal: typeof payload.finalMessage === 'string' && payload.finalMessage.length > 0,
          createdAt: existing?.createdAt || row.created_at,
          ...(Number.isSafeInteger(payload.providerContextGeneration)
            ? { providerContextGeneration: payload.providerContextGeneration }
            : {}),
        });
      }
      if (rows.length < batchRows) break;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.created_at, turnId: last.turn_id };
      await yieldTurn();
    }
    // Selection without a whole-history sort: the newest `maxRecent` complete
    // rounds under the synchronous order (createdAt localeCompare, then first
    // insertion order, as a stable sort would give).
    let completeRounds = 0;
    let recent: Array<{ fact: any; seq: number }> = [];
    let seq = 0;
    let processed = 0;
    const after = (a: { fact: any; seq: number }, b: { fact: any; seq: number }): boolean => {
      const order = String(a.fact.createdAt).localeCompare(String(b.fact.createdAt));
      return order !== 0 ? order > 0 : a.seq > b.seq;
    };
    for (const fact of facts.values()) {
      const entry = { fact, seq: seq += 1 };
      const generation = Number.isSafeInteger(fact.providerContextGeneration) ? fact.providerContextGeneration : 0;
      if (generation === options.providerContextGeneration
          && fact.promptRef && fact.hasFinal) {
        completeRounds += 1;
        let index = recent.length;
        while (index > 0 && after(recent[index - 1], entry)) index -= 1;
        recent.splice(index, 0, entry);
        if (recent.length > maxRecent) recent.shift();
      }
      processed += 1;
      if (processed % batchRows === 0) { await yieldTurn(); assertOpen(); }
    }
    assertOpen();
    const requestPayload = this.db.prepare('SELECT payload_json FROM a9_events WHERE session_id = ? AND id = ?');
    const checkpointPayload = this.db.prepare(`
      SELECT c.payload_json, c.created_at, t.status FROM a9_checkpoints c
      LEFT JOIN a9_turns t ON t.turn_id = c.turn_id WHERE c.session_id = ? AND c.turn_id = ?`);
    const selected: ReturnType<A9PersistenceManager['listConversationFacts']> = [];
    for (const { fact } of recent) {
      assertOpen();
      const row = checkpointPayload.get(sessionId, fact.turnId) as any;
      const promptRow = fact.promptRef.eventId !== undefined
        ? requestPayload.get(sessionId, fact.promptRef.eventId) as any
        : checkpointPayload.get(sessionId, fact.promptRef.turnId) as any;
      if (!row || !promptRow) throw a9PersistenceError('A9_CONTEXT_RESTORE_INTERRUPTED', 'Conversation rows changed during context scan');
      const payload = safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_checkpoints', rowId: fact.turnId }) as any;
      const prompt = safeParse(promptRow.payload_json, { buffer: this.diagnosticBuffer,
        table: fact.promptRef.eventId !== undefined ? 'a9_events' : 'a9_checkpoints',
        rowId: fact.promptRef.eventId ?? fact.promptRef.turnId }) as any;
      selected.push({ taskId: fact.taskId, turnId: fact.turnId,
        requestPrompt: typeof prompt.requestPrompt === 'string' ? prompt.requestPrompt : '',
        outcome: payload.outcome || row.status || 'completed', verification: payload.verification || 'not_applicable',
        finalMessage: typeof payload.finalMessage === 'string' ? payload.finalMessage : '',
        createdAt: fact.createdAt, updatedAt: row.created_at,
        ...(Number.isSafeInteger(fact.providerContextGeneration) ? { providerContextGeneration: fact.providerContextGeneration } : {}) });
      if (selected.length % batchRows === 0) await yieldTurn();
    }
    assertOpen();
    return { visibleRounds: facts.size, completeRounds, recent: selected };
  }

  /** A9-17: UI-only keyset paging. Only selected payloads cross into JS;
   * SQL still scans/sorts session metadata, so database work is not constant.
   * modern Provider restoration uses scanConversationFactsAsync; the full
   * synchronous listConversationFacts API remains for legacy callers. */
  listConversationFactPage(sessionId: string, options: {
    limit?: number; before?: { createdAt: string; taskId: string };
  } = {}): { facts: ReturnType<A9PersistenceManager['listConversationFacts']>;
    hasMore: boolean; nextBefore: { createdAt: string; taskId: string } | null } {
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (options.before && (typeof options.before.createdAt !== 'string' ||
          typeof options.before.taskId !== 'string' || !options.before.taskId))) {
      throw new Error('A9_CONVERSATION_PAGE_INVALID');
    }
    const before = options.before;
    const rows = this.db.prepare(`
      WITH requests AS (
        SELECT id, created_at,
          json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.taskId') AS task_id
        FROM a9_events WHERE session_id = ? AND kind = 'model' AND event_type = 'conversation.request' AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.interruptedTurnId') IS NULL
          AND json_type(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.requestPrompt') = 'text'
      ), latest_requests AS (
        SELECT task_id, MAX(id) AS request_id FROM requests
        WHERE typeof(task_id) = 'text' AND task_id <> '' GROUP BY task_id
      ), checkpoints AS (
        SELECT c.turn_id, c.created_at, COALESCE(t.task_id, 'legacy:' || c.turn_id) AS task_id,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(t.task_id, 'legacy:' || c.turn_id)
            ORDER BY c.created_at DESC, c.turn_id DESC) AS ordinal
        FROM a9_checkpoints c LEFT JOIN a9_turns t ON t.turn_id = c.turn_id WHERE c.session_id = ?
      ), keys AS (
        SELECT task_id FROM latest_requests UNION SELECT task_id FROM checkpoints
      ), candidates AS (
        SELECT k.task_id, r.request_id, c.turn_id, COALESCE(e.created_at, c.created_at) AS created_at
        FROM keys k LEFT JOIN latest_requests r ON r.task_id = k.task_id
        LEFT JOIN a9_events e ON e.id = r.request_id
        LEFT JOIN checkpoints c ON c.task_id = k.task_id AND c.ordinal = 1
      ), page AS (
        SELECT * FROM candidates
        ${before ? 'WHERE created_at < ? OR (created_at = ? AND task_id < ?)' : ''}
        ORDER BY created_at DESC, task_id DESC LIMIT ?
      )
      SELECT p.*, e.payload_json AS request_payload, c.payload_json AS checkpoint_payload,
        c.created_at AS checkpoint_at, t.status AS task_status, t.updated_at AS task_updated,
        tr.status AS turn_status, tr.outcome_json AS turn_payload
      FROM page p LEFT JOIN a9_events e ON e.id = p.request_id
      LEFT JOIN a9_checkpoints c ON c.turn_id = p.turn_id AND c.session_id = ?
      LEFT JOIN a9_tasks t ON t.task_id = p.task_id AND t.session_id = ?
      LEFT JOIN a9_turns tr ON tr.turn_id = p.turn_id
      ORDER BY p.created_at DESC, p.task_id DESC
    `).all(sessionId, sessionId, ...(before ? [before.createdAt, before.createdAt, before.taskId] : []),
      limit + 1, sessionId, sessionId) as any[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const last = selected[selected.length - 1];
    const facts = selected.reverse().map((row) => {
      const request = safeParse(row.request_payload || '{}', { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: row.request_id }) as any;
      const checkpoint = safeParse(row.checkpoint_payload || '{}', { buffer: this.diagnosticBuffer, table: 'a9_checkpoints', rowId: row.turn_id }) as any;
      return {
        taskId: row.task_id, turnId: row.turn_id || null,
        requestPrompt: (typeof request.requestPrompt === 'string' && request.requestPrompt)
          || (!this.isContinuationTurn(row.turn_payload, row.turn_id) && typeof checkpoint.requestPrompt === 'string' ? checkpoint.requestPrompt : ''),
        outcome: row.turn_id ? checkpoint.outcome || row.turn_status || 'completed' : row.task_status || 'running',
        verification: row.turn_id ? checkpoint.verification || 'not_applicable' : 'not_applicable',
        finalMessage: typeof checkpoint.finalMessage === 'string' ? checkpoint.finalMessage : '',
        createdAt: row.created_at, updatedAt: row.checkpoint_at || row.task_updated || row.created_at,
        ...(Number.isSafeInteger(checkpoint.providerContextGeneration)
          ? { providerContextGeneration: checkpoint.providerContextGeneration } : {}),
      };
    });
    return { facts, hasMore, nextBefore: hasMore && last ? { createdAt: last.created_at, taskId: last.task_id } : null };
  }

  /** ADR-0326: SQL filters and pages redacted visible text; no history arrays or writes.
   * The host projector must select visible fields BEFORE applying its secret filter. */
  private historyProjection(project: (payload: string, type: string) => string): void {
    const db = this.db as SqliteDatabase & { function?: (name: string, fn: (...args: any[]) => string) => void };
    if (!db.function) throw a9PersistenceError('A9_HISTORY_SQL_UNAVAILABLE', 'SQLite scalar functions unavailable');
    db.function('a9_history_visible', (payload: string, type: string) => project(payload, type));
  }

  private historyCandidates(): string {
    return `WITH candidates AS (
      SELECT e.session_id AS conversationId, c.title, c.state AS conversationState,
        'event' AS source, CAST(e.id AS TEXT) AS id, e.turn_id AS turnId,
        COALESCE(t.task_id, json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END, '$.taskId')) AS taskId,
        e.created_at AS createdAt, e.event_type AS kind,
        a9_history_visible(e.payload_json, e.event_type) AS text
      FROM a9_events e JOIN a9_sessions c ON c.session_id=e.session_id
      LEFT JOIN a9_turns t ON t.turn_id=e.turn_id AND t.session_id=e.session_id
      WHERE c.workspace_path=? AND e.event_type IN ('conversation.request','tool_start','tool_output','tool_end','turn_failed')
      UNION ALL
      SELECT p.session_id, c.title, c.state, 'checkpoint', p.turn_id, p.turn_id, t.task_id,
        p.created_at, 'reply', a9_history_visible(p.payload_json,
          CASE WHEN EXISTS (SELECT 1 FROM a9_events e WHERE e.session_id=p.session_id
            AND e.event_type='conversation.request' AND json_extract(CASE WHEN json_valid(e.payload_json)
            THEN e.payload_json ELSE '{}' END, '$.taskId')=t.task_id) THEN 'reply' ELSE 'retained_reply' END)
      FROM a9_checkpoints p JOIN a9_sessions c ON c.session_id=p.session_id
      LEFT JOIN a9_turns t ON t.turn_id=p.turn_id AND t.session_id=p.session_id WHERE c.workspace_path=?
    )`;
  }

  private validateHistorySearch(workspace: string, input: { query: string; limit?: number;
    before?: { createdAt: string; source: string; id: string } }): void {
    const limit = input.limit ?? 20, before = input.before;
    if (typeof workspace !== 'string' || !workspace || typeof input.query !== 'string' || !input.query.trim()
      || input.query.length > 256 || /[\u0000-\u001f]/.test(input.query) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || (before && (typeof before.createdAt !== 'string' || before.createdAt.length > 64
        || !['event', 'checkpoint'].includes(before.source) || typeof before.id !== 'string' || !before.id || before.id.length > 256))) {
      throw a9PersistenceError('A9_PAYLOAD_INVALID', 'Invalid history search');
    }
  }

  /** Legacy synchronous search: one statement over the whole retained history. */
  searchRetainedHistory(workspace: string, input: { query: string; limit?: number;
    before?: { createdAt: string; source: string; id: string } }, project: (payload: string, type: string) => string): any {
    this.validateHistorySearch(workspace, input);
    const limit = input.limit ?? 20, before = input.before;
    this.historyProjection(project);
    const rows = this.db.prepare(`${this.historyCandidates()}
      SELECT conversationId,title,conversationState,source,id,turnId,taskId,createdAt,kind,
        substr(text, max(1,instr(text,?)-100), 420) AS snippet
      FROM candidates WHERE instr(text,?)>0
      ${before ? 'AND (createdAt,source,id)<(?,?,?)' : ''}
      ORDER BY createdAt DESC,source DESC,id DESC LIMIT ?`).all(workspace, workspace, input.query, input.query,
      ...(before ? [before.createdAt, before.source, before.id] : []), limit + 1) as any[];
    const results = rows.slice(0, limit), last = results[results.length - 1];
    return { results, hasMore: rows.length > limit, nextBefore: rows.length > limit && last
      ? { createdAt: last.createdAt, source: last.source, id: last.id } : null };
  }

  /**
   * A9-66 F-008: same candidates, filter, order and cursor as
   * searchRetainedHistory, but scanned in bounded primary-key windows with a
   * real event-loop turn (setImmediate) between SQL statements. Every retained
   * row within the initial MAX(id)/MAX(turn_id) key bounds is examined;
   * there is no scan budget, so no matching history is silently skipped.
   * Only the best limit+1 result payloads are retained; request identifiers
   * still scale with retained requests and are released when this call ends.
   */
  async searchRetainedHistoryAsync(workspace: string, input: { query: string; limit?: number;
    before?: { createdAt: string; source: string; id: string } }, project: (payload: string, type: string) => string,
  options: { batchRows?: number; signal?: { readonly aborted: boolean } } = {}): Promise<any> {
    this.validateHistorySearch(workspace, input);
    const limit = input.limit ?? 20, before = input.before;
    const batchRows = options.batchRows ?? 256;
    if (!Number.isSafeInteger(batchRows) || batchRows < 1 || batchRows > 4096) {
      throw a9PersistenceError('A9_PAYLOAD_INVALID', 'Invalid history search batch');
    }
    const assertOpen = () => {
      if (options.signal?.aborted) throw a9PersistenceError('A9_HISTORY_SEARCH_CANCELLED', 'History search cancelled');
      if ((this.db as unknown as { open?: boolean }).open === false) {
        throw a9PersistenceError('A9_HISTORY_SEARCH_INTERRUPTED', 'History database closed during search');
      }
    };
    assertOpen();
    this.historyProjection(project);
    const beforeFilter = before ? 'AND (createdAt,source,id)<(?,?,?)' : '';
    const beforeArgs = before ? [before.createdAt, before.source, before.id] : [];
    const select = `SELECT conversationId,title,conversationState,source,id,turnId,taskId,createdAt,kind,
        substr(text, max(1,instr(text,?)-100), 420) AS snippet`;
    const eventBatchSql = `${select} FROM (
      SELECT e.session_id AS conversationId, c.title, c.state AS conversationState,
        'event' AS source, CAST(e.id AS TEXT) AS id, e.turn_id AS turnId,
        COALESCE(t.task_id, json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END, '$.taskId')) AS taskId,
        e.created_at AS createdAt, e.event_type AS kind,
        a9_history_visible(e.payload_json, e.event_type) AS text
      FROM a9_events e JOIN a9_sessions c ON c.session_id=e.session_id
      LEFT JOIN a9_turns t ON t.turn_id=e.turn_id AND t.session_id=e.session_id
      WHERE c.workspace_path=? AND e.event_type IN ('conversation.request','tool_start','tool_output','tool_end','turn_failed')
        AND e.id > ? AND e.id <= ?
    ) WHERE instr(text,?)>0 ${beforeFilter}`;
    // The legacy statement evaluates a per-row EXISTS over every request event
    // of the session. Here the same (session, text taskId) facts are collected
    // once, in bounded windows, and looked up through a token-keyed function so
    // concurrent searches never share state.
    const requestedTasks = new Set<string>();
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.historyRequestSets.set(token, requestedTasks);
    try {
      return await this.searchRetainedHistoryWindows(workspace, input, limit, batchRows, assertOpen,
        select, beforeFilter, beforeArgs, eventBatchSql, token, requestedTasks, project);
    } finally {
      this.historyRequestSets.delete(token);
    }
  }

  private readonly historyRequestSets = new Map<string, Set<string>>();

  private async searchRetainedHistoryWindows(workspace: string, input: { query: string }, limit: number,
    batchRows: number, assertOpen: () => void, select: string, beforeFilter: string, beforeArgs: string[],
    eventBatchSql: string, token: string, requestedTasks: Set<string>,
    project: (payload: string, type: string) => string): Promise<any> {
    const db = this.db as SqliteDatabase & { function: (name: string, fn: (...args: any[]) => number) => void };
    db.function('a9_history_task_requested', (searchToken: string, sessionId: string, taskId: unknown) =>
      typeof taskId === 'string' && this.historyRequestSets.get(searchToken)?.has(`${sessionId}\u0000${taskId}`) ? 1 : 0);
    const eventBatch = this.db.prepare(eventBatchSql);
    const requestBatch = this.db.prepare(`SELECT e.session_id AS sessionId,
        json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END, '$.taskId') AS taskId
      FROM a9_events e JOIN a9_sessions c ON c.session_id=e.session_id
      WHERE c.workspace_path=? AND e.event_type='conversation.request' AND e.id > ? AND e.id <= ?`);
    const checkpointBatch = this.db.prepare(`${select} FROM (
      SELECT p.session_id AS conversationId, c.title, c.state AS conversationState, 'checkpoint' AS source,
        p.turn_id AS id, p.turn_id AS turnId, t.task_id AS taskId,
        p.created_at AS createdAt, 'reply' AS kind, a9_history_visible(p.payload_json,
          CASE WHEN a9_history_task_requested('${token}', p.session_id, t.task_id) THEN 'reply' ELSE 'retained_reply' END) AS text
      FROM a9_checkpoints p JOIN a9_sessions c ON c.session_id=p.session_id
      LEFT JOIN a9_turns t ON t.turn_id=p.turn_id AND t.session_id=p.session_id
      WHERE c.workspace_path=? AND (? IS NULL OR p.turn_id > ?) AND p.turn_id <= ?
    ) WHERE instr(text,?)>0 ${beforeFilter}`);
    const maxEvent = Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM a9_events').get() as any).m);
    const maxCheckpoint = (this.db.prepare('SELECT MAX(turn_id) AS m FROM a9_checkpoints').get() as any).m as string | null;
    // SQLite orders TEXT with BINARY collation, i.e. UTF-8 byte order.
    const key = (row: any) => [row.createdAt, row.source, row.id].map((v) => Buffer.from(String(v), 'utf8'));
    const compareDesc = (a: any, b: any) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < 3; i += 1) {
        const order = Buffer.compare(kb[i], ka[i]);
        if (order !== 0) return order;
      }
      return 0;
    };
    let best: any[] = [];
    const offer = (rows: any[]) => {
      if (!rows.length) return;
      best = best.concat(rows).sort(compareDesc).slice(0, limit + 1);
    };
    // Advance by existing keys, so retention gaps do not turn a small database
    // into a scan of its historical numeric identifier space.
    const requestKeys = this.db.prepare("SELECT id AS key FROM a9_events WHERE event_type = 'conversation.request' AND id > ? AND id <= ? ORDER BY id LIMIT ?");
    const eventKeys = this.db.prepare('SELECT id AS key FROM a9_events WHERE id > ? AND id <= ? ORDER BY id LIMIT ?');
    const checkpointKeys = this.db.prepare('SELECT turn_id AS key FROM a9_checkpoints WHERE (? IS NULL OR turn_id > ?) AND turn_id <= ? ORDER BY turn_id LIMIT ?');
    const nextUpper = (keys: { all: (...args: any[]) => unknown[] }, low: number, max: number): number | null => {
      const rows = keys.all(low, max, batchRows) as Array<{ key: number }>;
      return rows.length ? rows[rows.length - 1].key : null;
    };
    const scan = async (statement: { all: (...args: any[]) => unknown[] }, max: number,
      keys: { all: (...args: any[]) => unknown[] }) => {
      let low = 0;
      for (;;) {
        assertOpen();
        const upper = nextUpper(keys, low, max);
        if (upper === null) break;
        // SQL functions belong to the connection. Restore this call's projector
        // immediately before each synchronous statement, after every yield.
        this.historyProjection(project);
        offer(statement.all(input.query, workspace, low, upper, input.query, ...beforeArgs) as any[]);
        low = upper;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    let low = 0;
    for (;;) {
      assertOpen();
      const upper = nextUpper(requestKeys, low, maxEvent);
      if (upper === null) break;
      for (const row of requestBatch.all(workspace, low, upper) as any[]) {
        if (typeof row.taskId === 'string') requestedTasks.add(`${row.sessionId}\u0000${row.taskId}`);
      }
      low = upper;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await scan(eventBatch, maxEvent, eventKeys);
    // turn_id survives INSERT OR REPLACE, whereas SQLite allocates a fresh
    // rowid. Scan stable logical keys so a not-yet-seen replacement is retained.
    let checkpointLow: string | null = null;
    while (maxCheckpoint !== null) {
      assertOpen();
      const keys = checkpointKeys.all(checkpointLow, checkpointLow, maxCheckpoint, batchRows) as Array<{ key: string }>;
      if (!keys.length) break;
      const upper = keys[keys.length - 1].key;
      this.historyProjection(project);
      offer(checkpointBatch.all(input.query, workspace, checkpointLow, checkpointLow, upper, input.query, ...beforeArgs) as any[]);
      checkpointLow = upper;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assertOpen();
    const results = best.slice(0, limit), last = results[results.length - 1];
    return { results, hasMore: best.length > limit, nextBefore: best.length > limit && last
      ? { createdAt: last.createdAt, source: last.source, id: last.id } : null };
  }

  locateRetainedHistory(workspace: string, input: { conversationId: string; source: string; id: string; query?: string },
    project: (payload: string, type: string) => string): any {
    this.historyProjection(project);
    // Direct identity lookups. Never walk previous conversation/event pages.
    const checkpoint = input.source === 'checkpoint';
    const sql = checkpoint ? `SELECT p.session_id AS conversationId, c.title,
        p.turn_id AS turnId, t.task_id AS taskId, p.created_at AS createdAt, 'reply' AS kind,
        a9_history_visible(p.payload_json,'retained_reply') AS text
      FROM a9_checkpoints p JOIN a9_sessions c ON c.session_id=p.session_id
      LEFT JOIN a9_turns t ON t.turn_id=p.turn_id AND t.session_id=p.session_id
      WHERE c.workspace_path=? AND p.session_id=? AND p.turn_id=?`
      : `SELECT e.session_id AS conversationId,c.title,e.turn_id AS turnId,
        COALESCE(t.task_id,json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END,'$.taskId')) AS taskId,
        e.created_at AS createdAt,e.event_type AS kind,a9_history_visible(e.payload_json,e.event_type) AS text
      FROM a9_events e JOIN a9_sessions c ON c.session_id=e.session_id
      LEFT JOIN a9_turns t ON t.turn_id=e.turn_id AND t.session_id=e.session_id
      WHERE c.workspace_path=? AND e.session_id=? AND e.id=?
        AND e.event_type IN ('conversation.request','tool_start','tool_output','tool_end','turn_failed')`;
    // SQL bounds the returned text even if the retained source itself is large.
    const bounded = this.db.prepare(`SELECT conversationId,title,turnId,taskId,createdAt,kind,
      substr(text,max(1,instr(text,?)-200),24000) AS text,
      max(1,instr(text,?)-200) AS textOffset,length(text) AS textLength
      FROM (${sql})`);
    return bounded.get(input.query || '', input.query || '', workspace, input.conversationId, input.id) || null;
  }

  getTurnDeliveryFacts(conversationId: string, turnId: string): any {
    const turn = this.db.prepare(`SELECT t.task_id AS taskId,t.turn_id AS turnId,t.status,
      t.outcome_json AS outcomeJson,c.payload_json AS checkpointJson
      FROM a9_turns t LEFT JOIN a9_checkpoints c ON c.turn_id=t.turn_id AND c.session_id=t.session_id
      WHERE t.session_id=? AND t.turn_id=?`).get(conversationId, turnId) as any;
    if (!turn) return null;
    const events = this.db.prepare(`SELECT e.id,e.event_type AS eventType,e.payload_json AS payloadJson,
      (SELECT s.payload_json FROM a9_events s WHERE s.session_id=e.session_id AND s.turn_id=e.turn_id
        AND s.event_type='tool_start' AND json_extract(CASE WHEN json_valid(s.payload_json) THEN s.payload_json ELSE '{}' END,'$.data.callId')=
          json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END,'$.data.callId') ORDER BY s.id DESC LIMIT 1) AS startJson
      FROM a9_events e WHERE e.session_id=? AND e.turn_id=?
      AND e.event_type IN ('tool_end','turn_completed','turn_failed') ORDER BY e.id DESC LIMIT 101`).all(conversationId, turnId);
    return { ...turn, events: events.slice(0, 100), auditTruncated: events.length > 100 };
  }

  private isContinuationTurn(payloadJson: string | undefined, turnId: string): boolean {
    const payload = safeParse(payloadJson || '{}', { buffer: this.diagnosticBuffer, table: 'a9_turns', rowId: turnId }) as any;
    return typeof payload.interruptedTurnId === 'string' || typeof payload.continuation?.interruptedTurnId === 'string';
  }

  hasConversationFacts(sessionId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM a9_events WHERE session_id = ? AND kind = 'model'
      AND event_type = 'conversation.request' AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.interruptedTurnId') IS NULL LIMIT 1`).get(sessionId) ||
      this.db.prepare('SELECT 1 FROM a9_checkpoints WHERE session_id = ? LIMIT 1').get(sessionId));
  }

  recordApproval(approval: {
    approvalId: string;
    sessionId: string;
    turnId?: string;
    toolName: string;
    binding: Record<string, unknown>;
    decision: 'pending' | 'approved' | 'denied' | 'interrupted';
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO a9_approvals (approval_id, session_id, turn_id, tool_name, binding_json, decision, decided_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.approvalId,
      approval.sessionId,
      approval.turnId ?? null,
      approval.toolName,
      JSON.stringify(approval.binding),
      approval.decision,
      approval.decision === 'pending' ? null : new Date().toISOString(),
      new Date().toISOString(),
    );
  }

  /** Persist one versioned question fact before the UI may display it. */
  recordQuestionPending(workspacePath: string, question: A9PendingQuestionFact): { eventId: number } {
    const conversation = this.requireConversation(question.conversationId);
    if (!sameWorkspacePath(conversation.workspacePath, workspacePath)
      || question.schemaVersion !== 1
      || question.revision !== 1
      || !question.questionId || question.questionId.length > 256
      || typeof question.prompt !== 'string' || !question.prompt.trim() || question.prompt.length > 2000
      || !Array.isArray(question.options) || question.options.length > 6
      || question.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 200)
      || !question.taskId || question.taskId.length > 256
      || !question.turnId || question.turnId.length > 256
      || !question.callId || question.callId.length > 256
      || question.workspace !== workspacePath) {
      throw a9PersistenceError('A9_QUESTION_FACT_INVALID', '问询事实身份或边界无效。');
    }
    return this.db.transaction(() => {
      const duplicate = this.db.prepare(`SELECT id FROM a9_events WHERE session_id = ?
        AND event_type = 'question_pending'
        AND json_extract(payload_json, '$.questionId') = ?
        AND json_extract(payload_json, '$.revision') = ? LIMIT 1`)
        .get(question.conversationId, question.questionId, question.revision) as any;
      if (duplicate) {
        const stored = safeParse((this.db.prepare('SELECT id, payload_json FROM a9_events WHERE id = ?').get(duplicate.id) as any)?.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: duplicate.id });
        if (JSON.stringify(stored) !== JSON.stringify(question)) {
          throw a9PersistenceError('A9_QUESTION_FACT_CONFLICT', '同一问题身份出现不同事实。');
        }
        return { eventId: Number(duplicate.id) };
      }
      const pending = this.db.prepare(`SELECT id FROM a9_events WHERE session_id = ?
        AND event_type = 'question_pending'
        AND NOT EXISTS (SELECT 1 FROM a9_events r WHERE r.session_id = a9_events.session_id
          AND r.event_type = 'question_resolved'
          AND json_extract(r.payload_json, '$.questionId') = json_extract(a9_events.payload_json, '$.questionId')
          AND json_extract(r.payload_json, '$.revision') = json_extract(a9_events.payload_json, '$.revision'))
        LIMIT 1`).get(question.conversationId);
      if (pending) throw a9PersistenceError('A9_QUESTION_ALREADY_PENDING', '当前对话已有未解决问询。');
      return this.insertEvent(question.conversationId, question.turnId, 'tool', 'question_pending', {
        ...question,
      });
    })();
  }

  getPendingQuestion(workspacePath: string, sessionId: string): A9PendingQuestionFact | null {
    const conversation = this.requireConversation(sessionId);
    if (!sameWorkspacePath(conversation.workspacePath, workspacePath)) return null;
    const row = this.db.prepare(`SELECT id, payload_json FROM a9_events e WHERE e.session_id = ?
      AND e.event_type = 'question_pending'
      AND NOT EXISTS (SELECT 1 FROM a9_events r WHERE r.session_id = e.session_id
        AND r.event_type = 'question_resolved'
        AND json_extract(r.payload_json, '$.questionId') = json_extract(e.payload_json, '$.questionId')
        AND json_extract(r.payload_json, '$.revision') = json_extract(e.payload_json, '$.revision'))
      ORDER BY e.id DESC LIMIT 1`).get(sessionId) as any;
    if (!row) return null;
    const payload = safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: row.id }) as any;
    if (!payload || payload.schemaVersion !== 1 || typeof payload.questionId !== 'string'
      || !Number.isSafeInteger(payload.revision) || !Array.isArray(payload.options)
      || typeof payload.prompt !== 'string') {
      throw a9PersistenceError('A9_QUESTION_FACT_CORRUPT', '持久化问询事实损坏。');
    }
    return {
      schemaVersion: 1,
      questionId: payload.questionId,
      revision: payload.revision,
      workspace: payload.workspace,
      conversationId: payload.conversationId,
      taskId: payload.taskId,
      turnId: payload.turnId,
      callId: payload.callId,
      prompt: payload.prompt,
      options: payload.options,
      recovered: payload.recovered === true,
    };
  }

  /**
   * Atomically commit the answer/cancel fact. Repeating the exact same reply
   * returns the original resolution without another event or side effect.
   */
  resolveQuestion(workspacePath: string, input: A9QuestionReplyFact): A9QuestionResolution {
    const conversation = this.requireConversation(input.conversationId);
    if (!sameWorkspacePath(conversation.workspacePath, workspacePath)
      || !input.questionId || input.questionId.length > 256
      || !Number.isSafeInteger(input.revision) || input.revision < 1
      || (input.decision !== 'answered' && input.decision !== 'cancelled')
      || (input.decision === 'answered'
        && (typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 2048))
      || (input.decision === 'cancelled' && input.answer !== undefined)) {
      throw a9PersistenceError('A9_QUESTION_REPLY_INVALID', '问询回复无效。');
    }
    return this.db.transaction(() => {
      const pendingRow = this.db.prepare(`SELECT id, payload_json FROM a9_events e WHERE e.session_id = ?
        AND e.event_type = 'question_pending'
        AND json_extract(e.payload_json, '$.questionId') = ?
        AND json_extract(e.payload_json, '$.revision') = ?
        AND NOT EXISTS (SELECT 1 FROM a9_events r WHERE r.session_id = e.session_id
          AND r.event_type = 'question_resolved'
          AND json_extract(r.payload_json, '$.questionId') = json_extract(e.payload_json, '$.questionId')
          AND json_extract(r.payload_json, '$.revision') = json_extract(e.payload_json, '$.revision'))
        ORDER BY e.id DESC LIMIT 1`).get(input.conversationId, input.questionId, input.revision) as any;
      if (!pendingRow) {
        const existingRow = this.db.prepare(`SELECT id, payload_json FROM a9_events WHERE session_id = ?
          AND event_type = 'question_resolved'
          AND json_extract(payload_json, '$.questionId') = ?
          AND json_extract(payload_json, '$.revision') = ?
          ORDER BY id DESC LIMIT 1`).get(input.conversationId, input.questionId, input.revision) as any;
        if (!existingRow) throw a9PersistenceError('A9_QUESTION_STALE', '问询不存在、已变化或不属于当前对话。');
        const existing = safeParse(existingRow.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: existingRow.id }) as any;
        if (existing.decision !== input.decision || existing.answer !== input.answer) {
          throw a9PersistenceError('A9_QUESTION_REPLY_CONFLICT', '同一问题已用不同回答解决。');
        }
        return { ...existing, duplicate: true } as A9QuestionResolution;
      }
      const pending = safeParse(pendingRow.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: pendingRow.id }) as any;
      if (pending.conversationId !== input.conversationId || pending.workspace !== workspacePath) {
        throw a9PersistenceError('A9_QUESTION_IDENTITY_MISMATCH', '问询不属于当前工作区或对话。');
      }
      const resolvedAt = new Date().toISOString();
      const resolution: A9QuestionResolution = {
        schemaVersion: 1,
        conversationId: input.conversationId,
        questionId: input.questionId,
        revision: input.revision,
        decision: input.decision,
        ...(input.decision === 'answered' ? { answer: input.answer } : {}),
        workspace: workspacePath,
        taskId: pending.taskId,
        turnId: pending.turnId,
        resolvedAt,
        duplicate: false,
      };
      this.insertEvent(input.conversationId, pending.turnId, 'tool', 'question_resolved', { ...resolution });
      return resolution;
    })();
  }

  recordManagedProcess(fact: {
    handleId: string;
    workspacePath: string;
    pid?: number;
    command: string;
    cwd: string;
    startedAt: string;
    lastProbeStatus?: string;
    pidReusePossible?: boolean;
    cleanupRequired?: boolean;
  }): void {
    const normalizedPid = fact.pid ?? null;
    const normalizedStatus = fact.cleanupRequired === true ? 'cleanup_required' : fact.lastProbeStatus ?? null;
    const normalizedPidReuse = fact.pidReusePossible ? 1 : 0;
    const existing = this.db.prepare(
      'SELECT workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible FROM a9_managed_processes WHERE handle_id = ?',
    ).get(fact.handleId) as {
      workspace_path: string;
      pid: number | null;
      command: string;
      cwd: string;
      started_at: string;
      last_probe_status: string | null;
      pid_reuse_possible: number;
    } | undefined;
    if (
      existing
      && existing.workspace_path === fact.workspacePath
      && (existing.pid ?? null) === normalizedPid
      && existing.command === fact.command
      && existing.cwd === fact.cwd
      && existing.started_at === fact.startedAt
      && (existing.last_probe_status ?? null) === normalizedStatus
      && existing.pid_reuse_possible === normalizedPidReuse
    ) {
      return;
    }
    const written = this.db.prepare(`
      INSERT OR REPLACE INTO a9_managed_processes
        (handle_id, workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fact.handleId,
      fact.workspacePath,
      normalizedPid,
      fact.command,
      fact.cwd,
      fact.startedAt,
      normalizedStatus,
      normalizedPidReuse,
    );
    // The equal-row early return above is the only legitimate zero-row write.
    assertWrittenRows(written, 1, 'managed process fact');
  }

  /** Versioned owner/release events plus legacy fact update share one SQLite transaction. */
  recordManagedOwnership(fact: Parameters<A9PersistenceManager['recordManagedProcess']>[0], ownership: A9ManagedOwnershipRecord,
    options: { mode?: 'register' | 'update' | 'reconcile' } = {}): void {
    const owner = ownership.owner;
    if (ownership.schemaVersion !== 1 || !owner || Object.values(owner).some((v) => typeof v !== 'string' || !v.trim())
      || !ownership.requestId || !fact.handleId || !['owned', 'release_intent', 'released', 'release_unknown'].includes(ownership.ownershipState)
      || (ownership.ownershipState !== 'owned' && !/^[a-zA-Z0-9_-]{1,128}$/.test(ownership.releaseId ?? ''))) throw new Error('A9_MANAGED_OWNERSHIP_INVALID');
    this.db.transaction(() => {
      this.assertManagedOwnershipOrigin(fact.workspacePath, owner);
      const previous = this.getManagedOwnership(fact.handleId, fact.workspacePath);
      const stored = this.db.prepare(`SELECT workspace_path, pid, command, cwd, started_at, last_probe_status, pid_reuse_possible
        FROM a9_managed_processes WHERE handle_id = ?`).get(fact.handleId) as {
        workspace_path: string; pid: number | null; command: string; cwd: string;
        started_at: string; last_probe_status: string | null; pid_reuse_possible: number;
      } | undefined;
      if (options.mode && options.mode !== 'register' && (!previous || !stored || stored.last_probe_status === 'user_dismissed')) {
        throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '持久化归属或待清理事实不存在');
      }
      if (previous && (JSON.stringify(previous.owner) !== JSON.stringify(owner) || previous.requestId !== ownership.requestId)) throw new Error('A9_MANAGED_OWNER_IMMUTABLE');
      if (options.mode === 'update' && stored && (!sameWorkspacePath(stored.workspace_path, fact.workspacePath)
        || stored.started_at !== fact.startedAt || (stored.pid !== null && stored.pid !== (fact.pid ?? null)))) {
        throw a9PersistenceError('A9_MANAGED_RECOVERY_STALE', '后台进程身份与持久事实不符');
      }
      if (options.mode === 'reconcile') {
        if (ownership.ownershipState === 'released' || previous?.ownershipState !== ownership.ownershipState
          || previous.releaseId !== ownership.releaseId) {
          throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '恢复探测不能确认或改变释放归属');
        }
        if (!stored || !sameWorkspacePath(stored.workspace_path, fact.workspacePath)
          || stored.pid !== (fact.pid ?? null) || stored.started_at !== fact.startedAt
          || !['starting', 'running', 'running_unknown', 'identity_mismatch', 'cleanup_required'].includes(stored.last_probe_status ?? '')) {
          throw a9PersistenceError('A9_MANAGED_RECOVERY_STALE', '恢复探测与当前持久事实不符');
        }
        this.updateManagedRecoveryProbe(fact);
        return;
      }
      if (previous?.ownershipState === 'released' && ownership.ownershipState !== 'released') throw new Error('A9_MANAGED_RELEASE_TERMINAL');
      if (ownership.ownershipState === 'released' && !['release_intent', 'released'].includes(previous?.ownershipState ?? '')) throw new Error('A9_MANAGED_RELEASE_INTENT_MISSING');
      if (ownership.ownershipState === 'released' && previous?.releaseId !== ownership.releaseId) throw new Error('A9_MANAGED_RELEASE_ID_MISMATCH');
      if (ownership.ownershipState === 'released' && (fact.lastProbeStatus !== 'released' || fact.cleanupRequired === true)) {
        throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '释放归属缺少一致的终态事实');
      }
      if (previous?.ownershipState === 'released') {
        if (stored?.last_probe_status !== 'released' || !sameWorkspacePath(stored.workspace_path, fact.workspacePath)
          || stored.pid !== (fact.pid ?? null) || stored.started_at !== fact.startedAt
          || stored.command !== fact.command || stored.cwd !== fact.cwd
          || stored.pid_reuse_possible !== (fact.pidReusePossible ? 1 : 0)
          || JSON.stringify(previous) !== JSON.stringify(ownership)) {
          throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '持久化释放事实不一致');
        }
        return;
      }
      // An owned live process needs future cleanup; this is not a failed-cleanup status.
      // Keep the legacy residual representation for every uncertain/terminal failure.
      const storedFact = ownership.ownershipState === 'owned' && ['starting', 'running'].includes(fact.lastProbeStatus ?? '')
        ? { ...fact, cleanupRequired: false } : fact;
      this.recordManagedProcess(storedFact);
      if (previous && JSON.stringify(previous) === JSON.stringify(ownership)) return;
      this.insertEvent(owner.conversationId, owner.turnId, 'tool', 'managed_process_ownership', { handleId: fact.handleId, ...ownership });
    })();
  }

  /** Refresh a legacy recovery probe without manufacturing ownership or replacing the row. */
  recordLegacyManagedRecoveryProbe(fact: Parameters<A9PersistenceManager['recordManagedProcess']>[0]): void {
    this.db.transaction(() => {
      const stored = this.db.prepare(`SELECT workspace_path, pid, started_at, last_probe_status
        FROM a9_managed_processes WHERE handle_id = ?`).get(fact.handleId) as {
        workspace_path: string; pid: number | null; started_at: string; last_probe_status: string | null;
      } | undefined;
      if (!stored || !sameWorkspacePath(stored.workspace_path, fact.workspacePath)
        || stored.pid !== (fact.pid ?? null) || stored.started_at !== fact.startedAt
        || !['starting', 'running', 'running_unknown', 'identity_mismatch', 'cleanup_required'].includes(stored.last_probe_status ?? '')) {
        throw a9PersistenceError('A9_MANAGED_RECOVERY_STALE', '恢复探测与当前持久事实不符');
      }
      if (this.getManagedOwnership(fact.handleId, fact.workspacePath)) {
        throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '旧句柄的持久归属已变化');
      }
      this.updateManagedRecoveryProbe(fact);
    })();
  }

  private updateManagedRecoveryProbe(fact: Parameters<A9PersistenceManager['recordManagedProcess']>[0]): void {
    const status = fact.cleanupRequired === true ? 'cleanup_required' : fact.lastProbeStatus ?? null;
    const reuse = fact.pidReusePossible ? 1 : 0;
    const updated = this.db.prepare(`UPDATE a9_managed_processes SET last_probe_status = ?, pid_reuse_possible = ?
      WHERE handle_id = ? AND (last_probe_status IS NOT ? OR pid_reuse_possible IS NOT ?)`)
      .run(status, reuse, fact.handleId, status, reuse);
    if (Number(updated.changes ?? 0) === 1) return;
    // Zero rows is idempotent only when the row already holds exactly these values.
    const row = this.db.prepare('SELECT last_probe_status, pid_reuse_possible FROM a9_managed_processes WHERE handle_id = ?')
      .get(fact.handleId) as { last_probe_status: string | null; pid_reuse_possible: number } | undefined;
    if (!row || (row.last_probe_status ?? null) !== status || row.pid_reuse_possible !== reuse) {
      throw a9PersistenceError('A9_PERSISTENCE_WRITE_UNCONFIRMED', '恢复探测事实未写入预期行');
    }
  }

  /**
   * Terminal write for a legacy (unowned) PID fact this Runtime adopted after a
   * restart. Only the adopted identity may settle the row: another connection may
   * have replaced the handle row with a new PID/start time, and that new fact must
   * never be overwritten with the old identity's terminal state.
   */
  settleRecoveredManagedProcess(fact: Parameters<A9PersistenceManager['recordManagedProcess']>[0]): void {
    const status = fact.lastProbeStatus ?? '';
    if (!['exited', 'stopped', 'failed'].includes(status) || fact.cleanupRequired === true) {
      throw a9PersistenceError('A9_MANAGED_RECOVERY_STALE', '恢复事实缺少 Runner 确认的终态');
    }
    const reuse = fact.pidReusePossible ? 1 : 0;
    this.db.transaction(() => {
      const stored = this.db.prepare(`SELECT workspace_path, pid, started_at, last_probe_status, pid_reuse_possible
        FROM a9_managed_processes WHERE handle_id = ?`).get(fact.handleId) as {
        workspace_path: string; pid: number | null; started_at: string; last_probe_status: string | null; pid_reuse_possible: number;
      } | undefined;
      const sameIdentity = Boolean(stored) && sameWorkspacePath(stored!.workspace_path, fact.workspacePath)
        && stored!.pid === (fact.pid ?? null) && stored!.started_at === fact.startedAt;
      if (!sameIdentity) {
        throw a9PersistenceError('A9_MANAGED_RECOVERY_STALE', '恢复事实已被另一身份取代或不再处于活动状态');
      }
      // Ownership is verified before both the idempotent success and the terminal
      // UPDATE: a damaged record throws its own error, and any ownership at all
      // (another connection may have owned this identity while it is still running)
      // means this is no longer a legacy handle that a legacy settle may overwrite.
      if (this.getManagedOwnership(fact.handleId, fact.workspacePath)) {
        throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '旧句柄的持久归属已变化');
      }
      if (stored!.last_probe_status === status && stored!.pid_reuse_possible === reuse) return;
      if (!['starting', 'running', 'running_unknown', 'identity_mismatch'].includes(stored!.last_probe_status ?? '')) {
        throw a9PersistenceError('A9_MANAGED_RECOVERY_STALE', '恢复事实已被另一身份取代或不再处于活动状态');
      }
      const updated = this.db.prepare(`UPDATE a9_managed_processes SET last_probe_status = ?, pid_reuse_possible = ?
        WHERE handle_id = ? AND pid IS ? AND started_at = ? AND last_probe_status = ?`)
        .run(status, reuse, fact.handleId, stored!.pid, stored!.started_at, stored!.last_probe_status);
      assertWrittenRows(updated, 1, 'recovered managed process terminal fact');
    })();
  }

  private assertManagedOwnershipOrigin(workspacePath: string, owner: A9ManagedOwnershipRecord['owner'], {
    requireActive = true, previousWorkspace,
  }: { requireActive?: boolean; previousWorkspace?: string } = {}): void {
    const origin = this.db.prepare(`SELECT s.workspace_path, s.state FROM a9_sessions s JOIN a9_tasks t ON t.session_id=s.session_id
      JOIN a9_turns tr ON tr.task_id=t.task_id AND tr.session_id=s.session_id
      WHERE s.session_id=? AND t.task_id=? AND tr.turn_id=?`).get(owner.conversationId, owner.taskId, owner.turnId) as any;
    const canonical = process.platform === 'win32' ? path.win32.resolve(workspacePath.replace(/\//g, '\\')).toLowerCase() : path.posix.resolve(workspacePath.replace(/\\/g, '/'));
    const workspaceMatches = owner.workspace === canonical
      || (previousWorkspace !== undefined && sameWorkspacePath(owner.workspace, previousWorkspace));
    if (!origin || !sameWorkspacePath(origin.workspace_path, workspacePath) || !workspaceMatches
      || (requireActive && origin.state !== 'active')) {
      throw a9PersistenceError('A9_MANAGED_OWNER_MISMATCH', '无法验证归属对应的工作区、会话与任务');
    }
  }

  getManagedOwnership(handleId: string, workspacePath?: string): A9ManagedOwnershipRecord | undefined {
    return this.readManagedOwnerships([handleId], undefined, workspacePath).get(handleId);
  }

  private parseManagedOwnership(row: {
    id: number; payload_json: string; session_id: string; turn_id: string | null; handle_id: string | null; turn_valid: number;
  }): A9ManagedOwnershipRecord {
    const payload = safeParse(row.payload_json, {
      buffer: this.diagnosticBuffer, table: 'a9_events', rowId: row.id,
    });
    const owner = payload?.owner as Record<string, unknown> | undefined;
    const hasText = (value: unknown) => typeof value === 'string' && Boolean(value.trim());
    if (!payload || payload.schemaVersion !== 1 || payload.handleId !== row.handle_id || row.turn_valid !== 1
      || !owner || typeof owner !== 'object' || Array.isArray(owner)) {
      throw a9PersistenceError('A9_MANAGED_OWNERSHIP_CORRUPT', '归属记录格式不受支持');
    }
    if (!['workspace', 'conversationId', 'taskId', 'turnId', 'toolCallId'].every(key => hasText(owner[key]))
      || !Object.values(owner).every(hasText) || !hasText(payload.requestId)
      || typeof payload.ownershipState !== 'string'
      || !['owned', 'release_intent', 'released', 'release_unknown'].includes(payload.ownershipState)
      || (payload.ownershipState !== 'owned'
        && (typeof payload.releaseId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.releaseId)))
      || (payload.recoveryStatus !== undefined
        && (typeof payload.recoveryStatus !== 'string'
          || !['running_unknown', 'identity_mismatch', 'exited'].includes(payload.recoveryStatus)))) {
      throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '归属未确认');
    }
    if (owner.conversationId !== row.session_id || owner.turnId !== row.turn_id) {
      throw a9PersistenceError('A9_MANAGED_HANDLE_WRONG_OWNER', '归属与事件来源不符');
    }
    const { handleId: _handleId, ...ownership } = payload;
    return ownership as unknown as A9ManagedOwnershipRecord;
  }

  /** Only the latest event per requested handle and uncertain scope is returned from SQLite. */
  listManagedOwnerships(handleIds: string[], onError?: (handleId: string, error: Error) => void, workspacePath?: string):
    Map<string, A9ManagedOwnershipRecord> {
    return this.readManagedOwnerships(handleIds, onError, workspacePath);
  }

  private readManagedOwnerships(handleIds: string[], onError?: (handleId: string, error: Error) => void, workspacePath?: string):
    Map<string, A9ManagedOwnershipRecord> {
    const targets = [...new Set(handleIds)];
    const ownerships = new Map<string, A9ManagedOwnershipRecord>();
    if (!targets.length) return ownerships;
    const ids = JSON.stringify(targets);
    const ownershipCandidates = `
      WITH candidates AS (
        SELECT id, session_id, turn_id, kind,
          CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json, '$.handleId') = 'text'
            THEN NULLIF(json_extract(payload_json, '$.handleId'), '') END END AS handle_id
        FROM a9_events WHERE event_type = 'managed_process_ownership'
      ), relevant AS (
        SELECT id, handle_id,
          (SELECT workspace_path FROM a9_sessions WHERE session_id = candidates.session_id) AS workspace_path,
          (SELECT json_extract(s.metadata_json, '$.workdir.previousWorkspace') FROM a9_sessions s
            WHERE s.session_id = candidates.session_id AND json_valid(s.metadata_json)) AS previous_workspace,
          (SELECT json_extract(s.metadata_json, '$.workdir.workspaceHistory') FROM a9_sessions s
            WHERE s.session_id = candidates.session_id AND json_valid(s.metadata_json)) AS workspace_history,
          (SELECT ${WORKDIR_ORIGIN_SQL} FROM a9_sessions s WHERE s.session_id = candidates.session_id) AS workdir_origin
        FROM candidates
        -- Only tool audit events are ownership evidence (ADR-0343); a non-tool record,
        -- with or without a handleId, is neither evidence nor damaged evidence.
        WHERE kind = 'tool' AND (handle_id IS NULL OR handle_id IN (SELECT value FROM json_each(?)))
      )`;
    // Every relevant record, ascending. Grouping is by canonical workspace in JS:
    // equivalent Windows spellings of one workspace are one scope (ADR-0344), so a
    // second spelling can never start its own "first" record and re-own a handle.
    const rows = this.db.prepare(`${ownershipCandidates}
      SELECT relevant.handle_id, relevant.workspace_path, relevant.previous_workspace, relevant.workspace_history,
        relevant.workdir_origin, e.id, e.payload_json, e.session_id, e.turn_id,
        EXISTS (SELECT 1 FROM a9_turns t WHERE t.turn_id = e.turn_id AND t.session_id = e.session_id) AS turn_valid
      FROM relevant JOIN a9_events e ON e.id = relevant.id ORDER BY e.id ASC`).all(ids) as Array<{
      handle_id: string | null; workspace_path: string | null; previous_workspace: unknown; workspace_history: unknown;
      workdir_origin: unknown; id: number; payload_json: string; session_id: string; turn_id: string | null; turn_valid: number }>;
    const byHandle = new Map<string | null, typeof rows>();
    // Damaged (invalid JSON) records attributed to a handle only through its salvaged handleId.
    const recoveredRows = new WeakSet<(typeof rows)[number]>();
    const group = (key: string | null, row: (typeof rows)[number]) => {
      const candidates = byHandle.get(key);
      if (candidates) candidates.push(row);
      else byHandle.set(key, [row]);
    };
    for (const row of rows) {
      group(row.handle_id, row);
      // Round 15 (P1): SQLite reads no handleId from invalid (e.g. truncated) JSON, yet a
      // complete top-level `"handleId":"…"` may survive. Such a record is that handle's own
      // candidate, so its damage fails closed (A9_MANAGED_OWNERSHIP_CORRUPT) even when the
      // truncation hid the owner workspace. It also stays in the unattributable group.
      // Round 17 (P1): a handleId cut before its closing quote names each requested handle
      // it is (a non-empty prefix of) as well.
      if (row.handle_id === null) {
        for (const recovered of damagedPayloadHandleTargets(row.payload_json, targets)) {
          const attributed = { ...row, handle_id: recovered };
          recoveredRows.add(attributed);
          group(recovered, attributed);
        }
      }
    }
    const workspaces = workspacePath === undefined && rows.length
      ? new Map((this.db.prepare(`SELECT handle_id, workspace_path FROM a9_managed_processes
          WHERE handle_id IN (SELECT value FROM json_each(?))`).all(ids) as Array<{ handle_id: string; workspace_path: string }>)
        .map(row => [row.handle_id, row.workspace_path]))
      : null;
    for (const handleId of targets) {
      try {
        const scope = workspacePath ?? workspaces?.get(handleId);
        const belongsToScope = (candidate: (typeof rows)[number]) =>
          !scope || !candidate.workspace_path || sameWorkspacePath(scope, candidate.workspace_path);
        // Round 19 (P1): a conversation rebound elsewhere came from the workspace in its
        // `workdir.previousWorkspace`; its unattributable records stay damage of that scope.
        // Its complete records keep their foreign-origin verification below.
        // Round 20 (P1): an unattributable record is damage of the workspace its conversation
        // was bound to when it was written (`workdir.workspaceHistory` event-id segments): an
        // early record stays damage of A across A -> B -> C and a default-directory rename,
        // while a record written after the rebind (in B) is never damage of A.
        const writtenInScope = (candidate: (typeof rows)[number]) => !scope
          || managedEventWrittenIn(candidate, candidate.workspace_path, scope);
        const candidates = byHandle.get(handleId);
        const scoped = candidates?.filter(belongsToScope) ?? [];
        const row = scoped[scoped.length - 1];
        // Round 13 (P1): a record without a usable handleId whose payload still names
        // this workspace as owner (e.g. the original record of a conversation rebound
        // elsewhere) is damaged evidence of this scope, whatever its session points to now.
        const namesScope = (candidate: (typeof rows)[number]) =>
          Boolean(scope) && namesManagedOwnerWorkspace(candidate.payload_json, scope!);
        // Round 19 (P1): an unattributable record of this scope older than the first in-scope
        // record and of another conversation (e.g. the only record of a rebound conversation,
        // cut before its handleId) is never shadowed by that later conversation: it fails closed.
        // Older damage of the anchor's own conversation keeps the earlier sibling semantics.
        const malformed = byHandle.get(null)
          ?.filter(candidate => writtenInScope(candidate) || namesScope(candidate))
          .reverse().find(candidate => !row || candidate.id > row.id
            || (candidate.id < scoped[0].id && candidate.session_id !== scoped[0].session_id));
        if (malformed) {
          safeParse(malformed.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: malformed.id });
          throw a9PersistenceError('A9_MANAGED_OWNERSHIP_CORRUPT', '无法确认归属记录的句柄');
        }
        if (row) {
          // Round 17 (P1): a complete record of another session in this scope never shadows
          // damaged evidence of this handle from outside it: a record of a session that names
          // this workspace as owner (e.g. the original conversation, rebound elsewhere) or that
          // itself names this workspace. Such damage fails closed whatever comes later.
          // Round 18 (P1): a damaged record attributed to this handle by its salvaged handleId
          // is its own damage whatever its session -- also the only (deduplicated) record of a
          // conversation rebound elsewhere, which neither names this workspace nor shares a
          // session with the scope. A valid foreign record naming the handle stays no evidence.
          const scopeSessions = new Set(candidates!.filter(candidate => belongsToScope(candidate) || namesScope(candidate))
            .map(candidate => candidate.session_id));
          for (const candidate of candidates!) {
            if (belongsToScope(candidate)
              || !(recoveredRows.has(candidate) || namesScope(candidate) || scopeSessions.has(candidate.session_id))) continue;
            try { this.parseManagedOwnership(candidate); }
            catch (error) {
              if ((error as { code?: unknown }).code === 'A9_MANAGED_OWNERSHIP_CORRUPT') throw error;
            }
          }
          // The first in-scope record is the owned anchor; every later record keeps
          // its owner five-tuple and requestId. Arrival order is not authority.
          const anchor = this.parseManagedOwnership(scoped[0]);
          if (anchor.ownershipState !== 'owned') {
            throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '缺少最初有效的持久归属记录');
          }
          let latest = anchor;
          for (const later of scoped.slice(1)) {
            latest = this.parseManagedOwnership(later);
            if (!sameManagedOwner(anchor.owner, latest.owner) || anchor.requestId !== latest.requestId) {
              throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '归属记录与最初归属不一致');
            }
          }
          ownerships.set(handleId, latest);
        } else if (candidates?.length) {
          // Only on a foreign-only claim, check older candidates too. A newer
          // malformed claim must not obscure a previously verified origin.
          // Round 12 (P1): only an origin mismatch (an unrelated foreign claim) is
          // ignorable. A claim that cannot be parsed -- e.g. the original record of a
          // rebound conversation with a damaged schemaVersion -- is damaged evidence
          // for this handle and fails closed; it is never read as "no ownership".
          let damaged: Error | undefined;
          for (const candidate of [...candidates].reverse()) {
            if (!candidate.workspace_path || belongsToScope(candidate)) continue;
            let claim: A9ManagedOwnershipRecord;
            try { claim = this.parseManagedOwnership(candidate); }
            catch (error) { damaged ??= error as Error; continue; }
            try {
              this.assertManagedOwnershipOrigin(candidate.workspace_path!, claim.owner, {
                requireActive: false, previousWorkspace: scope,
              });
            }
            catch (error) {
              // Round 13 (P1): only a claim naming another workspace is an unrelated
              // foreign claim. A claim that names this workspace but whose origin cannot
              // be verified is this handle's own damaged provenance: fail closed.
              if (error instanceof Error && 'code' in error && error.code === 'A9_MANAGED_OWNER_MISMATCH'
                && !namesScope(candidate) && !(scope && sameWorkspacePath(claim.owner.workspace, scope))) continue;
              throw error;
            }
            throw a9PersistenceError('A9_MANAGED_HANDLE_WRONG_OWNER', '句柄属于另一工作区');
          }
          if (damaged) throw damaged;
        }
      } catch (error) {
        if (!onError) throw error;
        onError(handleId, error as Error);
      }
    }
    return ownerships;
  }

  /**
   * ADR-0343: terminal released/user_dismissed facts are verified from their
   * stable history, not from the conversation's current workspace binding.
   * One query returns every tool ownership event of the requested handles plus
   * malformed ownership events, ascending.
   */
  private readManagedOwnershipHistories(handleIds: string[]) {
    const rows = this.db.prepare(`
      SELECT id, session_id, turn_id, payload_json, handle_id, turn_valid, session_known, session_workspace, previous_workspace,
        workspace_history, workdir_origin FROM (
        SELECT e.id, e.session_id, e.turn_id, e.payload_json, e.kind,
          CASE WHEN json_valid(e.payload_json) THEN CASE WHEN json_type(e.payload_json, '$.handleId') = 'text'
            THEN NULLIF(json_extract(e.payload_json, '$.handleId'), '') END END AS handle_id,
          EXISTS (SELECT 1 FROM a9_turns t WHERE t.turn_id = e.turn_id AND t.session_id = e.session_id) AS turn_valid,
          EXISTS (SELECT 1 FROM a9_sessions s WHERE s.session_id = e.session_id) AS session_known,
          (SELECT s.workspace_path FROM a9_sessions s WHERE s.session_id = e.session_id) AS session_workspace,
          (SELECT json_extract(s.metadata_json, '$.workdir.previousWorkspace') FROM a9_sessions s
            WHERE s.session_id = e.session_id AND json_valid(s.metadata_json)) AS previous_workspace,
          (SELECT json_extract(s.metadata_json, '$.workdir.workspaceHistory') FROM a9_sessions s
            WHERE s.session_id = e.session_id AND json_valid(s.metadata_json)) AS workspace_history,
          (SELECT ${WORKDIR_ORIGIN_SQL} FROM a9_sessions s WHERE s.session_id = e.session_id) AS workdir_origin
        FROM a9_events e WHERE e.event_type = 'managed_process_ownership')
      WHERE kind = 'tool' AND (handle_id IS NULL OR handle_id IN (SELECT value FROM json_each(?)))
      ORDER BY id ASC
    `).all(JSON.stringify(handleIds)) as Array<{ id: number; session_id: string; turn_id: string | null; payload_json: string;
      handle_id: string | null; turn_valid: number; session_known: number; session_workspace: string | null;
      previous_workspace: unknown; workspace_history: unknown; workdir_origin: unknown; recovered_handle_ids?: string[] }>;
    const byHandle = new Map<string, typeof rows>();
    const malformed: typeof rows = [];
    for (const row of rows) {
      if (row.handle_id === null) {
        // Round 16 (P1): exactly like the scoped reads (Round 15), a damaged record whose
        // top-level handleId survives is this handle's own history entry, wherever it sits
        // in that history. It joins the handle's list (its parse fails closed) and stays
        // in the unattributable group, marked with the handle it names.
        // Round 17 (P1): including a handleId cut before its closing quote.
        const attributed = damagedPayloadHandleTargets(row.payload_json, handleIds);
        malformed.push({ ...row, recovered_handle_ids: attributed });
        for (const handleId of attributed) {
          const list = byHandle.get(handleId) ?? [];
          list.push({ ...row, handle_id: handleId, recovered_handle_ids: attributed });
          byHandle.set(handleId, list);
        }
        continue;
      }
      const list = byHandle.get(row.handle_id) ?? [];
      list.push(row);
      byHandle.set(row.handle_id, list);
    }
    return { byHandle, malformed };
  }

  /**
   * The first valid tool record is the owned anchor. Every later record keeps its
   * owner and requestId; the session/task/turn origin must still exist, and the
   * anchor workspace must be the fact row's own workspace (stable source).
   */
  private verifyStableManagedHistory(row: { handle_id: string; workspace_path: string },
    histories: ReturnType<A9PersistenceManager['readManagedOwnershipHistories']>, { requireOwnedAnchor = true } = {}) {
    // ADR-0346: a record is a source of this fact's history only when it comes from an
    // unknown session, a session of the fact's own workspace, or names the fact's own
    // workspace as owner (the ADR-0343 relink context). A record of another workspace
    // that merely names the same handleId is neither anchor nor damage.
    const events = (histories.byHandle.get(row.handle_id) ?? []).filter(event => event.session_workspace === null
      || sameWorkspacePath(event.session_workspace, row.workspace_path)
      || namesManagedOwnerWorkspace(event.payload_json, row.workspace_path));
    const parsed = events.map(event => ({ id: event.id, record: this.parseManagedOwnership(event) }));
    const anchor = parsed[0]?.record;
    if (!anchor || (requireOwnedAnchor && anchor.ownershipState !== 'owned')) {
      throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '缺少最初有效的持久归属记录');
    }
    if (!sameWorkspacePath(anchor.owner.workspace, row.workspace_path)) {
      throw a9PersistenceError('A9_MANAGED_HANDLE_WRONG_OWNER', '最初归属与托管事实工作区不符');
    }
    const origin = this.db.prepare(`SELECT 1 FROM a9_sessions s JOIN a9_tasks t ON t.session_id=s.session_id
      JOIN a9_turns tr ON tr.task_id=t.task_id AND tr.session_id=s.session_id
      WHERE s.session_id=? AND t.task_id=? AND tr.turn_id=?`).get(anchor.owner.conversationId, anchor.owner.taskId, anchor.owner.turnId);
    if (!origin) throw a9PersistenceError('A9_MANAGED_OWNER_MISMATCH', '无法验证最初归属的会话与任务');
    for (const { record } of parsed) {
      if (!sameManagedOwner(record.owner, anchor.owner) || record.requestId !== anchor.requestId) {
        throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '归属记录与最初归属不一致');
      }
    }
    const latestId = parsed[parsed.length - 1].id;
    // Unattributable records of the anchor session, or of an unknown session, newer
    // than the history keep it fail-closed exactly like the scoped latest read.
    // Round 16 (P1): a damaged record naming this handle is damage of its history at any
    // position -- an older one followed by complete records is never skipped, even when
    // the truncation hid the owner workspace of a conversation rebound elsewhere.
    // Round 17 (P1): a malformed record of the anchor's own conversation and turn (or with no
    // turn) is damage of this history at any position, even when no handleId is readable.
    // Round 18 (P1): a damaged record naming this handle is its damage whatever its session
    // (e.g. the only record of a conversation rebound elsewhere, with a later anchor of another).
    // Round 19 (P1): an unattributable record of this workspace (an unknown session, a session
    // of this workspace or rebound from it, or a payload naming it) older than the anchor and of
    // another conversation is damage too: a later conversation can never be confirmed as the
    // original anchor over it.
    // Round 20 (P1): "of this workspace" means written while its conversation was bound to it
    // (`workdir.workspaceHistory` event-id segments), not its current or last previous binding:
    // a record of A survives A -> B -> C and a rename, one written in B is never damage of A.
    const malformedInScope = (event: (typeof histories.malformed)[number]) => event.session_known !== 1
      || managedEventWrittenIn(event, event.session_workspace, row.workspace_path)
      || namesManagedOwnerWorkspace(event.payload_json, row.workspace_path);
    // Round 21 (P1): an anonymous record (no handle of this history readable) is damage of this
    // workspace only when written in it: once the anchor's conversation is rebound elsewhere, its
    // newer (or turn-less) records there are never damage of a history kept in this workspace.
    // Round 22 (P1): the anchor's conversation was active in this workspace, so its anonymous
    // record is excluded only when well-formed segments prove it was written outside. A legacy
    // rebind (no segments), damaged segments or damaged session metadata prove nothing: fail closed.
    const provenOutside = (event: (typeof histories.malformed)[number]) => {
      const segments = parseWorkspaceHistory(event.workspace_history);
      return Array.isArray(segments) && segments.length > 0
        && !managedEventWrittenIn(event, event.session_workspace, row.workspace_path);
    };
    // Round 23 (P1): a record is attributable to this history only when it is in scope or not
    // proven written outside this workspace. (1) A record whose salvaged (possibly prefix-only,
    // e.g. `sh-`) handleId names this handle but that segments prove was written in another
    // workspace is that workspace's record, never damage here (ADR-0346). (2) A malformed record
    // of the anchor's own conversation that is attributable is damage at any position and of
    // any turn: an older record of another turn written in A is not skipped.
    const attributable = (event: (typeof histories.malformed)[number]) => malformedInScope(event) || !provenOutside(event);
    const damaged = histories.malformed.find(event => (event.recovered_handle_ids?.includes(row.handle_id) && attributable(event))
      || (malformedInScope(event) && (
        (event.id < parsed[0].id && event.session_id !== events[0].session_id)
        || (event.id > latestId && event.session_known !== 1)))
      || (event.session_id === anchor.owner.conversationId && attributable(event)));
    if (damaged) {
      safeParse(damaged.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: damaged.id });
      throw a9PersistenceError('A9_MANAGED_OWNERSHIP_CORRUPT', '无法确认归属记录的句柄');
    }
    return { anchor, records: parsed.map(item => item.record), latest: parsed[parsed.length - 1].record };
  }

  /** released: owned anchor -> release_intent(R) -> released(R), all one identity. */
  private verifyManagedReleaseHistory(row: { handle_id: string; workspace_path: string },
    histories: ReturnType<A9PersistenceManager['readManagedOwnershipHistories']>): A9ManagedOwnershipRecord {
    const { records, latest } = this.verifyStableManagedHistory(row, histories);
    const receiptIndex = records.findIndex(record => record.ownershipState === 'released');
    const receipt = records[receiptIndex];
    const intent = records[receiptIndex - 1];
    if (!receipt || latest.ownershipState !== 'released' || !intent || intent.ownershipState !== 'release_intent'
      || intent.releaseId !== receipt.releaseId
      || records.slice(receiptIndex).some(record => JSON.stringify(record) !== JSON.stringify(receipt))) {
      throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '释放审计链不完整或不一致');
    }
    return latest;
  }

  /** Recovery revision as it was when the row was still the pending cleanup fact. */
  private managedRecoveryRevision(row: any, ownership: A9ManagedOwnershipRecord, lastProbeStatus = row.last_probe_status) {
    return crypto.createHash('sha256').update(JSON.stringify({ row: { ...row, last_probe_status: lastProbeStatus }, ownership }), 'utf8').digest('hex');
  }

  /**
   * Latest tool disposition record of a handle, before verification. Records are
   * first restricted to trusted sources and only then is the latest chosen, so a
   * record of another workspace (damaged or carrying only this handleId) can neither
   * fail this read nor shadow the legitimate disposition. Trusted sources are the
   * handle's stable owner session (its anchor survives a registry relink, ADR-0343),
   * a session of this fact's workspace, and no known session. A trusted
   * unattributable tool record newer than the match stays fail-closed.
   */
  private readManagedDispositionRow(handleId: string, ownerSessionId: string | undefined = this.managedAnchorSession(handleId)) {
    const rows = this.db.prepare(`SELECT id, session_id, turn_id, payload_json, handle_id, session_workspace FROM (
        SELECT e.id, e.session_id, e.turn_id, e.payload_json,
          CASE WHEN json_valid(e.payload_json) THEN CASE WHEN json_type(e.payload_json, '$.handleId') = 'text'
            THEN NULLIF(json_extract(e.payload_json, '$.handleId'), '') END END AS handle_id,
          (SELECT s.workspace_path FROM a9_sessions s WHERE s.session_id = e.session_id) AS session_workspace
        FROM a9_events e WHERE e.event_type = 'managed_process_disposition' AND e.kind = 'tool')
      WHERE handle_id IS NULL OR handle_id = ? ORDER BY id DESC`).all(handleId) as Array<{ id: number; session_id: string;
      turn_id: string | null; payload_json: string; handle_id: string | null; session_workspace: string | null }>;
    const fact = this.db.prepare('SELECT workspace_path FROM a9_managed_processes WHERE handle_id = ?').get(handleId) as
      { workspace_path: string } | undefined;
    const trusted = (row: (typeof rows)[number]) => row.session_workspace === null
      || (ownerSessionId !== undefined && row.session_id === ownerSessionId)
      || (fact !== undefined && sameWorkspacePath(row.session_workspace, fact.workspace_path));
    const match = rows.find(row => row.handle_id === handleId && trusted(row));
    const damaged = rows.find(row => row.handle_id === null && (!match || row.id > match.id) && trusted(row));
    if (damaged) {
      safeParse(damaged.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: damaged.id });
      throw a9PersistenceError('A9_MANAGED_DISPOSITION_UNCONFIRMED', '本工作区的处置审计记录受损');
    }
    return match && { id: match.id, session_id: match.session_id, turn_id: match.turn_id, payload_json: match.payload_json };
  }

  /**
   * A9-34: a user_dismissed fact is settled only by its own tool disposition record,
   * bound to the original owner/requestId, PID, start time and the pre-dismissal
   * revision. Changing the status text alone settles nothing.
   */
  private verifyManagedDisposition(row: any, ownership: A9ManagedOwnershipRecord) {
    const event = this.readManagedDispositionRow(row.handle_id, ownership.owner.conversationId);
    const payload = event && safeParse(event.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: event.id }) as any;
    if (!event || !payload || payload.schemaVersion !== 1 || payload.disposition !== 'user_attested_after_restart'
      || payload.handleId !== row.handle_id || ownership.ownershipState !== 'owned'
      || event.session_id !== ownership.owner.conversationId || event.turn_id !== ownership.owner.turnId
      || !sameManagedOwner(payload.owner, ownership.owner) || payload.requestId !== ownership.requestId
      || payload.startedAt !== row.started_at || !Number.isSafeInteger(row.pid) || row.pid <= 0
      || payload.pidProbe?.pid !== row.pid || payload.pidProbe?.status !== 'absent'
      || !Number.isFinite(Date.parse(payload.pidProbe?.checkedAt))
      || typeof payload.recoveryRevision !== 'string' || !/^[0-9a-f]{64}$/.test(payload.recoveryRevision)
      || payload.recoveryRevision !== this.managedRecoveryRevision(row, ownership, 'cleanup_required')) {
      throw a9PersistenceError('A9_MANAGED_DISPOSITION_UNCONFIRMED', '已处置事实缺少一致的处置审计');
    }
    return { ...payload, eventId: Number(event.id) } as Record<string, any> & { eventId: number };
  }

  /** 摘要绑定原始行和完整归属；刷新相同事实不推进 revision。 */
  getManagedProcessRecoveryIdentity(handleId: string) {
    const row = this.db.prepare('SELECT * FROM a9_managed_processes WHERE handle_id=?').get(handleId) as any;
    if (!row) throw a9PersistenceError('A9_MANAGED_HANDLE_UNKNOWN', '恢复事实不存在');
    return this.managedRecoveryIdentity(row, this.getManagedOwnership(handleId, row.workspace_path));
  }

  /** Same identity and revision from a row and ownership already read in one batch. */
  private managedRecoveryIdentity(row: any, ownership: A9ManagedOwnershipRecord | undefined) {
    const owner = ownership?.owner;
    if (!owner || !['workspace', 'conversationId', 'taskId', 'turnId', 'toolCallId'].every((key) =>
      typeof owner[key as keyof typeof owner] === 'string' && owner[key as keyof typeof owner].trim())
      || !ownership.requestId || ownership.ownershipState !== 'owned') throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '归属未确认');
    const origin = this.db.prepare(`SELECT s.workspace_path, s.state FROM a9_sessions s JOIN a9_tasks t ON t.session_id=s.session_id
      JOIN a9_turns tr ON tr.task_id=t.task_id AND tr.session_id=s.session_id
      WHERE s.session_id=? AND t.task_id=? AND tr.turn_id=?`).get(owner.conversationId, owner.taskId, owner.turnId) as any;
    if (!origin || origin.state !== 'active' || !sameWorkspacePath(origin.workspace_path, owner.workspace)
      || !sameWorkspacePath(row.workspace_path, owner.workspace)) throw a9PersistenceError('A9_MANAGED_HANDLE_WRONG_OWNER', '原归属不完整或工作区不符');
    return { owner, requestId: ownership.requestId, pid: row.pid as number, startedAt: row.started_at as string,
      lastProbeStatus: row.last_probe_status as string,
      recoveryRevision: crypto.createHash('sha256').update(JSON.stringify({ row, ownership }), 'utf8').digest('hex') };
  }

  /**
   * Session of the first tool ownership record that is a credential of this fact:
   * a complete `owned` record whose owner workspace is the fact row's own workspace
   * and whose session/turn origin exists (ADR-0343 relink keeps it valid). A record
   * that only names the same handleId, or one owned by another workspace, is never
   * an anchor and cannot widen the trusted disposition sources (ADR-0346).
   */
  private managedAnchorSession(handleId: string): string | undefined {
    const fact = this.db.prepare('SELECT workspace_path FROM a9_managed_processes WHERE handle_id = ?').get(handleId) as
      { workspace_path: string } | undefined;
    if (!fact) return undefined;
    const rows = this.db.prepare(`SELECT e.id, e.session_id, e.turn_id, e.payload_json, ? AS handle_id,
        EXISTS (SELECT 1 FROM a9_turns t WHERE t.turn_id = e.turn_id AND t.session_id = e.session_id) AS turn_valid
      FROM a9_events e WHERE e.event_type = 'managed_process_ownership' AND e.kind = 'tool'
        AND json_valid(e.payload_json) AND json_type(e.payload_json, '$.handleId') = 'text' AND json_extract(e.payload_json, '$.handleId') = ?
      ORDER BY e.id ASC`).all(handleId, handleId) as Array<{ id: number; session_id: string; turn_id: string | null;
      payload_json: string; handle_id: string; turn_valid: number }>;
    for (const row of rows) {
      let record: A9ManagedOwnershipRecord;
      try { record = this.parseManagedOwnership(row); }
      catch (error) {
        if (error instanceof Error && 'code' in error && String(error.code).startsWith('A9_MANAGED_')) continue;
        throw error;
      }
      if (record.ownershipState !== 'owned' || !sameWorkspacePath(record.owner.workspace, fact.workspace_path)) continue;
      const origin = this.db.prepare(`SELECT 1 FROM a9_tasks t JOIN a9_turns tr ON tr.task_id = t.task_id AND tr.session_id = t.session_id
        WHERE t.session_id = ? AND t.task_id = ? AND tr.turn_id = ?`).get(row.session_id, record.owner.taskId, record.owner.turnId);
      if (origin) return row.session_id;
    }
    return undefined;
  }

  /** Latest tool disposition record as stored; listManagedProcesses verifies it before it settles a fact. */
  getManagedProcessDisposition(handleId: string): (Record<string, any> & { eventId: number }) | undefined {
    const row = this.readManagedDispositionRow(handleId);
    if (!row) return undefined;
    return { ...(safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: row.id }) as Record<string, any>), eventId: Number(row.id) };
  }

  /** 必需事件与处置状态原子提交；不变更 ownership 或声明清理成功。 */
  dismissRecoveredManagedProcess(input: {
    workspace: string; conversationId: string; lockOwnerId: string; handleId: string; recoveryRevision: string;
    identity?: { owner: Record<string, string>; requestId?: string; pid?: number; startedAt: string };
    pidProbe?: { pid: number; status: string; checkedAt: string };
  }) {
    return this.db.transaction(() => {
      const lock = this.db.prepare('SELECT owner_id FROM a9_workspace_locks WHERE workspace_path=?').get(input.workspace) as any;
      if (lock?.owner_id !== input.lockOwnerId) throw a9PersistenceError('A9_WORKSPACE_LOCKED', '当前窗口未持有工作区锁');
      const current = this.getManagedProcessRecoveryIdentity(input.handleId);
      if (current.owner.workspace !== input.workspace || current.owner.conversationId !== input.conversationId) throw a9PersistenceError('A9_MANAGED_HANDLE_WRONG_OWNER', '仅允许当前工作区及对话');
      const previous = this.getManagedProcessDisposition(input.handleId);
      if (previous) {
        // Idempotent retry: the same original revision, and the stored record must
        // still verify against the persisted owner, PID, start time and status.
        let verified: Record<string, any> | undefined;
        try {
          const row = this.db.prepare('SELECT * FROM a9_managed_processes WHERE handle_id=?').get(input.handleId) as any;
          verified = current.lastProbeStatus === 'user_dismissed'
            ? this.verifyManagedDisposition(row, this.getManagedOwnership(input.handleId, row.workspace_path)!) : undefined;
        } catch { verified = undefined; }
        if (!verified || verified.eventId !== previous.eventId || previous.recoveryRevision !== input.recoveryRevision
          || !sameManagedOwner(previous.owner, current.owner) || previous.requestId !== current.requestId
          || previous.pidProbe?.pid !== current.pid || previous.startedAt !== current.startedAt) throw a9PersistenceError('A9_MANAGED_RECOVERY_STALE', '处置身份已变化');
        return previous;
      }
      if (current.recoveryRevision !== input.recoveryRevision) throw a9PersistenceError('A9_MANAGED_RECOVERY_STALE', '恢复事实已变化');
      if (current.lastProbeStatus !== 'cleanup_required') throw a9PersistenceError('A9_MANAGED_NOT_RECOVERED_CLEANUP', '不是待处置恢复事实');
      const identity = input.identity;
      if (!identity || JSON.stringify(identity.owner) !== JSON.stringify(current.owner) || identity.requestId !== current.requestId
        || identity.pid !== current.pid || identity.startedAt !== current.startedAt) throw a9PersistenceError('A9_MANAGED_RECOVERY_STALE', '内存与持久化身份不符');
      if (!Number.isSafeInteger(current.pid) || current.pid <= 0 || input.pidProbe?.pid !== current.pid
        || input.pidProbe.status !== 'absent' || !Number.isFinite(Date.parse(input.pidProbe.checkedAt))) throw a9PersistenceError('A9_MANAGED_PID_PROBE_UNKNOWN', '缺少 PID 不存在的探测事实');
      const disposition = { schemaVersion: 1, disposition: 'user_attested_after_restart', owner: current.owner,
        handleId: input.handleId, requestId: current.requestId, startedAt: current.startedAt, recoveryRevision: input.recoveryRevision,
        disposedAt: new Date().toISOString(), pidProbe: input.pidProbe };
      const updated = this.db.prepare("UPDATE a9_managed_processes SET last_probe_status='user_dismissed' WHERE handle_id=? AND last_probe_status='cleanup_required'")
        .run(input.handleId);
      // Both the fact update and the required event must produce their row; any
      // ignored write throws and rolls the whole disposition back.
      assertWrittenRows(updated, 1, 'A9-34 disposition fact');
      const event = this.recordToolEvent(current.owner.conversationId, current.owner.turnId, 'managed_process_disposition', disposition);
      return { ...disposition, ...event };
    })();
  }

  listManagedProcesses(workspacePath: string, options: {
    includeOwnership?: true | 'recovery'; onOwnershipError?: (handleId: string, error: Error) => void;
    includeRecoveryIdentity?: boolean;
  } = {}): Array<{
    handleId: string; pid: number | null; command: string; cwd: string;
    startedAt: string; lastProbeStatus: string | null; pidReusePossible: boolean; cleanupRequired: boolean;
    ownership?: A9ManagedOwnershipRecord;
    recoveryIdentity?: { recoveryRevision: string } | { errorCode: string };
    disposition?: Record<string, any> & { eventId: number };
  }> {
    // One read transaction: in WAL mode the facts and their ownership/history reads
    // share one snapshot, so a commit from another connection between the statements
    // can never pair an old fact with a new ownership (or the reverse).
    return this.db.transaction(() => this.readManagedProcessList(workspacePath, options))();
  }

  private readManagedProcessList(workspacePath: string, options: {
    includeOwnership?: true | 'recovery'; onOwnershipError?: (handleId: string, error: Error) => void;
    includeRecoveryIdentity?: boolean;
  }): Array<{
    handleId: string; pid: number | null; command: string; cwd: string;
    startedAt: string; lastProbeStatus: string | null; pidReusePossible: boolean; cleanupRequired: boolean;
    ownership?: A9ManagedOwnershipRecord;
    recoveryIdentity?: { recoveryRevision: string } | { errorCode: string };
    disposition?: Record<string, any> & { eventId: number };
  }> {
    // Legacy facts retain the selected display path. Windows spelling changes must
    // not hide cleanup/recovery facts; compare path keys before loading their rows.
    const workspaceKeys = process.platform === 'win32'
      ? (this.db.prepare('SELECT DISTINCT workspace_path FROM a9_managed_processes').all() as Array<{ workspace_path: string }>)
        .filter((row) => sameWorkspacePath(row.workspace_path, workspacePath)).map((row) => row.workspace_path)
      : [workspacePath];
    const query = this.db.prepare('SELECT * FROM a9_managed_processes WHERE workspace_path = ?');
    const rows = workspaceKeys.flatMap((key) => query.all(key) as any[]);
    const needsRecovery = (row: any) =>
      ['starting', 'running', 'running_unknown', 'identity_mismatch', 'cleanup_required'].includes(row.last_probe_status);
    // released and user_dismissed settle cleanup only through their stable history.
    const settlesByHistory = (row: any) => ['released', 'user_dismissed'].includes(row.last_probe_status);
    // Active facts keep the scoped origin check: the conversation may not have moved.
    const activeIds = new Set(rows.filter(needsRecovery).map(row => row.handle_id as string));
    // Ordinary terminal facts share the same single batch read in both modes: the
    // Shell pre-checks (leave, new conversation, mode change) read 'recovery' and must
    // see the same release_unknown / release_intent conflicts as the final lock check.
    const terminalIds = new Set(rows.filter(row => Boolean(options.includeOwnership) && !needsRecovery(row) && !settlesByHistory(row))
      .map(row => row.handle_id as string));
    const corrupted = new Set<string>();
    const onError = options.onOwnershipError && ((handleId: string, error: Error) => {
      corrupted.add(handleId);
      options.onOwnershipError!(handleId, error);
    });
    const report = (handleId: string, error: Error) => { if (!onError) throw error; onError(handleId, error); };
    // A terminal fact's scoped miss is re-read from its stable history below: a
    // legitimate registry relink or rename changes the conversation's current
    // workspace, never the fact's own historical ownership.
    const deferred = new Map<string, Error>();
    const scopedIds = [...activeIds, ...terminalIds];
    const ownerships = scopedIds.length
      ? this.listManagedOwnerships(scopedIds, (handleId, error) => {
        // Round 16 (P1): a damaged payload is unrecoverable, never a scoped miss: it is
        // reported now and can never be laundered by the stable-history fallback.
        const corrupt = (error as { code?: unknown }).code === 'A9_MANAGED_OWNERSHIP_CORRUPT';
        if (terminalIds.has(handleId) && !corrupt) deferred.set(handleId, error); else report(handleId, error);
      }, workspacePath)
      : new Map<string, A9ManagedOwnershipRecord>();
    for (const handleId of activeIds) {
      const ownership = ownerships.get(handleId);
      if (!ownership) continue;
      try {
        if (ownership.ownershipState === 'released') {
          throw a9PersistenceError('A9_MANAGED_OWNERSHIP_UNCONFIRMED', '探测事实与释放归属冲突');
        }
        if (options.includeOwnership === 'recovery') this.assertManagedOwnershipOrigin(workspacePath, ownership.owner);
      } catch (error) {
        ownerships.delete(handleId);
        report(handleId, error as Error);
      }
    }
    // released and user_dismissed settle cleanup only through their stable history.
    // Round 17 (P1): an ordinary terminal fact (stopped, exited, ...) whose scoped read found an
    // ownership is verified against its stable history too: a later record of another session
    // must never hide older damage of the handle. A legacy handle -- the scoped read found
    // neither an ownership nor any record or damage of this scope -- settles without ownership
    // and needs no second read (it would find no anchor and no damage of its own either).
    const historyRows = rows.filter(row => settlesByHistory(row) || deferred.has(row.handle_id)
      || (terminalIds.has(row.handle_id) && ownerships.has(row.handle_id)));
    const histories = historyRows.length ? this.readManagedOwnershipHistories(historyRows.map(row => row.handle_id)) : null;
    const dispositions = new Map<string, Record<string, any> & { eventId: number }>();
    for (const row of historyRows) {
      const handleId = row.handle_id as string;
      try {
        if (row.last_probe_status === 'released') {
          ownerships.set(handleId, this.verifyManagedReleaseHistory(row, histories!));
          continue;
        }
        const { latest } = this.verifyStableManagedHistory(row, histories!, { requireOwnedAnchor: settlesByHistory(row) });
        if (row.last_probe_status === 'user_dismissed') dispositions.set(handleId, this.verifyManagedDisposition(row, latest));
        ownerships.set(handleId, latest);
      } catch (error) {
        // Round 16 (P1): every failed history verification blocks, whatever the status;
        // a damaged history is reported as such rather than as the deferred scoped miss.
        corrupted.add(handleId);
        ownerships.delete(handleId);
        const corrupt = (error as { code?: unknown }).code === 'A9_MANAGED_OWNERSHIP_CORRUPT';
        report(handleId, (corrupt ? error : deferred.get(handleId) ?? error) as Error);
      }
    }
    const recoveryIdentity = (r: any) => {
      if (!options.includeRecoveryIdentity || r.last_probe_status !== 'cleanup_required' || corrupted.has(r.handle_id)) return {};
      try { return { recoveryIdentity: { recoveryRevision: this.managedRecoveryIdentity(r, ownerships.get(r.handle_id)).recoveryRevision } }; }
      catch (error) { return { recoveryIdentity: { errorCode: String((error as { code?: unknown }).code || 'A9_MANAGED_DISPOSITION_UNAVAILABLE') } }; }
    };
    return rows.map((r) => ({
      ...(options.includeOwnership && ownerships.has(r.handle_id) ? { ownership: ownerships.get(r.handle_id) } : {}),
      ...recoveryIdentity(r),
      ...(dispositions.has(r.handle_id) ? { disposition: dispositions.get(r.handle_id) } : {}),
      handleId: r.handle_id,
      pid: r.pid,
      command: r.command,
      cwd: r.cwd,
      startedAt: r.started_at,
      lastProbeStatus: r.last_probe_status,
      pidReusePossible: r.pid_reuse_possible === 1,
      cleanupRequired: r.last_probe_status === 'cleanup_required'
        || (settlesByHistory(r) && corrupted.has(r.handle_id))
        || (needsRecovery(r) && (corrupted.has(r.handle_id) || ownerships.has(r.handle_id))),
    }));
  }

  // ---------------------------------------------------------------------
  // 事件与保留策略
  // ---------------------------------------------------------------------

  recordModelEvent(sessionId: string, turnId: string | null, eventType: string, payload: Record<string, unknown>): { eventId: number } {
    return this.insertEvent(sessionId, turnId, 'model', eventType, payload);
  }

  recordToolEvent(sessionId: string, turnId: string | null, eventType: string, payload: Record<string, unknown>): { eventId: number } {
    if (eventType === 'tool_output') {
      const d = payload.data as Record<string, unknown> | undefined;
      if (!d || d.schemaVersion !== 1 || d.conversationId !== sessionId || d.turnId !== turnId
        || typeof d.taskId !== 'string' || !d.taskId || typeof d.toolCallId !== 'string' || !d.toolCallId
        || typeof d.requestId !== 'string' || !d.requestId || !['stdout', 'stderr'].includes(String(d.stream))
        || typeof d.text !== 'string' || Buffer.byteLength(d.text) > 64 * 1024
        || !Number.isSafeInteger(d.outputSeq) || Number(d.outputSeq) < 1
        || !Number.isSafeInteger(d.sourceSeqThrough) || Number(d.sourceSeqThrough) < 0
        || !Number.isSafeInteger(d.rawBytesRead) || Number(d.rawBytesRead) < 0 || typeof d.truncated !== 'boolean') {
        throw new Error('A9_OUTPUT_EVENT_INVALID');
      }
      // The runtime is the unique writer; transaction binds sequence checks and insertion.
      return this.db.transaction(() => {
        const row = this.db.prepare("SELECT id, payload_json FROM a9_events WHERE session_id = ? AND turn_id = ? AND event_type = 'tool_output' AND json_extract(payload_json, '$.data.toolCallId') = ? ORDER BY id DESC LIMIT 1").get(sessionId, turnId, d.toolCallId) as { id: number; payload_json: string } | undefined;
        const previous = row ? (safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: row.id }) as any)?.data : undefined;
        if (Number(d.outputSeq) !== Number(previous?.outputSeq ?? 0) + 1 || (previous && (previous.requestId !== d.requestId || previous.taskId !== d.taskId))) throw new Error('A9_OUTPUT_EVENT_SEQUENCE');
        return this.insertEvent(sessionId, turnId, 'tool', eventType, payload);
      })();
    }
    return this.insertEvent(sessionId, turnId, 'tool', eventType, payload);
  }

  private insertEvent(sessionId: string, turnId: string | null, kind: 'model' | 'tool', eventType: string, payload: Record<string, unknown>): { eventId: number } {
    const info = this.db.prepare(`
      INSERT INTO a9_events (session_id, turn_id, kind, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, turnId, kind, eventType, JSON.stringify(payload), new Date().toISOString());
    // A trigger with RAISE(IGNORE) reports success with zero rows; an audit event
    // that produced no row is a failed write and rolls back its transaction.
    assertWrittenRows(info, 1, 'A9 event');
    return { eventId: Number(info.lastInsertRowid) };
  }

  /**
   * ADR-0114：按会话有界查询事件（id 升序）。eventId 即 a9_events 行 id
   * （AUTOINCREMENT），跨重启稳定，供 UI 过程回看与游标分页（beforeEventId）。
   * limit 夹紧 [1,1000]；返回过滤集中最新的 limit 条（升序输出）——无游标时即
   * 会话尾部窗口，带游标时为紧邻游标之前的上一页。payload_json 解析失败返回 null。
   */
  listSessionEvents(
    sessionId: string,
    options: { turnId?: string; beforeEventId?: number; limit?: number } = {},
  ): Array<{
    eventId: number;
    turnId: string | null;
    kind: string;
    eventType: string;
    payload: Record<string, unknown> | null;
    createdAt: string;
  }> {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 200), 1000));
    const clauses = ['session_id = ?'];
    const params: Array<string | number> = [sessionId];
    if (options.turnId !== undefined) {
      clauses.push('turn_id = ?');
      params.push(options.turnId);
    }
    if (options.beforeEventId !== undefined && Number.isFinite(options.beforeEventId)) {
      clauses.push('id < ?');
      params.push(Math.floor(options.beforeEventId));
    }
    const rows = this.db.prepare(`
      SELECT id, turn_id, kind, event_type, payload_json, created_at FROM a9_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params, limit) as any[];
    return rows.reverse().map((row) => {
      return {
        eventId: Number(row.id),
        turnId: row.turn_id ?? null,
        kind: row.kind,
        eventType: row.event_type,
        payload: safeParse(row.payload_json, { buffer: this.diagnosticBuffer, table: 'a9_events', rowId: row.id }) as Record<string, unknown> | null,
        createdAt: row.created_at,
      };
    });
  }

  /**
   * 保留策略：删除超过保留期的已结束事件；活动 checkpoint 与审批不删。
   */
  enforceRetention(now: Date = new Date()): { purgedEvents: number } {
    const cutoff = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    // ADR-0343: ownership and disposition tool records of a handle that still has a
    // managed fact row are the evidence that settles or authorizes that fact. They
    // stay while the row exists; every other expired event is purged as before.
    const info = this.db.prepare(`DELETE FROM a9_events WHERE created_at < ? AND NOT (
      kind = 'tool' AND event_type IN ('managed_process_ownership', 'managed_process_disposition')
      AND EXISTS (SELECT 1 FROM a9_managed_processes m WHERE m.handle_id =
        CASE WHEN json_valid(a9_events.payload_json) THEN CASE WHEN json_type(a9_events.payload_json, '$.handleId') = 'text'
          THEN json_extract(a9_events.payload_json, '$.handleId') END END))`).run(cutoff);
    return { purgedEvents: Number(info.changes ?? 0) };
  }

  countEvents(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM a9_events').get() as any).n;
  }

  // ---------------------------------------------------------------------
  // 单写锁（同一工作区）
  // ---------------------------------------------------------------------

  acquireWorkspaceLock(
    workspacePath: string,
    ownerId: string,
    options: { holderIsAlive?: (holderId: string) => boolean | undefined; now?: Date } = {},
  ): { acquired: boolean; holder?: string; acquiredAt?: string } {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const acquire = this.db.transaction(() => {
      const row = this.db.prepare('SELECT owner_id, heartbeat_at FROM a9_workspace_locks WHERE workspace_path = ?').get(workspacePath) as any;
      if (!row) {
        this.db.prepare(`
          INSERT INTO a9_workspace_locks (workspace_path, owner_id, acquired_at, heartbeat_at)
          VALUES (?, ?, ?, ?)
        `).run(workspacePath, ownerId, nowIso, nowIso);
        return { acquired: true, holder: ownerId, acquiredAt: nowIso };
      }
      if (row.owner_id === ownerId) {
        this.db.prepare('UPDATE a9_workspace_locks SET heartbeat_at = ? WHERE workspace_path = ? AND owner_id = ?')
          .run(nowIso, workspacePath, ownerId);
        return { acquired: true, holder: ownerId, acquiredAt: row.heartbeat_at as string };
      }

      const heartbeat = new Date(row.heartbeat_at as string);
      const heartbeatAge = now.getTime() - heartbeat.getTime();
      const expired = !Number.isFinite(heartbeat.getTime()) || heartbeatAge >= 15 * 60 * 1000;
      // Immediate takeover is allowed only when the caller can positively prove
      // the exact recorded owner is dead. Unknown/permission-denied results are
      // represented by undefined and remain fail-closed until normal expiry.
      const holderAlive = typeof options.holderIsAlive === 'function'
        ? options.holderIsAlive(String(row.owner_id))
        : undefined;
      if (!expired && holderAlive !== false) {
        return { acquired: false, holder: row.owner_id as string, acquiredAt: row.heartbeat_at as string };
      }

      const replaced = this.db.prepare(`
        UPDATE a9_workspace_locks
        SET owner_id = ?, acquired_at = ?, heartbeat_at = ?
        WHERE workspace_path = ? AND owner_id = ? AND heartbeat_at = ?
      `).run(ownerId, nowIso, nowIso, workspacePath, row.owner_id, row.heartbeat_at);
      if (Number(replaced.changes ?? 0) === 1) {
        return { acquired: true, holder: ownerId, acquiredAt: nowIso };
      }
      const current = this.db.prepare('SELECT owner_id, heartbeat_at FROM a9_workspace_locks WHERE workspace_path = ?').get(workspacePath) as any;
      return {
        acquired: false,
        ...(current ? { holder: current.owner_id as string, acquiredAt: current.heartbeat_at as string } : {}),
      };
    });
    return acquire();
  }

  /** Returns released=false when this owner's row is still present after the DELETE. */
  releaseWorkspaceLock(workspacePath: string, ownerId: string): { released: boolean; blockers: string[]; reason?: string } {
    return this.deleteOwnedWorkspaceLock(workspacePath, ownerId);
  }

  /**
   * A DELETE can report zero rows while the row survives (for example a trigger with
   * RAISE(IGNORE)). Success is only that this owner's row is gone afterwards.
   */
  private deleteOwnedWorkspaceLock(workspacePath: string, ownerId: string): { released: boolean; blockers: string[]; reason?: string } {
    this.db.prepare('DELETE FROM a9_workspace_locks WHERE workspace_path = ? AND owner_id = ?').run(workspacePath, ownerId);
    const remaining = this.db.prepare('SELECT 1 FROM a9_workspace_locks WHERE workspace_path = ? AND owner_id = ?').get(workspacePath, ownerId);
    return remaining
      ? { released: false, blockers: [], reason: 'A9_WORKSPACE_LOCK_RELEASE_UNCONFIRMED' }
      : { released: true, blockers: [] };
  }

  /**
   * The single activity criterion for listed managed facts (ADR-0343/ADR-0344): a
   * cleanup-pending fact or an active status blocks lock release and, in the Runtime,
   * switching. ADR-0343: an unowned active fact committed after the in-memory checks
   * (even without any in-memory handle) still blocks. Only a legacy direct-spawn handle
   * the Runner itself left to the system keeps its running row for the next startup
   * probe, and only that exact unowned identity (handleId, PID, start time) is exempt.
   */
  isManagedSettlementBlocker(fact: { handleId: string; pid: number | null; startedAt: string; lastProbeStatus: string | null;
    cleanupRequired: boolean; ownership?: unknown },
  handedOver: Array<{ handleId: string; pid: number | null; startedAt: string }> = []): boolean {
    if (fact.cleanupRequired) return true;
    // Only a known settled terminal status releases; NULL or an unknown status never does.
    // A settled status releases only when its ownership agrees: a release whose outcome
    // is unknown or still pending, or a status/ownership conflict, keeps blocking.
    if (MANAGED_SETTLED_STATUSES.includes(fact.lastProbeStatus ?? '')) {
      return fact.ownership !== undefined && fact.ownership !== null
        && managedSettledOwnershipConflict(fact.lastProbeStatus ?? '', fact.ownership);
    }
    if (!MANAGED_ACTIVE_STATUSES.includes(fact.lastProbeStatus ?? '')) return true;
    const handover = handedOver.find(item => item.handleId === fact.handleId);
    return !(!fact.ownership && handover && handover.pid === (fact.pid ?? null) && handover.startedAt === fact.startedAt
      && ['starting', 'running'].includes(fact.lastProbeStatus ?? ''));
  }

  /**
   * Final shutdown release. Managed facts that block release or recovery are read
   * again inside the same IMMEDIATE transaction that deletes this owner's lock row,
   * so a write committed after any earlier check keeps the lock.
   */
  releaseWorkspaceLockIfManagedSettled(workspacePath: string, ownerId: string, managedWorkspacePath: string,
    options: { handedOver?: Array<{ handleId: string; pid: number | null; startedAt: string }> } = {}):
    { released: boolean; blockers: string[]; reason?: string } {
    type Outcome = { released: boolean; blockers: string[]; reason?: string };
    const release = this.db.transaction((): Outcome => {
      const lock = this.db.prepare('SELECT owner_id FROM a9_workspace_locks WHERE workspace_path = ?').get(workspacePath) as any;
      if (lock?.owner_id !== ownerId) return { released: true, blockers: [] };
      const blockers = new Set<string>();
      // includeOwnership: true also verifies ordinary terminal ownership; every
      // ownership error keeps the lock.
      for (const fact of this.listManagedProcesses(managedWorkspacePath, {
        includeOwnership: true, onOwnershipError: (handleId) => { blockers.add(handleId); },
      })) {
        if (this.isManagedSettlementBlocker(fact, options.handedOver)) blockers.add(fact.handleId);
      }
      if (blockers.size) return { released: false, blockers: [...blockers] };
      return this.deleteOwnedWorkspaceLock(workspacePath, ownerId);
    }) as (() => Outcome) & { immediate?: () => Outcome };
    return (release.immediate ?? release)();
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function a8TablesPresent(db: SqliteDatabase): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='a8_workspaces'").get();
    return Boolean(row);
  } catch (_err) {
    throw a9PersistenceError('A9_SQLITE_PROBE_FAILED', 'A8 table probe failed');
  }
}

function a9BusinessTablesPresent(db: SqliteDatabase): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'a9_%' AND name <> 'a9_meta' LIMIT 1",
  ).get();
  return Boolean(row);
}

function classifyA9SchemaV4(db: SqliteDatabase): A9SchemaV4Profile {
  try {
    assertA9CurrentSchema(db, 'canonical');
    return 'canonical';
  } catch (canonicalError) {
    try {
      assertA9CurrentSchema(db, 'win7_19_legacy');
      return 'win7_19_legacy';
    } catch (_legacyError) {
      throw canonicalError;
    }
  }
}

/** Read-only exact profile inspection used by the packaged WIN7-21 evidence verifier. */
export function inspectA9SchemaV4Profile(db: SqliteDatabase): A9SchemaV4Profile {
  return classifyA9SchemaV4(db);
}

function assertA9CurrentSchema(db: SqliteDatabase, profile: A9SchemaV4Profile = 'canonical'): void {
  const quickCheck = db.prepare('PRAGMA quick_check').all() as any[];
  if (quickCheck.length !== 1 || Object.values(quickCheck[0] ?? {}).length !== 1
    || Object.values(quickCheck[0] ?? {})[0] !== 'ok') {
    throw new Error(`A9 schema v4 ${profile} profile failed SQLite quick_check`);
  }
  // Normalize only spelling/formatting noise, then pin every CREATE TABLE
  // contract. This rejects extra CHECK/COLLATE/FOREIGN KEY/UNIQUE/generated
  // clauses that PRAGMA table_info cannot fully describe.
  const expectedTableSignatures: Record<string, string> = {
    a9_approvals: '75e7f06f504e20b5ed99058e402df27111b949b02ce45ce134362a1fc2af31d8',
    a9_checkpoints: 'b1749c7a64617a79e10135787ea3bc188860db1226a68cc22615b1fdd732e5ed',
    a9_events: '2b98925a1c0f4a530d22b413717cd2b0376b0659e8b9e9daebdaf24fce4205fc',
    a9_managed_processes: 'ba196e756b7f88f7eff4d3f12794f2188b7ebf2f24314d366bb60ace5bdaadcd',
    a9_meta: 'ffbb428eb68b53f007b53cb9b6472a6890a8d7acfc63c8aa45e74ed5fb77c02b',
    a9_runs: 'de0969dc3c1521c7e7d9141b95fadf6e39ad004a0f6b1409c4a28ebed5606fce',
    a9_sessions: profile === 'canonical'
      ? '100f6f987ef676263c8cff5b4987c97bb44c267228c96669c0b4999006ec9f6c'
      : '19af696cd314930ef840219a4dd6db66e461ee9cdbc97cdf7325bd29a44a1de7',
    a9_tasks: '36945b33ae1f4420c2e3dce9ac072c9fe3eff4dfd1cb2a32128fec43faefdbfc',
    a9_turns: '60893760fe967f9d3df5ae7c1f321201198c0c08981ce7d7ea4bd6e928962b8f',
    a9_workspace_conversation_state: '9e1678683ce9281ff7b1458a95c018dd529f20d32c22de8da0ef71ce19d65ece',
    a9_workspace_locks: '2e22a2a25cec2b7d0430eec57802d257645b5aee5389aa0a12e6c71097fa4a5e',
    a9_workspaces: '5dfe37cf02091737a2ec47132d61128a17a88e3e2ff8d8048c852f1f5d02ace6',
  };
  const required: Record<string, string[]> = {
    a9_meta: ['id', 'schema_version', 'created_at', 'updated_at'],
    a9_workspaces: ['workspace_path', 'display_name', 'permission_mode', 'created_at', 'updated_at'],
    a9_sessions: ['session_id', 'workspace_path', 'title', 'title_source', 'state', 'created_at', 'updated_at', 'last_activated_at', 'draft_ciphertext', 'metadata_json'],
    a9_workspace_conversation_state: ['workspace_path', 'active_session_id', 'updated_at'],
    a9_tasks: ['task_id', 'session_id', 'status', 'created_at', 'updated_at'],
    a9_turns: ['turn_id', 'task_id', 'session_id', 'status', 'outcome_json', 'created_at', 'updated_at'],
    a9_runs: ['run_id', 'turn_id', 'session_id', 'status', 'created_at', 'updated_at'],
    a9_checkpoints: ['turn_id', 'session_id', 'created_at', 'payload_json'],
    a9_approvals: ['approval_id', 'session_id', 'turn_id', 'tool_name', 'binding_json', 'decision', 'decided_at', 'created_at'],
    a9_managed_processes: ['handle_id', 'workspace_path', 'pid', 'command', 'cwd', 'started_at', 'last_probe_status', 'pid_reuse_possible'],
    a9_events: ['id', 'session_id', 'turn_id', 'kind', 'event_type', 'payload_json', 'created_at'],
    a9_workspace_locks: ['workspace_path', 'owner_id', 'acquired_at', 'heartbeat_at'],
  };
  for (const [table, columns] of Object.entries(required)) {
    if (!tablePresent(db, table)) throw new Error(`A9 schema v4 is missing table ${table}`);
    const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    const present = new Set(tableInfo.map((row) => row.name)
      .filter((name): name is string => typeof name === 'string'));
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length > 0) throw new Error(`A9 schema v4 table ${table} is missing columns: ${missing.join(', ')}`);
  }

  const primaryKeys: Record<string, string> = {
    a9_meta: 'id',
    a9_workspaces: 'workspace_path',
    a9_sessions: 'session_id',
    a9_workspace_conversation_state: 'workspace_path',
    a9_tasks: 'task_id',
    a9_turns: 'turn_id',
    a9_runs: 'run_id',
    a9_checkpoints: 'turn_id',
    a9_approvals: 'approval_id',
    a9_managed_processes: 'handle_id',
    a9_events: 'id',
    a9_workspace_locks: 'workspace_path',
  };
  for (const [table, column] of Object.entries(primaryKeys)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!info.some((row) => row.name === column && Number(row.pk) > 0)) {
      throw new Error(`A9 schema v4 table ${table} is missing primary key on ${column}`);
    }
    if (db.prepare(`SELECT 1 AS invalid FROM ${table} WHERE ${column} IS NULL LIMIT 1`).get()) {
      throw new Error(`A9 schema v4 table ${table} contains a null primary identity`);
    }
  }

  const integerColumns = new Set(['a9_meta.id', 'a9_meta.schema_version', 'a9_managed_processes.pid',
    'a9_managed_processes.pid_reuse_possible', 'a9_events.id']);
  const nullableColumns = new Set(['a9_sessions.draft_ciphertext', 'a9_approvals.turn_id', 'a9_approvals.decided_at',
    'a9_managed_processes.pid', 'a9_managed_processes.last_probe_status', 'a9_events.turn_id']);
  if (profile === 'win7_19_legacy') nullableColumns.add('a9_sessions.last_activated_at');
  for (const [table, columns] of Object.entries(required)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    for (const column of columns) {
      const row = info.find((item) => item.name === column);
      const identity = `${table}.${column}`;
      const expectedType = integerColumns.has(identity) ? 'INTEGER' : 'TEXT';
      if (String(row?.type ?? '').toUpperCase() !== expectedType) {
        throw new Error(`A9 schema v4 column ${identity} has the wrong type`);
      }
      if (!nullableColumns.has(identity) && primaryKeys[table] !== column && Number(row?.notnull) !== 1) {
        throw new Error(`A9 schema v4 column ${identity} must be NOT NULL`);
      }
    }
  }

  const defaults: Record<string, string> = {
    'a9_sessions.title': "'新对话'",
    'a9_sessions.title_source': profile === 'win7_19_legacy' ? "'legacy'" : "'auto'",
    'a9_sessions.state': "'active'",
    'a9_sessions.metadata_json': "'{}'",
    'a9_turns.outcome_json': "'{}'",
    'a9_managed_processes.pid_reuse_possible': '0',
  };
  for (const [identity, expected] of Object.entries(defaults)) {
    const [table, column] = identity.split('.');
    const row = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).find((item) => item.name === column);
    if (String(row?.dflt_value ?? '') !== expected) {
      throw new Error(`A9 schema v4 column ${identity} has the wrong default`);
    }
  }

  // 两个受支持的 v4 profile 都必须精确匹配整套 A9 表和列合同。
  // WIN7-19 的 v4 来自对 v3 表执行 ALTER TABLE，追加列顺序也是该
  // 历史 profile 身份的一部分；不要把其他“近似 v4”带入修复路径。
  const profileColumns: Record<string, string[]> = profile === 'win7_19_legacy' ? { ...required, a9_sessions: [
      'session_id', 'workspace_path', 'created_at', 'updated_at', 'metadata_json',
      'title', 'title_source', 'state', 'last_activated_at', 'draft_ciphertext',
    ] } : required;
  const actualTables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'a9_%' ORDER BY name",
  ).all() as any[]).map((row) => row.name);
  const expectedTables = Object.keys(profileColumns).sort();
  if (actualTables.length !== expectedTables.length
    || actualTables.some((name, index) => name !== expectedTables[index])) {
    throw new Error(`A9 schema v4 ${profile} profile has unexpected A9 tables`);
  }
  for (const [table, signature] of Object.entries(expectedTableSignatures)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as any;
    const normalized = String(row?.sql ?? '').toLowerCase()
      .replace(/if\s+not\s+exists/g, '').replace(/[\s"`\[\];]+/g, '');
    const actual = crypto.createHash('sha256').update(normalized).digest('hex');
    if (actual !== signature) {
      throw new Error(`A9 schema v4 ${profile} profile has unexpected ${table} table contract`);
    }
  }
  for (const [table, expectedColumns] of Object.entries(profileColumns)) {
    const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    const actualColumns = tableInfo.map((row) => row.name);
    if (actualColumns.length !== expectedColumns.length
      || actualColumns.some((name, index) => name !== expectedColumns[index])) {
      throw new Error(`A9 schema v4 ${profile} profile has unexpected ${table} columns`);
    }
    for (const row of tableInfo) {
      const identity = `${table}.${String(row.name)}`;
      const expectedNotNull = primaryKeys[table] === row.name || nullableColumns.has(identity) ? 0 : 1;
      const expectedDefault = Object.prototype.hasOwnProperty.call(defaults, identity) ? defaults[identity] : null;
      if (Number(row.pk) !== (primaryKeys[table] === row.name ? 1 : 0)
        || Number(row.notnull) !== expectedNotNull
        || (row.dflt_value ?? null) !== expectedDefault) {
        throw new Error(`A9 schema v4 ${profile} profile has unexpected ${identity} contract`);
      }
    }
  }

  const requiredChecks: Record<string, string[]> = {
    a9_meta: ['check(id=1)'],
    a9_workspaces: ["check(permission_modein('full_access','review','read_only'))"],
    a9_sessions: ["check(title_sourcein('auto','manual','legacy'))", "check(statein('active','archived'))"],
    a9_tasks: ["check(statusin('active','completed','failed','cancelled','interrupted'))"],
    a9_turns: ["check(statusin('active','completed','completed_with_warnings','blocked','failed','cancelled','interrupted'))"],
    a9_runs: ["check(statusin('active','completed','failed','cancelled','interrupted'))"],
    a9_approvals: ["check(decisionin('pending','approved','denied','interrupted'))"],
    a9_events: ["check(kindin('model','tool'))"],
  };
  for (const [table, fragments] of Object.entries(requiredChecks)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as any;
    const normalized = String(row?.sql ?? '').toLowerCase().replace(/[\s\"`\[\]]+/g, '');
    for (const fragment of fragments) {
      if (!normalized.includes(fragment)) throw new Error(`A9 schema v4 table ${table} is missing required CHECK constraint`);
    }
  }

  const indexes: Record<string, { table: string; columns: string[] }> = {
    idx_a9_sessions_workspace: { table: 'a9_sessions', columns: ['workspace_path', 'state', 'last_activated_at'] },
    idx_a9_checkpoints_session: { table: 'a9_checkpoints', columns: ['session_id', 'created_at'] },
    idx_a9_events_session: { table: 'a9_events', columns: ['session_id', 'id'] },
  };
  for (const [index, contract] of Object.entries(indexes)) {
    const indexRow = (db.prepare(`PRAGMA index_list(${contract.table})`).all() as any[])
      .find((row) => row.name === index);
    if (!indexRow || Number(indexRow.unique) !== 0 || Number(indexRow.partial) !== 0) {
      throw new Error(`A9 schema v4 is missing compatible index ${index}`);
    }
    const columns = (db.prepare(`PRAGMA index_info(${index})`).all() as any[])
      .sort((left, right) => Number(left.seqno) - Number(right.seqno)).map((row) => row.name);
    if (columns.length !== contract.columns.length || columns.some((column, i) => column !== contract.columns[i])) {
      throw new Error(`A9 schema v4 index ${index} has the wrong columns`);
    }
    const keyColumns = (db.prepare(`PRAGMA index_xinfo(${index})`).all() as any[])
      .filter((row) => Number(row.key) === 1)
      .sort((left, right) => Number(left.seqno) - Number(right.seqno));
    if (keyColumns.length !== contract.columns.length || keyColumns.some((row, i) =>
      row.name !== contract.columns[i] || String(row.coll).toUpperCase() !== 'BINARY' || Number(row.desc) !== 0)) {
      throw new Error(`A9 schema v4 index ${index} has an incompatible key contract`);
    }
  }
  const explicitIndexes = (db.prepare(`
    SELECT name, tbl_name FROM sqlite_master
    WHERE type='index' AND sql IS NOT NULL AND tbl_name LIKE 'a9_%'
    ORDER BY name
  `).all() as any[]);
  const expectedIndexes = Object.keys(indexes).sort();
  if (profile === 'win7_19_legacy') {
    const names = explicitIndexes.map((row) => row.name);
    if (names.length !== expectedIndexes.length
      || names.some((name, index) => name !== expectedIndexes[index])) {
      throw new Error(`A9 schema v4 ${profile} profile has unexpected explicit indexes`);
    }
  } else {
    // Historical v1/v2 migrations preserve caller-created read indexes. Keep
    // only the behavior-neutral subset: non-unique, non-partial, named columns,
    // BINARY collation and ascending order. Constraints/expressions still fail.
    for (const index of explicitIndexes.filter((row) => !expectedIndexes.includes(row.name))) {
      const listed = (db.prepare(`PRAGMA index_list(${index.tbl_name})`).all() as any[])
        .find((row) => row.name === index.name);
      const keys = (db.prepare(`PRAGMA index_xinfo(${index.name})`).all() as any[])
        .filter((row) => Number(row.key) === 1);
      if (!listed || Number(listed.unique) !== 0 || Number(listed.partial) !== 0 || keys.length === 0
        || keys.some((row) => typeof row.name !== 'string'
          || String(row.coll).toUpperCase() !== 'BINARY' || Number(row.desc) !== 0)) {
        throw new Error(`A9 schema v4 canonical profile has unsafe explicit index ${index.name}`);
      }
    }
  }
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name LIKE 'a9_%' LIMIT 1",
  ).get();
  if (triggers) throw new Error(`A9 schema v4 ${profile} profile has unexpected triggers`);
  const eventSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='a9_events'").get() as any;
  if (!/\bid\s+integer\s+primary\s+key\s+autoincrement\b/i.test(String(eventSql?.sql ?? ''))) {
    throw new Error('A9 schema v4 a9_events.id must be AUTOINCREMENT');
  }
}

function a8TablesPresentStrict(db: SqliteDatabase): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='a8_workspaces'").get();
  if (!row) return false;
  assertA8WorkspaceSchema(db);
  return true;
}

function assertA8WorkspaceSchema(db: SqliteDatabase): void {
  const info = db.prepare('PRAGMA table_info(a8_workspaces)').all() as any[];
  const columns = info.map((row) => row.name)
    .filter((name): name is string => typeof name === 'string');
  const required = [
    'workspace_id', 'schema_version', 'canonical_path', 'comparison_key',
    'display_name', 'created_at', 'last_opened_at', 'archived_at',
  ];
  const missing = required.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    throw new Error(`A8 workspace schema mismatch; missing columns: ${missing.join(', ')}`);
  }
  const expected: Record<string, { type: 'TEXT' | 'INTEGER'; notnull: boolean; primary?: boolean }> = {
    workspace_id: { type: 'TEXT', notnull: false, primary: true },
    schema_version: { type: 'INTEGER', notnull: true },
    canonical_path: { type: 'TEXT', notnull: true },
    comparison_key: { type: 'TEXT', notnull: true },
    display_name: { type: 'TEXT', notnull: true },
    created_at: { type: 'TEXT', notnull: true },
    last_opened_at: { type: 'TEXT', notnull: false },
    archived_at: { type: 'TEXT', notnull: false },
  };
  for (const [name, contract] of Object.entries(expected)) {
    const row = info.find((item) => item.name === name);
    if (String(row?.type ?? '').toUpperCase() !== contract.type
      || Boolean(Number(row?.notnull)) !== contract.notnull
      || Boolean(Number(row?.pk)) !== Boolean(contract.primary)) {
      throw new Error(`A8 workspace schema mismatch; invalid column contract: ${name}`);
    }
  }
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='a8_workspaces'").get() as any;
  const normalizedSql = String(tableSql?.sql ?? '').toLowerCase().replace(/[\s"`\[\]]+/g, '');
  if (!normalizedSql.includes('check(schema_version=1)')) {
    throw new Error('A8 workspace schema mismatch; schema_version CHECK is missing');
  }
  const uniqueComparisonKey = (db.prepare('PRAGMA index_list(a8_workspaces)').all() as any[]).some((index) => {
    if (Number(index.unique) !== 1 || Number(index.partial) !== 0) return false;
    const names = (db.prepare(`PRAGMA index_info(${String(index.name)})`).all() as any[])
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((row) => row.name);
    return names.length === 1 && names[0] === 'comparison_key';
  });
  if (!uniqueComparisonKey) throw new Error('A8 workspace schema mismatch; comparison_key UNIQUE is missing');
}

function tablePresent(db: SqliteDatabase, tableName: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
    return Boolean(row);
  } catch (_err) {
    return false;
  }
}

function readSchemaVersion(db: SqliteDatabase): number | undefined {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='a9_meta'",
  ).get() as unknown;
  if (!table) return undefined;
  const rows = db.prepare('SELECT id, schema_version FROM a9_meta').all() as any[];
  if (rows.length !== 1 || rows[0]?.id !== 1 || !Number.isInteger(rows[0]?.schema_version) || rows[0].schema_version < 1) {
    throw new Error('A9_SCHEMA_INVALID: a9_meta 必须且只能包含 id=1 的正整数 schema_version。');
  }
  return rows[0].schema_version;
}

function readDataVersion(db: SqliteDatabase): number {
  const value = Number(db.pragma('data_version', { simple: true }));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('A9_SCHEMA_DATA_VERSION_INVALID: 无法读取 SQLite data_version。');
  }
  return value;
}

function backupDatabase(
  db: SqliteDatabase,
  dataRoot: string,
  openDatabase: A9OpenOptions['openDatabase'],
): { path: string; sha256: string } {
  const backupDir = path.join(dataRoot, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let suffix = 0;
  let backupPath: string;
  do {
    const uniqueSuffix = suffix === 0 ? '' : `-${suffix}`;
    backupPath = path.join(backupDir, `pre-a9-${stamp}-${process.pid}${uniqueSuffix}.db`);
    suffix += 1;
  } while (fs.existsSync(backupPath));

  try {
    // VACUUM INTO 由 SQLite 生成事务一致的独立数据库；它会读取已提交的 WAL
    // 页面，且不依赖 checkpoint 能否取得排他锁。
    db.prepare('VACUUM INTO ?').run(backupPath);
    const bytes = fs.readFileSync(backupPath);
    if (bytes.length < 16 || bytes.subarray(0, 16).toString('ascii') !== 'SQLite format 3\u0000') {
      throw new Error('迁移备份可读性检查失败：不是有效 SQLite 文件头。');
    }
    let validationDb: SqliteDatabase | undefined;
    try {
      validationDb = openDatabase(backupPath, { readonly: true });
      if (String(validationDb.pragma('quick_check', { simple: true })).toLowerCase() !== 'ok') {
        throw new Error('迁移备份可读性检查失败：SQLite quick_check 未通过。');
      }
    } finally {
      closeQuietly(validationDb, 'backup.validation_close');
    }
    return {
      path: backupPath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (err) {
    // 不把不完整快照暴露为可恢复备份。
    try {
      fs.rmSync(backupPath, { force: true });
    } catch (cleanupError) {
      // 残留的不完整备份不能被当作可恢复备份；留下诊断供人工清理。
      reportCleanupFailure('A9_BACKUP_CLEANUP_FAILED', 'backup.remove_incomplete', cleanupError, backupPath);
    }
    throw err;
  }
}

function displayNameFor(workspacePath: string): string {
  const base = workspacePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? workspacePath;
  return base.length > 0 ? base : workspacePath;
}

/** A mandatory write that reports another row count (e.g. RAISE(IGNORE)) is a failed write. */
function assertWrittenRows(info: { changes?: number | bigint }, expected: number, what: string): void {
  if (Number(info.changes ?? 0) !== expected) {
    throw a9PersistenceError('A9_PERSISTENCE_WRITE_UNCONFIRMED', `${what} did not produce the expected row`);
  }
}

const MANAGED_ACTIVE_STATUSES = ['starting', 'running', 'running_unknown', 'identity_mismatch'];
const MANAGED_SETTLED_STATUSES = ['stopped', 'exited', 'failed', 'released', 'user_dismissed'];

/**
 * A settled status agrees with its ownership only as: released <-> released, and every
 * other settled status with an `owned` record. release_unknown / release_intent (the
 * release outcome is unknown or pending) and any other pairing conflict.
 */
function managedSettledOwnershipConflict(status: string, ownership: unknown): boolean {
  const state = typeof ownership === 'object' && ownership !== null
    ? (ownership as { ownershipState?: unknown }).ownershipState : undefined;
  if (state === 'release_unknown' || state === 'release_intent') return true;
  return status === 'released' ? state !== 'released' : state !== 'owned';
}

const MANAGED_OWNER_KEYS = ['workspace', 'conversationId', 'taskId', 'turnId', 'toolCallId'] as const;
/** Field-wise owner comparison; key order of stored JSON is not identity. */
/**
 * True when an ownership payload names this workspace as its owner workspace.
 * Round 14 (P1): a payload that is no longer valid JSON (e.g. truncated, last brace
 * lost) still names its workspace; it must be matched textually so the damaged record
 * stays evidence of this scope instead of silently making the handle look legacy.
 */
function namesManagedOwnerWorkspace(payloadJson: string, workspacePath: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    // Round 15 (P1): a value cut inside the path (no closing quote) names this
    // workspace when it is a non-empty prefix of it.
    return damagedPayloadWorkspaces(payloadJson).some(({ value, complete }) => sameWorkspacePath(value, workspacePath)
      || (!complete && isTruncatedWorkspacePrefix(value, workspacePath)));
  }
  const owner = (parsed as { owner?: { workspace?: unknown } } | null)?.owner;
  return Boolean(owner) && typeof owner!.workspace === 'string' && sameWorkspacePath(owner!.workspace as string, workspacePath);
}

/**
 * Every `"workspace": "…"` value still readable in a damaged payload. `complete` is
 * false when the closing quote was lost, i.e. the value may be cut inside the path.
 */
function damagedPayloadWorkspaces(payloadJson: string): Array<{ value: string; complete: boolean }> {
  if (typeof payloadJson !== 'string') return [];
  const workspaces: Array<{ value: string; complete: boolean }> = [];
  for (const match of payloadJson.matchAll(/"workspace"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g)) {
    let value = match[1];
    try { value = JSON.parse(`"${value}"`) as string; } catch { /* keep the raw (unescapable) text */ }
    if (value) workspaces.push({ value, complete: match[2] === '"' });
  }
  return workspaces;
}

/** A non-empty path cut short by truncation that is a prefix of this workspace. */
function isTruncatedWorkspacePrefix(partial: string, workspacePath: string): boolean {
  if (!partial || !workspacePath) return false;
  const looksWindows = process.platform === 'win32' || [partial, workspacePath].some(value => /^(?:[a-zA-Z]:|[\\/]{2})/.test(value));
  if (looksWindows) {
    const target = path.win32.normalize(workspacePath).toLowerCase();
    return target.startsWith(partial.replace(/\//g, '\\').toLowerCase());
  }
  return [workspacePath, path.posix.resolve(workspacePath)].some(target => target.startsWith(partial));
}

/**
 * Round 15 (P1): the top-level `handleId` string of a payload that is not valid JSON
 * (e.g. truncated), or null. Only a top-level string value counts: a nested key or text
 * inside another string value is never read as this record's handle.
 * Round 17 (P1): a value cut before its closing quote is still read up to the end of the
 * text (`complete: false`); the characters kept may be the whole handleId or a prefix of it.
 */
function damagedPayloadHandleId(payloadJson: unknown): { value: string; complete: boolean } | null {
  if (typeof payloadJson !== 'string') return null;
  try { JSON.parse(payloadJson); return null; } catch { /* damaged: scan below */ }
  const text = payloadJson;
  const readString = (start: number, allowOpen = false): { value: string; end: number; complete: boolean } | null => {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === '"') {
        try { return { value: JSON.parse(text.slice(start, i + 1)) as string, end: i + 1, complete: true }; } catch { return null; }
      }
    }
    if (!allowOpen) return null;
    // Unclosed string: drop a trailing partial escape, then unescape what is left.
    let raw = text.slice(start + 1).replace(/(^|[^\\])((?:\\\\)*)\\u[0-9a-fA-F]{0,3}$/, '$1$2');
    if ((/\\+$/.exec(raw)?.[0].length ?? 0) % 2 === 1) raw = raw.slice(0, -1);
    let value = raw;
    try { value = JSON.parse(`"${raw}"`) as string; } catch { /* keep the raw (unescapable) text */ }
    return { value, end: text.length, complete: false };
  };
  const skipSpace = (i: number) => { while (i < text.length && /\s/.test(text[i])) i++; return i; };
  let depth = 0, expectKey = false;
  for (let i = skipSpace(0); i < text.length;) {
    const ch = text[i];
    if (ch === '"') {
      const key = readString(i);
      if (!key) return null;
      i = key.end;
      if (depth === 1 && expectKey) {
        expectKey = false;
        i = skipSpace(i);
        if (text[i] !== ':') return null;
        i = skipSpace(i + 1);
        if (key.value === 'handleId') {
          const value = text[i] === '"' ? readString(i, true) : null;
          return value?.value ? { value: value.value, complete: value.complete } : null;
        }
      }
      continue;
    }
    if (depth === 0 && ch !== '{') return null;
    if (ch === '{' || ch === '[') { depth++; if (depth === 1) expectKey = true; }
    else if (ch === '}' || ch === ']') { if (--depth <= 0) return null; }
    else if (ch === ',' && depth === 1) expectKey = true;
    i++;
  }
  return null;
}

/**
 * Requested handles a damaged payload names: the complete top-level handleId, or every
 * requested handle that a value cut before its closing quote is a non-empty prefix of
 * (fail-closed: an ambiguous prefix is damage of each handle it may name).
 */
function damagedPayloadHandleTargets(payloadJson: unknown, targets: readonly string[]): string[] {
  const recovered = damagedPayloadHandleId(payloadJson);
  if (!recovered) return [];
  return recovered.complete
    ? targets.filter(target => target === recovered.value)
    : targets.filter(target => target.startsWith(recovered.value));
}

/**
 * Round 20 (P1): one closed segment of a conversation's workspace binding. Every event of
 * the conversation with `id <= maxEventId` (and above the previous segment's bound) was
 * written while it was bound to `workspace`; events above the last segment belong to its
 * current workspace. `renamedTo` only records the later name of a renamed default directory:
 * facts keep the path they were written under (ADR-0343), so attribution uses `workspace`.
 */
interface A9WorkspaceHistoryEntry { workspace: string; maxEventId: number; renamedTo?: string }

/**
 * Round 23 (P1): marker `workspace` of a segment whose events were written before segments were
 * kept, in an earlier binding that cannot be bounded (a legacy rebind, a scalar previousWorkspace
 * or damaged metadata). Never a path; its events count as possibly written in any workspace.
 */
const A9_UNKNOWN_PRIOR_WORKSPACE = '#a9-unknown-prior';

/** The stored segments, or null when absent; 'damaged' when present but not well-formed. */
function parseWorkspaceHistory(value: unknown): A9WorkspaceHistoryEntry[] | null | 'damaged' {
  if (value === undefined || value === null) return null;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return 'damaged'; }
  }
  if (!Array.isArray(parsed)) return 'damaged';
  let bound = -1;
  for (const entry of parsed as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.workspace !== 'string' || !entry.workspace
      || !Number.isSafeInteger(entry.maxEventId) || Number(entry.maxEventId) < bound
      || (entry.renamedTo !== undefined && (typeof entry.renamedTo !== 'string' || !entry.renamedTo))) return 'damaged';
    bound = Number(entry.maxEventId);
  }
  return parsed as A9WorkspaceHistoryEntry[];
}

/**
 * `workdir.origin` of a session row aliased `s`; DAMAGED_WORKDIR_ORIGIN when its metadata is not
 * valid JSON (nothing about its earlier bindings can be read).
 */
const DAMAGED_WORKDIR_ORIGIN = '#a9-damaged-metadata';
const WORKDIR_ORIGIN_SQL = `CASE WHEN json_valid(s.metadata_json) THEN json_extract(s.metadata_json, '$.workdir.origin')
  ELSE '${DAMAGED_WORKDIR_ORIGIN}' END`;

/**
 * Round 20 (P1): the workspace(s) the event's conversation was bound to when the event was
 * written, or null for an unknown conversation. Damaged history or a legacy scalar
 * `previousWorkspace` (no segment bounds) is ambiguous and yields every candidate (fail-closed).
 * Round 22 (P1): a conversation rebound by a legacy build (`origin: 'linked'` with neither
 * segments nor `previousWorkspace`), or whose metadata is damaged, may have written the event
 * in any workspace: null (fail-closed).
 */
function managedEventWorkspaces(eventId: number, current: string | null, previousWorkspace: unknown, history: unknown,
  origin?: unknown): string[] | null {
  if (current === null || origin === DAMAGED_WORKDIR_ORIGIN) return null;
  const segments = parseWorkspaceHistory(history);
  if (segments === 'damaged') {
    const mentioned = typeof history === 'string'
      ? [...history.matchAll(/"(?:workspace|renamedTo)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(match => {
        try { return JSON.parse(`"${match[1]}"`) as string; } catch { return match[1]; }
      })
      : [];
    if (mentioned.includes(A9_UNKNOWN_PRIOR_WORKSPACE)) return null;
    return [...mentioned, ...(typeof previousWorkspace === 'string' ? [previousWorkspace] : []), current];
  }
  if (segments?.length) {
    const written = segments.find(entry => eventId <= entry.maxEventId)?.workspace ?? current;
    // Round 23 (P1): an event of the unknown prior segment may have been written anywhere.
    return written === A9_UNKNOWN_PRIOR_WORKSPACE ? null : [written];
  }
  if (typeof previousWorkspace === 'string') return [previousWorkspace, current];
  return origin === 'linked' ? null : [current];
}

/** True when the event was written in `scope` (an unknown conversation may have been: fail-closed). */
function managedEventWrittenIn(event: { id: number; previous_workspace: unknown; workspace_history: unknown; workdir_origin?: unknown },
  current: string | null, scope: string): boolean {
  const written = managedEventWorkspaces(event.id, current, event.previous_workspace, event.workspace_history, event.workdir_origin);
  return written === null || written.some(workspace => sameWorkspacePath(workspace, scope));
}

function sameManagedOwner(left: unknown, right: unknown): boolean {
  const a = left as Record<string, unknown> | undefined, b = right as Record<string, unknown> | undefined;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return Object.keys(a).length === Object.keys(b).length
    && MANAGED_OWNER_KEYS.every(key => typeof a[key] === 'string' && a[key] === b[key]);
}

function sameWorkspacePath(left: string, right: string): boolean {
  // win32.isAbsolute('/w') is true too. A POSIX root alone is not a drive/UNC
  // path and must not make POSIX conversation ownership case-insensitive.
  const looksWindows = process.platform === 'win32' || [left, right].some((value) =>
    path.win32.isAbsolute(value) && path.win32.parse(value).root.length > 1);
  if (looksWindows) {
    return path.win32.normalize(left).replace(/[\\/]+$/, '').toLowerCase()
      === path.win32.normalize(right).replace(/[\\/]+$/, '').toLowerCase();
  }
  return path.resolve(left) === path.resolve(right);
}

function conversationFromRow(row: any): A9ConversationRecord {
  return {
    sessionId: row.session_id,
    workspacePath: row.workspace_path,
    title: row.title,
    titleSource: row.title_source,
    state: row.state,
    activity: row.activity || 'idle',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivatedAt: row.last_activated_at,
  };
}

export function normalizeConversationTitle(value: string, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function parseConversationInbox(value: unknown): A9ConversationInbox {
  const empty: A9ConversationInbox = { version: 1, settledAt: null, activeSince: null, lastVisitedAt: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const inbox = value as Record<string, unknown>;
  if (inbox.version !== 1) return empty;
  for (const key of ['settledAt', 'activeSince', 'lastVisitedAt']) {
    const time = inbox[key];
    if (time !== undefined && time !== null && (typeof time !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)
      || !Number.isFinite(Date.parse(time)))) return empty;
  }
  return { version: 1, settledAt: inbox.settledAt as string ?? null,
    activeSince: inbox.activeSince as string ?? null, lastVisitedAt: inbox.lastVisitedAt as string ?? null };
}

function safeParse(text: string, context?: SafeParseContext): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
    if (context) {
      context.buffer.add({
        code: 'A9_PERSISTED_JSON_INVALID',
        detail: 'Persisted JSON is not an object; empty object returned for compatibility.',
        count: 1,
        table: context.table,
        rowId: String(context.rowId),
      });
    }
    return {};
  } catch (_err) {
    if (context) {
      context.buffer.add({
        code: 'A9_PERSISTED_JSON_INVALID',
        detail: 'Persisted JSON is invalid; empty object returned for compatibility.',
        count: 1,
        table: context.table,
        rowId: String(context.rowId),
      });
    }
    return {};
  }
}
