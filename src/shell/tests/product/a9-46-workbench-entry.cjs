'use strict';

// Development fixture: real Electron 22 workbench/preload/Schema IPC, explicit
// in-memory runtime responses. No product main, database, model or Win7 claim.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const productRoot = path.resolve(__dirname, '../../product');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error('NEW_OUTPUT_REQUIRED');
// Electron can write session files during process teardown. The Node parent owns
// the sandbox and removes it only after the entire Electron run has returned.
if (!process.versions.electron) {
  const electron = process.argv.find(arg => arg.startsWith('--electron='))?.slice(11);
  if (!electron || !path.isAbsolute(electron)) throw new Error('ELECTRON_EXECUTABLE_REQUIRED');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'win7-a9-46-ui-'));
  let code = 1;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = require('child_process').spawnSync(electron, [__filename, `--output=${output}`, `--fixture-temp=${temporary}`],
      { env, stdio: 'inherit', timeout: 75000 });
    code = result.status === 0 ? 0 : 1;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    const reportPath = path.join(output, 'RESULT.json');
    if (fs.existsSync(reportPath)) {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      report.temporaryRemoved = !fs.existsSync(temporary);
      report.cleanupAfterElectronExit = true;
      report.driverSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
      if (!report.temporaryRemoved || code !== 0) report.status = 'FAIL';
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    }
  }
  process.exit(code);
}
const { app, BrowserWindow, ipcMain } = require('electron');
fs.mkdirSync(output, { recursive: true });
const temporary = process.argv.find(arg => arg.startsWith('--fixture-temp='))?.slice(15);
if (!temporary || !path.isAbsolute(temporary)) throw new Error('NODE_PARENT_LAUNCHER_REQUIRED');
app.setPath('userData', temporary);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { schemaVersion: 1, evidence: 'DEVELOPMENT_ELECTRON_RENDERER_WITH_RUNTIME_FIXTURE',
  runtime: process.versions, platform: process.platform, productMain: 'NOT_PERFORMED',
  realBackend: 'NOT_PERFORMED', packaged: 'NOT_PERFORMED', win7: 'NOT_PERFORMED', checks: [], errors: [], blockedRequests: [] };
let win;
let eventFailure = false;
let gitProjection = { isGit: true, branch: 'fixture', clean: true, entries: [] };
let gitFailure = false;
let switched = 0;
const conversationId = 'fixture-conversation';
const start = '2026-11-04T10:00:00.000Z';
const end = '2026-11-04T10:00:12.000Z';
const fact = (taskId, outcome = 'completed') => ({ taskId, turnId: `turn-${taskId}`, requestPrompt: `查找样本 ${taskId}`,
  outcome, verification: 'not_applicable', finalMessage: '查找样本 已结束', createdAt: start, updatedAt: end });
let eventId = 0;
const event = (taskId, type, data = {}, timestamp = start) => ({ eventId: ++eventId, type, data, turnId: `turn-${taskId}`, timestamp });
const history = fact('history');
const snapshot = { status: 'ready', mode: 'read_only', workspaceRoot: 'C:\\fixture 中文 工作区',
  activeConversationId: conversationId, agentStatus: 'idle',
  provider: { configured: true, baseUrl: 'https://fixture.invalid/v1', model: 'fixture',
    probe: { classification: 'tool_calling' }, apiKey: { remembered: false, source: 'fixture' } },
  lock: { held: true }, controls: { canStop: false, stopKind: 'none' },
  conversationControls: { canSwitch: false, reason: '当前任务执行中', maxActive: 16 },
  conversations: [{ sessionId: conversationId, title: '当前对话', state: 'active', activity: 'idle', updatedAt: end },
    { sessionId: 'fixture-other', title: '稍后处理的对话', state: 'active', activity: 'idle', updatedAt: start }],
  conversation: [history], timeline: [event('history', 'turn_started'),
    event('history', 'tool_start', { toolName: 'read', callId: 'read', args: { path: '中文 样本.txt' } }),
    event('history', 'tool_end', { toolName: 'read', callId: 'read', result: '查找样本 <img src=x onerror=alert(1)>' }, end),
    event('history', 'turn_completed', { outcome: 'completed' }, end)],
  checkpoints: [], interruptions: [], managedProcesses: [], recoveryTasks: [], contextWindow: {},
  draft: { text: '', persistence: 'memory' } };
