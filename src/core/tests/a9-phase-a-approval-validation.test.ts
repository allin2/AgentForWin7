/**
 * Phase A7（H-P2-10）：core 先校验审批 digest，校验通过后才通知宿主落库（onValidated）。
 * 校验失败路径绝不触发 onValidated，因此宿主不会留下“已批准但未执行”的审计。
 */
import {
  A9AgentLoop,
  A9ModelPort,
  A9RunnerPort,
  A9WorkspacePort,
  PermissionMode,
  TurnOutcome,
} from '../src';

describe('Phase A7: approval validation precedes persistence', () => {
  let workspace: A9WorkspacePort;
  let runner: A9RunnerPort;

  beforeEach(() => {
    workspace = {
      list: jest.fn().mockResolvedValue({ totalEntries: 0, entries: [] }),
      read: jest.fn().mockResolvedValue({ content: 'ok' }),
      search: jest.fn().mockResolvedValue({ totalMatches: 0, matches: [] }),
      write: jest.fn().mockResolvedValue({ bytesWritten: 1, created: true }),
      edit: jest.fn().mockResolvedValue({ replaced: true }),
      copy: jest.fn().mockResolvedValue({ copied: true }),
      move: jest.fn().mockResolvedValue({ moved: true }),
      delete: jest.fn().mockResolvedValue({ deleted: true }),
    };
    runner = { execute: jest.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false }) };
  });

  async function suspendedLoop() {
    const provider: A9ModelPort = {
      sendStreamRequest: jest.fn()
        .mockResolvedValueOnce({ id: 'r1', content: '', finishReason: 'tool_calls',
          toolCalls: [{ id: 'tc-push', name: 'shell', arguments: JSON.stringify({ command: 'git push origin main' }) }] })
        .mockResolvedValue({ id: 'done', content: 'done', finishReason: 'stop' }),
    };
    const loop = new A9AgentLoop({ workspaceRoot: '/test/workspace', provider, workspaceService: workspace, runner,
      permissionMode: PermissionMode.FULL_ACCESS });
    const first = await loop.runTurn('push');
    expect(first.outcome).toBe(TurnOutcome.NEEDS_APPROVAL);
    return { loop, approval: first.pendingApproval! };
  }

  it('calls onValidated after validation and before the approved tool executes', async () => {
    const { loop, approval } = await suspendedLoop();
    const order: string[] = [];
    (runner.execute as jest.Mock).mockImplementation(async () => {
      order.push('execute');
      return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
    });
    await loop.resumeAfterApproval(
      { approvalId: approval.approvalId, decision: 'approved', bindingDigest: approval.bindingDigest },
      { onValidated: (decision) => { order.push(`validated:${decision}`); } },
    );
    expect(order).toEqual(['validated:approved', 'execute']);
  });

  it('calls onValidated for a denial too, and never executes the tool', async () => {
    const { loop, approval } = await suspendedLoop();
    const onValidated = jest.fn();
    await loop.resumeAfterApproval(
      { approvalId: approval.approvalId, decision: 'denied', bindingDigest: approval.bindingDigest },
      { onValidated },
    );
    expect(onValidated).toHaveBeenCalledWith('denied');
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it('never calls onValidated when the bindingDigest does not match, and keeps the approval pending', async () => {
    const { loop, approval } = await suspendedLoop();
    const onValidated = jest.fn();
    await expect(loop.resumeAfterApproval(
      { approvalId: approval.approvalId, decision: 'approved', bindingDigest: 'f'.repeat(64) },
      { onValidated },
    )).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(onValidated).not.toHaveBeenCalled();
    expect(runner.execute).not.toHaveBeenCalled();

    // 挂起未被消费：用正确 digest 仍可恢复。
    await loop.resumeAfterApproval({ approvalId: approval.approvalId, decision: 'approved', bindingDigest: approval.bindingDigest });
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });

  it('never calls onValidated for a wrong approvalId', async () => {
    const { loop, approval } = await suspendedLoop();
    const onValidated = jest.fn();
    await expect(loop.resumeAfterApproval(
      { approvalId: 'other-approval', decision: 'approved', bindingDigest: approval.bindingDigest },
      { onValidated },
    )).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(onValidated).not.toHaveBeenCalled();
  });

  it('aborts without executing or consuming the suspension when the host persistence callback throws', async () => {
    const { loop, approval } = await suspendedLoop();
    await expect(loop.resumeAfterApproval(
      { approvalId: approval.approvalId, decision: 'approved', bindingDigest: approval.bindingDigest },
      { onValidated: () => { throw new Error('SQLITE_BUSY'); } },
    )).rejects.toThrow('SQLITE_BUSY');
    expect(runner.execute).not.toHaveBeenCalled();

    await loop.resumeAfterApproval({ approvalId: approval.approvalId, decision: 'approved', bindingDigest: approval.bindingDigest });
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });
});
