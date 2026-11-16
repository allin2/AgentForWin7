import { A9AgentLoop } from '../src/a9-agent-loop';
import { ApprovalLevel, PermissionMode, PolicyVerdict } from '../src/types';
import { PolicyEngine } from '../src/policy';
import { OFFICE_WRITE_TOOLS } from '../src/a9-office-tools';

function fixture(mode = PermissionMode.FULL_ACCESS, policyEngine?: PolicyEngine, args: any = { request: '{"planId":"plan-1"}' }) {
  let request = 0, revision = 1, stale = false;
  const port = {
    supportedTools: ['batch_organize', 'workspace_scan_metadata'],
    read: jest.fn(async () => ({ entries: [] })),
    prepare: jest.fn(async () => { if (stale) throw new Error('BATCH_SOURCE_DRIFT'); return {
      summary: `源.txt -> 整理/目标.txt，源 SHA ${String(revision).repeat(64)}`,
      bindingSha256: String(revision).repeat(64),
    }; }),
    execute: jest.fn(async () => ({ status: 'completed' })),
  };
  const loop = new A9AgentLoop({ workspaceRoot: '/workspace', permissionMode: mode, policyEngine,
    workspaceService: {} as any, runner: {} as any, officeWorkflow: port,
    provider: { sendStreamRequest: jest.fn(async () => ++request === 1
      ? { id: 'model-1', content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c-1', name: 'batch_organize', arguments: JSON.stringify(args) }] }
      : { id: 'done', content: 'done', finishReason: 'stop' }) },
  });
  return { loop, port, change: () => { revision++; }, stale: () => { stale = true; } };
}

test('every office write always requires approval and refuses a false read-only level', () => {
  for (const toolName of OFFICE_WRITE_TOOLS) {
    const policy = new PolicyEngine();
    expect(policy.evaluate({ id: 'call', toolName, args: { request: '{}' }, approvalLevel: ApprovalLevel.FULL_ACCESS }).verdict).toBe(PolicyVerdict.ASK);
    expect(policy.evaluate({ id: 'call', toolName, args: { request: '{}' }, approvalLevel: ApprovalLevel.READ_ONLY }).verdict).toBe(PolicyVerdict.DENY);
  }
});
test.each([PermissionMode.READ_ONLY, PermissionMode.REVIEW])('%s never exposes office writes', mode => {
  const { loop } = fixture(mode);
  expect(loop.getVisibleTools()).toContain('workspace_scan_metadata');
  expect(loop.getVisibleTools()).not.toContain('batch_organize');
});
test('full access suspends on the complete host preview, and executes exactly once after approval', async () => {
  const { loop, port } = fixture();
  const result = await loop.runTurn('整理'); const approval = result.pendingApproval!;
  expect(result.outcome).toBe('needs_approval'); expect(port.execute).not.toHaveBeenCalled();
  expect(approval.summary).toContain('源.txt -> 整理/目标.txt');
  const decision = { approvalId: approval.approvalId, bindingDigest: approval.bindingDigest, decision: 'approved' as const };
  await loop.resumeAfterApproval(decision);
  expect(port.prepare).toHaveBeenCalledTimes(2);
  expect(port.execute).toHaveBeenCalledWith('batch_organize', { request: '{"planId":"plan-1"}' }, approval.turnId,
    { approvalId: approval.approvalId, bindingSha256: '1'.repeat(64) }, undefined);
  await expect(loop.resumeAfterApproval(decision)).rejects.toThrow(); expect(port.execute).toHaveBeenCalledTimes(1);
});
test('changed host plan invalidates approval, and a stale plan still permits denial', async () => {
  const f = fixture(); const approval = (await f.loop.runTurn('整理')).pendingApproval!;
  f.change(); const decision = { approvalId: approval.approvalId, bindingDigest: approval.bindingDigest, decision: 'approved' as const };
  await expect(f.loop.resumeAfterApproval(decision)).rejects.toThrow(); expect(f.port.execute).not.toHaveBeenCalled();
  f.stale(); await f.loop.resumeAfterApproval({ ...decision, decision: 'denied' });
  expect(f.port.execute).not.toHaveBeenCalled();
});
test('a permissive injected policy cannot fabricate the host approval grant', async () => {
  const policy = { evaluate: () => ({ verdict: PolicyVerdict.ALLOW }) } as unknown as PolicyEngine;
  const { loop, port } = fixture(PermissionMode.FULL_ACCESS, policy);
  await loop.runTurn('整理'); expect(port.execute).not.toHaveBeenCalled();
  expect(loop.getConversationHistory().some(m => m.content?.includes('A9_OFFICE_APPROVAL_REQUIRED'))).toBe(true);
});
test('model approval fields cannot pass tool schema validation', async () => {
  const { loop, port } = fixture(PermissionMode.FULL_ACCESS, undefined, { request: '{}', confirmed: true });
  await loop.runTurn('整理'); expect(port.prepare).not.toHaveBeenCalled(); expect(port.execute).not.toHaveBeenCalled();
});

test('selection reissue can only narrow the pending list and invalidates the old approval', async () => {
  const { loop, port } = fixture(PermissionMode.FULL_ACCESS, undefined, { request: JSON.stringify({ planId: 'plan-1', selectedActionIds: ['a001', 'a002'] }) });
  const old = (await loop.runTurn('整理')).pendingApproval!;
  await expect(loop.selectOfficeActions({ approvalId: old.approvalId, bindingDigest: old.bindingDigest, selectedActionIds: ['a003'] })).rejects.toThrow('A9_OFFICE_SELECTION_EXPANSION');
  const narrowed = await loop.selectOfficeActions({ approvalId: old.approvalId, bindingDigest: old.bindingDigest, selectedActionIds: ['a001'] });
  expect(port.execute).not.toHaveBeenCalled(); expect(narrowed.approvalId).not.toBe(old.approvalId);
  expect(JSON.parse(String(narrowed.args.request)).selectedActionIds).toEqual(['a001']);
  await expect(loop.resumeAfterApproval({ approvalId: old.approvalId, bindingDigest: old.bindingDigest, decision: 'approved' })).rejects.toThrow();
  await loop.resumeAfterApproval({ approvalId: narrowed.approvalId, bindingDigest: narrowed.bindingDigest, decision: 'denied' });
  expect(port.execute).not.toHaveBeenCalled();
});