const runtime = {
  getSnapshot: () => JSON.parse(JSON.stringify(snapshot)),
  queryEvents: async () => eventFailure ? { ok: false, error: { message: 'private failure detail' } }
    : { ok: true, events: snapshot.timeline, hasMore: false },
  gitStatus: async () => gitFailure ? { ok: false, error: { message: '夹具状态不可用' } }
    : { ok: true, projection: gitProjection },
  activateConversation: async () => { switched++; return { ok: true }; },
};
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ...args) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await evaluate(fn, ...args)) return; await pause(30); }
  throw new Error(`RENDERER_TIMEOUT: ${fn.toString().slice(0, 160)}`);
}
async function check(name, run) {
  try { const detail = await run(); report.checks.push({ name, status: 'PASS', detail }); }
  catch (error) { report.checks.push({ name, status: 'FAIL', error: error.message }); throw error; }
}
async function refresh() { await evaluate(() => window.win7AgentA9Workbench.refreshSnapshot()); }
async function load(reload = false) {
  const ready = new Promise(resolve => ipcMain.once('product:renderer-ready', resolve));
  if (reload) win.reload(); else await win.loadFile(path.join(productRoot, 'renderer/workbench.html'));
  await ready;
  await until(() => document.querySelector('.turn-duration')?.textContent === '耗时 12 秒');
}
async function run() {
  await app.whenReady();
  assert.strictEqual(process.versions.electron, '22.3.27');
  assert.strictEqual(process.versions.chrome.split('.')[0], '108');
  const { createWindowOptions } = require(path.join(productRoot, 'policy'));
  const { createA9ProductRequestHandler } = require(path.join(productRoot, 'a9-product-ipc'));
  const { installSessionPolicy, installWindowPolicy } = require(path.join(productRoot, 'security-policy'));
  // Fixture-only minimum: exercise CSS boundaries below the product window's
  // native minimum without changing the product's window or security policy.
  win = new BrowserWindow({ ...createWindowOptions(path.join(productRoot, 'preload.js')),
    minWidth: 1, minHeight: 1 });
  win.setContentSize(1366, 768);
  installSessionPolicy(win.webContents.session, path.join(productRoot, 'renderer'), { onRequestBlocked: url => report.blockedRequests.push(url) });
  installWindowPolicy(win, path.join(productRoot, 'renderer'));
  win.webContents.on('preload-error', (_event, _file, error) => report.errors.push(error.message));
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
  ipcMain.handle('product:a9-request', createA9ProductRequestHandler({ isValidRendererSender: e => e.sender === win.webContents, getA9Runtime: () => runtime }));
  ipcMain.handle('desktop:request', () => ({ ok: true, sessions: [] }));
  ipcMain.handle('product:get-diagnostics', () => ({ ok: true, runtime: { fixture: true } }));
  await load();
  win.showInactive();
  await check('A_disabled_reason_waiting_group_and_no_dispatch', async () => {
    const result = await evaluate(() => {
      const button = document.querySelector('#conversation-waiting-list button'); button.click();
      return { disabled: button.disabled, title: button.title, label: button.getAttribute('aria-label'),
        note: document.querySelector('.conversation-waiting-note').textContent,
        visible: !document.getElementById('conversation-waiting-section').hidden };
    });
    assert(result.disabled && result.visible && result.title.includes('当前任务执行中') && result.label.includes('可切换'));
    assert(result.note.includes('不会自动执行')); assert.strictEqual(switched, 0);
    return result;
  });
  await check('B_duration_survives_renderer_reload_without_clock_fallback', async () => {
    await load(true);
    assert.strictEqual(await evaluate(() => document.querySelector('.turn-duration').textContent), '耗时 12 秒');
    for (const [id, time] of [['missing-time', ''], ['reverse-time', '2026-11-04T09:59:59.000Z']]) {
      snapshot.conversation.push(fact(id));
      snapshot.timeline.push(event(id, 'turn_started'), event(id, 'turn_completed', { outcome: 'completed' }, time));
    }
    await refresh();
    assert.deepStrictEqual(await evaluate(() => Array.from(document.querySelectorAll('.turn-duration')).map(n => n.textContent)), ['耗时 12 秒', '', '']);
    return { reload: true, invalidAndReverseHidden: true };
  });
  await check('C_git_actions_use_known_projection_only', async () => {
    assert((await evaluate(() => document.getElementById('a9-git-status').textContent)).includes('尚未读取'));
    await evaluate(() => document.getElementById('a9-git-refresh').click());
    await until(() => document.getElementById('a9-git-status').textContent.includes('工作区干净'));
    assert(!(await evaluate(() => document.getElementById('a9-git-status').textContent)).includes('已是最新'));
    gitProjection = { isGit: true, branch: 'fixture', clean: false, entries: [{ path: '中文.txt' }], ahead: 2, behind: 1 };
    await evaluate(() => document.getElementById('a9-git-refresh').click());
    await until(() => document.getElementById('a9-git-status').textContent.includes('本地落后 1 提交'));
    const value = await evaluate(() => document.getElementById('a9-git-status').textContent);
    assert(value.includes('有 1 处变更，可审阅 Diff') && value.includes('本地领先 2 提交'));
    return value;
  });
  await check('D_provider_global_scope_is_visible_in_settings', async () => {
    await evaluate(() => document.getElementById('open-settings').click());
    assert(await evaluate(() => !document.getElementById('settings-drawer').hidden && document.getElementById('a9-provider-scope').textContent.includes('所有工作区共用')));
    await evaluate(() => document.querySelector('#settings-drawer [data-close]').click());
  });
  await check('E_find_keyboard_navigation_refresh_and_focus', async () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'f', modifiers: ['control'] });
    await until(() => document.activeElement.id === 'conversation-find-input');
    await evaluate(() => { const input = document.getElementById('conversation-find-input'); input.value = '查找样本'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    const first = await evaluate(() => document.getElementById('conversation-find-count').textContent);
    assert(first.startsWith('1 / '));
    await evaluate(() => document.getElementById('conversation-find-next').click());
    assert((await evaluate(() => document.getElementById('conversation-find-count').textContent)).startsWith('2 / '));
    await evaluate(() => document.getElementById('conversation-find-prev').click());
    assert.strictEqual(await evaluate(() => document.getElementById('conversation-find-count').textContent), first);
    assert.strictEqual(await evaluate(() => window.getSelection().toString()), '查找样本');
    // 新加载一条只有持久化结果、尚无过程事件的历史轮次。
    snapshot.conversation.push(fact('find-added'));
    await refresh();
    await until(before => document.getElementById('conversation-find-count').textContent !== before, first);
    assert(await evaluate(() => document.getElementById('conversation-find-scope').textContent.includes('仅搜索已加载记录')));
    await evaluate(() => document.getElementById('conversation-find-close').click());
    assert.strictEqual(await evaluate(() => document.activeElement.id), 'task-prompt');
    assert(!(await evaluate(() => !!document.querySelector('#a9-task-stream img'))));
    return { matches: first, focusRestored: true, untrustedTextNotParsed: true };
  });
  await check('F_unread_failure_empty_and_retry_keep_loaded_history', async () => {
    gitFailure = true;
    await evaluate(() => document.getElementById('a9-git-refresh').click());
    await until(() => document.getElementById('a9-git-status').textContent.includes('读取失败'));
    gitFailure = false;
    await evaluate(() => document.querySelector('#error-banner button').click());
    await until(() => document.getElementById('error-banner').hidden);
    eventFailure = true;
    await evaluate(() => document.getElementById('activity-refresh').click());
    await until(() => document.getElementById('activity-empty').textContent.includes('加载失败'));
    assert(!(await evaluate(() => document.getElementById('activity-empty').textContent)).includes('private'));
    assert((await evaluate(() => document.getElementById('a9-task-stream').textContent)).includes('查找样本'));
    eventFailure = false;
    await evaluate(() => document.getElementById('activity-refresh').click());
    await until(() => document.getElementById('activity-empty').textContent === '');
    const savedFacts = snapshot.conversation;
    const savedEvents = snapshot.timeline;
    snapshot.activeConversationId = 'fixture-empty'; snapshot.conversation = []; snapshot.timeline = [];
    await refresh();
    await evaluate(() => document.getElementById('activity-refresh').click());
    await until(() => !document.getElementById('file-empty').hidden && document.getElementById('file-empty').textContent.includes('已加载记录中没有'));
    snapshot.activeConversationId = conversationId; snapshot.conversation = savedFacts; snapshot.timeline = savedEvents;
    await refresh();
  });
  await check('G_tool_phases_and_non_success_outcomes_stay_distinct', async () => {
    for (const [id, data] of [['denied', { denied: true }], ['failed', { error: 'fixture failure' }],
      ['stopped', { shell: { status: 'cancelled' } }], ['unknown', { shell: { status: 'unknown', exitCode: null } }]]) {
      snapshot.conversation.push(fact(id, id === 'stopped' ? 'cancelled' : 'failed'));
      snapshot.timeline.push(event(id, 'turn_started'), event(id, 'plan_updated', { plan: ['读取样本'] }),
        event(id, 'tool_start', { toolName: 'read', callId: id }), event(id, 'tool_end', { toolName: 'read', callId: id, ...data }, end),
        event(id, 'turn_completed', { outcome: id === 'stopped' ? 'cancelled' : 'failed' }, end));
    }
    await refresh();
    const tags = await evaluate(() => Array.from(document.querySelectorAll('.activity-item .status-tag')).map(n => ({ text: n.textContent, cls: n.className })));
    for (const label of ['已读取', '已拒绝', '失败', '已停止', '结果未确认']) assert(tags.some(tag => tag.text === label), `${label}: ${JSON.stringify(tags)}`);
    assert(await evaluate(() => !document.querySelector('.plan-step.completed, .plan-step.success')));
    assert(!(await evaluate(() => document.getElementById('a9-timeline').textContent)).includes('任务完成 · cancelled'));
    return tags;
  });
  await check('viewports_and_drawer_find_focus_in_chromium108', async () => {
    const rows = [];
    for (const [width, height] of [[1366, 768], [1093, 614], [1079, 540], [900, 650], [800, 650], [780, 640]]) {
      win.setContentSize(width, height);
      await until((w, h) => innerWidth === w && innerHeight === h, width, height);
      await until(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      await evaluate(() => document.getElementById('conversation-find-open').click());
      const geometry = await evaluate(() => { const box = document.getElementById('conversation-find-input').getBoundingClientRect();
        return { width: innerWidth, scroll: document.querySelector('.workbench').scrollWidth,
          findVisible: box.width > 0 && box.left >= 0 && box.right <= innerWidth,
          sendBottom: document.getElementById('run-task').getBoundingClientRect().bottom, height: innerHeight }; });
      assert.strictEqual(geometry.width, width, `Requested viewport width: ${JSON.stringify(geometry)}`);
      assert.strictEqual(geometry.height, height, `Requested viewport height: ${JSON.stringify(geometry)}`);
      assert(geometry.scroll <= geometry.width && geometry.findVisible && geometry.sendBottom <= geometry.height, JSON.stringify(geometry));
      await evaluate(() => document.getElementById('conversation-find-close').click());
      assert.strictEqual(await evaluate(() => document.activeElement.id), 'task-prompt');
      await until(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      rows.push({ requestedWidth: width, requestedHeight: height, ...geometry });
      if (width === 780) fs.writeFileSync(path.join(output, 'workbench-780.png'), (await win.webContents.capturePage()).toPNG());
    }
    win.setContentSize(1366, 768);
    await until(() => innerWidth === 1366 && innerHeight === 768);
    await until(() => document.getAnimations().every(animation => animation.playState !== 'running'));
    fs.writeFileSync(path.join(output, 'workbench.png'), (await win.webContents.capturePage()).toPNG());
    return rows;
  });
  assert.deepStrictEqual(report.errors, []);
  assert.deepStrictEqual(report.blockedRequests, []);
}
let timeout;
Promise.race([run(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('FIXTURE_TIMEOUT')), 60000); })])
  .catch(error => { report.firstFailure = error.stack; })
  .finally(() => {
    clearTimeout(timeout);
    if (win && !win.isDestroyed()) win.destroy();
    report.temporaryRemoved = 'PENDING_PARENT_CLEANUP';
    report.sources = ['preload.js', 'a9-product-ipc.js', 'renderer/workbench.html', 'renderer/a9-workbench.js', 'renderer/a9-workbench.css']
      .map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(productRoot, file))).digest('hex') }));
    report.status = !report.firstFailure && report.checks.length === 8 ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.map(c => ({ name: c.name, status: c.status })), firstFailure: report.firstFailure }));
    app.exit(report.status === 'PASS' ? 0 : 1);
  });
