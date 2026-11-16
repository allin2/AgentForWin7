import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { OfficeBatchApprovalBinding, OfficeBatchIdentity, OfficeOrganizeActionInput } from '../../src/a9-office-batch';
// Deliberately consume the built package, including the actual service wiring.
const { A9WorkspaceService, OFFICE_BATCH_LIMITS } = require('../../dist') as typeof import('../../src');

const identity: OfficeBatchIdentity = { workspaceId: 'workspace-70', conversationId: 'conversation-70', turnId: 'turn-70' };
const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(approved = true) {
  // Match the canonical root used by the service (/var resolves to /private/var on macOS).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-files-'))); roots.push(root);
  const bindings: OfficeBatchApprovalBinding[] = [];
  const service = new A9WorkspaceService(root, approved ? { officeBatchApproval: {
    async consume(id, binding) { bindings.push(binding); if (id !== 'ui-authorized') throw Object.assign(new Error('denied'), { code: 'UI_DENIED' }); return { status: 'approved', bindingSha256: binding.bindingSha256 }; },
  } } : {});
  function write(name: string, bytes: string | Buffer) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
  async function plan(actions: OfficeOrganizeActionInput[] = [{ kind: 'move', source: '源 中文 #%.bin', destination: '整理/目标 中文.bin' }]) { return service.planOrganize(identity, actions); }
  return { root, service, write, plan, bindings };
}
async function run(f: ReturnType<typeof fixture>, plan: Awaited<ReturnType<ReturnType<typeof fixture>['plan']>>, ids = plan.actions.map(a => a.actionId)) {
  return f.service.executeOrganize({ planId: plan.planId, identity, selectedActionIds: ids, approvalId: 'ui-authorized' });
}
function exdev(source: string, onCopy?: () => void) {
  const original = fs.linkSync;
  return jest.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(from) === source) { onCopy?.(); throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); }
    return original(from, to);
  });
}

it('loads the current dist and scans bounded metadata, exact hashes, Chinese spaces and exclusions without writes', async () => {
  expect(require.resolve('../../dist')).toBe(path.join(__dirname, '../../dist/index.js'));
  const f = fixture(); f.write('中文 空格/报告 v1.txt', '同样字节'); f.write('中文 空格/报告 v2.txt', '不同字节');
  f.write('copy.txt', '同样字节'); f.write('unique.txt', 'unique-sized-file-17'); f.write('.visible-dotfile', 'dot');
  f.write('.git/config', 'private'); f.write('.agent_recovery/not-a-checkpoint', 'private'); f.write('_待清理隔离区_20261116/old', 'old'); f.write('~$locked.docx', 'lock');
  fs.symlinkSync(f.root, path.join(f.root, 'loop'), 'dir');
  const before = fs.readdirSync(f.root).sort(); const result = await f.service.scanMetadata('', { hash: 'size_groups' });
  expect(result.status).toBe('completed'); expect(result.truncated).toBe(false);
  expect(result.entries.find(e => e.path === '中文 空格/报告 v1.txt')?.sha256).toBe(crypto.createHash('sha256').update('同样字节').digest('hex'));
  expect(result.entries.find(e => e.path === 'copy.txt')?.sha256).toBe(result.entries.find(e => e.path === '中文 空格/报告 v1.txt')?.sha256);
  expect(result.entries.find(e => e.path === 'unique.txt')?.hashSkipped).toBe('unique_size');
  expect(result.entries.some(e => e.path === '.visible-dotfile')).toBe(true);
  expect(result.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'loop', reason: 'reparse_or_symlink' }), expect.objectContaining({ path: '.git', reason: 'excluded' })]));
  expect(result.entries.map(e => e.path)).toEqual(result.entries.map(e => e.path).sort());
  expect(result.limitations).toContain('WINDOWS_HIDDEN_ATTRIBUTE_NOT_AVAILABLE');
  expect(fs.readdirSync(f.root).sort()).toEqual(before);
});

