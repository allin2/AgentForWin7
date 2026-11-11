import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { createDiagnosticsLog, createFlightRecorder, errorFacts } = require(process.env.A9_62_REVIEW_LOGGER || '../../product/a9-diagnostics-log');
const roots: string[] = [];
const recorders: any[] = [];
afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  jest.useRealTimers();
});
function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-62-log-test-'));
  roots.push(value);
  return path.join(value, '中文 user data %#');
}
function rows(directory: string) {
  return fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).flatMap(name => {
    const bytes = fs.readFileSync(path.join(directory, name));
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString('utf8')).not.toContain('\r');
    expect(bytes[bytes.length - 1]).toBe(10);
    return bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  });
}

describe('A9-62 bounded diagnostic disk log', () => {
  test('rotates, bounds every file and total bytes, and reopens a Chinese/spaced path', async () => {
    const userDataPath = root();
    const log = createDiagnosticsLog({ userDataPath, maxFileBytes: 512 });
    for (let index = 0; index < 40; index++) await log.record('ipc-begin', { operationId: index, channel: 'product:a9-request', action: 'a9.turn.submit' });
    await log.fatal('startup-failed', errorFacts(new Error('not written'), 'A9_STARTUP_FAILED'));
    const { directory } = log.snapshot();
    for (let index = 0; index < 40; index++) await log.record('startup-stage-end', { operationId: index, stage: 'desktop-host' });
    expect(fs.readdirSync(directory).sort()).toEqual(['critical.jsonl', 'critical.previous.jsonl', 'main.jsonl']);
    const sizes = fs.readdirSync(directory).map(name => fs.statSync(path.join(directory, name)).size);
    expect(sizes.every(size => size <= 512)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3 * 512);
    expect(rows(directory).every(row => row.schemaVersion === 1)).toBe(true);
    const reopened = createDiagnosticsLog({ userDataPath, maxFileBytes: 512 });
    await reopened.record('process-start');
    await reopened.fatal('exit-end', { exitCode: 0 });
    expect(rows(directory).some(row => row.event === 'process-start')).toBe(true);
    expect(fs.readdirSync(directory).reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0)).toBeLessThanOrEqual(1536);
  });

  test('truncates an oversized multibyte record into valid bounded JSONL', async () => {
    const log = createDiagnosticsLog({ userDataPath: root(), maxLineBytes: 256 });
    await log.record('ipc-end', { stage: '中'.repeat(1000), channel: '中'.repeat(1000), action: '中'.repeat(1000),
      pending: Array.from({ length: 100 }, (_, operationId) => ({ operationId, stage: 'long-stage' })) });
    const file = path.join(log.snapshot().directory, 'main.jsonl');
    expect(fs.statSync(file).size).toBeLessThanOrEqual(256);
    expect(rows(log.snapshot().directory)[0]).toMatchObject({ schemaVersion: 1, truncated: true });
    expect(log.snapshot().truncatedCount).toBe(1);
  });

  test('drops on a full queue without accumulating unbounded payloads or throwing', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const real = fs.promises;
    const io = { ...fs, promises: { mkdir: async () => blocked, stat: real.stat.bind(real),
      appendFile: real.appendFile.bind(real), unlink: real.unlink.bind(real), rename: real.rename.bind(real) } };
    const log = createDiagnosticsLog({ userDataPath: root(), maxQueue: 2, fs: io });
    const first = log.record('first');
    const second = log.record('second');
    await expect(log.record('dropped', { payload: 'never queued' })).resolves.toBe(false);
    expect(log.snapshot()).toMatchObject({ queuedCount: 2, droppedCount: 1, recordCount: 3 });
    release();
    await first; await second; // mkdir did not create the directory: both failures are contained.
    expect(log.snapshot().queuedCount).toBe(0);
  });

  test('bounds checkpoint waiting when the filesystem never responds', async () => {
    const io = { promises: { mkdir: () => new Promise(() => {}) } };
    const log = createDiagnosticsLog({ userDataPath: root(), fs: io, maxQueue: 1 });
    const started = Date.now();
    await expect(log.checkpoint('startup-stage-begin', { stage: 'desktop-host' })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(log.record('overflow')).resolves.toBe(false);
    expect(log.snapshot().droppedCount).toBe(1);
  });

  test('contains async and fatal write errors, counting them without product exceptions', async () => {
    const denied = () => { throw Object.assign(new Error('secret failure'), { code: 'EACCES' }); };
    const log = createDiagnosticsLog({ userDataPath: root(), fs: { promises: { mkdir: denied }, mkdirSync: denied } });
    await expect(log.record('process-start')).resolves.toBe(false);
    await expect(log.fatal('uncaught-exception')).resolves.toBe(false);
    expect(log.snapshot()).toMatchObject({ writeFailureCount: 2, writtenCount: 0 });
  });

  test('writes exit-end with a small synchronous append and contains synchronous write failures', async () => {
    let writes = 0;
    const io = { ...fs, writeFileSync: (...args: any[]) => { writes++; return (fs.writeFileSync as any)(...args); } };
    const log = createDiagnosticsLog({ userDataPath: root(), fs: io });
    await log.record('exit-begin');
    expect(log.criticalSync('exit-end', { exitCode: 0 })).toBe(true);
    expect(writes).toBe(1);
    expect(log.snapshot().writtenCount).toBe(2);
    const denied = createDiagnosticsLog({ userDataPath: root(), fs: { ...fs, writeFileSync() { throw new Error('denied'); } } });
    await denied.record('exit-begin');
    expect(() => denied.criticalSync('exit-end')).not.toThrow();
    expect(denied.snapshot().writeFailureCount).toBe(1);
  });

  test('never persists prompts, contents, commands, environment, arbitrary error text or fake credentials', async () => {
    const fake = 'sk-THIS_IS_A_FAKE_SECRET_0123456789';
    const error = Object.assign(new Error(`prompt=${fake} command=cat private-file`), { name: fake, code: fake });
    error.stack = `${fake}\n at ${fake} (/secret/${fake}/main.js:12:3)\n at evil (/secret/${fake}.js:9:1)\n`;
    const log = createDiagnosticsLog({ userDataPath: root() });
    await log.record('uncaught-exception', { ...errorFacts(error, 'A9_MAIN_UNCAUGHT_EXCEPTION'),
      prompt: fake, content: fake, command: fake, env: { KEY: fake }, payload: { fake }, error });
    const text = JSON.stringify(rows(log.snapshot().directory)[0]);
    expect(text).not.toContain(fake);
    expect(text).not.toContain('private-file');
    expect(text).not.toContain('/secret/');
    expect(JSON.parse(text)).toMatchObject({ errorName: 'Error', errorCode: 'A9_MAIN_UNCAUGHT_EXCEPTION', stackFrames: [{ file: 'main.js', line: 12, column: 3 }] });
    expect(errorFacts({ code: fake, name: 'Password' })).toEqual({ errorCode: 'A9_DIAGNOSTIC_ERROR', errorName: 'Error' });
  });

  test('contains hostile error accessors', () => {
    expect(errorFacts({ get code() { throw new Error('fake secret'); } })).toEqual({ errorCode: 'A9_DIAGNOSTIC_ERROR', errorName: 'Error' });
  });
});

