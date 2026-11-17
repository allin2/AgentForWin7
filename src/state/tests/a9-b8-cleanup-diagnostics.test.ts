/**
 * Phase B / B8：清理路径失败不再被静默吞掉，而是留下结构化诊断（AGENTS §5）。
 */
/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  A9PersistenceManager, clearCleanupDiagnostics, getRecentCleanupDiagnostics, reportCleanupFailure,
} from '../src';
import type { SqliteDatabase } from '../src';

describe('B8 cleanup diagnostics', () => {
  let root: string;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-b8-'));
    warnSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    clearCleanupDiagnostics();
  });
  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records a bounded, truncated entry with a stable code and emits a coded warning', () => {
    const error = Object.assign(new Error('x'.repeat(1000)), { code: 'EBUSY' });
    const entry = reportCleanupFailure('A9_TEST_CODE', 'test.operation', error, 'C:\\数据 目录\\a9.db');
    expect(entry).toMatchObject({ code: 'A9_TEST_CODE', operation: 'test.operation' });
    expect(entry.detail.startsWith('EBUSY: ')).toBe(true);
    expect(entry.detail.length).toBeLessThanOrEqual(240);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('A9_TEST_CODE (test.operation)'),
      { type: 'A9CleanupWarning', code: 'A9_TEST_CODE' });
    for (let index = 0; index < 50; index += 1) reportCleanupFailure('A9_TEST_CODE', `op-${index}`, new Error('e'));
    expect(getRecentCleanupDiagnostics()).toHaveLength(32);
    expect(getRecentCleanupDiagnostics()[31].operation).toBe('op-49');
  });

  it('survives a failing warning channel without throwing', () => {
    warnSpy.mockImplementation(() => { throw new Error('warning channel down'); });
    expect(() => reportCleanupFailure('A9_TEST_CODE', 'op', new Error('e'))).not.toThrow();
    expect(getRecentCleanupDiagnostics()).toHaveLength(1);
  });

  it('reports a database close failure on the open() cleanup path instead of swallowing it', () => {
    const dbPath = path.join(root, 'a9.db');
    const first = A9PersistenceManager.open({
      databasePath: dbPath, dataRoot: root,
      openDatabase: (file, options) => new Database(file, options?.readonly ? { readonly: true } : {}) as unknown as SqliteDatabase,
    });
    expect(first.status).toBe('ready');
    if (first.status === 'ready') first.manager.db.close();

    // 重开时只读 schema 探测连接的 close() 失败：打开本身必须继续成功，且失败要被记录。
    const second = A9PersistenceManager.open({
      databasePath: dbPath, dataRoot: root,
      openDatabase: (file, options) => {
        const db = new Database(file, options?.readonly ? { readonly: true } : {}) as any;
        if (!options?.readonly) return db as SqliteDatabase;
        return new Proxy(db, { get(target, key) {
          if (key === 'close') return () => { throw Object.assign(new Error('database is locked'), { code: 'EBUSY' }); };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        } }) as SqliteDatabase;
      },
    });
    expect(second.status).toBe('ready');
    if (second.status === 'ready') second.manager.db.close();
    const entries = getRecentCleanupDiagnostics().filter((entry) => entry.code === 'A9_DB_CLOSE_FAILED');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]).toMatchObject({ operation: 'open.cleanup' });
    expect(entries[0].detail).toContain('EBUSY');
  });
});
