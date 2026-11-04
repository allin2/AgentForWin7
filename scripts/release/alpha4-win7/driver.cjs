'use strict';
// alpha.4 candidate-external Win7 shortest-chain driver.
// Phases: controller (package closure), first/second (A9-44 manual theme and restart), a945 (A9-45 system wire
// against a loopback strict chat-template fixture). The product main/preload/renderer are loaded unchanged.
// These bytes are identical for every run; the run binding lives in t/config.json next to this file.
const path = require('path');
const crypto = require('crypto');

const STRICT_ERROR = 'System message must be at the beginning.';
const AGENTS_MARKER = 'A945-AGENTS-MARKER';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Mirrors the Qwen3.5/3.6 official chat template rule: a system message is only allowed as the first message.
function wireFacts(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : [];
  const roles = messages.map((m) => (m && typeof m.role === 'string' ? m.role : 'invalid'));
  const systemText = messages.filter((m) => m && m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const users = messages.filter((m) => m && m.role === 'user');
  const lastUser = users.length && typeof users[users.length - 1].content === 'string' ? users[users.length - 1].content : '';
  const tools = body && Array.isArray(body.tools) ? body.tools.map((t) => t && t.function && t.function.name).filter((n) => typeof n === 'string') : [];
  return {
    roles,
    systems: roles.filter((r) => r === 'system').length,
    system_only_at_head: roles.every((r, i) => r !== 'system' || i === 0),
    tool_messages: roles.filter((r) => r === 'tool').length,
    tools: tools.slice(0, 64),
    environment_in_system: systemText.includes('<environment_facts>'),
    agents_in_system: systemText.includes(AGENTS_MARKER),
    last_user: lastUser.slice(0, 40),
  };
}

function fixtureStep(facts) {
  if (!facts.system_only_at_head) return { status: 400, kind: 'rejected' };
  if (facts.tools.includes('probe_test_echo')) return { status: 200, kind: 'probe', tool: { id: 'a945-probe', name: 'probe_test_echo', arguments: '{"message":"probe_ok"}' } };
  if (facts.last_user === 'A945-CONTROL') return { status: 200, kind: 'control', text: 'A945-CONTROL-OK' };
  if (facts.tool_messages === 0) return { status: 200, kind: 'turn', tool: { id: 'a945-read', name: 'read', arguments: '{"path":"note.txt"}' } };
  return { status: 200, kind: 'turn', text: 'A945-OK' };
}

function sseBody(step) {
  const chunk = step.tool
    ? { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: step.tool.id, type: 'function', function: { name: step.tool.name, arguments: step.tool.arguments } }] }, finish_reason: 'tool_calls' }] }
    : { choices: [{ index: 0, delta: { content: step.text }, finish_reason: 'stop' }] };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

