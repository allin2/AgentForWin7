/**
 * A9-67 F-023: synchronous IPCChannel APIs must reject a native async handler
 * before it runs (no side effect, safe to switch to the async API). An
 * ordinary function returning a Promise cannot be recognised before the call;
 * it is reported as started-without-result, never as a retryable failure.
 *
 * A9-66 F-007: the product question-reply IPC identity check must not project
 * the full conversation history (non-paged snapshot).
 */
import { IPCChannel } from '../../src/ipc/channel';
import { IPCMessageType, IPCDirection, IPCMessage } from '../../src/ipc/messages';

const { createA9ProductRequestHandler, A9_ACTIONS, A9_IPC_SCHEMA_VERSION } = require('../../product/a9-product-ipc');

function message(): IPCMessage {
  return {
    protocolVersion: '1.0.0', id: 'msg-a9-67', type: IPCMessageType.SESSION_CREATE,
    direction: IPCDirection.RENDERER_TO_CORE, sessionId: 'sess-a9-67', timestamp: new Date().toISOString(),
    payload: { workspacePath: '/home/user/project' },
  };
}

describe('A9-67 F-023 IPCChannel sync/async boundary', () => {
  it('rejects a native async handler before any side effect for send and receive', async () => {
    const channel = new IPCChannel();
    let sideEffects = 0;
    channel.registerHandler(IPCMessageType.SESSION_CREATE, async () => { sideEffects += 1; });
    expect(channel.send(message())).toMatchObject({ success: false, code: 'ASYNC_HANDLER_REQUIRES_ASYNC_API' });
    expect(channel.receive(message())).toMatchObject({ success: false, code: 'ASYNC_HANDLER_REQUIRES_ASYNC_API' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sideEffects).toBe(0);
    // The recommended async API then runs the handler exactly once.
    expect(await channel.sendAsync(message())).toMatchObject({ success: true });
    expect(sideEffects).toBe(1);
  });

  it('reports an ordinary Promise-returning handler as started, not as a retryable failure', async () => {
    const channel = new IPCChannel();
    let sideEffects = 0;
    channel.registerHandler(IPCMessageType.SESSION_CREATE, () => { sideEffects += 1; return Promise.resolve(); });
    const result = channel.send(message());
    expect(result).toMatchObject({ success: false, code: 'ASYNC_HANDLER_STARTED_WITHOUT_RESULT' });
    expect(result.recommendedAction).toContain('不要重试');
    expect(sideEffects).toBe(1);
  });
});

describe('A9-66 F-007 question reply identity check', () => {
  it('uses the paged snapshot, never the full-history projection', async () => {
    const snapshotCalls: any[] = [];
    const runtime = {
      getSnapshot(options?: any) { snapshotCalls.push(options); return { activeConversationId: 'conv-1' }; },
      async answerQuestion(payload: any) { return { ok: true, payload }; },
    };
    const handler = createA9ProductRequestHandler({ getA9Runtime: () => runtime, isValidRendererSender: () => true });
    const result = await handler({}, { schemaVersion: A9_IPC_SCHEMA_VERSION, action: A9_ACTIONS.QUESTION_REPLY,
      payload: { conversationId: 'conv-1', questionId: 'q-1', revision: 1, decision: 'cancelled' } });
    expect(result.ok).toBe(true);
    expect(snapshotCalls.length).toBeGreaterThan(0);
    for (const options of snapshotCalls) expect(options).toMatchObject({ conversationPage: true });
  });
});

describe('A9-67 F-028 SQLite probe diagnostics', () => {
  it('a failed Electron SQLite probe carries a stable classifiable code before the detail', () => {
    const { openA9RuntimePersistence } = require('../../product/a9-agent-runtime');
    const outcome = openA9RuntimePersistence({ electronSqliteRoot: '/nonexistent-a9-66-67-sqlite-root', dataRoot: '/nonexistent' }, {});
    expect(outcome.status).toBe('electron_sqlite_unavailable');
    expect(outcome.reason).toMatch(/^A9_PROBE_SQLITE_MODULE_MISSING: /);
  });
});
