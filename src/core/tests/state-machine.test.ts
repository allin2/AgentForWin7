/**
 * @module state-machine.test
 * @description 状态机模块测试 — 覆盖所有合法转移、非法转移拒绝、可用转移查询
 */

import {
  transition,
  canTransition,
  getAvailableTransitions,
  getAvailableTriggers,
  isTerminalState,
  TransitionTrigger,
} from '../src/state-machine';
import { AgentState } from '../src/types';
import { AgentError, AgentErrorCode } from '../src/errors';

describe('state-machine', () => {
  describe('transition()', () => {
    // IDLE 出发的合法转移
    it('IDLE → PLANNING (start_planning)', () => {
      const result = transition(AgentState.IDLE, 'start_planning');
      expect(result.from).toBe(AgentState.IDLE);
      expect(result.to).toBe(AgentState.PLANNING);
      expect(result.trigger).toBe('start_planning');
      expect(result.timestamp).toBeDefined();
    });

    it('IDLE → CANCELLED (cancel)', () => {
      const result = transition(AgentState.IDLE, 'cancel');
      expect(result.to).toBe(AgentState.CANCELLED);
    });

    it('IDLE → FAILED when Turn startup persistence fails', () => {
      const result = transition(AgentState.IDLE, 'execution_failed');
      expect(result.to).toBe(AgentState.FAILED);
    });

    // PLANNING 出发的合法转移
    it('PLANNING → AWAITING_APPROVAL (submit_for_approval)', () => {
      const result = transition(AgentState.PLANNING, 'submit_for_approval');
      expect(result.to).toBe(AgentState.AWAITING_APPROVAL);
    });

    it('PLANNING → PAUSED (pause)', () => {
      const result = transition(AgentState.PLANNING, 'pause');
      expect(result.to).toBe(AgentState.PAUSED);
    });

    it('PLANNING → CANCELLED (cancel)', () => {
      const result = transition(AgentState.PLANNING, 'cancel');
      expect(result.to).toBe(AgentState.CANCELLED);
    });

    it('PLANNING → FAILED (execution_failed)', () => {
      const result = transition(AgentState.PLANNING, 'execution_failed');
      expect(result.to).toBe(AgentState.FAILED);
    });

    // AWAITING_APPROVAL 出发的合法转移
    it('AWAITING_APPROVAL → EXECUTING (approval_granted)', () => {
      const result = transition(AgentState.AWAITING_APPROVAL, 'approval_granted');
      expect(result.to).toBe(AgentState.EXECUTING);
    });

    it('AWAITING_APPROVAL → PLANNING (approval_rejected)', () => {
      const result = transition(AgentState.AWAITING_APPROVAL, 'approval_rejected');
      expect(result.to).toBe(AgentState.PLANNING);
    });

    it('AWAITING_APPROVAL → CANCELLED (cancel)', () => {
      const result = transition(AgentState.AWAITING_APPROVAL, 'cancel');
      expect(result.to).toBe(AgentState.CANCELLED);
    });

    // EXECUTING 出发的合法转移
    it('EXECUTING → VERIFYING (execution_complete)', () => {
      const result = transition(AgentState.EXECUTING, 'execution_complete');
      expect(result.to).toBe(AgentState.VERIFYING);
    });

    it('EXECUTING → AWAITING_APPROVAL when a later Step proposes a write', () => {
      const result = transition(AgentState.EXECUTING, 'submit_for_approval');
      expect(result.to).toBe(AgentState.AWAITING_APPROVAL);
    });

    it('VERIFYING → COMPLETED only after verification_passed', () => {
      const result = transition(AgentState.VERIFYING, 'verification_passed');
      expect(result.to).toBe(AgentState.COMPLETED);
    });

    it('VERIFYING → FAILED after verification_failed', () => {
      const result = transition(AgentState.VERIFYING, 'verification_failed');
      expect(result.to).toBe(AgentState.FAILED);
    });

    it('VERIFYING → EXECUTING when verification feedback requests a repair', () => {
      const result = transition(AgentState.VERIFYING, 'verification_repair_requested');
      expect(result.to).toBe(AgentState.EXECUTING);
    });

    it('EXECUTING → FAILED (execution_failed)', () => {
      const result = transition(AgentState.EXECUTING, 'execution_failed');
      expect(result.to).toBe(AgentState.FAILED);
    });

    it('EXECUTING → PAUSED (pause)', () => {
      const result = transition(AgentState.EXECUTING, 'pause');
      expect(result.to).toBe(AgentState.PAUSED);
    });

    it('EXECUTING → CANCELLED (cancel)', () => {
      const result = transition(AgentState.EXECUTING, 'cancel');
      expect(result.to).toBe(AgentState.CANCELLED);
    });

    // PAUSED 出发的合法转移
    it('PAUSED → PLANNING (resume)', () => {
      const result = transition(AgentState.PAUSED, 'resume');
      expect(result.to).toBe(AgentState.PLANNING);
    });

    it('PAUSED → CANCELLED (cancel)', () => {
      const result = transition(AgentState.PAUSED, 'cancel');
      expect(result.to).toBe(AgentState.CANCELLED);
    });

    // 非法转移拒绝
    it('拒绝 IDLE → EXECUTING（非法转移）', () => {
      expect(() => transition(AgentState.IDLE, 'approval_granted')).toThrow(AgentError);
      try {
        transition(AgentState.IDLE, 'approval_granted');
      } catch (e) {
        expect(e).toBeInstanceOf(AgentError);
        expect((e as AgentError).code).toBe(AgentErrorCode.INVALID_STATE_TRANSITION);
      }
    });

    it('拒绝 COMPLETED → 任何状态（终态无转移）', () => {
      expect(() => transition(AgentState.COMPLETED, 'start_planning')).toThrow(AgentError);
    });

    it('拒绝 FAILED → 任何状态（终态无转移）', () => {
      expect(() => transition(AgentState.FAILED, 'cancel')).toThrow(AgentError);
    });

    it('拒绝 CANCELLED → 任何状态（终态无转移）', () => {
      expect(() => transition(AgentState.CANCELLED, 'resume')).toThrow(AgentError);
    });

    // 带 metadata 的转移
    it('转移可携带 metadata', () => {
      const result = transition(AgentState.IDLE, 'start_planning', { reason: 'user request' });
      expect(result.metadata).toEqual({ reason: 'user request' });
    });
  });

  describe('canTransition()', () => {
    it('IDLE → PLANNING 允许', () => {
      expect(canTransition(AgentState.IDLE, AgentState.PLANNING)).toBe(true);
    });

    it('IDLE → EXECUTING 不允许', () => {
      expect(canTransition(AgentState.IDLE, AgentState.EXECUTING)).toBe(false);
    });

    it('PLANNING → PAUSED 允许', () => {
      expect(canTransition(AgentState.PLANNING, AgentState.PAUSED)).toBe(true);
    });

    it('COMPLETED → 任何状态不允许', () => {
      expect(canTransition(AgentState.COMPLETED, AgentState.IDLE)).toBe(false);
      expect(canTransition(AgentState.COMPLETED, AgentState.PLANNING)).toBe(false);
    });

    it('PAUSED → PLANNING 允许', () => {
      expect(canTransition(AgentState.PAUSED, AgentState.PLANNING)).toBe(true);
    });
  });

  describe('getAvailableTransitions()', () => {
    it('IDLE 可达 [PLANNING, FAILED, CANCELLED]', () => {
      const targets = getAvailableTransitions(AgentState.IDLE);
      expect(targets).toContain(AgentState.PLANNING);
      expect(targets).toContain(AgentState.FAILED);
      expect(targets).toContain(AgentState.CANCELLED);
      expect(targets).toHaveLength(3);
    });

    it('PLANNING 可达审批、直接执行、暂停、取消或失败', () => {
      const targets = getAvailableTransitions(AgentState.PLANNING);
      expect(targets).toContain(AgentState.AWAITING_APPROVAL);
      expect(targets).toContain(AgentState.EXECUTING);
      expect(targets).toContain(AgentState.PAUSED);
      expect(targets).toContain(AgentState.CANCELLED);
      expect(targets).toContain(AgentState.FAILED);
      expect(targets).toHaveLength(5);
    });

    it('EXECUTING 可达审批、验证、失败、暂停或取消', () => {
      const targets = getAvailableTransitions(AgentState.EXECUTING);
      expect(targets).toContain(AgentState.AWAITING_APPROVAL);
      expect(targets).toContain(AgentState.VERIFYING);
      expect(targets).toContain(AgentState.FAILED);
      expect(targets).toContain(AgentState.PAUSED);
      expect(targets).toContain(AgentState.CANCELLED);
      expect(targets).toHaveLength(5);
    });

    it('VERIFYING can complete, fail, request a repair, or cancel', () => {
      const targets = getAvailableTransitions(AgentState.VERIFYING);
      expect(targets).toEqual([
        AgentState.COMPLETED,
        AgentState.FAILED,
        AgentState.EXECUTING,
        AgentState.CANCELLED,
      ]);
    });

    it('COMPLETED 无可达状态', () => {
      expect(getAvailableTransitions(AgentState.COMPLETED)).toHaveLength(0);
    });

    it('FAILED 无可达状态', () => {
      expect(getAvailableTransitions(AgentState.FAILED)).toHaveLength(0);
    });

    it('CANCELLED 无可达状态', () => {
      expect(getAvailableTransitions(AgentState.CANCELLED)).toHaveLength(0);
    });
  });

  describe('getAvailableTriggers()', () => {
    it('IDLE 可用触发 [start_planning, cancel]', () => {
      const triggers = getAvailableTriggers(AgentState.IDLE);
      expect(triggers).toContain('start_planning');
      expect(triggers).toContain('cancel');
    });

    it('终态无可用触发', () => {
      expect(getAvailableTriggers(AgentState.COMPLETED)).toHaveLength(0);
      expect(getAvailableTriggers(AgentState.FAILED)).toHaveLength(0);
      expect(getAvailableTriggers(AgentState.CANCELLED)).toHaveLength(0);
    });
  });

  describe('isTerminalState()', () => {
    it('COMPLETED 是终态', () => {
      expect(isTerminalState(AgentState.COMPLETED)).toBe(true);
    });

    it('FAILED 是终态', () => {
      expect(isTerminalState(AgentState.FAILED)).toBe(true);
    });

    it('CANCELLED 是终态', () => {
      expect(isTerminalState(AgentState.CANCELLED)).toBe(true);
    });

    it('IDLE 不是终态', () => {
      expect(isTerminalState(AgentState.IDLE)).toBe(false);
    });

    it('EXECUTING 不是终态', () => {
      expect(isTerminalState(AgentState.EXECUTING)).toBe(false);
    });

    it('VERIFYING 不是终态', () => {
      expect(isTerminalState(AgentState.VERIFYING)).toBe(false);
    });

    it('PAUSED 不是终态', () => {
      expect(isTerminalState(AgentState.PAUSED)).toBe(false);
    });
  });
});

