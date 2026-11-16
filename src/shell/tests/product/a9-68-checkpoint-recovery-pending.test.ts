/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9ProductRequestHandler, A9_ACTIONS } = require('../../product/a9-product-ipc');
const { CheckpointManager, A9WorkspaceService } = require('../../../workspace/dist');
const { A9PersistenceManager } = require('../../../state/dist');

// Real SQLite/workspace recovery, held at the asynchronous manifest boundary.
// No timer threshold: calls must settle before the held validation is released.
describe('A9-68 nonblocking checkpoint recovery', () => {
  let root: string;
  let runtime: any;
  let release: () => void;
  let requests: number;
  const turnId = 'turn-crash';
  const create = () => createA9AgentRuntime({
    workspaceRoot: path.join(root, '中文 空格'), dataRoot: path.join(root, 'data'),
    wrapProvider: () => ({ sendStreamRequest: async () => {
      requests += 1;
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    } }),
    openDatabase: (file: string, options?: { readonly?: boolean }) => new Database(file, options?.readonly ? { readonly: true } : {}),
  });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-68-'));
    fs.mkdirSync(path.join(root, '中文 空格'));
    requests = 0;
    runtime = create();
    runtime.setMode('full_access');
    await runtime.configureProvider({ baseUrl: 'https://fixture.invalid', model: 'fixture', skipProbe: true });
    const sessionId = runtime.getSnapshot().activeConversationId;
    await runtime.shutdown();
    runtime = null;
    await new A9WorkspaceService(path.join(root, '中文 空格')).freezeTurnBaseline(turnId);
    const db = new Database(path.join(root, 'data', 'a9-state.db'));
    const now = new Date().toISOString();
    db.prepare('INSERT INTO a9_tasks (task_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-crash', sessionId, 'active', now, now);
    db.prepare('INSERT INTO a9_turns (turn_id, task_id, session_id, status, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(turnId, 'task-crash', sessionId, 'active', '{}', now, now);
    db.close();
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const load = CheckpointManager.prototype.loadCheckpointAsync;
    jest.spyOn(CheckpointManager.prototype, 'loadCheckpointAsync').mockImplementation(async function (this: any, ...args: any[]) {
      await gate;
      return load.apply(this, args);
    });
  });

  afterEach(async () => {
    release();
    if (runtime) await runtime.shutdown();
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // continueTask 是恢复动作：对账完成后恢复（有限等待），不属于 PENDING 断言集；其成功路径由 a9-ask-user-runtime.test.ts 覆盖。
  const gatedEntries = () => [
    () => runtime.submitTurn('hello'),
    () => runtime.undoTurn(turnId),
    () => runtime.undoFile(turnId, 'file.txt'),
    () => runtime.getDiff(turnId),
    () => runtime.resumeApproval({}),
    () => runtime.answerQuestion({}),
  ];

  // 有中断 turn 时，对账有界完成（gate.release() 后放行）：入口等待而非无限卡死，随后正常执行。
  // shutdown/scope/approval 等确定态语义由既有 a9-61 / a9-lifecycle 套件覆盖。
  it('waits for reconciliation (bounded), then allows execution and checkpoint access', async () => {
    runtime = create();
    expect(runtime.getSnapshot().activeConversationId).toBeTruthy();
    const turn = runtime.submitTurn('hello');
    const diff = runtime.getDiff(turnId);
    const undo = runtime.undoTurn(turnId);
    // 对账未完成时入口不 resolve（等待，而非无限轮询卡死）。
    const stillWaiting = await Promise.race([
      Promise.all([turn, diff, undo].map((p) => p.then(() => 'resolved'))),
      new Promise((resolve) => setImmediate(() => resolve('entry still waiting'))),
    ]);
    expect(stillWaiting).toBe('entry still waiting');
    expect(requests).toBe(0);
    release();
    expect((await diff).ok).toBe(true);
    expect((await undo).ok).toBe(true);
    expect((await turn).ok).toBe(true);
    expect(requests).toBe(1);
    await runtime.whenReady();
  });

  it('keeps every gated entry fail-closed after reconciliation fails', async () => {
    jest.spyOn(A9PersistenceManager.prototype, 'reconcileInterruptedWorkspaceCheckpoints').mockImplementation(() => {
      throw new Error('fixture reconciliation failure');
    });
    runtime = create();
    release();
    await runtime.whenReady();
    expect(runtime.getSnapshot().checkpointRecoveryDiagnostics.code).toBe('A9_CHECKPOINT_RECONCILIATION_FAILED');
    // 依赖 checkpoint/输入校验的入口（undoTurn/undoFile/getDiff/resumeApproval/answerQuestion）
    // 由其前置检查兜底；此处覆盖 FATAL 直达的入口级 fail-closed（submitTurn/continueTask）。
    const entries = () => [
      () => runtime.submitTurn('hello'),
      () => runtime.continueTask({}),
    ];
    for (const call of entries()) {
      expect(await call()).toMatchObject({ ok: false, error: { code: 'A9_CHECKPOINT_RECONCILIATION_FAILED' } });
    }
    expect(requests).toBe(0);
  });

  it('serves a9.snapshot.get through product IPC immediately while checkpoint reconciliation is pending', async () => {
    runtime = create();
    const handler = createA9ProductRequestHandler({
      isValidRendererSender: () => true,
      getA9Runtime: () => runtime,
    });
    let snapshotSettled = false;
    const snapshotPromise = handler({}, {
      schemaVersion: 9,
      action: A9_ACTIONS.SNAPSHOT_GET,
      payload: { conversationPage: true },
    }).then((value: any) => {
      snapshotSettled = true;
      return value;
    });
    const turnPromise = handler({}, {
      schemaVersion: 9,
      action: A9_ACTIONS.TURN_SUBMIT,
      payload: { prompt: 'wait for reconciliation' },
    });
    const outcome = await Promise.race([
      snapshotPromise.then((value: any) => ({ tag: 'snapshot', value })),
      new Promise((resolve) => setImmediate(() => resolve({ tag: 'timeout' }))),
    ]);
    expect(snapshotSettled).toBe(true);
    expect(outcome).toMatchObject({
      tag: 'snapshot',
      value: {
        ok: true,
        snapshot: {
          status: 'ready',
          activeConversationId: expect.any(String),
          conversationPage: expect.any(Object),
        },
      },
    });
    expect(requests).toBe(0);
    release();
    await runtime.whenReady();
    expect(await turnPromise).toMatchObject({ ok: true });
    expect(requests).toBe(1);
    await runtime.shutdown();
    expect(await handler({}, {
      schemaVersion: 9,
      action: A9_ACTIONS.SNAPSHOT_GET,
      payload: { conversationPage: true },
    })).toMatchObject({ ok: false, error: { code: 'A9_RUNTIME_SHUTDOWN' } });
    runtime = null;
  });
});