describe('A9-62 stage and heartbeat recorder', () => {
  test('persists a begin marker before heavy work and keeps exact result/error identity', async () => {
    const log = createDiagnosticsLog({ userDataPath: root() });
    const recorder = createFlightRecorder(log); recorders.push(recorder);
    const result = {};
    await expect(recorder.stage('desktop-host', () => {
      const tail = rows(log.snapshot().directory).filter(row => row.event === 'startup-stage-begin').pop();
      expect(tail.stage).toBe('desktop-host');
      return result;
    })).resolves.toBe(result);
    const failure = Object.assign(new Error('not logged'), { code: 'ENOSPC' });
    await expect(recorder.stage('workspace-restore', () => { throw failure; })).rejects.toBe(failure);
    await log.flush();
    expect(rows(log.snapshot().directory)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'startup-stage-end', stage: 'workspace-restore', errorCode: 'ENOSPC' }),
    ]));
  });

  test('captures a synchronous stall with the action still pending, before its microtask completion', async () => {
    const record = jest.fn(async () => true);
    const log = { record, critical: record, checkpoint: async () => true, criticalCheckpoint: async () => true, stop() {} };
    const recorder = createFlightRecorder(log); recorders.push(recorder);
    const op = recorder.begin('ipc', { channel: 'product:a9-request', action: 'a9.checkpoint.undoTurn' }, false);
    const start = process.hrtime.bigint();
    while (Number(process.hrtime.bigint() - start) / 1e6 < 1100) { /* real main-thread starvation */ }
    op.end();
    expect(log.record).toHaveBeenCalledWith('main-thread-stall', expect.objectContaining({
      durationMs: expect.any(Number), pending: [expect.objectContaining({ action: 'a9.checkpoint.undoTurn' })],
    }));
    expect(log.record).toHaveBeenCalledWith('ipc-end', expect.objectContaining({ durationMs: expect.any(Number) }));
  });

  test('does not turn the heartbeat into an operation deadline', async () => {
    const record = jest.fn(async () => true);
    const log = { record, critical: record, checkpoint: async () => true, criticalCheckpoint: async () => true, stop() {} };
    const recorder = createFlightRecorder(log); recorders.push(recorder);
    const op = recorder.begin('ipc', { channel: 'desktop:request', action: 'task.submit' }, false);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(log.record.mock.calls.filter((call: any[]) => call[0] === 'main-thread-stall')).toHaveLength(0);
    op.end();
    expect(log.record).toHaveBeenCalledWith('ipc-end', expect.objectContaining({ durationMs: expect.any(Number) }));
  });
});

