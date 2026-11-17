'use strict';
// Single source of truth for the A9 agent turn lifecycle (snapshot.agentStatus).
// Loaded by the main runtime (require) and the workbench renderer (<script>),
// so both sides classify the same status the same way.
//
// Lifecycle (who sets what lives in a9-agent-runtime.js setAgentStatus calls):
//   idle ──submit/continue──▶ running ──cancel──▶ cancelling
//   running|cancelling ──turn ends──▶ <TurnOutcome> (completed, needs_approval, failed, …)
//   needs_approval ──decision──▶ running        needs_input ──reply──▶ running
//   any ──restart/continue failure──▶ interrupted        any ──unexpected error──▶ failed
// canTransition() below encodes these edges; startup/conversation-switch
// resynchronization from durable facts bypasses it.
// Statuses beyond idle/running/cancelling/interrupted mirror core TurnOutcome
// (src/core/src/loop-control.ts); persisted task status comes from
// statusesForOutcome in the runtime, which maps every FAILURE status to 'failed'.
(function expose(root) {
  const PHASE = Object.freeze({
    IDLE: 'idle',
    ACTIVE: 'active',
    AWAITING_USER: 'awaiting_user',
    INTERRUPTED: 'interrupted',
    FAILED: 'failed',
  });
  const PHASE_BY_STATUS = Object.freeze({
    idle: PHASE.IDLE,
    completed: PHASE.IDLE,
    completed_with_warnings: PHASE.IDLE,
    cancelled: PHASE.IDLE,
    running: PHASE.ACTIVE,
    cancelling: PHASE.ACTIVE,
    needs_approval: PHASE.AWAITING_USER,
    needs_input: PHASE.AWAITING_USER,
    interrupted: PHASE.INTERRUPTED,
    failed: PHASE.FAILED,
    blocked: PHASE.FAILED,
    stuck: PHASE.FAILED,
    budget_exceeded: PHASE.FAILED,
  });
  const STATUSES = Object.freeze(Object.keys(PHASE_BY_STATUS));

  function isKnown(status) { return Object.prototype.hasOwnProperty.call(PHASE_BY_STATUS, status); }
  // Unknown or missing statuses read as idle, matching the renderer's historic fallback.
  function phaseOf(status) { return isKnown(status) ? PHASE_BY_STATUS[status] : PHASE.IDLE; }
  /** A turn holds the controller: running or cancelling. */
  function isActive(status) { return phaseOf(status) === PHASE.ACTIVE; }
  /** The turn is paused on the user: an approval or a question. */
  function isAwaitingUser(status) { return phaseOf(status) === PHASE.AWAITING_USER; }
  /** The last turn ended in a failure outcome (failed, blocked, stuck, budget_exceeded). */
  function isFailure(status) { return phaseOf(status) === PHASE.FAILED; }

  // Statuses a finished or paused turn reports (core TurnOutcome); the runtime-only
  // ones (idle/running/cancelling/interrupted) are excluded.
  const OUTCOMES = Object.freeze(STATUSES.filter((s) => !['idle', 'running', 'cancelling', 'interrupted'].includes(s)));

  /**
   * Transition contract for setAgentStatus. Observational: the runtime reports a
   * violation (config.agentStatusObserver) but never blocks it, so network
   * retries, Stop and self-healing paths keep their historic behavior.
   * Resynchronization from durable facts (startup, conversation switch,
   * recovered pending question) is not a transition and bypasses this table.
   */
  function canTransition(from, to) {
    if (!isKnown(to)) return false;
    if (from === to) return true;
    // A failure (unexpected error, audit persistence) or a broken continuation can end any phase.
    if (to === 'failed' || to === 'interrupted') return true;
    switch (phaseOf(from)) {
      // running ends in an outcome or is cancelled; it never silently returns to idle.
      case PHASE.ACTIVE: return from === 'running' ? to !== 'idle' : OUTCOMES.includes(to);
      // A decision or reply resumes; Stop aborts an approval-bound office selection;
      // closing the workspace cancels the pending operation without running it.
      case PHASE.AWAITING_USER: return ['running', 'cancelling', 'cancelled', 'needs_approval', 'needs_input'].includes(to);
      // idle, failure and interrupted phases start (or continue) a turn.
      default: return to === 'running';
    }
  }

  const api = Object.freeze({ PHASE, STATUSES, OUTCOMES, isKnown, phaseOf, isActive, isAwaitingUser, isFailure, canTransition });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.win7AgentStatus = api;
}(typeof window === 'object' ? window : globalThis));
