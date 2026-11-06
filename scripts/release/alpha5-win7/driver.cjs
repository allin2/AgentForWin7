'use strict';
// A9-48 candidate-external combined Win7 smoke, derived from the verified A9-47 r4 driver.
// Product bytes remain unchanged; all run/source/package bindings arrive in config.json.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const cp = require('child_process');
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const config = JSON.parse(fs.readFileSync(arg('config'), 'utf8'));
const out = arg('out') || config.output;
assert(out && path.isAbsolute(out));
const physicalFs = process.versions.electron ? require('original-fs') : fs;
const hash = file => crypto.createHash('sha256').update(physicalFs.readFileSync(file)).digest('hex');
const textHash = text => crypto.createHash('sha256').update(text).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const draftPersistence = () => {
  if (process.platform !== 'win32') return { mode: 'memory', note: 'Mac 开发机无 Windows DPAPI，草稿仅在当前进程保留。' };
  try {
    const safeStorage = require('electron').safeStorage;
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable() === true) return { mode: 'dpapi' };
  } catch (_error) {}
  return { mode: 'memory', note: 'Windows DPAPI 不可用，草稿仅在当前进程保留。' };
};
const files = ['main.js', 'preload.js', 'a9-agent-runtime.js', 'a9-package-runtime.js', 'renderer/a9-theme.js', 'renderer/a9-workbench.js', 'renderer/workbench.html', 'renderer/a9-workbench.css'];

function verifyInputs() {
  if (config.manifestSha256) {
    const releaseRoot = path.resolve(config.productRoot, '../../..');
    const manifestFile = path.join(releaseRoot, 'release-manifest.json');
    assert.strictEqual(hash(manifestFile), config.manifestSha256);
    const manifest = JSON.parse(physicalFs.readFileSync(manifestFile, 'utf8'));
    assert.strictEqual(manifest.source_commit, config.sourceCommit);
    assert.strictEqual(manifest.external_acceptance_eligible, true);
    for (const file of manifest.files) {
      const absolute = path.resolve(releaseRoot, file.path);
      assert(absolute.startsWith(releaseRoot + path.sep));
      assert.strictEqual(physicalFs.statSync(absolute).size, file.size, file.path);
      assert.strictEqual(hash(absolute), file.sha256, file.path);
    }
  }
  for (const file of config.sourceFiles || []) {
    assert.strictEqual(hash(path.join(config.productRoot, file.path)), file.sha256, file.path);
  }
}
verifyInputs();

