'use strict';
// Provider context restore lifecycle for one A9 runtime (A9-66 F-007).
// Owns what used to be the loose providerContextRestorePending /
// pendingConversationHistory / restoredContext / epoch / abort / in-flight
// variables, so the runtime asks for transitions instead of flipping flags.
//
//   pending ──ensureRestoredAsync()──▶ restoring ──scope unchanged──▶ ready
//   restoring ──failure / cancel / stale scope──▶ pending   (cache untouched; a later call retries)
//   ready|restoring|pending ──requireRestore()──▶ pending   (conversation switch, Provider state transfer)
//   any ──invalidateScope()──▶ same phase, new epoch       (in-flight work becomes stale)
//
// Invalidation is an event, not a resting phase: it bumps the scope epoch and
// aborts in-flight scans, after which a restoring phase reads as pending again.
//
// The carry-over history is the Provider-visible conversation the next loop
// receives once (model/shell/mode switch keeps it, a Base URL change drops it).
const PHASE = Object.freeze({ PENDING: 'pending', RESTORING: 'restoring', READY: 'ready' });
const DEFERRED_NOTE = '历史上下文将在首次任务前恢复。';

function deferredContext(note = DEFERRED_NOTE) {
  return { messages: [], stats: { deferred: true, note } };
}
function staleScopeError() {
  return Object.assign(new Error('A9_SCOPE_STALE'), { code: 'A9_SCOPE_STALE' });
}

/**
 * @param {{
 *   currentSessionId: () => string,
 *   isShutdownRequested: () => boolean,
 *   restoreSync: (sessionId: string) => { messages: unknown[], stats: object },
 *   restoreAsync: (sessionId: string, signal: { aborted: boolean }) => Promise<{ messages: unknown[], stats: object }>,
 * }} port
 */
function createProviderContextState(port) {
  let restorePending = true;
  let epoch = 0;
  // The signal also reads shutdown, so an in-flight scan stops at its next batch on close.
  const newAbort = () => ({ stale: false, get aborted() { return this.stale || port.isShutdownRequested(); } });
  let abort = newAbort();
  let inFlight = null;
  let restoredContext = deferredContext();
  let carryOverHistory = null;

  function scopeUnchanged(scopeEpoch, sessionId) {
    return scopeEpoch === epoch && sessionId === port.currentSessionId();
  }
  function commit(context) {
    restoredContext = context;
    carryOverHistory = context.messages;
    restorePending = false;
  }
  function phase() {
    if (!restorePending) return PHASE.READY;
    return inFlight && inFlight.epoch === epoch && inFlight.sessionId === port.currentSessionId() ? PHASE.RESTORING : PHASE.PENDING;
  }
  /** New scope epoch: in-flight work is aborted and its late result is dropped. */
  function invalidateScope() {
    epoch += 1;
    abort.stale = true;
    abort = newAbort();
    inFlight = null;
  }
  /**
   * The next entry must restore from SQLite again. A conversation switch also
   * drops the carry-over history and shows the deferred statistics.
   */
  function requireRestore({ resetContext = false } = {}) {
    invalidateScope();
    restorePending = true;
    if (resetContext) {
      carryOverHistory = null;
      restoredContext = deferredContext();
    }
  }
  /** Legacy synchronous path (non-paged getSnapshot, schemaVersion<7). */
  function ensureRestoredSync() {
    if (!restorePending) return;
    commit(port.restoreSync(port.currentSessionId()));
  }
  /** Shared, scope-bound initialization promise; failure/cancel leaves the cache untouched so a later call retries. */
  function ensureRestoredAsync() {
    if (!restorePending) return Promise.resolve();
    const sessionId = port.currentSessionId();
    const scopeEpoch = epoch;
    if (inFlight && inFlight.epoch === scopeEpoch && inFlight.sessionId === sessionId) return inFlight.promise;
    const signal = abort;
    const entry = { epoch: scopeEpoch, sessionId, promise: null };
    entry.promise = (async () => {
      let context;
      try { context = await port.restoreAsync(sessionId, signal); }
      catch (error) {
        if (!scopeUnchanged(scopeEpoch, sessionId)) throw staleScopeError();
        throw error;
      }
      if (!scopeUnchanged(scopeEpoch, sessionId) || port.isShutdownRequested()) throw staleScopeError();
      commit(context);
    })();
    const clear = () => { if (inFlight === entry) inFlight = null; };
    entry.promise.then(clear, clear);
    inFlight = entry;
    return entry.promise;
  }
  /** Recomputes only the displayed statistics (after a Turn or a generation change). Never throws. */
  async function refreshStatsAsync() {
    const sessionId = port.currentSessionId();
    const scopeEpoch = epoch;
    try {
      const context = await port.restoreAsync(sessionId, abort);
      if (scopeUnchanged(scopeEpoch, sessionId)) restoredContext = context;
    } catch (error) {
      if (!scopeUnchanged(scopeEpoch, sessionId)) return;
      restoredContext = deferredContext(`历史上下文统计暂未刷新（${error && error.code ? error.code : 'A9_CONTEXT_STATS_REFRESH_FAILED'}）。`);
    }
  }

  return Object.freeze({
    phase,
    /** True until a restore for the current scope has committed (pending or restoring). */
    isRestorePending: () => restorePending,
    invalidateScope,
    requireRestore,
    ensureRestoredSync,
    ensureRestoredAsync,
    refreshStatsAsync,
    /** Statistics shown in the snapshot's contextWindow. */
    stats: () => restoredContext.stats,
    /** Replaces the displayed statistics with a deferred note (statistics refresh follows). */
    showDeferredStats(note) { restoredContext = deferredContext(note); },
    carryOverHistory: () => carryOverHistory,
    setCarryOverHistory(history) { carryOverHistory = history; },
    /** Hands a non-empty carry-over history to a new loop exactly once. */
    takeCarryOverHistory() {
      if (!carryOverHistory || carryOverHistory.length === 0) return null;
      const history = carryOverHistory;
      carryOverHistory = null;
      return history;
    },
  });
}

module.exports = { PHASE, DEFERRED_NOTE, createProviderContextState };