it('enforces file count, per-file bytes and serialized return caps', async () => {
  const f = fixture(); for (let i = 0; i < 12; i++) f.write(`file-${i}.txt`, 'same');
  const count = await f.service.scanMetadata('', { maxFiles: 2 }); expect(count.entries).toHaveLength(2); expect(count.truncationReasons).toContain('files');
  const bytes = await f.service.scanMetadata('', { hash: 'size_groups', maxFileBytes: 3 }); expect(bytes.entries.every(e => e.hashSkipped === 'file_bytes')).toBe(true);
  const limited = await f.service.scanMetadata('', { maxReturnBytes: 1024 }); expect(limited.truncationReasons).toContain('return_bytes'); expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(1024);
  await expect(f.service.scanMetadata('', { maxFiles: OFFICE_BATCH_LIMITS.files + 1 })).rejects.toMatchObject({ code: 'BATCH_LIMIT_INVALID' });
});

it('cancels an actual scan cooperatively and returns a bounded partial result', async () => {
  const f = fixture(); for (let i = 0; i < 100; i++) f.write(`${i}.txt`, 'data');
  const controller = new AbortController(); const timer = setImmediate(() => controller.abort());
  try { const result = await f.service.scanMetadata('', { hash: 'size_groups', signal: controller.signal }); expect(result.status).toBe('cancelled'); expect(result.truncationReasons).toContain('cancelled'); }
  finally { clearImmediate(timer); }
  expect(fs.existsSync(path.join(f.root, '.agent_recovery'))).toBe(false);
});

it('keeps preview immutable and side-effect free, and separates byte duplicates from version candidates', async () => {
  const f = fixture(); f.write('报告 v1.txt', 'one'); f.write('报告 v2.txt', 'two'); f.write('copy.txt', 'one');
  const inputs: OfficeOrganizeActionInput[] = [
    { kind: 'quarantine_duplicate', source: 'copy.txt', duplicateOf: '报告 v1.txt', destination: '_待清理隔离区_20261116/copy.txt' },
    { kind: 'skip_conflict', source: '报告 v1.txt' }, { kind: 'skip_conflict', source: '报告 v2.txt' },
  ];
  const before = fs.readdirSync(f.root).sort(), plan = await f.plan(inputs);
  inputs[0].destination = 'forged.txt';
  expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.actions[0].sourceIdentity)).toBe(true);
  expect(() => { (plan.actions[0] as any).destination = 'forged.txt'; }).toThrow();
  expect(plan.exact_duplicates[0].paths).toEqual(['copy.txt', '报告 v1.txt']);
  expect(plan.version_candidates[0].paths).toEqual(['报告 v1.txt', '报告 v2.txt']);
  expect(fs.readdirSync(f.root).sort()).toEqual(before);
  await expect(f.plan([{ kind: 'quarantine_duplicate', source: '报告 v2.txt', duplicateOf: '报告 v1.txt', destination: '_待清理隔离区_20261116/no.txt' }])).rejects.toMatchObject({ code: 'BATCH_NOT_EXACT_DUPLICATE' });
});

it('requires trusted host approval, binds the exact selection and rejects consumed plans', async () => {
  const f = fixture(false); f.write('源 中文 #%.bin', 'bytes'); const plan = await f.plan();
  await expect(run(f, plan)).rejects.toMatchObject({ code: 'BATCH_APPROVAL_REQUIRED' });
  expect(fs.existsSync(path.join(f.root, '.agent_recovery'))).toBe(false);
  const g = fixture(); g.write('源 中文 #%.bin', 'bytes'); g.write('keep.txt', 'keep');
  const accepted = await g.plan([{ kind: 'move', source: '源 中文 #%.bin', destination: '整理/目标 中文.bin' }, { kind: 'move', source: 'keep.txt', destination: 'not-selected.txt' }]);
  const result = await run(g, accepted, [accepted.actions[0].actionId]);
  expect(result.operations[0]).toMatchObject({ status: 'succeeded', transfer: 'hardlink', recovery: 'recorded', sourceRemoved: true });
  expect(g.bindings[0].selectedActions).toEqual([accepted.actions[0]]); expect(Object.isFrozen(g.bindings[0])).toBe(true);
  expect(fs.existsSync(path.join(g.root, 'keep.txt'))).toBe(true); expect(fs.existsSync(path.join(g.root, 'not-selected.txt'))).toBe(false);
  await expect(run(g, accepted)).rejects.toMatchObject({ code: 'BATCH_PLAN_CONSUMED' });
});

