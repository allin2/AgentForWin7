/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const status = require('../../product/renderer/a9-agent-status');
const { TurnOutcome } = require('../../../core/dist');
const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');

describe('A9 agent turn lifecycle vocabulary', () => {
  test('knows every core TurnOutcome, so setAgentStatus never rejects a real turn result', () => {
    for (const outcome of Object.values(TurnOutcome)) expect(status.isKnown(outcome)).toBe(true);
  });

  test('classifies each status into exactly one phase', () => {
    expect(status.STATUSES.filter(status.isActive)).toEqual(['running', 'cancelling']);
    expect(status.STATUSES.filter(status.isAwaitingUser)).toEqual(['needs_approval', 'needs_input']);
    // Every outcome persisted as task 'failed' by statusesForOutcome reads as a failure live too.
    expect(status.STATUSES.filter(status.isFailure)).toEqual(['failed', 'blocked', 'stuck', 'budget_exceeded']);
    expect(status.phaseOf('interrupted')).toBe(status.PHASE.INTERRUPTED);
    for (const idle of ['idle', 'completed', 'completed_with_warnings', 'cancelled']) expect(status.phaseOf(idle)).toBe(status.PHASE.IDLE);
  });

  test('unknown or missing statuses keep the historic idle reading', () => {
    for (const value of [undefined, null, '', 'ready', 'closed']) {
      expect(status.isKnown(value)).toBe(false);
      expect(status.phaseOf(value)).toBe(status.PHASE.IDLE);
    }
  });

  test('the runtime writes agentStatus only through setAgentStatus', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../product/a9-agent-runtime.js'), 'utf8');
    const writes = source.split('\n').filter((line) => /\bagentStatus\s*=[^=]/.test(line)).map((line) => line.trim());
    expect(writes).toEqual(["let agentStatus = 'idle';", 'agentStatus = next;']);
  });
});

describe('A9 agent turn lifecycle transition contract', () => {
  const legal = (from: string, to: string) => status.canTransition(from, to);

  test('OUTCOMES are exactly the core TurnOutcome values', () => {
    expect([...status.OUTCOMES].sort()).toEqual([...Object.values(TurnOutcome)].sort());
  });

  test('a turn starts from every resting phase and never from nothing', () => {
    for (const from of ['idle', 'completed', 'completed_with_warnings', 'cancelled', 'failed', 'blocked', 'stuck', 'budget_exceeded', 'interrupted', 'needs_approval', 'needs_input']) {
      expect(legal(from, 'running')).toBe(true);
    }
    expect(legal('cancelling', 'running')).toBe(false);
  });

  test('running ends in an outcome or is cancelled; cancelling only ends', () => {
    for (const outcome of status.OUTCOMES) {
      expect(legal('running', outcome)).toBe(true);
      expect(legal('cancelling', outcome)).toBe(true);
    }
    expect(legal('running', 'cancelling')).toBe(true);
    expect(legal('running', 'idle')).toBe(false);
    expect(legal('cancelling', 'idle')).toBe(false);
  });

  test('resting phases cannot jump to an outcome or cancel without a running turn', () => {
    for (const from of ['idle', 'completed', 'cancelled', 'blocked', 'interrupted']) {
      expect(legal(from, 'completed_with_warnings')).toBe(false);
      expect(legal(from, 'cancelling')).toBe(false);
      expect(legal(from, 'needs_approval')).toBe(false);
    }
  });

  test('awaiting the user: resume, Stop on an office selection, or close-cancel', () => {
    for (const to of ['running', 'cancelling', 'cancelled', 'needs_approval', 'needs_input']) expect(legal('needs_approval', to)).toBe(true);
    expect(legal('needs_input', 'completed')).toBe(false);
    expect(legal('needs_input', 'idle')).toBe(false);
  });

  test('failure and interruption can end any phase; self transitions are idempotent', () => {
    for (const from of status.STATUSES) {
      expect(legal(from, 'failed')).toBe(true);
      expect(legal(from, 'interrupted')).toBe(true);
      expect(legal(from, from)).toBe(true);
    }
    expect(legal('running', 'unknown')).toBe(false);
  });

  test('only durable resynchronization writes are marked resync in the runtime', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../product/a9-agent-runtime.js'), 'utf8');
    const resyncs = source.split('\n').filter((line) => line.includes('resync: true')).map((line) => line.trim());
    expect(resyncs).toEqual([
      'setAgentStatus(statusForConversationActivity(activeConversation.activity), { resync: true });',
      'setAgentStatus(statusForConversationActivity(record.activity), { resync: true });',
      "setAgentStatus('needs_input', { resync: true });",
    ]);
  });
});

