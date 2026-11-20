/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as vm from 'vm';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const { createOfficeApprovalAuthority, createOfficeWorkflow } = require('../../product/a9-office-workflow');
const { loadSkillCatalog } = require('../../../core/dist');
const { OFFICE_READ_TOOLS, OFFICE_WRITE_TOOLS } = require('../../../core/dist/a9-office-tools');
const { A9WorkspaceService } = require('../../../workspace/dist');
import { withCardRenderers } from './a9-renderer-bundle';

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const close of cleanups) await close();
});

async function setup(options: { mode?: string; steps?: Array<{ kind: 'tool'; name: string; args: any } | { kind: 'text'; content: string }> } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-p6-')));
  let runtime: any;
  let server: http.Server;
  const databases: Array<InstanceType<typeof Database>> = [];
  const openDatabase = (file: string, opts: any = {}) => {
    const db = new Database(file, opts);
    databases.push(db);
    return db;
  };
  const close = async () => {
    try { await runtime?.shutdown(); } finally {
      try { for (const db of databases) if ((db as any).open) db.close(); } finally {
        try { if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); } finally {
          fs.rmSync(root, { recursive: true, force: true });
          cleanups.delete(close);
        }
      }
    }
  };
  cleanups.add(close);

  const workspaceRoot = path.join(root, '办公 闭环');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(dataRoot);

  const requests: any[] = [];
  let idx = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const step = (options.steps || [])[idx++];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!step || step.kind === 'text') {
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: step && step.kind === 'text' ? step.content : 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const args = typeof step.args === 'function' ? step.args(parsed) : step.args;
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `p6-${idx}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  runtime = createA9AgentRuntime({
    workspaceRoot,
    dataRoot,
    ownerId: `a9-70-p6-${process.pid}-${Math.random()}`,
    openDatabase,
  });
  runtime.setMode(options.mode || 'full_access');
  await runtime.configureProvider({ baseUrl, model: 'fixture', skipProbe: true });
  const ipc = () => createA9ProductRequestHandler({ isValidRendererSender: () => true, getA9Runtime: () => runtime });
  return { root, workspaceRoot, runtime, requests, ipc, close };
}

describe('A9-70 P6 UI, skills installer & full product closure', () => {
  it('wires every Core office tool across P1-P6 in createOfficeWorkflow', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-wf-')));
    try {
      const authority = createOfficeApprovalAuthority();
      const service = new A9WorkspaceService(tmp, { officeBatchApproval: authority.port });
      const workflow = createOfficeWorkflow({
        service,
        authority,
        identity: (turnId: string) => ({ workspaceId: 'w', conversationId: 'c', turnId }),
        containsSensitiveData: () => false,
        assertAvailable: () => {},
        workspaceModule: require('../../../workspace/dist'),
        transferWorkspaces: { list: () => [], get: () => null },
        withTransferReservation: (_ids: string[], fn: () => any) => fn(),
        archiveAvailable: true,
        templateAvailable: true,
        reportAvailable: true,
        mailAvailable: true,
      });
      const expectedAll = [...OFFICE_READ_TOOLS, ...OFFICE_WRITE_TOOLS].sort();
      expect([...workflow.supportedTools].sort()).toEqual(expectedAll);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('installs built-in skills via host IPC & tool approval, integrates with loadSkillCatalog and refuses Read Only / overwrite', async () => {
    const ro = await setup({ mode: 'read_only' });
    const roScope = ro.runtime.getSnapshot().scope;
    const roRes = await ro.ipc()({}, { schemaVersion: 9, scope: roScope, action: 'a9.office.installSkills', payload: { confirmed: true } });
    expect(roRes).toMatchObject({ ok: false, error: { code: 'A9_MODE_READ_ONLY' } });
    await ro.close();

    const f = await setup({ mode: 'full_access' });
    const snapBefore = f.runtime.getSnapshot();
    expect(snapBefore.builtinOfficeSkills).toHaveLength(3);
    expect(snapBefore.builtinOfficeSkills.every((s: any) => s.installed === false)).toBe(true);

    const scope = snapBefore.scope;
    const res = await f.ipc()({}, { schemaVersion: 9, scope, action: 'a9.office.installSkills', payload: { confirmed: true } });
    expect(res.ok).toBe(true);
    expect(res.result.status).toBe('completed');
    expect(res.result.installed).toHaveLength(3);
    expect(typeof res.turnId).toBe('string');

    // Core loadSkillCatalog picks up all 3 skills immediately.
    const catalog = loadSkillCatalog(f.workspaceRoot, { containsSensitiveData: () => false });
    expect(catalog.status).toBe('loaded');
    expect(catalog.entries.map((e: any) => e.name).sort()).toEqual([
      'office-file-organize', 'office-mail-triage', 'office-template-report',
    ]);

    const snapAfter = f.runtime.getSnapshot();
    expect(snapAfter.builtinOfficeSkills.every((s: any) => s.installed === true)).toBe(true);
    expect(snapAfter.checkpoints.some((c: any) => c.turnId === res.turnId)).toBe(true);

    // Refuses overwrite on repeat call.
    const repeat = await f.ipc()({}, { schemaVersion: 9, scope, action: 'a9.office.installSkills', payload: { confirmed: true } });
    expect(repeat.ok).toBe(false);
    expect(repeat.error.code).toBe('SKILLS_TARGET_EXISTS');

    // Registered UI checkpoint supports real IPC diff & undoTurn cleanly!
    const diffRes = await f.ipc()({}, { schemaVersion: 9, scope, action: 'a9.diff.get', payload: { turnId: res.turnId } });
    expect(diffRes.ok).toBe(true);
    expect(diffRes.review.files).toHaveLength(3);
    const undoRes = await f.ipc()({}, { schemaVersion: 9, scope, action: 'a9.checkpoint.undoTurn', payload: { turnId: res.turnId } });
    expect(undoRes.ok).toBe(true);
    expect(undoRes.outcome.errors).toEqual([]);
    expect(f.runtime.getSnapshot().builtinOfficeSkills.every((s: any) => s.installed === false)).toBe(true);
    await f.close();
  });

  it('folds budget/thinking into advanced settings while preserving initial setup, and drives organize checklist & sample confirmation in workbench DOM', async () => {
    const productRoot = path.join(__dirname, '../../product');
    const html = fs.readFileSync(path.join(productRoot, 'renderer/workbench.html'), 'utf8');
    const script = fs.readFileSync(path.join(productRoot, 'renderer/a9-workbench.js'), 'utf8');

    // Initial model setup stays top-level; budget/thinking folded in #a9-provider-advanced.
    expect(html).toContain('id="a9-provider-advanced"');
    const advStart = html.indexOf('id="a9-provider-advanced"');
    const advEnd = html.indexOf('</details>', advStart);
    const advBlock = html.slice(advStart, advEnd);
    expect(advBlock).toContain('id="a9-provider-budget"');
    expect(advBlock).toContain('id="a9-provider-composer-max"');
    expect(advBlock).toContain('id="a9-provider-thinking"');
    expect(advBlock).toContain('id="a9-provider-effort"');
    expect(html.indexOf('id="a9-provider-url"')).toBeLessThan(advStart);
    expect(html.indexOf('id="a9-provider-model"')).toBeLessThan(advStart);
    expect(html.indexOf('id="a9-provider-key"')).toBeLessThan(advStart);

    // 3 office onboarding prompts present.
    expect(html).toContain('办公：整理去重与归档');
    expect(html).toContain('办公：模板套打与汇报看板');
    expect(html).toContain('办公：只读邮箱与附件收割');
    expect(html).toContain('id="a9-office-install-skills"');

    // Exercise organize checklist narrowing & sample confirmation in real VM workbench harness.
    const nodes = new Map<string, any>();
    const listeners = new Map<string, Array<(e?: any) => any>>();
    class FakeNode {
      children: FakeNode[] = [];
      parentNode: FakeNode | null = null;
      dataset: Record<string, string> = {};
      hidden = false;
      disabled = false;
      checked = false;
      open = false;
      type = '';
      value = '';
      title = '';
      maxLength = 128000;
      private ownText = '';
      attributes: Record<string, string> = {};
      className = '';
      style: Record<string, string> = {};
      classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
      constructor(readonly tagName = 'div') {}
      get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
      set textContent(v: string) { this.ownText = String(v == null ? '' : v); this.children.forEach(c => { c.parentNode = null; }); this.children = []; }
      appendChild(c: FakeNode) { c.parentNode = this; this.children.push(c); return c; }
      insertBefore(c: FakeNode) { return this.appendChild(c); }
      replaceChildren() { this.children = []; }
      remove() {}
      setAttribute(k: string, v: string) { this.attributes[k] = String(v); }
      removeAttribute(k: string) { delete this.attributes[k]; }
      getAttribute(k: string) { return this.attributes[k] || null; }
      focus() {}
      contains(other: any): boolean { return this === other || this.children.some(c => c.contains(other)); }
      addEventListener(type: string, fn: (e?: any) => any) {
        const key = this.attributes.id ? `${this.attributes.id}:${type}` : type;
        if (!this.ownListeners[type]) this.ownListeners[type] = [];
        this.ownListeners[type].push(fn);
        (listeners.get(key) || (listeners.set(key, []), listeners.get(key)!)).push(fn);
      }
      ownListeners: Record<string, Array<(e?: any) => any>> = {};
      fire(type: string, ev: any = {}) { (this.ownListeners[type] || []).forEach(fn => fn(ev)); }
      querySelectorAll(sel: string) {
        const out: FakeNode[] = [];
        const visit = (n: FakeNode) => {
          n.children.forEach((c) => {
            if (sel === 'input[type="checkbox"]' && c.tagName === 'input' && c.type === 'checkbox') out.push(c);
            visit(c);
          });
        };
        visit(this);
        return out;
      }
      querySelector() { return null; }
      getClientRects() { return [{}]; }
    }
    const tagRe = /<([a-z0-9-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html)) !== null) {
      const n = new FakeNode(m[1].toLowerCase());
      n.attributes.id = m[3];
      if (/(?:^|\s)hidden(?:\s|=|$)/i.test(m[2])) n.hidden = true;
      if (/(?:^|\s)disabled(?:\s|=|$)/i.test(m[2])) n.disabled = true;
      nodes.set(m[3], n);
    }

    const selectOfficeActions = jest.fn(async () => ({ ok: true }));
    const confirmTemplateSample = jest.fn(async () => ({ ok: true, confirmedInViewer: true }));
    const installOfficeSkills = jest.fn(async () => ({ ok: true, result: { status: 'completed', installed: [{ name: 'office-file-organize', status: 'succeeded' }] } }));
    let currentSnap: any = {
      schemaVersion: 1,
      status: 'ready',
      workspaceRoot: '/ws',
      mode: 'full_access',
      agentStatus: 'needs_approval',
      activeConversationId: 'c1',
      scope: { workspaceId: 'w1', conversationId: 'c1' },
      conversations: [{ sessionId: 'c1', title: '办公测试', state: 'active', activity: 'waiting_approval' }],
      provider: { configured: true, probe: { classification: 'tool_calling' } },
      shell: { kind: 'automatic', source: 'automatic' },
      pendingApproval: {
        approvalId: 'apr-1',
        bindingDigest: 'a'.repeat(64),
        conversationId: 'c1',
        taskId: 'task-1',
        turnId: 'turn-1',
        toolName: 'batch_organize',
        summary: 'plan summary ("evidenceClass": "SURROGATE")',
        officeSelection: {
          schemaVersion: 1,
          planId: 'plan-1',
          actions: [
            { actionId: 'a001', kind: 'move', source: 'a.txt', destination: '整理/a.txt', sourceSha256: '1'.repeat(64) },
            { actionId: 'a002', kind: 'move', source: 'b.txt', destination: '整理/b.txt', sourceSha256: '2'.repeat(64) },
          ],
        },
      },
      templateSamples: [{
        sampleId: 'smp-1',
        templatePath: '模板/通知.docx',
        templateSha256: '3'.repeat(64),
        normalOutputPath: '样张/普通.docx',
        normalSampleSha256: '4'.repeat(64),
        boundaryOutputPath: '样张/边界.docx',
        boundarySampleSha256: '5'.repeat(64),
        viewerEnvironment: 'WPS Office',
        confirmedInViewer: false,
      }],
      builtinOfficeSkills: [{ name: 'office-file-organize', description: 'd', targetPath: '.agents/skills/office-file-organize/SKILL.md', installed: false }],
    };

    const a9Mock: any = {
      forScope: () => a9Mock,
      snapshot: async () => ({ ok: true, snapshot: currentSnap }),
      queryEvents: async () => ({ ok: true, events: [], hasMore: false }),
      selectOfficeActions,
      confirmTemplateSample,
      installOfficeSkills,
      listCheckpoints: async () => ({ ok: true, checkpoints: [], total: 0 }),
    };

    const docStub: any = {
      getElementById: (id: string) => nodes.get(id) || null,
      createElement: (tag: string) => new FakeNode(tag),
      createTextNode: (t: string) => { const n = new FakeNode('#text'); n.textContent = t; return n; },
      addEventListener: (t: string, fn: any) => { (listeners.get(`doc:${t}`) || (listeners.set(`doc:${t}`, []), listeners.get(`doc:${t}`)!)).push(fn); },
      querySelectorAll: () => [],
      querySelector: () => null,
      body: new FakeNode('body'),
      documentElement: new FakeNode('html'),
    };
    const winStub: any = {
      win7Agent: { a9: a9Mock, signalReady: jest.fn(), getDiagnostics: async () => ({}) },
      win7AgentStatus: require('../../product/renderer/a9-agent-status'),
      win7AgentComposerController: require('../../product/renderer/a9-composer-controller'),
      addEventListener: jest.fn(),
      setInterval, clearInterval, setTimeout, clearTimeout,
      innerWidth: 1366,
    };

    vm.runInNewContext(withCardRenderers(script), {
      window: winStub, document: docStub, console, Promise, Set, Map, Object, Array, String, Number, Date, JSON, Math, Boolean,
    });
    await listeners.get('doc:DOMContentLoaded')![0]();
    await new Promise(r => setTimeout(r, 20));

    // Verify organize checklist rendered 2 checkboxes & approve starts enabled.
    const selList = nodes.get('a9-approval-selection-list')!;
    const checkboxes = selList.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(nodes.get('a9-approval-approve')!.disabled).toBe(false);
    expect(nodes.get('a9-approval-select-apply')!.disabled).toBe(true);

    // Unchecking second item disables direct approve & enables "按勾选更新审批清单".
    checkboxes[1].checked = false;
    checkboxes[1].fire('change');
    expect(nodes.get('a9-approval-approve')!.disabled).toBe(true);
    expect(nodes.get('a9-approval-select-apply')!.disabled).toBe(false);

    // Clicking apply calls selectOfficeActions with ['a001'] only.
    nodes.get('a9-approval-select-apply')!.fire('click');
    await new Promise(r => setTimeout(r, 20));
    expect(selectOfficeActions).toHaveBeenCalledWith('apr-1', 'a'.repeat(64), ['a001'], 'c1', 'task-1', 'turn-1');

    // Verify sample confirmation card rendered & requires checkbox before confirm button activates.
    const sampleList = nodes.get('a9-sample-list')!;
    const sampleChecks = sampleList.querySelectorAll('input[type="checkbox"]');
    expect(sampleChecks).toHaveLength(1);
    const sampleItem = sampleList.children[0];
    const actionsDiv = sampleItem.children[2];
    const confirmBtn = actionsDiv.children[1];
    expect(confirmBtn.disabled).toBe(true);
    sampleChecks[0].checked = true;
    sampleChecks[0].fire('change');
    expect(confirmBtn.disabled).toBe(false);
    confirmBtn.fire('click');
    await new Promise(r => setTimeout(r, 20));
    expect(confirmTemplateSample).toHaveBeenCalledWith({
      sampleId: 'smp-1',
      viewerEnvironment: 'WPS Office',
      normalSampleSha256: '4'.repeat(64),
      boundarySampleSha256: '5'.repeat(64),
    });

    // Verify SURROGATE badge displays when approval summary marks SURROGATE.
    expect(nodes.get('a9-approval-surrogate')!.hidden).toBe(false);
    expect(nodes.get('a9-approval-surrogate')!.textContent).toContain('SURROGATE');

    // Verify built-in skills installer shows target paths first on welcome & settings and only installs after explicit confirm click.
    expect(html).toContain('id="a9-settings-install-skills"');
    expect(nodes.get('a9-office-skills-confirm')!.hidden).toBe(true);
    expect(nodes.get('a9-settings-skills-confirm')!.hidden).toBe(true);
    nodes.get('a9-office-install-skills')!.fire('click');
    expect(nodes.get('a9-office-skills-confirm')!.hidden).toBe(false);
    expect(nodes.get('a9-settings-skills-confirm')!.hidden).toBe(true);
    expect(nodes.get('a9-office-skills-targets')!.textContent).toContain('.agents/skills/office-file-organize/SKILL.md');
    expect(installOfficeSkills).not.toHaveBeenCalled();

    nodes.get('a9-settings-install-skills')!.fire('click');
    expect(nodes.get('a9-settings-skills-confirm')!.hidden).toBe(false);
    expect(nodes.get('a9-office-skills-confirm')!.hidden).toBe(true);
    expect(nodes.get('a9-settings-skills-targets')!.textContent).toContain('.agents/skills/office-file-organize/SKILL.md');
    expect(installOfficeSkills).not.toHaveBeenCalled();

    nodes.get('a9-settings-skills-confirm-btn')!.fire('click');
    await new Promise(r => setTimeout(r, 20));
    expect(installOfficeSkills).toHaveBeenCalledTimes(1);

    nodes.get('a9-office-install-skills')!.fire('click');
    nodes.get('a9-office-skills-confirm-btn')!.fire('click');
    await new Promise(r => setTimeout(r, 20));
    expect(installOfficeSkills).toHaveBeenCalledTimes(2);
  });
});