async function parent() {
  assert(!fs.existsSync(out)); fs.mkdirSync(out);
  fs.copyFileSync(__filename, path.join(out, 'drive.cjs'));
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'win7-a9-47-draft-')));
  const workspace = path.join(temporary, '中文 空格工作区');
  const dataRoot = path.join(temporary, 'data');
  const requests = [];
  const sockets = new Set();
  let held = null;
  let running = false;
  const report = { status: 'RUNNING', evidenceClass: process.platform === 'win32' ? 'DEV_CHANNEL' : 'LOCAL_DEVELOPER',
    driverRevision: 'alpha5-combined-r1', driverSha256: hash(__filename), sourceCommit: config.sourceCommit,
    sourceDirty: !config.manifestSha256, zipSha256: config.zipSha256, manifestSha256: config.manifestSha256, runtime: process.versions, externalModelRequests: 0, phases: [],
    sourceFiles: files.map(file => ({ path: file, sha256: hash(path.join(config.productRoot, file)) })) };
  const send = (res, delta, reason) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/facts') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ count: requests.length, prompts: requests.map(x => x.prompt), held: !!held })); return;
    }
    if (req.url === '/release') {
      assert(held); const release = held; held = null; release(); res.end('released'); return;
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 512000) req.destroy(); });
    req.on('end', () => {
      try {
        assert(!req.headers.authorization);
        const input = JSON.parse(body);
        const probe = input.tools?.[0]?.function?.name === 'probe_test_echo';
        const lastUser = input.messages.map(message => message.role).lastIndexOf('user');
        const prompt = String(input.messages[lastUser]?.content || '');
        const hasTool = input.messages.slice(lastUser + 1).some(message => message.role === 'tool');
        const scenario = probe ? 'probe' : prompt.startsWith('A947_CURRENT_FIRST') ? 'first'
          : prompt.startsWith('A947_CURRENT_CANCEL') ? 'cancel' : prompt.startsWith('A947_DRAFT_READY') ? 'manual' : 'unexpected';
        const roles = input.messages.map(message => message.role);
        const systems = roles.filter(role => role === 'system').length;
        const systemOnlyAtHead = roles.every((role, index) => role !== 'system' || index === 0);
        assert(systemOnlyAtHead && systems <= 1, 'STRICT_SYSTEM_TEMPLATE_REJECTED');
        if (scenario === 'first') {
          assert.strictEqual(systems, 1);
          assert(input.messages[0].content.includes('<environment_facts>'));
          assert(input.messages[0].content.includes('A948_PROVIDER_MARKER'));
        }
        requests.push({ scenario, prompt, body, hasTool, systems, systemOnlyAtHead });
        assert(scenario !== 'unexpected');
        if (probe) return send(res, { tool_calls: [{ index: 0, id: 'probe', function: { name: 'probe_test_echo', arguments: '{"message":"probe_ok"}' } }] }, 'tool_calls');
        assert(!body.includes('A947_UNSENT_AFTER_CANCEL'), 'UNSENT_CANCEL_DRAFT_LEAKED');
        if (scenario === 'first') assert(!body.includes('A947_DRAFT_READY'), 'NEXT_DRAFT_LEAKED_INTO_CURRENT_TURN');
        if (hasTool || scenario === 'manual') return send(res, { content: '本轮检查结束。' }, 'stop');
        if (scenario === 'first') held = () => send(res, { tool_calls: [{ index: 0, id: 'read-sample', function: {
          name: 'read', arguments: '{"path":"样本.txt"}' } }] }, 'tool_calls');
        else held = () => send(res, { content: '这条响应不应在取消后消费。' }, 'stop');
        res.once('close', () => { held = null; });
      } catch (error) {
        report.providerError = String(error.stack || error);
        if (!res.headersSent) res.writeHead(500); res.end('FIXTURE_REJECTED');
      }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  try {
    fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# A948 fixture rules\nA948_PROVIDER_MARKER\n', 'utf8'); fs.writeFileSync(path.join(workspace, '样本.txt'), 'a9-47 fixture\n', 'utf8');
    const sampleHash = hash(path.join(workspace, '样本.txt'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const fixture = `http://127.0.0.1:${server.address().port}`;
    const run = async phase => {
      const env = { ...process.env, WIN7AGENT_A9_DATAROOT: dataRoot, LOCALAPPDATA: path.join(temporary, 'local') };
      if (config.manifestSha256) delete env.WIN7AGENT_A9_ELECTRON_SQLITE;
      else env.WIN7AGENT_A9_ELECTRON_SQLITE = config.nativeRoot;
      for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'WIN7AGENT_A9_WORKSPACE']) delete env[name];
      const args = [__filename, `--config=${arg('config')}`, `--out=${path.join(out, phase + '.json')}`, `--phase=${phase}`,
        `--temporary=${temporary}`, `--fixture=${fixture}`, `--evidence=${out}`];
      if (phase === 'first') args.push(`--a9-smoke-workspace=${workspace}`);
      const log = fs.openSync(path.join(out, phase + '.log'), 'wx');
      const result = await new Promise((resolve, reject) => {
        const child = cp.spawn(config.electron, args, { env, stdio: ['ignore', log, log] }); running = true;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 65000);
        child.once('error', error => { clearTimeout(timer); running = false; reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); running = false; resolve({ code, signal, timedOut }); });
      }).finally(() => fs.closeSync(log));
      const detail = JSON.parse(fs.readFileSync(path.join(out, phase + '.json'), 'utf8'));
      report.phases.push({ phase, ...result, detail });
      assert.strictEqual(result.code, 0, detail.error); assert(!result.timedOut && detail.status === 'PASS');
      return detail;
    };
    const firstDetail = await run('first');
    const expectedPersistence = firstDetail.draftPersistence?.mode;
    assert(expectedPersistence === 'dpapi' || expectedPersistence === 'memory');
    const count = requests.length;
    await run('restored'); assert.strictEqual(requests.length, count);
    assert.strictEqual(hash(path.join(workspace, '样本.txt')), sampleHash);
    const Database = require(process.versions.electron ? path.join(config.nativeRoot, 'node_modules/better-sqlite3') : config.hostDatabase); const db = new Database(path.join(dataRoot, 'a9-state.db'), { readonly: true });
    try {
      report.persistence = { integrity: db.pragma('integrity_check', { simple: true }),
        activeTasks: db.prepare("SELECT count(*) n FROM a9_tasks WHERE status='active'").get().n,
        activeTurns: db.prepare("SELECT count(*) n FROM a9_turns WHERE status='active'").get().n,
        activeRuns: db.prepare("SELECT count(*) n FROM a9_runs WHERE status='active'").get().n };
      assert.strictEqual(report.persistence.integrity, 'ok');
      assert.strictEqual(report.persistence.activeTasks + report.persistence.activeTurns + report.persistence.activeRuns, 0);
      assert(!JSON.stringify(db.prepare('SELECT payload_json FROM a9_events').all()).includes('A947_UNSENT_AFTER_CANCEL'));
      const drafts = db.prepare('SELECT draft_ciphertext FROM a9_sessions').all();
      report.draftAtRest = { rows: drafts.length, encrypted: drafts.filter(row => !!row.draft_ciphertext).length,
        plaintextMarkerAbsent: !JSON.stringify(drafts).includes('A947_UNSENT_AFTER_CANCEL') };
      assert(report.draftAtRest.plaintextMarkerAbsent);
      if (expectedPersistence === 'dpapi') assert(report.draftAtRest.encrypted > 0);
    } finally { db.close(); }
    assert(!report.providerError);
    report.restartWithoutReplay = true; report.sampleUnchanged = true;
    assert(report.sourceFiles.every(file => hash(path.join(config.productRoot, file.path)) === file.sha256));
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.error = String(error.stack || error); }
  finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert(!running); fs.rmSync(temporary, { recursive: true, force: true });
    report.temporaryRemoved = !fs.existsSync(temporary);
    report.requests = requests.map(request => ({ scenario: request.scenario, promptSha256: textHash(request.prompt), hasTool: request.hasTool, systems: request.systems, systemOnlyAtHead: request.systemOnlyAtHead }));
    write(path.join(out, 'RESULT.json'), report);
  }
  console.log(JSON.stringify({ status: report.status, checks: report.phases.map(phase => ({ phase: phase.phase, checks: phase.detail.checks.length })),
    requests: requests.length, temporaryRemoved: report.temporaryRemoved, error: report.error }));
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}

