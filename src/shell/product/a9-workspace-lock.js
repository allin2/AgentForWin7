'use strict';
// Workspace single-writer lock lifecycle (multi-window) for one A9 runtime.
// It replaces the former lockHeld/workspaceLockReleased flag pair, so every
// caller asks one question ("is the lock usable?") the same way.
//
//   unlocked ──retry() acquires──▶ acquired
//   unlocked|acquired ──release()──▶ released   (terminal; release is idempotent)
//
// unlocked: another live process holds the SQLite row; retry() may take it later.
// acquired: this runtime may write the workspace.
// released: shutdown gave the lock back; nothing re-acquires it in this runtime.
const LOCK_STATE = Object.freeze({ UNLOCKED: 'unlocked', ACQUIRED: 'acquired', RELEASED: 'released' });

/**
 * @param {{ acquire: () => { acquired?: boolean, holder?: string },
 *   release: (options?: object) => void | { released: boolean, blockers?: string[], reason?: string } }} port
 *   acquire runs persistence.acquireWorkspaceLock; release runs the persistence release.
 *   A release result with released=false means the row was kept: the lock stays acquired.
 */
function createWorkspaceLock(port) {
  let state = LOCK_STATE.UNLOCKED;
  let lastAttempt = { acquired: false };
  // The legacy retry returned the last acquisition result even after release.
  // Kept so ensureRuntime keeps its historic answer during shutdown.
  let heldAtRelease = false;
  function attempt() {
    lastAttempt = port.acquire() || { acquired: false };
    state = lastAttempt.acquired === true ? LOCK_STATE.ACQUIRED : LOCK_STATE.UNLOCKED;
  }
  attempt();
  return Object.freeze({
    get state() { return state; },
    /** Holder reported by the latest acquisition attempt (this owner when acquired). */
    get holder() { return lastAttempt.holder; },
    /** The lock is ours and has not been released: writes are allowed. */
    isHeld() { return state === LOCK_STATE.ACQUIRED; },
    isReleased() { return state === LOCK_STATE.RELEASED; },
    /** Retries only from unlocked. Returns whether the lock was acquired (see heldAtRelease). */
    retry() {
      if (state === LOCK_STATE.UNLOCKED) attempt();
      return state === LOCK_STATE.ACQUIRED || (state === LOCK_STATE.RELEASED && heldAtRelease);
    },
    /** Gives the persisted lock back once; later calls are no-ops. A refused release keeps it held. */
    release(options) {
      if (state === LOCK_STATE.RELEASED) return { released: true };
      const held = state === LOCK_STATE.ACQUIRED;
      if (held) {
        const outcome = port.release(options);
        if (outcome && outcome.released === false) {
          return { released: false, blockers: Array.isArray(outcome.blockers) ? [...outcome.blockers] : [],
            ...(typeof outcome.reason === 'string' ? { reason: outcome.reason } : {}) };
        }
      }
      heldAtRelease = held;
      state = LOCK_STATE.RELEASED;
      return { released: true };
    },
  });
}

module.exports = { LOCK_STATE, createWorkspaceLock };
