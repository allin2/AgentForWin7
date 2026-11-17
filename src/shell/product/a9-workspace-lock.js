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
 * @param {{ acquire: () => { acquired?: boolean, holder?: string }, release: () => void }} port
 *   acquire runs persistence.acquireWorkspaceLock; release runs persistence.releaseWorkspaceLock.
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
    /** Gives the persisted lock back once; later calls are no-ops. */
    release() {
      if (state === LOCK_STATE.RELEASED) return;
      heldAtRelease = state === LOCK_STATE.ACQUIRED;
      if (heldAtRelease) port.release();
      state = LOCK_STATE.RELEASED;
    },
  });
}

module.exports = { LOCK_STATE, createWorkspaceLock };