it.each(['workspaceId', 'conversationId', 'turnId'] as const)('rejects stale %s before approval or writes', async key => {
  const f = fixture(); f.write('源 中文 #%.bin', 'bytes'); const plan = await f.plan();
  await expect(f.service.executeOrganize({ planId: plan.planId, identity: { ...identity, [key]: 'stale' }, selectedActionIds: [plan.actions[0].actionId], approvalId: 'ui-authorized' })).rejects.toMatchObject({ code: 'BATCH_IDENTITY_MISMATCH' });
  expect(f.bindings).toHaveLength(0); expect(fs.existsSync(path.join(f.root, '.agent_recovery'))).toBe(false);
});

it('preflights every action for conflicts and source drift before any move', async () => {
  const f = fixture(); f.write('a.txt', 'a'); f.write('b.txt', 'b');
  const plan = await f.plan([{ kind: 'move', source: 'a.txt', destination: 'out/a.txt' }, { kind: 'move', source: 'b.txt', destination: 'out/b.txt' }]);
  f.write('out/b.txt', 'human'); await expect(run(f, plan)).rejects.toMatchObject({ code: 'BATCH_TARGET_EXISTS' });
  expect(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('a');
  const drift = await f.plan([{ kind: 'move', source: 'a.txt', destination: 'out/a.txt' }]); f.write('a.txt', 'changed');
  await expect(run(f, drift)).rejects.toMatchObject({ code: 'BATCH_SOURCE_DRIFT' });
  expect(fs.existsSync(path.join(f.root, '.agent_recovery'))).toBe(false);
});

it.each(['CON.txt', 'out/NUL', 'out/trailing.', '../escape', 'C:/drive.txt', '//host/share', 'out\\back.txt', '.git/result.txt', '_待清理隔离区_20261116/.agent_recovery/bad'])('blocks unsafe destination %s', async destination => {
  const f = fixture(); f.write('a.txt', 'a'); await expect(f.plan([{ kind: 'move', source: 'a.txt', destination }])).rejects.toHaveProperty('code');
  expect(fs.readdirSync(f.root)).toEqual(['a.txt']);
});

it('blocks output paths above 240 characters and internal symlink redirects', async () => {
  const f = fixture(); f.write('a.txt', 'a');
  await expect(f.plan([{ kind: 'move', source: 'a.txt', destination: 'x'.repeat(220) + '/a.txt' }])).rejects.toMatchObject({ code: 'BATCH_PATH_TOO_LONG' });
  fs.mkdirSync(path.join(f.root, 'real')); fs.symlinkSync(path.join(f.root, 'real'), path.join(f.root, 'link'), 'dir');
  await expect(f.plan([{ kind: 'move', source: 'a.txt', destination: 'link/a.txt' }])).rejects.toMatchObject({ code: 'BATCH_PATH_REDIRECTED' });
});

it('invalidates parent directory identity after preview, including a same-path replacement', async () => {
  const f = fixture(); f.write('input/a.txt', 'a'); fs.mkdirSync(path.join(f.root, 'out'));
  const plan = await f.plan([{ kind: 'move', source: 'input/a.txt', destination: 'out/a.txt' }]);
  fs.renameSync(path.join(f.root, 'out'), path.join(f.root, 'held')); fs.mkdirSync(path.join(f.root, 'out'));
  await expect(run(f, plan)).rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_CHANGED' }); expect(fs.existsSync(path.join(f.root, 'input/a.txt'))).toBe(true);
});

it('runs injected EXDEV through real byte copying, verified publication, source handling and restart facts', async () => {
  const f = fixture(); const bytes = crypto.randomBytes(320 * 1024 + 7), source = f.write('源 中文 #%.bin', bytes); const plan = await f.plan();
  exdev(source); const result = await run(f, plan);
  expect(result.operations[0]).toMatchObject({ status: 'succeeded', transfer: 'exdev_copy', targetPublished: true, sourceRemoved: true, recovery: 'recorded' });
  expect(fs.readFileSync(path.join(f.root, '整理/目标 中文.bin'))).toEqual(bytes); expect(fs.existsSync(source)).toBe(false);
  expect(fs.readdirSync(path.join(f.root, '整理'))).toEqual(['目标 中文.bin']);
  const restarted = new A9WorkspaceService(f.root); const checkpoint = restarted.getCheckpointManager().loadCheckpoint(identity.turnId)!;
  expect(checkpoint.changes['源 中文 #%.bin'].newKind).toBe('absent'); expect(checkpoint.changes['整理/目标 中文.bin'].newHash).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  await expect(restarted.executeOrganize({ planId: plan.planId, identity, selectedActionIds: [plan.actions[0].actionId], approvalId: 'ui-authorized' })).rejects.toMatchObject({ code: 'BATCH_PLAN_UNKNOWN' });
  expect(fs.readFileSync(path.join(f.root, '整理/目标 中文.bin'))).toEqual(bytes);
});

it('preserves a raced-in target and source after EXDEV copy and reports the conflict', async () => {
  const f = fixture(); const source = f.write('源 中文 #%.bin', crypto.randomBytes(150000)); const originalBytes = fs.readFileSync(source), plan = await f.plan();
  exdev(source, () => f.write('整理/目标 中文.bin', 'human target'));
  const result = await run(f, plan); expect(result.operations[0]).toMatchObject({ status: 'skipped', code: 'BATCH_TARGET_EXISTS', sourceRemoved: false });
  expect(fs.readFileSync(source)).toEqual(originalBytes); expect(fs.readFileSync(path.join(f.root, '整理/目标 中文.bin'), 'utf8')).toBe('human target');
  expect(fs.readdirSync(path.join(f.root, '整理'))).toEqual(['目标 中文.bin']);
});

it('cancels during actual EXDEV copying, cleans temporary bytes, and keeps source', async () => {
  const f = fixture(); const bytes = crypto.randomBytes(300000), source = f.write('源 中文 #%.bin', bytes), plan = await f.plan();
  const controller = new AbortController(); let timer: NodeJS.Immediate | undefined;
  exdev(source, () => { timer = setImmediate(() => controller.abort()); });
  try {
    const result = await f.service.executeOrganize({ planId: plan.planId, identity, selectedActionIds: [plan.actions[0].actionId], approvalId: 'ui-authorized', signal: controller.signal });
    expect(result.status).toBe('cancelled'); expect(result.operations[0]).toMatchObject({ status: 'cancelled', sourceRemoved: false, targetPublished: false });
    expect(fs.readFileSync(source)).toEqual(bytes); expect(fs.readdirSync(path.join(f.root, '整理'))).toEqual([]);
  } finally { if (timer) clearImmediate(timer); }
});

it('rejects source changes while copying and retains changed source bytes', async () => {
  const f = fixture(); const source = f.write('源 中文 #%.bin', crypto.randomBytes(300000)), plan = await f.plan(); let timer: NodeJS.Immediate | undefined;
  exdev(source, () => { timer = setImmediate(() => fs.writeFileSync(source, 'changed by human')); });
  try {
    const result = await run(f, plan); expect(result.status).toBe('stopped'); expect(result.operations[0]).toMatchObject({ code: 'BATCH_SOURCE_DRIFT', sourceRemoved: false, targetPublished: false });
    expect(fs.readFileSync(source, 'utf8')).toBe('changed by human'); expect(fs.readdirSync(path.join(f.root, '整理'))).toEqual([]);
  } finally { if (timer) clearImmediate(timer); }
});

it('does not call EPERM occupancy and stops later actions with source intact', async () => {
  const f = fixture(); f.write('a.txt', 'a'); f.write('b.txt', 'b'); const plan = await f.plan([{ kind: 'move', source: 'a.txt', destination: 'out/a' }, { kind: 'move', source: 'b.txt', destination: 'out/b' }]);
  const original = fs.linkSync; jest.spyOn(fs, 'linkSync').mockImplementation((from, to) => { if (String(from) === path.join(f.root, 'a.txt')) throw Object.assign(new Error('permission unknown'), { code: 'EPERM' }); return original(from, to); });
  const result = await run(f, plan); expect(result.status).toBe('stopped'); expect(result.operations.map(r => r.code)).toEqual(['EPERM', 'BATCH_STOPPED']);
  expect(result.operations[0].status).toBe('failed'); expect(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('a'); expect(fs.readFileSync(path.join(f.root, 'b.txt'), 'utf8')).toBe('b');
});

it('stops source processing and later actions when the real recovery namespace becomes redirected after publication', async () => {
  const f = fixture(); f.write('a.txt', 'a'); f.write('b.txt', 'b'); const plan = await f.plan([{ kind: 'move', source: 'a.txt', destination: 'out/a' }, { kind: 'move', source: 'b.txt', destination: 'out/b' }]);
  const original = fs.linkSync; let redirected = false;
  jest.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    original(from, to);
    if (String(to) === path.join(f.root, 'out/a')) {
      const store = path.join(f.root, '.agent_recovery/checkpoints'); fs.renameSync(store, path.join(f.root, 'held-checkpoints'));
      fs.mkdirSync(path.join(f.root, 'outside')); fs.symlinkSync(path.join(f.root, 'outside'), store, 'dir'); redirected = true;
    }
  });
  const result = await run(f, plan); expect(redirected).toBe(true); expect(result.status).toBe('stopped');
  expect(result.operations[0]).toMatchObject({ targetPublished: true, sourceRemoved: false, recovery: 'unknown' }); expect(result.operations[1].code).toBe('BATCH_STOPPED');
  expect(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('a'); expect(fs.readdirSync(path.join(f.root, 'outside'))).toEqual([]);
});

it('uses real checkpoint undo and refuses subsequent manual-change conflicts, including repeated undo', async () => {
  const f = fixture(); f.write('源 中文 #%.bin', 'original'); const plan = await f.plan(); await run(f, plan);
  const manager = new A9WorkspaceService(f.root).getCheckpointManager();
  f.write('整理/目标 中文.bin', 'human target edit'); f.write('源 中文 #%.bin', 'human recreated source');
  const conflict = manager.undoTurn(identity.turnId); expect(conflict.drifted).toHaveLength(2);
  expect(fs.readFileSync(path.join(f.root, '整理/目标 中文.bin'), 'utf8')).toBe('human target edit'); expect(fs.readFileSync(path.join(f.root, '源 中文 #%.bin'), 'utf8')).toBe('human recreated source');
  const g = fixture(); g.write('源 中文 #%.bin', 'original'); await run(g, await g.plan());
  expect(g.service.getCheckpointManager().undoTurn(identity.turnId).errors).toEqual([]); g.write('源 中文 #%.bin', 'edit after undo');
  g.service.getCheckpointManager().undoTurn(identity.turnId); expect(fs.readFileSync(path.join(g.root, '源 中文 #%.bin'), 'utf8')).toBe('edit after undo');
});

it('returns stable result order and escaped inventory content without writing reports', async () => {
  const f = fixture(); f.write('=formula.txt', 'a'); f.write('z.txt', 'b');
  const plan = await f.plan([{ kind: 'rename', source: '=formula.txt', destination: 'renamed.txt' }, { kind: 'skip_conflict', source: 'z.txt' }]);
  const result = await run(f, plan, plan.actions.map(a => a.actionId).reverse());
  expect(result.operations.map(r => r.actionId)).toEqual(['a001', 'a002']); expect(result.manifestCsv).toContain('"\'=formula.txt"');
  expect(result.manifestMarkdown).toContain('文件整理与去重清单'); expect(fs.readdirSync(f.root).some(n => /\.(md|csv)$/.test(n))).toBe(false);
});

it('rejects forged selection and a host receipt that does not bind the requested targets', async () => {
  const f = fixture(); f.write('源 中文 #%.bin', 'bytes'); const plan = await f.plan();
  await expect(run(f, plan, ['a999'])).rejects.toMatchObject({ code: 'BATCH_SELECTION_INVALID' });
  await expect(run(f, plan, ['a001', 'a001'])).rejects.toMatchObject({ code: 'BATCH_SELECTION_INVALID' });
  const service = new A9WorkspaceService(f.root, { officeBatchApproval: { async consume() { return { status: 'approved', bindingSha256: 'other-targets' }; } } });
  const p = await service.planOrganize(identity, [{ kind: 'move', source: '源 中文 #%.bin', destination: 'out.bin' }]);
  await expect(service.executeOrganize({ planId: p.planId, identity, selectedActionIds: ['a001'], approvalId: 'ui-authorized' })).rejects.toMatchObject({ code: 'BATCH_APPROVAL_REJECTED' });
  expect(fs.readdirSync(f.root)).toEqual(['源 中文 #%.bin']);
});

it('reports cancellation after one success and leaves the later source intact', async () => {
  const f = fixture(); f.write('a.txt', 'a'); f.write('b.txt', 'b');
  const plan = await f.plan([{ kind: 'move', source: 'a.txt', destination: 'out/a' }, { kind: 'move', source: 'b.txt', destination: 'out/b' }]);
  const controller = new AbortController(), original = fs.unlinkSync;
  jest.spyOn(fs, 'unlinkSync').mockImplementation(file => { original(file); if (String(file) === path.join(f.root, 'a.txt')) controller.abort(); });
  const result = await f.service.executeOrganize({ planId: plan.planId, identity, selectedActionIds: ['a001', 'a002'], approvalId: 'ui-authorized', signal: controller.signal });
  expect(result.status).toBe('cancelled'); expect(result.operations.map(r => r.status)).toEqual(['succeeded', 'cancelled']);
  expect(fs.readFileSync(path.join(f.root, 'out/a'), 'utf8')).toBe('a'); expect(fs.readFileSync(path.join(f.root, 'b.txt'), 'utf8')).toBe('b');
});

it('retains both copies when cancelled after publication; restart reads facts and real undo is safe', async () => {
  const f = fixture(); const source = f.write('源 中文 #%.bin', crypto.randomBytes(100000)), bytes = fs.readFileSync(source), plan = await f.plan();
  const controller = new AbortController(), original = fs.linkSync;
  jest.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(from) === source) throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
    original(from, to); if (String(to) === path.join(f.root, '整理/目标 中文.bin')) controller.abort();
  });
  const result = await f.service.executeOrganize({ planId: plan.planId, identity, selectedActionIds: ['a001'], approvalId: 'ui-authorized', signal: controller.signal });
  expect(result.operations[0]).toMatchObject({ status: 'cancelled', targetPublished: true, sourceRemoved: false, recovery: 'recorded' });
  expect(fs.readFileSync(source)).toEqual(bytes); expect(fs.readFileSync(path.join(f.root, '整理/目标 中文.bin'))).toEqual(bytes);
  const restarted = new A9WorkspaceService(f.root), checkpoint = restarted.getCheckpointManager().loadCheckpoint(identity.turnId)!;
  expect(checkpoint.changes['整理/目标 中文.bin'].newKind).toBe('file');
  expect(restarted.getCheckpointManager().undoTurn(identity.turnId).errors).toEqual([]);
  expect(fs.readFileSync(source)).toEqual(bytes); expect(fs.existsSync(path.join(f.root, '整理/目标 中文.bin'))).toBe(false);
});