async function child() {
  const { app, BrowserWindow } = require('electron');
  const temporary = arg('temporary'); const fixture = arg('fixture'); const phase = arg('phase');
  const report = { phase, status: 'RUNNING', runtime: process.versions, checks: [], errors: [] };
  const nextDraft = 'A947_DRAFT_READY'; const cancelDraft = 'A947_UNSENT_AFTER_CANCEL';
  app.disableHardwareAcceleration(); app.setPath('userData', path.join(temporary, 'profile')); app.setPath('crashDumps', path.join(temporary, 'crashes'));
  let win;
  const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (fn, label) => {
    const deadline = Date.now() + 12000;
    let lastError = null; let lastValue;
    while (Date.now() < deadline) {
      try { const value = await fn(); lastValue = value; if (value) return value; }
      catch (error) { lastError = error; lastValue = { lastError: String(error) }; }
      await delay(30);
    }
    const detail = { lastValue, lastError: lastError ? String(lastError) : null };
    throw new Error('TIMEOUT: ' + label + ' ' + JSON.stringify(detail));
  };
  const snapshot = async () => { const response = await evaluate(() => window.win7Agent.a9.snapshot()); assert(response.ok); return response.snapshot; };
  const control = route => new Promise((resolve, reject) => http.get(fixture + route, response => {
    let body = ''; response.on('data', chunk => { body += chunk; });
    response.on('end', () => { if (response.statusCode !== 200) reject(new Error(body)); else resolve(route === '/facts' ? JSON.parse(body) : body); });
  }).on('error', reject));
  const setInput = value => evaluate(text => {
    const node = document.getElementById('task-prompt'); node.value = text; node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  const check = async (name, fn) => { report.checks.push({ name, status: 'PASS', detail: await fn() }); };
  const isIdle = async () => evaluate(() => !document.getElementById('run-task').hidden && !document.getElementById('task-prompt').disabled);
  const submit = async prompt => { await setInput(prompt); await evaluate(() => document.getElementById('run-task').click()); };
  app.on('web-contents-created', (_event, contents) => {
    contents.on('preload-error', (_e, _file, error) => report.errors.push(error.message));
    contents.on('render-process-gone', (_e, detail) => report.errors.push(JSON.stringify(detail)));
  });
  require(path.join(config.productRoot, 'main.js'));
  try {
    await app.whenReady(); assert.strictEqual(process.versions.electron, '22.3.27'); assert.strictEqual(process.versions.modules, '110');
    await until(() => {
      win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/renderer/workbench.html'));
      return win && !win.webContents.isLoading();
    }, 'real product window');
    await until(async () => (await snapshot()).status === 'ready', 'runtime ready');
    report.draftPersistence = draftPersistence();
    if (phase === 'first') {
      await check('theme_switch_retains_renderer_isolation', async () => {
        const initial = await evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'),
          node: typeof require, process: typeof process }));
        assert.strictEqual(initial.theme, 'light');
        assert.strictEqual(initial.node, 'undefined'); assert.strictEqual(initial.process, 'undefined');
        await evaluate(() => { const node = document.getElementById('a9-appearance-theme');
          node.value = 'dark'; node.dispatchEvent(new Event('change', { bubbles: true })); });
        await until(() => evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark'), 'dark theme');
        return { initial, changedTo: 'dark' };
      });
      await evaluate(() => {
        document.querySelector('input[name="a9-mode-choice"][value="read_only"]').checked = true;
        document.getElementById('a9-mode-apply').click();
      });
      await until(async () => (await snapshot()).mode === 'read_only', 'Read Only');
      await evaluate(url => {
        document.getElementById('a9-provider-url').value = url + '/v1';
        document.getElementById('a9-provider-model').value = 'local-a947-fixture'; document.getElementById('a9-provider-apply').click();
      }, fixture);
      await until(() => evaluate(() => document.getElementById('a9-provider-probe-state').textContent === 'tool_calling'), 'probe');
      await submit('A947_CURRENT_FIRST 当前只读任务');
      await until(async () => (await control('/facts')).held && (await snapshot()).agentStatus === 'running', 'held real request');
      await check('running_draft_is_editable_enter_newline_and_send_blocked', async () => {
        const ui = await evaluate(() => {
          const input = document.getElementById('task-prompt'); input.focus();
          return { disabled: input.disabled, sendHidden: document.getElementById('run-task').hidden,
            stopHidden: document.getElementById('cancel-task').hidden, placeholder: input.placeholder };
        });
        assert(!ui.disabled && ui.sendHidden && !ui.stopHidden && ui.placeholder.includes('手动发送'));
        await setInput(nextDraft);
        await evaluate(() => { const input = document.getElementById('task-prompt'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
        win.show(); win.focus();
        await until(() => win.isFocused(), 'test window focus');
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await until(() => evaluate(() => document.getElementById('task-prompt').value.includes('\n')), 'native Enter newline');
        await win.webContents.insertText('继续核对');
        const text = await evaluate(() => document.getElementById('task-prompt').value);
        assert.strictEqual((await control('/facts')).count, 2);
        await until(async () => (await snapshot()).draft.text === text, 'real draft save');
        report.savedDraftHash = textHash(text);
        return { ...ui, persistence: report.draftPersistence.mode };
      });
      const value = await evaluate(() => document.getElementById('task-prompt').value);
      await check('running_refresh_preserves_draft_selection_and_request_isolation', async () => {
        await evaluate(() => document.getElementById('task-prompt').setSelectionRange(1, 5));
        await evaluate(() => window.win7AgentA9Workbench.refreshSnapshot());
        const actual = await evaluate(() => { const node = document.getElementById('task-prompt'); return { value: node.value, start: node.selectionStart, end: node.selectionEnd }; });
        assert.strictEqual(actual.value, value); assert.strictEqual(actual.start, 1); assert.strictEqual(actual.end, 5);
        const facts = await control('/facts'); assert(!facts.prompts.some(prompt => prompt.includes(nextDraft)));
        const current = await snapshot(); const events = await evaluate(id => window.win7Agent.a9.queryEvents({ conversationId: id, limit: 200 }), current.activeConversationId);
        assert(!JSON.stringify(events).includes(nextDraft));
        assert.strictEqual(current.draft.persistence, report.draftPersistence.mode);
        if (report.draftPersistence.mode === 'memory') {
          assert(current.draft.note.includes('内存') || current.draft.note.includes('当前进程'));
        }
        return { selectionPreserved: true, requests: facts.count, persistence: current.draft.persistence,
          expectedPersistence: report.draftPersistence.mode, draftNotInCurrentEvents: true };
      });
      await check('running_draft_and_stop_remain_visible_at_affected_viewports', async () => {
        const rows = []; const originalMinimum = win.getMinimumSize();
        win.setMinimumSize(500, 400);
        try {
          for (const [width, height] of [[1366,768],[1079,540],[900,650],[780,640]]) {
            win.setPosition(0, 0); win.setContentSize(width, height);
            // A single physical-pixel rounding difference is possible under fractional DPI.
            await until(() => evaluate((w,h) => Math.abs(innerWidth-w) <= 1 && Math.abs(innerHeight-h) <= 1,
              width, height), 'requested viewport within one CSS pixel');
            await evaluate(() => {
              if (document.getElementById('inspector').classList.contains('open')) document.getElementById('close-inspector').click();
              if (innerWidth < 800 && document.getElementById('navigation-rail').classList.contains('open')) document.getElementById('close-navigation').click();
            });
            await until(() => evaluate(() => document.getAnimations().filter(animation =>
              animation.effect.getTiming().iterations !== Infinity).every(animation => animation.playState !== 'running')),
              'finite layout animations finished');
            await until(() => evaluate(() => {
              const input = document.getElementById('task-prompt'); const inputBox = input.getBoundingClientRect();
              const inputHit = document.elementFromPoint(inputBox.left + 16, inputBox.top + 20);
              const button = document.getElementById('cancel-task'); const box = button.getBoundingClientRect();
              const hit = document.elementFromPoint(box.x + box.width/2, box.y + box.height/2);
              const hint = document.getElementById('composer-draft-guidance').getBoundingClientRect();
              return inputHit === input && !!hit && button.contains(hit) && hint.left >= 0 && hint.right <= innerWidth;
            }), 'visible draft and directly clickable Stop');
            const fact = await evaluate((w,h) => ({ requestedWidth:w, requestedHeight:h, width:innerWidth, height:innerHeight,
              devicePixelRatio, scrollWidth:document.documentElement.scrollWidth,
              guidanceVisible:!!document.getElementById('composer-draft-guidance').getClientRects().length,
              stopBottom:document.getElementById('cancel-task').getBoundingClientRect().bottom }), width, height);
            assert(fact.guidanceVisible && fact.stopBottom <= fact.height && fact.scrollWidth <= fact.width);
            rows.push(fact);
            if (width === 900 || width === 780) fs.writeFileSync(path.join(arg('evidence'), `draft-running-${width}.png`),
              (await win.webContents.capturePage()).toPNG(), {flag:'wx'});
          }
        } finally { win.setMinimumSize(...originalMinimum); win.setContentSize(1366, 768); }
        return rows;
      });
      await control('/release');
      await until(async () => (await snapshot()).conversation.some(fact => fact.outcome === 'completed') && await isIdle(), 'first completion');
      await check('real_tool_outcome_duration_and_body_find', async () => {
        const facts = await evaluate(() => ({ durations: Array.from(document.querySelectorAll('.turn-duration')).map(n => n.textContent),
          outcomes: Array.from(document.querySelectorAll('.activity-item .status-tag')).map(n => n.textContent) }));
        assert(facts.durations.some(text => /^\u8017\u65f6 \d+ \u79d2$/.test(text)));
        assert(facts.outcomes.includes('\u5df2\u8bfb\u53d6'));
        await evaluate(() => { document.getElementById('conversation-find-open').click();
          const node = document.getElementById('conversation-find-input'); node.value = 'A947_CURRENT_FIRST';
          node.dispatchEvent(new Event('input', { bubbles: true })); });
        await until(() => evaluate(() => /^1 \/ [1-9]/.test(document.getElementById('conversation-find-count').textContent)), 'real body search match');
        const count = await evaluate(() => document.getElementById('conversation-find-count').textContent);
        await evaluate(() => document.getElementById('conversation-find-close').click());
        assert(await evaluate(() => document.activeElement.id === 'task-prompt'));
        return { ...facts, findCount: count, focusRestored: true };
      });
      await check('completion_retains_draft_and_requires_manual_send', async () => {
        const actual = await evaluate(() => { const node=document.getElementById('task-prompt'); return { value:node.value,start:node.selectionStart,end:node.selectionEnd,disabled:document.getElementById('run-task').disabled }; });
        assert.strictEqual(actual.value,value); assert.strictEqual(actual.start,1); assert.strictEqual(actual.end,5); assert(!actual.disabled);
        assert.strictEqual((await control('/facts')).count,3);
        await evaluate(() => document.getElementById('run-task').click());
        await until(async () => (await snapshot()).conversation.length === 2 && await isIdle(), 'manual second turn');
        const facts=await control('/facts'); assert.strictEqual(facts.count,4); assert.strictEqual(facts.prompts[3],value.trim());
        assert.strictEqual((await snapshot()).draft.text,'');
        return { beforeManualRequests:3, afterManualRequests:4, manualPromptHash:textHash(facts.prompts[3]), draftConsumedOnce:true };
      });
      await submit('A947_CURRENT_CANCEL 当前任务取消');
      await until(async () => (await control('/facts')).held && (await snapshot()).agentStatus === 'running','cancel held request');
      await setInput(cancelDraft);
      await until(async () => (await snapshot()).draft.text === cancelDraft,'saved cancellation draft');
      await evaluate(() => document.getElementById('cancel-task').click());
      await until(async () => (await snapshot()).conversation.some(fact => fact.outcome === 'cancelled') && await isIdle(),'cancelled terminal');
      await check('stop_preserves_unsent_draft_without_audit_or_model_leak',async()=>{
        assert.strictEqual(await evaluate(()=>document.getElementById('task-prompt').value),cancelDraft);
        const facts=await control('/facts');assert.strictEqual(facts.count,5);assert(!facts.prompts.some(prompt=>prompt.includes(cancelDraft)));
        const current=await snapshot();const events=await evaluate(id=>window.win7Agent.a9.queryEvents({conversationId:id,limit:200}),current.activeConversationId);
        assert(!JSON.stringify(events).includes(cancelDraft));
        return { draftRetained:true, requestCount:facts.count, currentTaskCancelled:true, draftNotInEvents:true };
      });
    } else {
      await check('theme_recovers_after_normal_exit_and_can_return_to_light', async () => {
        assert.strictEqual(await evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
        await evaluate(() => { const node = document.getElementById('a9-appearance-theme'); node.value = 'light';
          node.dispatchEvent(new Event('change', { bubbles: true })); });
        await until(() => evaluate(() => document.documentElement.getAttribute('data-theme') === 'light'), 'restored light theme');
        return { darkRestored: true, lightRestored: true };
      });
      await check('restart_honestly_reconciles_persistent_draft_without_replay',async()=>{
        const current=await snapshot();assert.strictEqual(current.draft.persistence,report.draftPersistence.mode);
        const expectedText=report.draftPersistence.mode === 'dpapi' ? 'A947_UNSENT_AFTER_CANCEL' : '';
        assert.strictEqual(current.draft.text,expectedText);
        assert.strictEqual(await evaluate(()=>document.getElementById('task-prompt').value),expectedText);
        const facts=await control('/facts');assert.strictEqual(facts.count,5);
        assert(current.conversationControls.canSwitch && !current.pendingQuestion && !current.pendingApproval);
        return { persistence:current.draft.persistence, expectedPersistence:report.draftPersistence.mode,
          draftRecovered:report.draftPersistence.mode === 'dpapi' && current.draft.text === expectedText,
          requests:facts.count, windowsDpapi: report.draftPersistence.mode === 'dpapi' ? 'OBSERVED_PRODUCT_DPAPI_ROUNDTRIP' : 'DEGRADED_MEMORY',
          note:current.draft.note };
      });
    }
    const final=await snapshot();assert(final.conversationControls.canSwitch);
    report.loadedModules=Object.keys(require.cache).filter(file=>file.startsWith(path.resolve(config.productRoot,'..')+path.sep)
      ||file.startsWith(config.nativeRoot+path.sep)).map(file=>({path:file,sha256:hash(file)}));
    assert.strictEqual(report.errors.length,0);report.status='PASS';
  } catch(error){report.status='FAIL';report.error=String(error.stack||error);}
  finally{write(out,report);app.quit();process.exitCode=report.status==='PASS'?0:1;}
}
if (process.argv.includes('--verify-only')) console.log(JSON.stringify({status:'PASS',operation:'PACKAGE_INPUT_VERIFICATION',sourceCommit:config.sourceCommit}));
else (arg('phase')?child():parent()).catch(error=>{console.error(error);process.exitCode=1;});