describe('A9 runtime reports agentStatus transitions to the observer', () => {
  type Step = 'text' | 'ask' | 'hang' | 'fail';
  async function fixture(steps: Step[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-status-'));
    const workspaceRoot = path.join(root, 'ws'); const dataRoot = path.join(root, 'data');
    fs.mkdirSync(workspaceRoot); fs.mkdirSync(dataRoot);
    const hanging: http.ServerResponse[] = [];
    let notifyHang: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => { notifyHang = resolve; });
    let index = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const step = steps[index++] || 'text';
        if (step === 'fail') { res.writeHead(400); res.end('fixture failure'); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (step === 'hang') { res.write(': waiting\n\n'); hanging.push(res); notifyHang?.(); return; }
        const delta = step === 'ask'
          ? { tool_calls: [{ index: 0, id: `q-${index}`, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ prompt: 'which?' }) } }] }
          : { content: 'done' };
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: step === 'ask' ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const transitions: any[] = [];
    const databases: any[] = [];
    const runtime = createA9AgentRuntime({
      workspaceRoot, dataRoot, ownerId: `a9-status-${process.pid}`,
      openDatabase: (file: string, options: any = {}) => { const db = new Database(file, options); databases.push(db); return db; },
      agentStatusObserver: (t: any) => transitions.push(t),
    });
    runtime.setMode('read_only');
    await runtime.configureProvider({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: 'fixture', skipProbe: true });
    const close = async () => {
      try { await runtime.shutdown(); }
      finally {
        hanging.forEach((res) => res.destroy());
        for (const db of databases) if (db.open) db.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
    return { runtime, transitions, hung, close };
  }
  const edges = (transitions: any[]) => transitions.filter((t) => !t.resync).map((t) => `${t.from}>${t.to}`);

  test('complete, ask/answer, Stop and provider failure all follow the contract', async () => {
    const f = await fixture(['text', 'ask', 'text', 'hang', 'fail']);
    try {
      expect((await f.runtime.submitTurn('hello')).result.outcome).toBe('completed');
      const asked = await f.runtime.submitTurn('ask me');
      expect(asked.result.outcome).toBe('needs_input');
      const q = asked.result.pendingQuestion;
      const answered = await f.runtime.answerQuestion({ conversationId: q.conversationId, questionId: q.questionId,
        revision: q.revision, decision: 'answered', answer: 'this one' });
      expect(answered.ok).toBe(true);
      const stopped = f.runtime.submitTurn('wait then stop');
      await f.hung;
      expect(f.runtime.stop().ok).toBe(true);
      expect((await stopped).result.outcome).toBe('cancelled');
      await f.runtime.submitTurn('fail please');
      const observed = edges(f.transitions);
      expect(observed.slice(0, 7)).toEqual([
        'idle>running', 'running>completed', 'completed>running', 'running>needs_input',
        'needs_input>running', 'running>completed', 'completed>running',
      ]);
      expect(observed).toEqual(expect.arrayContaining(['running>cancelling', 'cancelling>cancelled', 'cancelled>running']));
      expect(f.transitions.filter((t) => !t.legal)).toEqual([]);
      expect(f.runtime.getSnapshot().agentStatus).toBe(observed[observed.length - 1].split('>')[1]);
    } finally { await f.close(); }
  }, 30_000);

  test('a throwing observer cannot change the turn', async () => {
    const f = await fixture(['text']);
    try {
      (f.transitions as any).push = () => { throw new Error('observer bug'); };
      expect((await f.runtime.submitTurn('hello')).result.outcome).toBe('completed');
      expect(f.runtime.getSnapshot().agentStatus).toBe('completed');
    } finally { await f.close(); }
  }, 30_000);

  test('an async rejecting observer cannot change the turn or crash unhandled', async () => {
    const f = await fixture(['text']);
    try {
      (f.transitions as any).push = async () => { throw new Error('async observer bug'); };
      expect((await f.runtime.submitTurn('hello')).result.outcome).toBe('completed');
      expect(f.runtime.getSnapshot().agentStatus).toBe('completed');
    } finally { await f.close(); }
  }, 30_000);
});
