import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// Deliberately consume the freshly built production module, not ts-jest source.
import type { RegisteredTransferWorkspace, TransferApprovalBinding } from '../../src/a9-office-transfer';
const { OfficeTransferService, CheckpointManager } = require('../../dist');

describe('A9-70 paired transfer current dist', () => {
  let root: string, source: string, target: string;
  let registered: Map<string, RegisteredTransferWorkspace>;
  let approvals: Map<string, string>, serial: number;
  let service: InstanceType<typeof OfficeTransferService>;
  const who = { conversationId: 'conversation', turnId: 'move-turn' };
  const undoWho = { conversationId: 'conversation', turnId: 'new-undo-turn' };
  const input = () => ({ source: { workspaceId: 'a', relativePath: '中文 空格%#.bin', turnId: 'source-turn' }, target: { workspaceId: 'b', relativePath: '交接.bin', turnId: 'target-turn' } });
  const bytes = Buffer.from([0, 255, 13, 10, 0x81, 0x40]);
  const a = () => registered.get('a')!.checkpoint;
  const b = () => registered.get('b')!.checkpoint;
  const restart = () => {
    registered = new Map([['a', { workspaceId: 'a', workspaceRoot: source, checkpoint: new CheckpointManager(source) }], ['b', { workspaceId: 'b', workspaceRoot: target, checkpoint: new CheckpointManager(target) }]]);
    service = new OfficeTransferService({ resolve: (id: string) => registered.get(id), revalidate: (w: RegisteredTransferWorkspace) => { if (registered.get(w.workspaceId) !== w) throw new Error('revoked'); } }, {
      consume: (id: string, binding: TransferApprovalBinding) => { const saved = approvals.get(id); approvals.delete(id); return saved === JSON.stringify(binding); },
    });
  };
  const approve = (plan: { planId: string }, identity = who) => {
    const id = 'approval-' + ++serial;
    approvals.set(id, JSON.stringify(service.getApprovalBinding(plan.planId, identity))); return id;
  };
  const move = async () => { const p = service.plan(input(), who); return service.execute(p.planId, who, approve(p)); };
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a970-transfer-')));
    source = path.join(root, '源 工作区'); target = path.join(root, '目标 工作区'); fs.mkdirSync(source); fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, input().source.relativePath), bytes); approvals = new Map(); serial = 0; restart();
  });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); expect(fs.existsSync(root)).toBe(false); });

  it('real two roots move, recreate service, reconcile read-only, fresh undo restores exact bytes', async () => {
    const result = await move(); expect(result.code).toBe('A9_TRANSFER_MOVED');
    expect(fs.existsSync(path.join(source, input().source.relativePath))).toBe(false);
    expect(fs.readFileSync(path.join(target, input().target.relativePath))).toEqual(bytes);
    restart();
    const before = fs.readFileSync(path.join(source, '.agent_recovery/transfers', result.transferId + '.json'));
    const facts = service.reconcile(result.transferId, 'a', 'b');
    expect(facts).toMatchObject({ code: 'A9_TRANSFER_RECONCILED', phase: 'moved', source: { exists: false }, target: { exists: true }, conflict: false });
    expect(fs.readFileSync(path.join(source, '.agent_recovery/transfers', result.transferId + '.json'))).toEqual(before);
    const undo = service.planUndo(result.transferId, 'a', 'b', undoWho);
    const done = await service.executeUndo(undo.planId, undoWho, approve(undo, undoWho));
    expect(done.code).toBe('A9_TRANSFER_UNDONE');
    expect(fs.readFileSync(path.join(source, input().source.relativePath))).toEqual(bytes);
    expect(fs.existsSync(path.join(target, input().target.relativePath))).toBe(false);
    restart(); expect(service.reconcile(result.transferId, 'a', 'b').phase).toBe('closed');
    expect(b().undoTurn('target-turn').errors).toEqual([]);
    expect(fs.readFileSync(path.join(source, input().source.relativePath))).toEqual(bytes);
  });
  it('uses binding v2 only for paired manifests and rejects mismatched or downgraded markers', async () => {
    const ordinary = new CheckpointManager(source);
    ordinary.recordPreMutation('ordinary-turn', input().source.relativePath);
    const ordinaryFile = path.join(source, '.agent_recovery/checkpoints/ordinary-turn.json');
    expect(JSON.parse(fs.readFileSync(ordinaryFile, 'utf8')).artifactBindingVersion).toBe(1);
    expect(new CheckpointManager(source).loadCheckpoint('ordinary-turn')).toBeDefined();
    await move();
    const manifest = path.join(target, '.agent_recovery/checkpoints/target-turn.json');
    const paired = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    expect(paired.artifactBindingVersion).toBe(2);
    expect(new CheckpointManager(target).undoTurn('target-turn').errors).toEqual(['A9_TRANSFER_PAIRED_UNDO_REQUIRED']);
    paired.artifactBindingVersion = 1; fs.writeFileSync(manifest, JSON.stringify(paired));
    expect(() => new CheckpointManager(target).loadCheckpoint('target-turn')).toThrow('A9_TRANSFER_METADATA_VERSION_INVALID');
    paired.artifactBindingVersion = 2; delete paired.pairedTransfers; fs.writeFileSync(manifest, JSON.stringify(paired));
    expect(() => new CheckpointManager(target).loadCheckpoint('target-turn')).toThrow('A9_TRANSFER_METADATA_VERSION_INVALID');
  });
  it('plan is read-only and binding returned to host cannot mutate stored plan', () => {
    const p = service.plan(input(), who), binding = service.getApprovalBinding(p.planId, who);
    expect(fs.readdirSync(source)).toEqual([input().source.relativePath]); expect(fs.readdirSync(target)).toEqual([]);
    binding.source.relativePath = 'tampered';
    expect(service.getApprovalBinding(p.planId, who).source.relativePath).toBe(input().source.relativePath);
  });
  it('old approval and repeat plan execution cannot authorize another move', async () => {
    const p = service.plan(input(), who), old = approve(p); service.discardPlan(p.planId);
    const fresh = service.plan(input(), who); const result = await service.execute(fresh.planId, who, old);
    expect(result.code).toBe('A9_TRANSFER_APPROVAL_REJECTED');
    await expect(service.execute(fresh.planId, who, old)).rejects.toHaveProperty('code', 'A9_TRANSFER_PLAN_STALE');
    expect(fs.readFileSync(path.join(source, input().source.relativePath))).toEqual(bytes);
  });
  it.each([{ ...who, conversationId: 'other' }, { ...who, turnId: 'other' }])('rejects conversation/Turn identity drift %j', async identity => {
    const p = service.plan(input(), who); await expect(service.execute(p.planId, identity, approve(p))).rejects.toHaveProperty('code', 'A9_TRANSFER_PLAN_STALE');
  });
  it('rejects source drift after approval with no target published', async () => {
    const p = service.plan(input(), who), approval = approve(p); fs.writeFileSync(path.join(source, input().source.relativePath), 'changed');
    await expect(service.execute(p.planId, who, approval)).rejects.toHaveProperty('code', 'A9_TRANSFER_DRIFT');
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it.each(['../outside', '/absolute', 'C:\\outside', 'a\\b', '.agent_recovery/x', 'CON.txt', 'a/../b', 'trailing.', 'bad:ads', 'x'.repeat(241)])('rejects untrusted relative path %s', name => {
    const request = input(); request.target.relativePath = name; expect(() => service.plan(request, who)).toThrow(/A9_TRANSFER_/);
  });
  it('rejects extra confirmed flag and model-supplied roots', () => {
    expect(() => service.plan({ ...input(), confirmed: true }, who)).toThrow('A9_TRANSFER_INPUT_INVALID');
    expect(() => service.plan({ ...input(), workspaceRoot: root }, who)).toThrow('A9_TRANSFER_INPUT_INVALID');
  });
  it('rejects unknown and nested registered roots', () => {
    const request = input(); request.target.workspaceId = 'unknown'; expect(() => service.plan(request, who)).toThrow('A9_TRANSFER_UNREGISTERED');
    const nested = path.join(source, 'nested'); fs.mkdirSync(nested);
    registered.set('b', { workspaceId: 'b', workspaceRoot: nested, checkpoint: new CheckpointManager(nested) });
    expect(() => service.plan(input(), who)).toThrow('A9_TRANSFER_ROOT_OVERLAP');
  });
  it('rejects target overwrite and symlink/reparse paths', () => {
    fs.writeFileSync(path.join(target, input().target.relativePath), 'manual'); expect(() => service.plan(input(), who)).toThrow('A9_TRANSFER_TARGET_EXISTS');
    fs.symlinkSync(source, path.join(target, 'link'));
    const request = input(); request.target.relativePath = 'link/new'; expect(() => service.plan(request, who)).toThrow('A9_TRANSFER_REPARSE');
  });
  it('rejects >16MiB source and bounded live plans', () => {
    for (let n = 0; n < 100; n++) service.plan(input(), who);
    expect(() => service.plan(input(), who)).toThrow('A9_TRANSFER_PLAN_LIMIT');
    service = new OfficeTransferService({ resolve: (id: string) => registered.get(id), revalidate: () => {} }, { consume: () => false });
    fs.truncateSync(path.join(source, input().source.relativePath), 16 * 1024 * 1024 + 1);
    expect(() => service.plan(input(), who)).toThrow('A9_TRANSFER_FILE_INVALID');
  });
  it('pre-cancel has zero effects', async () => {
    const p = service.plan(input(), who), signal = new AbortController(); signal.abort();
    await expect(service.execute(p.planId, who, approve(p), signal.signal)).rejects.toHaveProperty('code', 'A9_TRANSFER_CANCELLED');
    expect(fs.readdirSync(source)).toEqual([input().source.relativePath]); expect(fs.readdirSync(target)).toEqual([]);
  });
  it('cancel during copying preserves source and cleans own temp', async () => {
    const signal = new AbortController(), p = service.plan(input(), who), approval = approve(p);
    setImmediate(() => signal.abort());
    const result = await service.execute(p.planId, who, approval, signal.signal);
    expect(result.code).toBe('A9_TRANSFER_CANCELLED'); expect(result.sourceDeleted).toBe(false);
    expect(fs.readFileSync(path.join(source, input().source.relativePath))).toEqual(bytes);
    expect(fs.readdirSync(target).filter(n => n.startsWith('.a9-transfer-'))).toEqual([]);
  });
  it('post-publication receipt failure preserves both copies, never reports complete', async () => {
    const original = b().writeTransferReceipt.bind(b());
    jest.spyOn(b(), 'writeTransferReceipt').mockImplementation((id: string, raw: string) => { if (JSON.parse(raw).phase === 'target_published') throw new Error('injected'); original(id, raw); });
    const result = await move(); expect(result).toMatchObject({ code: 'A9_TRANSFER_IO_FAILED', targetPublished: true, sourceDeleted: false });
    expect(fs.readFileSync(path.join(source, input().source.relativePath))).toEqual(bytes);
    expect(fs.readFileSync(path.join(target, input().target.relativePath))).toEqual(bytes);
    restart(); expect(service.reconcile(result.transferId, 'a', 'b').code).toBe('A9_TRANSFER_RECEIPTS_DISAGREE');
    expect(() => service.planUndo(result.transferId, 'a', 'b', undoWho)).toThrow('A9_TRANSFER_RECEIPTS_DISAGREE');
  });
  it('ordinary checkpoint undo is blocked after full recreation on both sides', async () => {
    await move(); restart();
    for (const cp of [a(), b()]) {
      const turn = cp === a() ? 'source-turn' : 'target-turn';
      expect(cp.undoTurn(turn).errors).toEqual(['A9_TRANSFER_PAIRED_UNDO_REQUIRED']);
      expect(cp.undoFile(turn, cp === a() ? input().source.relativePath : input().target.relativePath).errors).toEqual(['A9_TRANSFER_PAIRED_UNDO_REQUIRED']);
    }
    expect(fs.readFileSync(path.join(target, input().target.relativePath))).toEqual(bytes);
  });
  it.each(['source', 'target'])('refuses undo over manual %s changes', async side => {
    const result = await move();
    fs.writeFileSync(side === 'source' ? path.join(source, input().source.relativePath) : path.join(target, input().target.relativePath), 'human'); restart();
    expect(service.reconcile(result.transferId, 'a', 'b').conflict).toBe(true);
    expect(() => service.planUndo(result.transferId, 'a', 'b', undoWho)).toThrow('A9_TRANSFER_UNDO_CONFLICT');
  });
  it('reconcile never replays even if both files are present', async () => {
    const original = b().recordPostMutation.bind(b());
    jest.spyOn(b(), 'recordPostMutation').mockImplementation(() => { throw new Error('after-publish'); });
    const result = await move(); expect(result.sourceDeleted).toBe(false); restart();
    const facts = service.reconcile(result.transferId, 'a', 'b'); expect(facts).toMatchObject({ phase: 'prepared', source: { exists: true }, target: { exists: true } });
    expect(fs.readFileSync(path.join(source, input().source.relativePath))).toEqual(bytes);
    const undo = service.planUndo(result.transferId, 'a', 'b', undoWho);
    expect((await service.executeUndo(undo.planId, undoWho, approve(undo, undoWho))).code).toBe('A9_TRANSFER_UNDONE');
    void original;
  });
  it('rejects tampered receipt paths and malformed durable pairing metadata', async () => {
    const result = await move(), receiptPath = path.join(source, '.agent_recovery/transfers', result.transferId + '.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); receipt.source.relativePath = '../outside'; fs.writeFileSync(receiptPath, JSON.stringify(receipt)); restart();
    expect(() => service.reconcile(result.transferId, 'a', 'b')).toThrow(/A9_TRANSFER_/);
    const manifest = path.join(target, '.agent_recovery/checkpoints/target-turn.json');
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8')); data.pairedTransfers[result.transferId].closed = 'true'; fs.writeFileSync(manifest, JSON.stringify(data)); restart();
    expect(() => b().undoTurn('target-turn')).toThrow('A9_TRANSFER_METADATA_INVALID');
  });
  it('revoked registration and directory replacements invalidate approved plans', async () => {
    const p = service.plan(input(), who), approval = approve(p);
    const old = registered.get('b')!;
    registered.set('b', { ...old, checkpoint: new CheckpointManager(target) });
    await expect(service.execute(p.planId, who, approval)).rejects.toThrow('revoked');
    registered.set('b', old);
    fs.renameSync(target, target + '-old'); fs.mkdirSync(target);
    await expect(service.execute(p.planId, who, approval)).rejects.toHaveProperty('code', 'DIRECTORY_IDENTITY_CHANGED');
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it('rejects drift introduced while consuming approval', async () => {
    const host = { resolve: (id: string) => registered.get(id), revalidate: () => {} };
    service = new OfficeTransferService(host, { consume: async () => { await Promise.resolve(); fs.writeFileSync(path.join(target, input().target.relativePath), 'human'); return true; } });
    const p = service.plan(input(), who), result = await service.execute(p.planId, who, 'trusted-host-token');
    expect(result.code).toBe('A9_TRANSFER_DRIFT'); expect(result.sourceDeleted).toBe(false);
    expect(fs.readFileSync(path.join(target, input().target.relativePath), 'utf8')).toBe('human');
  });
  it('exclusive publication race never overwrites the other writer', async () => {
    const original = fs.linkSync, dest = path.join(target, input().target.relativePath);
    jest.spyOn(require('fs'), 'linkSync').mockImplementation((from: any, to: any) => {
      if (to === dest) fs.writeFileSync(dest, 'human', { flag: 'wx' });
      return original(from, to);
    });
    const result = await move(); expect(result.code).toBe('A9_TRANSFER_IO_FAILED'); expect(result.sourceDeleted).toBe(false);
    expect(fs.readFileSync(dest, 'utf8')).toBe('human');
    expect(fs.readdirSync(target).filter(n => n.startsWith('.a9-transfer-'))).toEqual([]);
  });
  it('both missing are honestly reconciled and source recovers only from its local checkpoint', async () => {
    const result = await move(); fs.unlinkSync(path.join(target, input().target.relativePath)); restart();
    expect(service.reconcile(result.transferId, 'a', 'b')).toMatchObject({ source: { exists: false }, target: { exists: false } });
    const undo = service.planUndo(result.transferId, 'a', 'b', undoWho);
    expect((await service.executeUndo(undo.planId, undoWho, approve(undo, undoWho))).code).toBe('A9_TRANSFER_UNDONE');
    expect(fs.readFileSync(path.join(source, input().source.relativePath))).toEqual(bytes);
  });
  it('source disappearance during undo receipt write stops target deletion', async () => {
    const result = await move(), original = b().writeTransferReceipt.bind(b());
    jest.spyOn(b(), 'writeTransferReceipt').mockImplementation((id: string, raw: string) => {
      original(id, raw); if (JSON.parse(raw).phase === 'source_restored') fs.unlinkSync(path.join(source, input().source.relativePath));
    });
    const undo = service.planUndo(result.transferId, 'a', 'b', undoWho);
    const failed = await service.executeUndo(undo.planId, undoWho, approve(undo, undoWho));
    expect(failed.code).toBe('A9_TRANSFER_UNDO_CONFLICT');
    expect(fs.readFileSync(path.join(target, input().target.relativePath))).toEqual(bytes);
  });
  it('failure closing local marker is recoverable with another fresh approval', async () => {
    const result = await move(), original = b().setPairedTransfer.bind(b());
    const spy = jest.spyOn(b(), 'setPairedTransfer').mockImplementation((turn: string, id: string, file: string, closed: boolean) => {
      if (closed) throw new Error('marker-write'); return original(turn, id, file, closed);
    });
    const undo = service.planUndo(result.transferId, 'a', 'b', undoWho);
    expect((await service.executeUndo(undo.planId, undoWho, approve(undo, undoWho))).code).toBe('A9_TRANSFER_IO_FAILED');
    spy.mockRestore(); restart(); expect(b().undoTurn('target-turn').errors).toEqual(['A9_TRANSFER_PAIRED_UNDO_REQUIRED']);
    const retry = service.planUndo(result.transferId, 'a', 'b', { ...undoWho, turnId: 'retry' });
    expect((await service.executeUndo(retry.planId, { ...undoWho, turnId: 'retry' }, approve(retry, { ...undoWho, turnId: 'retry' }))).code).toBe('A9_TRANSFER_UNDONE');
    expect(b().undoTurn('target-turn').errors).toEqual([]);
  });
  it('recovery namespace replacement stops before deleting source', async () => {
    const original = b().recordPostMutation.bind(b());
    jest.spyOn(b(), 'recordPostMutation').mockImplementation((...args: any[]) => {
      original(args[0], args[1], args[2]);
      const dir = path.join(target, '.agent_recovery/transfers'); fs.renameSync(dir, dir + '-old'); fs.mkdirSync(dir);
    });
    const result = await move(); expect(result.code).toBe('A9_TRANSFER_IO_FAILED'); expect(result.sourceDeleted).toBe(false);
    expect(fs.readFileSync(path.join(source, input().source.relativePath))).toEqual(bytes);
  });

  it('cancellation after target publication preserves both copies', async () => {
    const controller = new AbortController(), original = b().recordPostMutation.bind(b());
    jest.spyOn(b(), 'recordPostMutation').mockImplementation((...args: any[]) => {
      original(args[0], args[1], args[2]); controller.abort();
    });
    const p = service.plan(input(), who);
    const result = await service.execute(p.planId, who, approve(p), controller.signal);
    expect(result).toMatchObject({ code: 'A9_TRANSFER_CANCELLED', targetPublished: true, sourceDeleted: false });
    expect(fs.readFileSync(path.join(source, input().source.relativePath))).toEqual(bytes);
    expect(fs.readFileSync(path.join(target, input().target.relativePath))).toEqual(bytes);
  });

});