describe('state-machine strict fail-closed contract (Phase C / C2)', () => {
  const ALL_STATES = Object.values(AgentState) as AgentState[];
  const ALL_TRIGGERS: TransitionTrigger[] = [
    'start_planning', 'submit_for_approval', 'plan_ready', 'approval_granted', 'approval_rejected',
    'execution_complete', 'execution_failed', 'verification_passed', 'verification_failed',
    'verification_repair_requested', 'pause', 'resume', 'cancel',
  ];

  it('每个 (状态, 触发) 组合要么命中转移表，要么以结构化 INVALID_STATE_TRANSITION 拒绝', () => {
    let accepted = 0;
    let rejected = 0;
    for (const from of ALL_STATES) {
      const availableTriggers = getAvailableTriggers(from);
      for (const trigger of ALL_TRIGGERS) {
        if (availableTriggers.includes(trigger)) {
          const result = transition(from, trigger);
          expect(result.from).toBe(from);
          expect(canTransition(from, result.to)).toBe(true);
          expect(getAvailableTransitions(from)).toContain(result.to);
          accepted += 1;
        } else {
          let caught: unknown;
          try { transition(from, trigger); } catch (error) { caught = error; }
          expect(caught).toBeInstanceOf(AgentError);
          const error = caught as AgentError;
          expect(error.code).toBe(AgentErrorCode.INVALID_STATE_TRANSITION);
          // 现场诊断：源状态、触发事件与当时可用转移必须保留。
          expect(error.context).toEqual({ from, trigger, available: getAvailableTransitions(from) });
          rejected += 1;
        }
      }
    }
    expect(accepted + rejected).toBe(ALL_STATES.length * ALL_TRIGGERS.length);
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(accepted);
  });

  it('终态没有任何出边，且每个终态的全部触发都被拒绝', () => {
    for (const state of ALL_STATES.filter(isTerminalState)) {
      expect(getAvailableTriggers(state)).toEqual([]);
      expect(getAvailableTransitions(state)).toEqual([]);
      for (const trigger of ALL_TRIGGERS) expect(() => transition(state, trigger)).toThrow(AgentError);
      for (const target of ALL_STATES) expect(canTransition(state, target)).toBe(false);
    }
  });

  it('非终态都有出边，不存在无法离开的隐式死状态', () => {
    for (const state of ALL_STATES.filter((item) => !isTerminalState(item))) {
      expect(getAvailableTriggers(state).length).toBeGreaterThan(0);
    }
  });

  it('拒绝未知触发事件与未知状态，不静默放行', () => {
    expect(() => transition(AgentState.IDLE, 'teleport' as TransitionTrigger)).toThrow(AgentError);
    let caught: unknown;
    try { transition('bogus' as AgentState, 'cancel'); } catch (error) { caught = error; }
    expect((caught as AgentError).code).toBe(AgentErrorCode.INVALID_STATE_TRANSITION);
    expect((caught as AgentError).context).toEqual({ from: 'bogus', trigger: 'cancel' });
    expect(canTransition('bogus' as AgentState, AgentState.IDLE)).toBe(false);
    expect(getAvailableTransitions('bogus' as AgentState)).toEqual([]);
  });

  it('主线 IDLE → PLANNING → AWAITING_APPROVAL → EXECUTING → VERIFYING → COMPLETED 逐步合法，跳步被拒绝', () => {
    let state = AgentState.IDLE;
    const line: Array<[TransitionTrigger, AgentState]> = [
      ['start_planning', AgentState.PLANNING], ['submit_for_approval', AgentState.AWAITING_APPROVAL],
      ['approval_granted', AgentState.EXECUTING], ['execution_complete', AgentState.VERIFYING],
      ['verification_passed', AgentState.COMPLETED],
    ];
    for (const [trigger, expected] of line) {
      state = transition(state, trigger).to;
      expect(state).toBe(expected);
    }
    expect(() => transition(AgentState.IDLE, 'verification_passed')).toThrow(AgentError);
    expect(() => transition(AgentState.PLANNING, 'verification_passed')).toThrow(AgentError);
    expect(() => transition(AgentState.EXECUTING, 'verification_passed')).toThrow(AgentError);
  });

  it('拒绝不会产生转移记录，调用方只能拿到异常', () => {
    const attempts: unknown[] = [];
    for (const trigger of ALL_TRIGGERS) {
      try { attempts.push(transition(AgentState.COMPLETED, trigger)); } catch { /* 预期拒绝 */ }
    }
    expect(attempts).toEqual([]);
  });
});