function startStrictFixture() {
  const http = require('http');
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = []; let size = 0;
    request.on('data', (c) => { size += c.length; if (size <= 4 * 1024 * 1024) chunks.push(c); });
    request.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) { body = null; }
      const facts = body ? wireFacts(body) : { roles: [], systems: 0, system_only_at_head: false, tool_messages: 0, tools: [], environment_in_system: false, agents_in_system: false, last_user: '' };
      let step = request.method === 'POST' && /\/chat\/completions$/.test(request.url) && body && size <= 4 * 1024 * 1024 ? fixtureStep(facts) : { status: 404, kind: 'unexpected' };
      if (requests.length >= 40) step = { status: 429, kind: 'overflow' };
      requests.push({ index: requests.length + 1, path: request.url.slice(0, 80), bytes: size, status: step.status, kind: step.kind, step: step.tool ? 'tool:' + step.tool.name : step.text ? 'text' : 'none', ...facts });
      if (step.status !== 200) {
        response.writeHead(step.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: step.status === 400 ? STRICT_ERROR : 'not found', type: 'BadRequestError', param: null, code: step.status } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.end(sseBody(step));
    });
  });
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const close = () => new Promise((done) => { server.close(() => done()); for (const socket of sockets) socket.destroy(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${address.port}/v1`, address: address.address, requests, close });
    });
  });
}

function electronMain() {
  const fs = require('original-fs');
  const cp = require('child_process');
  const os = require('os');
  const { app, BrowserWindow, ipcMain, dialog } = require('electron');
  const T = path.dirname(__filename);
  const ROOT = path.dirname(T);
  const config = JSON.parse(fs.readFileSync(path.join(T, 'config.json'), 'utf8'));
  const phaseArg = process.argv.find((x) => x.startsWith('--a9w-phase='));
  const phase = phaseArg ? phaseArg.slice('--a9w-phase='.length) : 'controller';
  const need = (ok, code) => { if (!ok) throw new Error(code); };
  const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const inside = (file) => path.resolve(file).toLowerCase().startsWith(ROOT.toLowerCase() + '\\');
  need(config.schema_version === 1 && config.evidence_class === 'DEV_CHANNEL' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.run_id), 'RUN_BINDING');
  need(ROOT.toLowerCase() === ('c:\\a9-dev\\run\\' + config.run_id.slice(0, 8)), 'RUN_ROOT');
  need(/^[0-9a-f]{40}$/.test(config.source_commit) && /^[0-9a-f]{64}$/.test(config.zip_sha256) && /^[0-9a-f]{64}$/.test(config.manifest_sha256), 'PRODUCT_BINDING');
  need(hash(fs.readFileSync(__filename)) === config.driver_sha256, 'DRIVER_BINDING');
  need(['controller', 'first', 'second', 'a945'].includes(phase) && Date.now() < Date.parse(config.deadline_utc), 'PHASE_WINDOW');
  need(config.real_model_request_limit === 0, 'MODEL_BUDGET');

  const baseEnv = {};
  for (const key of ['SystemRoot', 'windir', 'SystemDrive', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (process.env[key] !== undefined) baseEnv[key] = process.env[key];
  Object.assign(baseEnv, { PATH: `${baseEnv.SystemRoot}\\System32;${baseEnv.SystemRoot}\\System32\\Wbem`, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: `${baseEnv.SystemRoot}\\System32\\cmd.exe`, LOCALAPPDATA: path.join(ROOT, 'profile', 'local'), APPDATA: path.join(ROOT, 'profile', 'roaming'), USERPROFILE: path.join(ROOT, 'profile', 'user'), TEMP: path.join(ROOT, 'profile', 'temp'), TMP: path.join(ROOT, 'profile', 'temp'), WIN7AGENT_PORTABLE: '0' });
  for (const key of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'TEMP']) fs.mkdirSync(baseEnv[key], { recursive: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, baseEnv);
  app.setPath('appData', baseEnv.APPDATA);
  app.setPath('userData', path.join(ROOT, 'controller-profile'));
  app.setPath('crashDumps', baseEnv.TEMP);
  app.setPath('temp', baseEnv.TEMP);

  const report = path.join(ROOT, 'e', phase + '.json');
  const result = { schema_version: 1, evidence_class: 'DEV_CHANNEL', run_id: config.run_id, source_commit: config.source_commit, zip_sha256: config.zip_sha256, driver_sha256: config.driver_sha256, phase, status: 'IN_PROGRESS', started_utc: new Date().toISOString(), checks: [], ipc_actions: [], real_model_requests: 0, normal_quit: false };
  const persist = () => save(report, result);
  const check = (name, ok) => { result.checks.push({ name, ok: Boolean(ok) }); persist(); need(ok, name); };
  async function waitFor(read, label, ms = 20000) { const end = Math.min(Date.now() + ms, Date.parse(config.deadline_utc)); while (Date.now() < end) { const v = await read(); if (v) return v; await delay(100); } throw new Error('TIMEOUT_' + label); }

  function identity() {
    need(process.platform === 'win32' && process.arch === 'x64' && os.hostname().toUpperCase() === 'DCCS-CHAIZL-PC' && os.release() === '6.1.7601', 'HOST_IDENTITY');
    need(process.versions.electron === '22.3.27' && process.versions.node === '16.17.1', 'RUNTIME_VERSION');
    need(os.userInfo().username.toLowerCase() === 'agent', 'USER_IDENTITY');
    const system = path.join(baseEnv.SystemRoot, 'System32');
    const user = cp.execFileSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const sid = 'S-1-5-21-1708701742-428676696-1831205153-1001';
    need(user.includes('"' + sid + '"'), 'SID_IDENTITY');
    const groups = cp.execFileSync(path.join(system, 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    need(groups.includes('S-1-16-8192') && !/S-1-16-(12288|16384)/.test(groups), 'MEDIUM_INTEGRITY');
    const text = cp.execFileSync(path.join(system, 'wbem', 'WMIC.exe'), ['process', 'where', 'ProcessId=' + process.pid, 'get', 'ProcessId,ParentProcessId,CreationDate,ExecutablePath,SessionId', '/format:csv'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const lines = text.trim().split(/\r?\n/).map((x) => x.trim()).filter(Boolean); need(lines.length === 2, 'PROCESS_IDENTITY');
    const row = Object.fromEntries(lines[0].split(',').map((key, i) => [key, lines[1].split(',')[i]]));
    need(Number(row.ProcessId) === process.pid && Number(row.SessionId) === config.session && inside(row.ExecutablePath) && row.CreationDate, 'PROCESS_SESSION');
    return { host: os.hostname(), os: os.release(), sid, integrity: 'Medium', pid: process.pid, session: Number(row.SessionId), image: row.ExecutablePath, created: row.CreationDate, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node };
  }
  app.on('will-quit', () => { result.normal_quit = true; result.ended_utc = new Date().toISOString(); persist(); });
  app.on('quit', (_event, code) => { result.quit_code = code; persist(); });

  async function controller() {
    result.identity = identity(); persist();
    const packageRoot = path.join(ROOT, 'p');
    const manifestBytes = fs.readFileSync(path.join(packageRoot, 'release-manifest.json'));
    check('MANIFEST_IDENTITY', hash(manifestBytes) === config.manifest_sha256);
    const manifest = JSON.parse(manifestBytes);
    check('PACKAGE_SOURCE', manifest.source_commit === config.source_commit && manifest.source_dirty === false && manifest.version === config.version && manifest.external_acceptance_eligible === config.external_acceptance_eligible);
    let verified = 0;
    for (const entry of manifest.files) {
      const target = path.resolve(packageRoot, entry.path);
      need(target.startsWith(packageRoot + path.sep), 'PACKAGE_PATH');
      const stat = fs.lstatSync(target); need(stat.isFile() && !stat.isSymbolicLink(), 'PACKAGE_LINK');
      const bytes = fs.readFileSync(target); need(bytes.length === entry.size && hash(bytes) === entry.sha256, 'PACKAGE_BYTES'); verified++;
    }
    result.verified_files = verified; check('PACKAGE_CLOSURE', verified === config.package_files);
    const Database = require(path.join(packageRoot, 'resources/native/storage/node_modules/better-sqlite3'));
    const db = new Database(':memory:'); try { result.sqlite_version = db.prepare('SELECT sqlite_version() AS version').get().version; } finally { db.close(); }
    check('SQLITE_NATIVE_LOAD', typeof result.sqlite_version === 'string');
    result.loaded_modules = [];
    for (const mod of ['core', 'gateway', 'workspace', 'runner', 'state', 'git-adapter']) { require(path.join(packageRoot, 'resources/app', mod, 'dist/index.js')); result.loaded_modules.push(mod); }
    check('PRODUCT_MODULE_LOAD', result.loaded_modules.length === 6);
    check('FRESH_PRODUCT_PROFILE', !fs.existsSync(path.join(baseEnv.LOCALAPPDATA, 'Win7CodingAgent')));
    result.children = [];
    for (const next of ['first', 'second', 'a945']) {
      need(Date.now() < Date.parse(config.new_scenario_deadline_utc), 'SCENARIO_WINDOW');
      const log = fs.openSync(path.join(ROOT, 'e', next + '-stdout.bin'), 'wx');
      const err = fs.openSync(path.join(ROOT, 'e', next + '-stderr.bin'), 'wx');
      let exit;
      try {
        exit = await new Promise((resolve, reject) => {
          const child = cp.spawn(process.execPath, [T, '--a9w-phase=' + next], { env: baseEnv, cwd: ROOT, windowsHide: false, stdio: ['ignore', log, err] });
          let timedOut = false;
          const limit = next === 'a945' ? 240000 : 120000;
          const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.min(limit, Math.max(1, Date.parse(config.deadline_utc) - Date.now() - 30000)));
          child.once('error', (e) => { clearTimeout(timer); reject(e); });
          child.once('close', (code, signal) => { clearTimeout(timer); resolve({ pid: child.pid, code, signal, timed_out: timedOut }); });
        });
      } finally { fs.closeSync(log); fs.closeSync(err); }
      result.children.push({ phase: next, ...exit }); persist();
      check(next.toUpperCase() + '_EXIT', exit.code === 0 && exit.signal === null && !exit.timed_out);
      const ui = JSON.parse(fs.readFileSync(path.join(ROOT, 'e', next + '.json'), 'utf8'));
      check(next.toUpperCase() + '_NORMAL_PRODUCT_QUIT', ui.status === 'CHECKS_COMPLETE' && ui.normal_quit && ui.quit_code === 0 && !ui.error);
    }
    result.status = 'PASS'; persist(); app.quit();
  }

  async function openProduct(workspaceRoot) {
    result.identity = identity(); persist();
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
      const action = channel === 'product:a9-request' && args[1] ? args[1].action : channel === 'desktop:request' && args[1] ? args[1].type : channel;
      result.ipc_actions.push(typeof action === 'string' ? action.slice(0, 100) : 'UNKNOWN');
      need(result.ipc_actions.length <= 400, 'IPC_LIMIT');
      return listener(...args);
    });
    result.dialogs = [];
    dialog.showOpenDialog = async (...args) => {
      const options = args.find((item) => item && typeof item === 'object' && Array.isArray(item.properties)) || {};
      const directory = Array.isArray(options.properties) && options.properties.includes('openDirectory');
      result.dialogs.push(directory ? 'openDirectory' : 'other'); persist();
      if (workspaceRoot && directory) return { canceled: false, filePaths: [workspaceRoot] };
      throw new Error('UNEXPECTED_OPEN_DIALOG');
    };
    const policy = require(path.join(ROOT, 'p', 'resources/app/product/policy.js'));
    const originalOptions = policy.createWindowOptions;
    let constructorPreferences;
    policy.createWindowOptions = function (...args) {
      const options = originalOptions.apply(this, args);
      constructorPreferences = { ...options.webPreferences };
      result.constructor_preferences = constructorPreferences;
      persist();
      return options;
    };
    app.on('web-contents-created', (_event, contents) => contents.on('preload-error', () => { result.preload_error = true; persist(); }));
    require(path.join(ROOT, 'p', 'resources/app/product/main.js'));
    check('PRODUCT_PROFILE', app.getPath('userData') === path.join(baseEnv.LOCALAPPDATA, 'Win7CodingAgent'));
    await app.whenReady();
    const win = await waitFor(() => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/renderer/workbench.html')), 'REAL_WORKBENCH');
    const evaluate = (source) => win.webContents.executeJavaScript(source);
    await waitFor(() => evaluate('document.readyState === "complete" && Boolean(window.win7Agent && window.win7Agent.a9)'), 'PRELOAD');
    await waitFor(() => win.isVisible() && !win.isMinimized(), 'VISIBLE');
    await waitFor(() => evaluate('window.win7Agent.getDiagnostics().then(r => Boolean(r && r.runtime))'), 'PRODUCT_STARTUP');
    const prefs = win.webContents.getLastWebPreferences();
    result.preferences = Object.fromEntries(['nodeIntegration', 'contextIsolation', 'sandbox', 'webSecurity', 'allowRunningInsecureContent', 'preload'].map((k) => [k, prefs[k]]));
    check('RENDERER_ISOLATION', prefs.nodeIntegration === false && prefs.contextIsolation === true && prefs.sandbox === true && prefs.webSecurity === true && prefs.allowRunningInsecureContent === false);
    check('PRELOAD_BINDING', constructorPreferences && constructorPreferences.preload === path.join(ROOT, 'p', 'resources/app/product/preload.js') && constructorPreferences.nodeIntegration === false && constructorPreferences.contextIsolation === true && constructorPreferences.sandbox === true && constructorPreferences.webSecurity === true && constructorPreferences.allowRunningInsecureContent === false && !result.preload_error);
    return { win, evaluate };
  }

  async function theme() {
    const { win, evaluate } = await openProduct(null);
    const dom = () => evaluate(`(() => ({theme:document.documentElement.getAttribute('data-theme'), selected:document.getElementById('a9-appearance-theme').value, record:localStorage.getItem('win7-coding-agent.a9.appearance.v1'), node:typeof require, process:typeof process, csp:document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, notice:document.getElementById('a9-appearance-status').hidden}))()`);
    result.initial = await dom();
    check('RENDERER_NO_NODE', result.initial.node === 'undefined' && result.initial.process === 'undefined');
    check('CSP_NETWORK_CLOSED', result.initial.csp.includes("connect-src 'none'") && !result.initial.csp.includes('unsafe-inline'));
    const expected = phase === 'first' ? 'light' : 'dark';
    check('INITIAL_' + expected.toUpperCase(), result.initial.theme === expected && result.initial.selected === expected);
    check('STORAGE_' + (phase === 'first' ? 'ABSENT' : 'RESTORED'), phase === 'first' ? result.initial.record === null : result.initial.record === '{"schemaVersion":1,"theme":"dark"}');
    const click = async (selector) => {
      const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||e.hidden)throw Error('ACTION_UNAVAILABLE'); const r=e.getBoundingClientRect(),x=Math.floor(r.left+r.width/2),y=Math.floor(r.top+r.height/2),hit=document.elementFromPoint(x,y);if(!r.width||!r.height||x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||!(hit===e||e.contains(hit)))throw Error('ACTION_OCCLUDED');return {x,y};})()`);
      win.focus(); for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    };
    await click('#open-settings');
    await waitFor(() => evaluate('!document.getElementById("settings-drawer").hidden && document.getElementById("settings-drawer").getBoundingClientRect().width>0'), 'SETTINGS');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    // Wait for the actual drawer transition before hit testing the real select.
    await waitFor(() => evaluate(`(() => {const e=document.getElementById('a9-appearance-theme'),r=e.getBoundingClientRect(),h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.right<=innerWidth&&h===e;})()`), 'THEME_CONTROL');
    await delay(250);
    fs.writeFileSync(path.join(ROOT, 'e', phase === 'first' ? 'light.png' : 'restored-dark.png'), (await win.webContents.capturePage()).toPNG());
    await click('#a9-appearance-theme');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: phase === 'first' ? 'End' : 'Home' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: phase === 'first' ? 'End' : 'Home' });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    const next = phase === 'first' ? 'dark' : 'light';
    await waitFor(async () => { const state = await dom(); return state.theme === next && state.selected === next; }, 'THEME_CHANGED');
    result.after = await dom();
    check('PERSISTED_' + next.toUpperCase(), result.after.record === JSON.stringify({ schemaVersion: 1, theme: next }) && result.after.notice === true);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(ROOT, 'e', phase === 'first' ? 'dark.png' : 'final-light.png'), (await win.webContents.capturePage()).toPNG());
    check('NO_PROVIDER_SAVE_OR_TURN', !result.ipc_actions.some((a) => /(?:settings\.set|provider\.(?:set|save|probe|configure)|turn\.submit)/i.test(a)));
    result.status = 'CHECKS_COMPLETE'; persist(); win.close();
  }

  async function a945() {
    const workspace = path.join(ROOT, 'w');
    need(!fs.existsSync(workspace), 'WORKSPACE_EXISTS');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# A945 project rules\n\n' + AGENTS_MARKER + '\n', 'utf8');
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'A945 note fixture\n', 'utf8');
    const fixture = await startStrictFixture();
    result.fixture_requests = fixture.requests;
    check('FIXTURE_LOOPBACK', fixture.address === '127.0.0.1');
    // Control: the packaged Gateway in passthrough is rejected by the strict template; its default merges and passes.
    const { OpenAICompatibleProvider } = require(path.join(ROOT, 'p', 'resources/app/gateway/dist/provider/openai-compatible.js'));
    const controlMessages = [{ role: 'system', content: 'A945 base' }, { role: 'system', content: '<environment_facts>\ncontrol\n</environment_facts>' }, { role: 'user', content: 'A945-CONTROL' }];
    let passthroughError = null;
    try {
      await new OpenAICompatibleProvider({ baseUrl: fixture.url, model: 'a945-control', systemMessagePolicy: 'passthrough', totalTimeoutMs: 20000 })
        .sendStreamRequest({ id: 'a945-control-passthrough', messages: controlMessages }, () => {});
    } catch (error) { passthroughError = String((error && error.message) || error).slice(0, 300); }
    result.control_passthrough_error = passthroughError;
    check('CONTROL_PASSTHROUGH_REJECTED', typeof passthroughError === 'string' && passthroughError.includes(STRICT_ERROR));
    const merged = await new OpenAICompatibleProvider({ baseUrl: fixture.url, model: 'a945-control', totalTimeoutMs: 20000 })
      .sendStreamRequest({ id: 'a945-control-merged', messages: controlMessages }, () => {});
    check('CONTROL_DEFAULT_MERGED_ACCEPTED', merged && merged.content === 'A945-CONTROL-OK');
    const controlCount = fixture.requests.length;

    const { win, evaluate } = await openProduct(workspace);
    const snapshot = async () => { const r = await evaluate('window.win7Agent.a9.snapshot()'); need(r && r.ok, 'SNAPSHOT_FAILED'); return r.snapshot; };
    await evaluate('document.getElementById("workspace-select").click(); true');
    await waitFor(() => evaluate(`(() => { const s = document.getElementById('a9-surface'); return Boolean(s && !s.hidden && s.dataset.a9Status); })()`), 'WORKSPACE_SURFACE', 30000);
    check('WORKSPACE_DIALOG', result.dialogs.length === 1 && result.dialogs[0] === 'openDirectory');
    const modeReply = await evaluate('window.win7Agent.a9.setMode("read_only")');
    await waitFor(async () => (await snapshot()).mode === 'read_only', 'READ_ONLY_MODE', 20000);
    check('READ_ONLY_MODE', Boolean(modeReply) && (await snapshot()).mode === 'read_only');
    const providerState = `(() => { const apply = document.getElementById('a9-provider-apply'); const error = document.getElementById('a9-provider-error');
      return { busy: !apply || apply.disabled || apply.getAttribute('aria-busy') === 'true', error: Boolean(error && !error.hidden), probe: document.getElementById('a9-provider-probe-state').textContent }; })()`;
    await evaluate(`(() => {
      document.getElementById('a9-provider-url').value = ${JSON.stringify(fixture.url)};
      document.getElementById('a9-provider-model').value = 'a945-strict-template';
      document.getElementById('a9-provider-key').value = 'a945-fixture-key';
      document.getElementById('a9-provider-remember').checked = false;
      document.getElementById('a9-provider-apply').click();
      return true; })()`);
    await waitFor(async () => { const state = await evaluate(providerState); need(!state.error, 'PROVIDER_FORM_ERROR'); return !state.busy && state.probe === 'tool_calling'; }, 'PROVIDER_APPLIED', 45000);
    check('PROVIDER_PROBE_TOOL_CALLING', fixture.requests.slice(controlCount).some((r) => r.kind === 'probe' && r.status === 200));
    const turnStart = fixture.requests.length;
    const reply = await evaluate('window.win7Agent.a9.submitTurn("A945-PROMPT")');
    result.turn_reply_ok = Boolean(reply && reply.ok);
    await waitFor(async () => { const snap = await snapshot(); return snap.controls && snap.controls.stopKind !== 'turn' && snap.agentStatus !== 'running' && fixture.requests.slice(turnStart).some((r) => r.kind === 'turn' && r.step === 'text'); }, 'TURN_IDLE', 90000);
    const turn = fixture.requests.slice(turnStart).filter((r) => r.kind === 'turn');
    result.turn_requests = turn.length;
    check('TURN_REPLY_OK', result.turn_reply_ok);
    check('TURN_TOOL_THEN_FINAL', turn.some((r) => r.tool_messages === 0 && r.step === 'tool:read') && turn.some((r) => r.tool_messages >= 1 && r.step === 'text'));
    check('TURN_SINGLE_LEADING_SYSTEM', turn.every((r) => r.status === 200 && r.systems === 1 && r.roles[0] === 'system' && r.system_only_at_head));
    check('TURN_FACTS_AND_RULES_MERGED', turn.every((r) => r.environment_in_system && r.agents_in_system));
    const rejected = fixture.requests.filter((r) => r.status !== 200);
    check('ONLY_CONTROL_REJECTED', rejected.length === 1 && rejected[0].kind === 'rejected' && rejected[0].last_user === 'A945-CONTROL');
    check('PRODUCT_ACTIONS', result.ipc_actions.includes('a9.provider.configure') && result.ipc_actions.includes('a9.turn.submit'));
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(ROOT, 'e', 'a945.png'), (await win.webContents.capturePage()).toPNG());
    await fixture.close();
    result.status = 'CHECKS_COMPLETE'; persist(); win.close();
  }

  const work = phase === 'controller' ? app.whenReady().then(controller) : phase === 'a945' ? a945() : theme();
  work.catch((error) => {
    result.status = 'FAIL';
    result.error = /^[A-Z0-9_]+$/.test((error && error.message) || '') ? error.message : 'DRIVER_EXCEPTION';
    result.error_detail = String((error && error.message) || error).replace(/[^\x20-\x7e]/g, '?').slice(0, 300);
    persist();
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) for (const win of wins) win.close(); else app.quit();
  });
}

if (process.versions.electron) electronMain();
else module.exports = { STRICT_ERROR, AGENTS_MARKER, wireFacts, fixtureStep, sseBody, startStrictFixture };
