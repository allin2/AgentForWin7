/**
 * Phase B / B1（H-P1-03）：会话快照相关子查询的性能索引。
 *
 * 只验证可观察合同：索引随 open 创建/补建且不破坏 v4 schema 校验；真实
 * listConversations / getConversationInboxSummary / enforceRetention 查询的
 * EXPLAIN QUERY PLAN 不再对 tasks/runs/approvals/events 做全表 SCAN；
 * 合并后的 inbox 聚合语义不变。
 */
/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { A9PersistenceManager, A9_SCHEMA_VERSION } from '../src';
import type { SqliteDatabase } from '../src';

const PERF_INDEXES: Record<string, string[]> = {
  idx_a9_tasks_session_status: ['session_id', 'status'],
  idx_a9_runs_session_status: ['session_id', 'status'],
  idx_a9_approvals_session_decision: ['session_id', 'decision'],
  idx_a9_turns_session_task: ['session_id', 'task_id'],
  idx_a9_events_created: ['created_at'],
  idx_a9_events_session_type: ['session_id', 'event_type'],
};

const openReal = (file: string, options?: { readonly?: boolean }): SqliteDatabase =>
  new Database(file, options?.readonly ? { readonly: true } : {}) as unknown as SqliteDatabase;

describe('B1 SQLite performance indexes', () => {
  let root: string;
  let dbPath: string;
  const open = (): A9PersistenceManager => {
    const outcome = A9PersistenceManager.open({ databasePath: dbPath, openDatabase: openReal, dataRoot: root });
    if (outcome.status !== 'ready') throw new Error(`open failed: ${outcome.status}`);
    return outcome.manager;
  };
  const indexColumns = (db: SqliteDatabase, name: string): string[] =>
    (db.prepare(`PRAGMA index_info(${name})`).all() as any[])
      .sort((a, b) => a.seqno - b.seqno).map((row) => row.name);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-b1-'));
    dbPath = path.join(root, 'a9.db');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('creates every performance index on a fresh database without bumping the schema version', () => {
    const manager = open();
    for (const [name, columns] of Object.entries(PERF_INDEXES)) {
      expect(indexColumns(manager.db, name)).toEqual(columns);
    }
    expect((manager.db.prepare('SELECT schema_version FROM a9_meta WHERE id = 1').get() as any).schema_version)
      .toBe(A9_SCHEMA_VERSION);
    manager.db.close();
  });

  it('adds the indexes to an existing v4 database that predates them and keeps its data', () => {
    const first = open();
    first.createConversation('s1', '/ws');
    first.upsertTask('t1', 's1', 'active');
    for (const name of Object.keys(PERF_INDEXES)) first.db.exec(`DROP INDEX ${name}`);
    first.db.close();

    // 重开路径先做只读 v4 探测：缺失的性能索引不能导致 diagnostics。
    const second = open();
    for (const name of Object.keys(PERF_INDEXES)) expect(indexColumns(second.db, name).length).toBeGreaterThan(0);
    expect(second.listConversations('/ws')[0].activity).toBe('interrupted');
    second.db.close();
  });

  it('refuses nothing on reopen when the indexes already exist (idempotent)', () => {
    open().db.close();
    const again = open();
    expect(indexColumns(again.db, 'idx_a9_events_created')).toEqual(['created_at']);
    again.db.close();
  });

  it('keeps list/summary/retention query plans free of full table scans on the guarded tables', () => {
    const manager = open();
    manager.createConversation('s1', '/ws');
    manager.upsertTask('t1', 's1', 'active');
    manager.upsertTurn('u1', 't1', 's1', 'active');
    manager.upsertRun('r1', 'u1', 's1', 'active');
    manager.recordApproval({ approvalId: 'a1', sessionId: 's1', toolName: 'x', binding: {}, decision: 'pending' });
    manager.recordModelEvent('s1', null, 'request', {});

    const captured: string[] = [];
    const rawPrepare = manager.db.prepare.bind(manager.db);
    (manager.db as any).prepare = (sql: string) => { captured.push(sql); return rawPrepare(sql); };
    manager.listConversations('/ws');
    manager.getConversationInboxSummary('s1');
    manager.enforceRetention();
    (manager.db as any).prepare = rawPrepare;

    const hot = captured.filter((sql) => /a9_(tasks|runs|approvals)\b|DELETE FROM a9_events/.test(sql)
      && !/^\s*(INSERT|UPDATE)/i.test(sql));
    expect(hot.length).toBeGreaterThanOrEqual(3);
    const guarded = /\bSCAN\s+(t|r|a|a9_tasks|a9_runs|a9_approvals|a9_events)\b(?!\s+USING)/i;
    for (const sql of hot) {
      const params = (sql.match(/\?/g) ?? []).map(() => 'x');
      const plan = (rawPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as any[]).map((row) => String(row.detail));
      for (const detail of plan) {
        // 允许 a9_sessions 外层，以及对单行物化聚合子查询 r 的 "SCAN r LEFT-JOIN"。
        if (/^SCAN (s|a9_sessions)\b/.test(detail) || detail === 'SCAN r LEFT-JOIN') continue;
        expect({ sql: sql.slice(0, 60), detail, bad: guarded.test(detail) }).toMatchObject({ bad: false });
      }
    }
    // question_pending 子查询按 (session_id, event_type) 精确定位，而不是读取整个会话的事件。
    const listPlan = (rawPrepare(`EXPLAIN QUERY PLAN ${hot.find((sql) => /question_pending/.test(sql) && /a9_sessions s/.test(sql))}`)
      .all('x') as any[]).map((row) => String(row.detail)).join('\n');
    expect(listPlan).toContain('idx_a9_events_session_type (session_id=? AND event_type=?)');
    // 保留期 DELETE 通过 created_at 索引范围删除。
    const retentionPlan = (rawPrepare('EXPLAIN QUERY PLAN DELETE FROM a9_events WHERE created_at < ?')
      .all('2000-01-01T00:00:00.000Z') as any[]).map((row) => String(row.detail)).join('\n');
    expect(retentionPlan).toContain('idx_a9_events_created');
    manager.db.close();
  });

  it('merged inbox aggregation preserves completed/started/ended semantics', () => {
    const manager = open();
    manager.createConversation('s1', '/ws');
    const run = manager.db.prepare('INSERT INTO a9_runs (run_id, turn_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    run.run('r1', 'u1', 's1', 'completed', '2026-10-01T00:00:00.000Z', '2026-10-01T00:05:00.000Z');
    run.run('r2', 'u2', 's1', 'failed', '2026-10-02T00:00:00.000Z', '2026-10-02T00:07:00.000Z');
    run.run('r3', 'u3', 's1', 'active', '2026-10-03T00:00:00.000Z', '2026-10-03T00:09:00.000Z');
    run.run('rx', 'ux', 'other', 'completed', '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');

    const summary = manager.getConversationInboxSummary('s1');
    expect(summary.lastCompletedAt).toBe('2026-10-01T00:05:00.000Z');
    // started = MAX(created_at)=r3；ended = MAX(updated_at WHERE status<>active)=r2。
    expect(summary.lastActivityAt).toBe('2026-10-03T00:00:00.000Z');

    manager.createConversation('s2', '/ws');
    const empty = manager.getConversationInboxSummary('s2');
    expect(empty.lastCompletedAt).toBeNull();
    expect(typeof empty.lastActivityAt).toBe('string');
    manager.db.close();
  });
});
