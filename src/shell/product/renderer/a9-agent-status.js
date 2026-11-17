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
// TRANSITIONS below encodes these edges and the runtime enforces them fail-closed
// (illegal edge => A9_AGENT_STATUS_TRANSITION_ILLEGAL); startup/conversation-switch
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

  // Explicit finite transition table (C2, fail-closed). Every status lists the
  // statuses it may move to; a self transition is idempotent and always legal.
  //   - resting (idle/completed/cancelled/failure/interrupted): starts a turn, or ends in failure/interruption;
  //   - running: ends in any outcome or is cancelled; it never silently returns to idle;
  //   - cancelling: only ends in an outcome (or failure/interruption);
  //   - awaiting the user: a decision/reply resumes; Stop aborts an approval-bound office
  //     selection; closing the workspace cancels the pending operation without running it.
  // A failure (unexpected error, audit persistence) or a broken continuation can end any phase.
  const RESTING_TARGETS = Object.freeze(['running', 'failed', 'interrupted']);
  const TRANSITIONS = Object.freeze({
    idle: RESTING_TARGETS,
    completed: RESTING_TARGETS,
    completed_with_warnings: RESTING_TARGETS,
    cancelled: RESTING_TARGETS,
    failed: Object.freeze(['running', 'interrupted']),
    blocked: RESTING_TARGETS,
    stuck: RESTING_TARGETS,
    budget_exceeded: RESTING_TARGETS,
    interrupted: Object.freeze(['running', 'failed']),
    running: Object.freeze(['cancelling', 'completed', 'completed_with_warnings', 'cancelled', 'needs_approval',
      'needs_input', 'failed', 'blocked', 'stuck', 'budget_exceeded', 'interrupted']),
    cancelling: Object.freeze(['completed', 'completed_with_warnings', 'cancelled', 'needs_approval',
      'needs_input', 'failed', 'blocked', 'stuck', 'budget_exceeded', 'interrupted']),
    needs_approval: Object.freeze(['running', 'cancelling', 'cancelled', 'needs_input', 'failed', 'interrupted']),
    needs_input: Object.freeze(['running', 'cancelling', 'cancelled', 'needs_approval', 'failed', 'interrupted']),
  });

  /**
   * Transition contract for setAgentStatus. The runtime enforces it fail-closed:
   * an illegal edge throws A9_AGENT_STATUS_TRANSITION_ILLEGAL (see transitionError)
   * and leaves the current status untouched. Resynchronization from durable facts
   * (startup, conversation switch, recovered pending question) is not a transition
   * and bypasses this table.
   */
  function canTransition(from, to) {
    if (!isKnown(to) || !isKnown(from)) return false;
    if (from === to) return true;
    return TRANSITIONS[from].includes(to);
  }

  /** Statuses reachable from `from` in one step (excluding the idempotent self edge). */
  function allowedTargets(from) { return isKnown(from) ? TRANSITIONS[from].slice() : []; }

  /**
   * Structured, secret-free error for an illegal transition. `context` carries
   * scene diagnostics (short scalar facts only); it is never serialized from user content.
   */
  function transitionError(from, to, context) {
    const error = new Error(`A9_AGENT_STATUS_TRANSITION_ILLEGAL: ${String(from)} -> ${String(to)}`);
    error.code = 'A9_AGENT_STATUS_TRANSITION_ILLEGAL';
    error.diagnostics = Object.freeze({
      from: String(from), to: String(to), fromKnown: isKnown(from), toKnown: isKnown(to),
      allowed: allowedTargets(from), ...(context || {}),
    });
    return error;
  }

  /** Throws transitionError unless from -> to is a legal edge. */
  function assertTransition(from, to, context) {
    if (!canTransition(from, to)) throw transitionError(from, to, context);
  }

  const api = Object.freeze({ PHASE, STATUSES, OUTCOMES, TRANSITIONS, isKnown, phaseOf, isActive, isAwaitingUser, isFailure, canTransition, allowedTargets, transitionError, assertTransition });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.win7AgentStatus = api;
}(typeof window === 'object' ? window : globalThis));
