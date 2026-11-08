'use strict';
// A9-53 Win7 DEV_CHANNEL journey for the packaged alpha.7 product. Derived from
// src/shell/tests/product/a9-52-multiworkspace-entry.cjs; the model and native
// directory picker are bounded local fixtures. Node parent owns all sandboxes.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const cp = require('child_process'), assert = require('assert'), crypto = require('crypto');
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const config = JSON.parse(fs.readFileSync(arg('config'), 'utf8'));
const product = config.productRoot;
const windows = process.platform === 'win32';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const physicalFs = process.versions.electron ? require('original-fs') : fs;
const sha = file => crypto.createHash('sha256').update(physicalFs.readFileSync(file)).digest('hex');
function verifyInputs() {
  if (config.manifestSha256) {
    const releaseRoot = path.resolve(product, '../../..'), file = path.join(releaseRoot, 'release-manifest.json');
    assert.strictEqual(sha(file), config.manifestSha256);
    const manifest = JSON.parse(physicalFs.readFileSync(file, 'utf8'));
    assert.strictEqual(manifest.source_commit, config.sourceCommit); assert.strictEqual(manifest.external_acceptance_eligible, true);
    for (const entry of manifest.files) {
      const absolute = path.resolve(releaseRoot, entry.path); assert(absolute.startsWith(releaseRoot + path.sep));
      assert.strictEqual(physicalFs.statSync(absolute).size, entry.size, entry.path); assert.strictEqual(sha(absolute), entry.sha256, entry.path);
    }
  }
  for (const file of config.sourceFiles || []) assert.strictEqual(sha(path.join(product, file.path)), file.sha256, file.path);
}
verifyInputs();
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); }
async function parent() {
  const out = arg('out'), electron = config.electron, native = config.nativeRoot;
  if (!out || !electron || !native || fs.existsSync(out)) throw new Error('NEW_OUTPUT_AND_RUNTIME_PATHS_REQUIRED');
  fs.mkdirSync(out, { recursive: true });
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'win7-a9-52-product-')));
  const a = path.join(temporary, 'A 中文'), b = path.join(temporary, 'B space');
  for (const workspace of [a, b]) { fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'note.txt'), 'preserve\n', 'utf8'); }
  const report = { status: 'RUNNING', evidenceLevel: windows ? 'Win7 DEV_CHANNEL packaged product' : 'Mac development Electron22 packaged product',
    sourceCommit: config.sourceCommit, sourceDirty: config.sourceDirty !== false, zipSha256: config.zipSha256, manifestSha256: config.manifestSha256,
    driverSha256: sha(__filename), sourceFiles: (config.sourceFiles || []).map(file => ({ path: file.path, sha256: sha(path.join(product, file.path)) })),
    externalModelRequests: 0, picker: 'native dialog fixture returning real directories', phases: [], requests: [] };
  const held = new Map(), sockets = new Set(); let child = null;
  const send = (res, delta, reason = 'stop') => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
  };
  const release = prompt => {
    const res = held.get(prompt); if (!res || res.destroyed) throw new Error('NO_HELD_REQUEST ' + prompt); held.delete(prompt);
    const tool = prompt.endsWith('-BG') ? { name: 'start_process', arguments: JSON.stringify({ command: 'ping.exe -n 90 127.0.0.1' }) }
      : prompt.endsWith('-SHELL') ? { name: 'shell', arguments: JSON.stringify({ command: windows ? `echo ${prompt}>shell-result.txt` : `printf '%s' '${prompt}' > shell-result.txt; pwd` }) }
      : { name: 'write', arguments: JSON.stringify({ path: 'result.txt', content: prompt }) };
    send(res, { tool_calls: [{ index: 0, id: 'call-' + prompt, function: tool }] }, 'tool_calls');
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/facts') { res.end(JSON.stringify({ held: [...held.keys()], requests: report.requests })); return; }
      if (url.pathname === '/release') { try { release(url.searchParams.get('prompt')); res.end('ok'); } catch (error) { res.writeHead(400); res.end(error.message); } return; }
    }
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.tools?.[0]?.function?.name === 'probe_test_echo') {
          send(res, { tool_calls: [{ index: 0, id: 'probe', function: { name: 'probe_test_echo', arguments: '{"message":"probe_ok"}' } }] }, 'tool_calls'); return;
        }
        const prompt = data.messages.filter(item => item.role === 'user').pop().content;
        const fact = { prompt, startedAt: Date.now(), endedAt: null }; report.requests.push(fact);
        res.once('close', () => { fact.endedAt = Date.now(); if (held.get(prompt) === res) held.delete(prompt); });
        const lastUser = data.messages.map(item => item.role).lastIndexOf('user');
        if (data.messages.slice(lastUser + 1).some(item => item.role === 'tool')) send(res, { content: prompt + ' completed' });
        else held.set(prompt, res);
      } catch (error) { report.providerError = error.message; res.writeHead(500); res.end('fixture failed'); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const fixture = `http://127.0.0.1:${server.address().port}`;
    for (const phase of (arg('geometry-only') ? ['geometry'] : ['first', 'restart'])) {
      const env = { ...process.env, WIN7AGENT_A9_DATAROOT: path.join(temporary, 'data'), WIN7AGENT_A9_ELECTRON_SQLITE: native, LOCALAPPDATA: path.join(temporary, 'local') };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'WIN7AGENT_A9_WORKSPACE', 'WIN7AGENT_PORTABLE']) delete env[key];
      const log = fs.openSync(path.join(out, phase + '.log'), 'wx');
      const args = [__filename, `--config=${arg('config')}`, `--phase=${phase}`, `--temporary=${temporary}`, `--fixture=${fixture}`, `--out=${out}`, ...(phase !== 'restart' ? [`--a9-smoke-workspace=${a}`] : [])];
      const result = await new Promise((resolve, reject) => {
        child = cp.spawn(electron, args, { env, stdio: ['ignore', log, log] });
        const timeout = setTimeout(() => child.kill('SIGKILL'), windows ? 240000 : 90000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timeout); child = null; resolve({ code, signal }); });
      }).finally(() => fs.closeSync(log));
      const detail = JSON.parse(fs.readFileSync(path.join(out, phase + '.json'), 'utf8'));
      report.phases.push({ phase, ...result, detail }); assert.strictEqual(result.code, 0, detail.error); assert.strictEqual(detail.status, 'PASS', detail.error);
    }
    if (!arg('geometry-only')) {
    assert.strictEqual(fs.readFileSync(path.join(b, 'result.txt'), 'utf8'), 'B-WRITE');
    assert.strictEqual(fs.readFileSync(path.join(a, 'result.txt'), 'utf8'), 'A-WRITE');
    assert.strictEqual(fs.readFileSync(path.join(a, 'shell-result.txt'), 'utf8').trim(), 'A-SHELL');
    assert.strictEqual(fs.readFileSync(path.join(b, 'shell-result.txt'), 'utf8').trim(), 'B-SHELL');
    }
    const Database = require(config.hostDatabase);
    const db = new Database(path.join(temporary, 'data', 'a9-state.db'), { readonly: true });
    try {
      report.sqlite = { integrity: db.pragma('integrity_check', { simple: true }),
        active: ['tasks', 'turns', 'runs'].map(table => db.prepare(`SELECT COUNT(*) n FROM a9_${table} WHERE status='active'`).get().n),
        locks: db.prepare('SELECT COUNT(*) n FROM a9_workspace_locks').get().n };
      assert.strictEqual(report.sqlite.integrity, 'ok'); assert(report.sqlite.active.every(count => count === 0)); assert.strictEqual(report.sqlite.locks, 0);
    } finally { db.close(); }
    report.packagedFiles = ['main.js', 'preload.js', 'a9-product-ipc.js', 'a9-workspace-registry.js', 'a9-agent-runtime.js', 'renderer/a9-workbench.js', 'renderer/workbench.html', 'renderer/a9-workbench.css'].map(file => ({ file, sha256: sha(path.join(product, file)) }));
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.error = error.stack; }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    assert(!child); fs.rmSync(temporary, { recursive: true, force: true });
    report.temporaryRemoved = !fs.existsSync(temporary); write(path.join(out, 'RESULT.json'), report);
  }
  console.log(JSON.stringify({ status: report.status, error: report.error, phases: report.phases.length, requests: report.requests.length }));
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
async function child() {
  const { app, BrowserWindow, dialog } = require('electron');
  const temporary = arg('temporary'), phase = arg('phase'), out = arg('out'), fixture = arg('fixture');
  app.setPath('userData', path.join(temporary, 'profile')); app.setPath('crashDumps', path.join(temporary, 'crashes')); app.disableHardwareAcceleration();
  let nextDirectory = path.join(temporary, 'B space');
  dialog.showOpenDialog = async (_window, options) => options.properties.includes('openFile')
    ? (windows ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: ['/bin/bash'] })
    : nextDirectory ? { canceled: false, filePaths: [nextDirectory] } : { canceled: true, filePaths: [] };
  const report = { status: 'RUNNING', runtime: process.versions, checks: [], errors: [] }; let win;
  const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (check, label) => { const end = Date.now() + (windows ? 30000 : 10000); while (Date.now() < end) { if (await check()) return; await delay(20); } throw new Error('TIMEOUT ' + label); };
  const control = route => new Promise((resolve, reject) => http.get(fixture + route, res => { let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => res.statusCode === 200 ? resolve(route === '/facts' ? JSON.parse(text) : text) : reject(new Error(text))); }).on('error', reject));
  const snapshot = async () => { const response = await evaluate(() => window.win7Agent.a9.snapshot()); assert(response.ok, JSON.stringify(response)); return response.snapshot; };
  const refresh = () => evaluate(() => window.win7AgentA9Workbench.refreshSnapshot());
  const click = id => evaluate(value => document.getElementById(value).click(), id);
  const input = value => evaluate(text => { const el = document.getElementById('task-prompt'); el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const submit = async prompt => { await input(prompt); await until(() => evaluate(() => !document.getElementById('run-task').disabled), 'send enabled'); await click('run-task'); await until(async () => (await control('/facts')).held.includes(prompt), 'request ' + prompt); };
  const check = async (name, run) => { const detail = await run(); report.checks.push({ name, status: 'PASS', detail }); };
  // Resource facts are recorded, not asserted; Win7 limits are decided from these numbers (A9-53 §3).
  const handleCount = pid => { if (!windows) return 'NOT_PERFORMED'; try { const text = cp.execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'HandleCount', '/value'], { encoding: 'utf8', timeout: 10000, windowsHide: true }); const match = /HandleCount=(\d+)/.exec(text); return match ? Number(match[1]) : 'UNKNOWN'; } catch (_error) { return 'UNKNOWN'; } };
  const sample = label => { const metrics = app.getAppMetrics(); const processes = metrics.map(item => ({ pid: item.pid, type: item.type, workingSetKB: item.memory.workingSetSize, privateKB: item.memory.privateBytes ?? 'UNKNOWN', handles: handleCount(item.pid) }));
    const entry = { label, processes: processes.length, workingSetKB: processes.reduce((sum, item) => sum + item.workingSetKB, 0), handles: processes.every(item => typeof item.handles === 'number') ? processes.reduce((sum, item) => sum + item.handles, 0) : 'UNKNOWN', detail: processes };
    (report.resources ||= []).push(entry); return entry; };
  // A9-52 inbox: another workspace is reached by clicking one of its inbox rows; the row must be enabled.
  const selectWorkspace = async id => {
    if ((await snapshot()).scope.workspaceId === id) return;
    // A settled conversation sits in the collapsed "已结束" group; expand it the way a user would.
    await evaluate(value => {
      const rows = [...document.querySelectorAll('#conversation-list .conversation-row')];
      const toggle = document.querySelector('#conversation-list .conversation-group-toggle[aria-expanded="false"]');
      if (!rows.some(row => row.dataset.workspaceId === value) && toggle) toggle.click();
    }, id);
    await until(() => evaluate(value => [...document.querySelectorAll('#conversation-list .conversation-row')]
      .some(row => row.dataset.workspaceId === value && !row.disabled), id), 'inbox row enabled ' + id);
    await evaluate(value => [...document.querySelectorAll('#conversation-list .conversation-row')]
      .find(row => row.dataset.workspaceId === value && !row.disabled).click(), id);
    await until(() => evaluate(async value => { const response = await window.win7Agent.a9.snapshot(); return response.ok && response.snapshot.scope.workspaceId === value; }, id), 'workspace selected');
    await until(() => evaluate(value => [...document.querySelectorAll('#conversation-list .conversation-row')]
      .some(row => row.dataset.workspaceId === value && row.getAttribute('aria-current') === 'true'), id), 'inbox row current');
  };
  // Closing is offered in the filter menu for every opened workspace, including background ones.
  const closeWorkspace = async id => {
    await click('conversation-filter');
    await until(() => evaluate(value => !document.getElementById('workspace-menu').hidden
      && [...document.querySelectorAll('.workspace-menu-close')].some(button => button.dataset.workspaceId === value && !button.disabled), id), 'close entry ' + id);
    await evaluate(value => [...document.querySelectorAll('.workspace-menu-close')].find(button => button.dataset.workspaceId === value).click(), id);
    assert(await evaluate(() => document.getElementById('workspace-close-dialog').open && document.getElementById('workspace-menu').hidden));
    await click('workspace-close-confirm');
    await until(() => evaluate(() => !document.getElementById('workspace-close-dialog').open), 'close dialog closed');
  };
  const responsive = async () => {
        const facts = []; win.setMinimumSize(500, 400);
        for (const [width, height] of [[1366, 768], [1079, 540], [900, 540], [780, 540]]) {
          win.setPosition(0, 0); win.setContentSize(width, height);
          await until(() => evaluate((w, h) => innerWidth === w && innerHeight === h, width, height), 'viewport');
          await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await evaluate(() => { const button = document.getElementById('open-navigation'); if (button.getAttribute('aria-expanded') !== 'true') button.click(); });
          await evaluate(async () => Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
          const detail = await evaluate(() => {
            const hit = el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); };
            const list = document.getElementById('conversation-list'), filter = document.getElementById('conversation-filter'), add = document.getElementById('conversation-new');
            const rows = [...list.querySelectorAll('.conversation-row')];
            // Budget uses the taller two-line row (min 44px) even when only compact settled rows are rendered.
            const rowHeight = Math.max(44, ...rows.map(row => row.getBoundingClientRect().height));
            return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
              railOpen: document.getElementById('navigation-rail').className, expanded: document.getElementById('open-navigation').getAttribute('aria-expanded'),
              rows: rows.length, rowHeight, listHeight: list.clientHeight,
              // One group head stays visible above the rows; each row also has a 2px list-item margin.
              rowCapacity: rowHeight ? Math.floor((list.clientHeight - 8 - (list.querySelector('.conversation-group-head, .conversation-group-toggle')?.getBoundingClientRect().height || 0)) / (rowHeight + 2)) : 0,
              filterHit: hit(filter), newHit: hit(add), rowsHit: rows.every(row => { row.scrollIntoView({ block: 'nearest' }); return hit(row); }),
              composerWorkspace: !document.getElementById('composer-workspace').hidden && document.getElementById('composer-workspace-path').textContent };
          });
          assert(detail.filterHit && detail.newHit && detail.rowsHit && detail.scrollWidth <= width && detail.composerWorkspace, JSON.stringify(detail));
          // U02 budget: at least four conversation rows fit at 1366x768 and at the 125% DPI equivalent 1079x540.
          if (width >= 1079) assert(detail.rowCapacity >= 4, JSON.stringify(detail));
          facts.push(detail);
          if (width === 780 || width === 1079 || width === 1366) fs.writeFileSync(path.join(out, `inbox-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
        return facts;
  };
  app.on('web-contents-created', (_event, contents) => {
    contents.on('preload-error', (_event, _file, error) => report.errors.push(error.message));
    contents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
  });
  require(path.join(product, 'main.js'));
  try {
    await app.whenReady();
    await until(() => { win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/renderer/workbench.html')); return win && !win.webContents.isLoading(); }, 'product window');
    await until(async () => (await snapshot()).status === 'ready', 'runtime');
    if (phase === 'geometry') {
      await evaluate(() => { document.querySelector('input[name="a9-mode-choice"][value="read_only"]').checked = true; document.getElementById('a9-mode-apply').click(); });
      await until(async () => (await snapshot()).mode === 'read_only', 'geometry mode');
      await check('responsive_directory_and_composer', responsive);
    } else if (phase === 'first') {
      await evaluate(() => { document.querySelector('input[name="a9-mode-choice"][value="full_access"]').checked = true; document.getElementById('a9-mode-apply').click(); });
      await until(async () => (await snapshot()).mode === 'full_access', 'mode');
      await evaluate(url => { document.getElementById('a9-provider-url').value = url + '/v1'; document.getElementById('a9-provider-model').value = 'local-a952'; document.getElementById('a9-provider-apply').click(); }, fixture);
      await until(async () => (await snapshot()).provider.probe?.classification === 'tool_calling', 'provider configured');
      await refresh(); const a = await snapshot(); sample('one_workspace_ready');
      await submit('A-HOLD');
      await input('UNSENT_A');
      await until(async () => (await snapshot()).draft.text === 'UNSENT_A', 'A draft');
      await check('new_conversation_selects_directory_while_A_keeps_running', async () => {
        await click('conversation-new');
        assert(await evaluate(() => document.getElementById('conversation-new-dialog').open));
        await evaluate(() => { document.querySelector('.project-picker-other').click(); });
        await until(async () => (await snapshot()).workspaceRoot.endsWith('B space'), 'B opened');
        await until(() => evaluate(() => !document.getElementById('conversation-new-dialog').open), 'new dialog closed');
        assert((await control('/facts')).held.includes('A-HOLD'));
        const b = await snapshot(); assert.strictEqual(b.provider.model, 'local-a952');
        await evaluate(() => { document.querySelector('input[name="a9-mode-choice"][value="full_access"]').checked = true; document.getElementById('a9-mode-apply').click(); });
        await until(async () => (await snapshot()).mode === 'full_access', 'B mode');
        return { a: a.scope, b: b.scope };
      });
      const b = await snapshot();
      await submit('B-HOLD');
      await check('two_requests_overlap_and_scope_is_exact', async () => {
        const facts = await control('/facts'); assert(facts.held.includes('A-HOLD') && facts.held.includes('B-HOLD')); sample('two_concurrent_requests');
        assert.strictEqual((await snapshot()).accounting.activeRequests, 2);
        const stale = await evaluate(scope => window.win7Agent.a9.forScope(scope).stop(), a.scope);
        assert.strictEqual(stale.error.code, 'A9_SCOPE_STALE');
        return facts;
      });
      await check('stopping_A_preserves_B_and_drafts', async () => {
        await selectWorkspace(a.scope.workspaceId);
        assert.strictEqual(await evaluate(() => document.getElementById('task-prompt').value), 'UNSENT_A');
        await click('cancel-task');
        await until(async () => (await snapshot()).agentStatus === 'cancelled', 'A cancelled');
        assert((await control('/facts')).held.includes('B-HOLD'));
        await selectWorkspace(b.scope.workspaceId);
        await input('UNSENT_B');
        await until(async () => (await snapshot()).draft.text === 'UNSENT_B', 'B draft');
        await control('/release?prompt=B-HOLD');
        await until(async () => ['completed', 'completed_with_warnings'].includes((await snapshot()).agentStatus), 'B completed');
        await refresh();
        assert.strictEqual(await evaluate(() => document.getElementById('task-prompt').value), 'UNSENT_B');
        return { a: 'cancelled', b: 'completed' };
      });
      await check('cancelled_picker_has_no_empty_conversation', async () => {
        const before = (await snapshot()).conversations.length; nextDirectory = null;
        await click('conversation-new');
        await evaluate(() => { document.querySelector('.project-picker-other').click(); });
        await until(() => evaluate(() => !document.getElementById('conversation-new-dialog').querySelector('.project-picker-item:disabled')), 'picker re-enabled');
        assert.strictEqual((await snapshot()).conversations.length, before);
        await click('conversation-new-cancel'); return { conversations: before };
      });
      await check('both_workspaces_write_and_late_A_completion_preserves_B', async () => {
        await selectWorkspace(a.scope.workspaceId); await submit('A-WRITE');
        await selectWorkspace(b.scope.workspaceId); await submit('B-WRITE');
        await input('B-DRAFT-AFTER-SWITCH');
        await control('/release?prompt=A-WRITE');
        await until(async () => (await control('/facts')).requests.filter(item => item.prompt === 'A-WRITE').length === 2, 'A finished its write');
        assert.strictEqual((await snapshot()).agentStatus, 'running');
        assert.strictEqual(await evaluate(() => document.getElementById('task-prompt').value), 'B-DRAFT-AFTER-SWITCH');
        assert.strictEqual(await evaluate(() => document.getElementById('cancel-task').hidden), false);
        await control('/release?prompt=B-WRITE');
        await until(async () => ['completed', 'completed_with_warnings'].includes((await snapshot()).agentStatus), 'B write completed');
        return { a: 'result.txt=A-WRITE', b: 'result.txt=B-WRITE', lateResponseStayedOnA: true };
      });
      await check('two_real_shells_use_their_own_cwd_and_audited_runner', async () => {
        // Win7 uses the automatic system shell (cmd.exe below PowerShell 5.1); Mac selects /bin/bash explicitly.
        const configure = async () => {
          if (windows) return;
          const response = await evaluate(async () => {
            const api = window.win7Agent.a9; const s = (await api.snapshot()).snapshot;
            return api.forScope(s.scope).configureShell({ kind: 'bash', envOverlay: {} });
          });
          assert(response.ok, JSON.stringify(response)); await refresh();
        };
        await selectWorkspace(a.scope.workspaceId); await configure(); await submit('A-SHELL');
        await selectWorkspace(b.scope.workspaceId); await configure(); await submit('B-SHELL');
        await Promise.all([control('/release?prompt=A-SHELL'), control('/release?prompt=B-SHELL')]);
        await until(async () => ['completed', 'completed_with_warnings'].includes((await snapshot()).agentStatus), 'B real shell');
        await selectWorkspace(a.scope.workspaceId);
        await until(async () => ['completed', 'completed_with_warnings'].includes((await snapshot()).agentStatus), 'A real shell');
        const facts = (await snapshot()).conversation;
        assert(facts.some(fact => fact.requestPrompt === 'A-SHELL' && ['completed', 'completed_with_warnings'].includes(fact.outcome)));
        await selectWorkspace(b.scope.workspaceId);
        return windows ? { shell: 'automatic system shell', evidence: 'Win7 D-013 helper' } : { shell: '/bin/bash', evidence: 'Mac development POSIX runner only; Windows helper NOT_PERFORMED' };
      });
      await check('responsive_directory_and_composer', responsive);
      const ownedRunning = s => (s.managedProcesses || []).some(item => item.lastProbeStatus === 'running' && item.ownershipState === 'owned');
      if (windows) await check('two_workspaces_run_real_background_processes_concurrently', async () => {
        await selectWorkspace(a.scope.workspaceId); await submit('A-BG'); await control('/release?prompt=A-BG');
        await until(async () => ownedRunning(await snapshot()), 'A background running');
        await selectWorkspace(b.scope.workspaceId); await submit('B-BG'); await control('/release?prompt=B-BG');
        await until(async () => ownedRunning(await snapshot()), 'B background running');
        const resources = sample('two_concurrent_background_processes');
        return { a: 'ping.exe owned running', b: 'ping.exe owned running', processes: resources.processes, workingSetKB: resources.workingSetKB };
      });
      await check('closing_background_A_from_filter_menu_keeps_B_in_view', async () => {
        assert.strictEqual((await snapshot()).scope.workspaceId, b.scope.workspaceId);
        await closeWorkspace(a.scope.workspaceId);
        await until(async () => (await snapshot()).workspaces.some(item => item.workspaceId === a.scope.workspaceId && !item.opened), 'A closed');
        assert.strictEqual((await snapshot()).scope.workspaceId, b.scope.workspaceId);
        assert.strictEqual(await evaluate(value => [...document.querySelectorAll('#conversation-list .conversation-row')].some(row => row.dataset.workspaceId === value), a.scope.workspaceId), false);
        assert.strictEqual(await evaluate(() => document.getElementById('task-prompt').disabled), false);
        if (windows) {
          // A's owned process was stopped by the close; B's keeps running until B is stopped explicitly.
          assert(ownedRunning(await snapshot()), 'B background survived A close');
          await refresh(); await click('cancel-task');
          await until(async () => { const s = await snapshot(); return s.conversationControls.canSwitch && s.controls.canStop === false && !ownedRunning(s); }, 'B background stopped');
          sample('after_background_cleanup');
        }
        return { closed: 'A (background)', view: 'B', backgroundA: windows ? 'stopped by close' : 'NOT_PERFORMED', backgroundB: windows ? 'stopped by user' : 'NOT_PERFORMED' };
      });
      await check('closing_last_workspace_clears_the_view_and_palette_reopens', async () => {
        await closeWorkspace(b.scope.workspaceId);
        await until(() => evaluate(() => document.getElementById('workspace-label').textContent === '未连接工作区'), 'no workspace view');
        assert.strictEqual(await evaluate(() => document.getElementById('task-prompt').disabled), true);
        assert.strictEqual(await evaluate(() => document.getElementById('a9-task-stream').textContent), '');
        assert.strictEqual(await evaluate(() => document.getElementById('workspace-select').hidden), false);
        fs.writeFileSync(path.join(out, 'no-workspace.png'), (await win.webContents.capturePage()).toPNG());
        await click('conversation-new');
        await until(() => evaluate(value => document.getElementById('conversation-new-dialog').open
          && [...document.querySelectorAll('.project-picker-item')].some(item => item.dataset.value === value), b.scope.workspaceId), 'palette lists recent B');
        fs.writeFileSync(path.join(out, 'palette-recent.png'), (await win.webContents.capturePage()).toPNG());
        await evaluate(value => [...document.querySelectorAll('.project-picker-item')].find(item => item.dataset.value === value).click(), b.scope.workspaceId);
        await until(async () => { try { return (await snapshot()).workspaceRoot === b.workspaceRoot; } catch (_error) { return false; } }, 'B reopened');
        await until(() => evaluate(() => !document.getElementById('conversation-new-dialog').open), 'palette closed');
        return { closedLast: true, reopenedFrom: 'palette recent section' };
      });
    } else {
      await check('restart_keeps_history_directory_and_never_replays', async () => {
        const facts = await control('/facts');
        const s = await snapshot(); assert.strictEqual(s.workspaces.length, 2); assert(!facts.held.length);
        assert.strictEqual(facts.requests.length, windows ? 15 : 11);
        assert.strictEqual(s.agentStatus, 'idle');
        return { requests: facts.requests.length, workspaces: s.workspaces.length };
      });
    }
    assert.strictEqual(report.errors.length, 0, JSON.stringify(report.errors)); report.status = 'PASS';
    report.loadedModules = Object.keys(require.cache).filter(file => file.startsWith(path.resolve(product, '..') + path.sep) || file.startsWith(config.nativeRoot + path.sep)).map(file => ({ file, sha256: sha(file) }));
  } catch (error) { report.status = 'FAIL'; report.error = error.stack; try { report.failureSnapshot = await snapshot(); } catch (_snapshotError) { report.failureSnapshot = 'UNAVAILABLE'; } }
  finally { write(path.join(out, phase + '.json'), report); app.quit(); process.exitCode = report.status === 'PASS' ? 0 : 1; }
}
(arg('phase') ? child() : parent()).catch(error => { console.error(error); process.exitCode = 1; });
