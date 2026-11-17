import * as fs from 'fs';
import * as path from 'path';

const { PHASE, DEFERRED_NOTE, createProviderContextState } = require('../../product/a9-provider-context-state');

const deferred = () => {
  let resolve!: (value?: any) => void; let reject!: (error: any) => void;
  const promise = new Promise<any>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
};
const context = (label: string) => ({ messages: [{ role: 'user', content: label }], stats: { restored: label } });

function harness() {
  const env = { session: 's1', shutdown: false };
  const scans: Array<{ sessionId: string; signal: any; gate: ReturnType<typeof deferred> }> = [];
  const restoreSync = jest.fn((sessionId: string) => context(`sync-${sessionId}`));
  const restoreAsync = jest.fn((sessionId: string, signal: any) => {
    const gate = deferred(); scans.push({ sessionId, signal, gate }); return gate.promise;
  });
  const state = createProviderContextState({
    currentSessionId: () => env.session, isShutdownRequested: () => env.shutdown, restoreSync, restoreAsync,
  });
  return { env, scans, restoreSync, restoreAsync, state };
}

describe('A9 Provider context restore lifecycle', () => {
  test('starts pending with deferred statistics and no carry-over history', () => {
    const { state } = harness();
    expect(state.phase()).toBe(PHASE.PENDING);
    expect(state.isRestorePending()).toBe(true);
    expect(state.stats()).toEqual({ deferred: true, note: DEFERRED_NOTE });
    expect(state.carryOverHistory()).toBeNull();
  });

  test('pending → restoring → ready shares one scan and hands the history to one loop', async () => {
    const h = harness();
    const first = h.state.ensureRestoredAsync();
    const second = h.state.ensureRestoredAsync();
    expect(h.state.phase()).toBe(PHASE.RESTORING);
    expect(h.restoreAsync).toHaveBeenCalledTimes(1);
    h.scans[0].gate.resolve(context('a'));
    await Promise.all([first, second]);
    expect(h.state.phase()).toBe(PHASE.READY);
    expect(h.state.stats()).toEqual({ restored: 'a' });
    await h.state.ensureRestoredAsync();
    expect(h.restoreAsync).toHaveBeenCalledTimes(1);
    expect(h.state.takeCarryOverHistory()).toEqual([{ role: 'user', content: 'a' }]);
    expect(h.state.takeCarryOverHistory()).toBeNull();
  });

  test('an empty carry-over history is never handed to a loop and is kept as-is', () => {
    const h = harness();
    h.state.setCarryOverHistory([]);
    expect(h.state.takeCarryOverHistory()).toBeNull();
    expect(h.state.carryOverHistory()).toEqual([]);
  });

  test('a failed restore returns to pending, keeps the cache, and the next entry retries', async () => {
    const h = harness();
    const attempt = h.state.ensureRestoredAsync();
    h.scans[0].gate.reject(Object.assign(new Error('io'), { code: 'A9_IO' }));
    await expect(attempt).rejects.toMatchObject({ code: 'A9_IO' });
    expect(h.state.phase()).toBe(PHASE.PENDING);
    expect(h.state.stats()).toEqual({ deferred: true, note: DEFERRED_NOTE });
    const retry = h.state.ensureRestoredAsync();
    expect(h.restoreAsync).toHaveBeenCalledTimes(2);
    h.scans[1].gate.resolve(context('b'));
    await retry;
    expect(h.state.phase()).toBe(PHASE.READY);
  });

  test('invalidation aborts the in-flight scan and drops its late result as stale', async () => {
    const h = harness();
    const attempt = h.state.ensureRestoredAsync();
    const { signal } = h.scans[0];
    h.state.invalidateScope();
    expect(signal.aborted).toBe(true);
    expect(h.state.phase()).toBe(PHASE.PENDING);
    h.scans[0].gate.resolve(context('late'));
    await expect(attempt).rejects.toMatchObject({ code: 'A9_SCOPE_STALE' });
    expect(h.state.isRestorePending()).toBe(true);
    expect(h.state.carryOverHistory()).toBeNull();
  });

  test('a conversation switch while restoring is stale even when the scan fails', async () => {
    const h = harness();
    const attempt = h.state.ensureRestoredAsync();
    h.env.session = 's2';
    h.scans[0].gate.reject(new Error('aborted'));
    await expect(attempt).rejects.toMatchObject({ code: 'A9_SCOPE_STALE' });
  });

  test('shutdown aborts the scan signal and never commits a result', async () => {
    const h = harness();
    const attempt = h.state.ensureRestoredAsync();
    h.env.shutdown = true;
    expect(h.scans[0].signal.aborted).toBe(true);
    h.scans[0].gate.resolve(context('late'));
    await expect(attempt).rejects.toMatchObject({ code: 'A9_SCOPE_STALE' });
    expect(h.state.isRestorePending()).toBe(true);
  });

  test('requireRestore returns ready to pending; resetContext also drops history and statistics', async () => {
    const h = harness();
    h.state.ensureRestoredSync();
    expect(h.restoreSync).toHaveBeenCalledWith('s1');
    expect(h.state.phase()).toBe(PHASE.READY);
    h.state.requireRestore();
    expect(h.state.phase()).toBe(PHASE.PENDING);
    expect(h.state.carryOverHistory()).toEqual([{ role: 'user', content: 'sync-s1' }]);
    h.state.requireRestore({ resetContext: true });
    expect(h.state.carryOverHistory()).toBeNull();
    expect(h.state.stats()).toEqual({ deferred: true, note: DEFERRED_NOTE });
  });

  test('invalidateScope keeps a ready phase ready (Base URL change refreshes statistics only)', () => {
    const h = harness();
    h.state.ensureRestoredSync();
    h.state.invalidateScope();
    h.state.showDeferredStats('历史上下文统计正在刷新。');
    expect(h.state.phase()).toBe(PHASE.READY);
    expect(h.state.stats()).toEqual({ deferred: true, note: '历史上下文统计正在刷新。' });
  });

  test('statistics refresh never throws and ignores results from an old scope', async () => {
    const h = harness();
    const ok = h.state.refreshStatsAsync();
    h.scans[0].gate.resolve(context('fresh'));
    await ok;
    expect(h.state.stats()).toEqual({ restored: 'fresh' });
    expect(h.state.isRestorePending()).toBe(true);

    const failed = h.state.refreshStatsAsync();
    h.scans[1].gate.reject(Object.assign(new Error('x'), { code: 'A9_X' }));
    await failed;
    expect(h.state.stats()).toEqual({ deferred: true, note: '历史上下文统计暂未刷新（A9_X）。' });

    const stale = h.state.refreshStatsAsync();
    h.state.invalidateScope();
    h.scans[2].gate.resolve(context('old'));
    await stale;
    expect(h.state.stats()).toEqual({ deferred: true, note: '历史上下文统计暂未刷新（A9_X）。' });
  });

  test('the runtime keeps no loose Provider context flags', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../product/a9-agent-runtime.js'), 'utf8');
    expect(source).not.toMatch(/\bproviderContextRestorePending\b|\bpendingConversationHistory\b|\brestoredContext\b|\bproviderContextEpoch\b|\binvalidateProviderContextScope\b/);
  });
});