describe('A9-62 review red-green regressions', () => {
  test('R1 preserves all syntactically valid error codes and rejects invalid or fake-key codes on disk', async () => {
    const log = createDiagnosticsLog({ userDataPath: root() });
    for (const code of ['A9_SCOPE_STALE', 'A9_APPLICATION_BUSY', 'ERR_INVALID_ARG_TYPE']) {
      await log.record('ipc-end', errorFacts({ code }, 'A9_IPC_FAILED'));
    }
    const invalid = ['a9_scope_stale', 'A9 HAS SPACE', 'A'.repeat(65), 123, null, {}, 'sk-FAKE_CREDENTIAL_01234567890123456789'];
    for (const code of invalid) await log.record('ipc-end', errorFacts({ code }, 'A9_IPC_FAILED'));
    const recorded = rows(log.snapshot().directory);
    expect(recorded.slice(0, 3).map(row => row.errorCode)).toEqual(['A9_SCOPE_STALE', 'A9_APPLICATION_BUSY', 'ERR_INVALID_ARG_TYPE']);
    expect(recorded.slice(3).map(row => row.errorCode)).toEqual(invalid.map(() => 'A9_IPC_FAILED'));
    expect(JSON.stringify(recorded)).not.toContain('sk-FAKE_CREDENTIAL');
  });

  test('R3 retains one stall through 20000 IPC records and initializes directory/file sizes only once', async () => {
    let mkdirCalls = 0; let statCalls = 0;
    const io = { ...fs, promises: { ...fs.promises,
      mkdir: (...args: any[]) => { mkdirCalls++; return (fs.promises.mkdir as any)(...args); },
      stat: (...args: any[]) => { statCalls++; return (fs.promises.stat as any)(...args); },
    } };
    const log = createDiagnosticsLog({ userDataPath: root(), maxFileBytes: 4096, fs: io });
    await log.record('main-thread-stall', { durationMs: 3000, pending: [{ operationId: 1, stage: 'desktop-host' }] });
    const initialStats = statCalls;
    for (let index = 0; index < 20000; index++) await log.record(index % 2 ? 'ipc-end' : 'ipc-begin', { channel: 'product:a9-request', action: 'a9.snapshot.get', operationId: index });
    const directory = log.snapshot().directory;
    expect(rows(directory).some(row => row.event === 'main-thread-stall')).toBe(true);
    expect(mkdirCalls).toBe(1);
    expect(statCalls).toBe(initialStats);
    expect(fs.readdirSync(directory).reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0)).toBeLessThanOrEqual(3 * 4096);
  }, 20000);
});