it('never cleans an externally replaced copy temporary and reports the unresolved path', async () => {
  const f = fixture(); const source = f.write('源 中文 #%.bin', crypto.randomBytes(300000)), plan = await f.plan(); let timer: NodeJS.Immediate | undefined;
  exdev(source, () => { timer = setImmediate(() => {
    const dir = path.join(f.root, '整理'), temp = fs.readdirSync(dir).find(n => n.startsWith('.a9-batch-'))!;
    fs.renameSync(path.join(dir, temp), path.join(dir, 'held-copy')); fs.writeFileSync(path.join(dir, temp), 'human replacement');
  }); });
  try {
    const result = await run(f, plan); expect(result.status).toBe('stopped');
    expect(result.operations[0]).toMatchObject({ code: 'BATCH_TEMP_IDENTITY_CHANGED', cleanupCode: 'BATCH_TEMP_IDENTITY_CHANGED', recovery: 'unknown', sourceRemoved: false });
    expect(fs.readFileSync(path.join(f.root, result.operations[0].residualTemporary!), 'utf8')).toBe('human replacement');
    expect(fs.existsSync(source)).toBe(true);
  } finally { if (timer) clearImmediate(timer); }
});

it('rejects a scanned child directory replaced between cooperative slices', async () => {
  const f = fixture(); f.write('child/a.txt', 'inside'); f.write('outside/private.txt', 'outside');
  let timer: NodeJS.Immediate | undefined, scheduled = false; const original = fs.lstatSync;
  jest.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: any) => {
    const stat = original(file, options);
    if (String(file) === path.join(f.root, 'child') && !scheduled) {
      scheduled = true; timer = setImmediate(() => { fs.renameSync(path.join(f.root, 'child'), path.join(f.root, 'held')); fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, 'child'), 'dir'); });
    }
    return stat;
  }) as typeof fs.lstatSync);
  try { await expect(f.service.scanMetadata()).rejects.toMatchObject({ code: 'DIRECTORY_IDENTITY_CHANGED' }); }
  finally { if (timer) clearImmediate(timer); }
  expect(fs.readFileSync(path.join(f.root, 'outside/private.txt'), 'utf8')).toBe('outside');
});

it('quarantines only the selected exact duplicate and retains the named reference', async () => {
  const f = fixture(); f.write('original.txt', 'same bytes'); f.write('copy.txt', 'same bytes');
  const plan = await f.plan([{ kind: 'quarantine_duplicate', source: 'copy.txt', duplicateOf: 'original.txt', destination: '_待清理隔离区_20261116/copy.txt' }]);
  const result = await run(f, plan); expect(result.operations[0].status).toBe('succeeded');
  expect(fs.readFileSync(path.join(f.root, 'original.txt'), 'utf8')).toBe('same bytes');
  expect(fs.readFileSync(path.join(f.root, '_待清理隔离区_20261116/copy.txt'), 'utf8')).toBe('same bytes');
});

it('rechecks the source leaf after the final target hash yields, before removing it', async () => {
  const f = fixture(); const source = f.write('源 中文 #%.bin', crypto.randomBytes(150000)), plan = await f.plan();
  exdev(source); const original = fs.openSync; let targetReads = 0, timer: NodeJS.Immediate | undefined;
  jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = original(file, flags, mode);
    // First target read is real checkpoint post-state storage. Second is the
    // final target hash, which runs after the last source hash completed.
    if (String(file) === path.join(f.root, '整理/目标 中文.bin') && flags === 'r' && ++targetReads === 2) timer = setImmediate(() => fs.writeFileSync(source, 'late human edit'));
    return fd;
  }) as typeof fs.openSync);
  try {
    const result = await run(f, plan); expect(targetReads).toBeGreaterThanOrEqual(2);
    expect(result.operations[0]).toMatchObject({ status: 'failed', code: 'BATCH_SOURCE_DRIFT', targetPublished: true, sourceRemoved: false });
    expect(fs.readFileSync(source, 'utf8')).toBe('late human edit');
  } finally { if (timer) clearImmediate(timer); }
});

it('does not accept caller identity mutation across the trusted approval await', async () => {
  const f = fixture(), callerIdentity = { ...identity }; f.write('a.txt', 'bytes');
  const service = new A9WorkspaceService(f.root, { officeBatchApproval: { async consume(_id, binding) {
    queueMicrotask(() => { callerIdentity.turnId = 'forged-turn'; });
    return { status: 'approved', bindingSha256: binding.bindingSha256 };
  } } });
  const plan = await service.planOrganize(callerIdentity, [{ kind: 'move', source: 'a.txt', destination: 'out.txt' }]);
  const result = await service.executeOrganize({ planId: plan.planId, identity: callerIdentity, selectedActionIds: ['a001'], approvalId: 'ui-authorized' });
  expect(result.operations[0].status).toBe('succeeded'); expect(service.getCheckpointManager().loadCheckpoint(identity.turnId)).toBeDefined();
  expect(service.getCheckpointManager().loadCheckpoint('forged-turn')).toBeUndefined();
});
