'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const argument = name => { const value = process.argv.find(item => item.startsWith(`--${name}=`)); return value && value.slice(name.length + 3); };
const electron = argument('electron');
const output = argument('out');
assert(electron && output && path.isAbsolute(output), 'explicit Electron path and absolute --out required');
fs.mkdirSync(output, { recursive: true });
const productMain = argument('main') || path.resolve(__dirname, '../../product/main.js');
const selected = argument('case');
const dialogMode = argument('dialog-mode') || 'interactive';
assert(['interactive', 'capture'].includes(dialogMode));
const cases = selected ? selected.split(',') : ['smoke', 'startup-failure', 'stall-stage', 'stall-ipc', 'kill-stage', 'kill-ipc', 'rejection', 'window-events'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const results = [];
function readRows(root) {
  const directory = path.join(root, '中文 user data %#', 'diagnostics');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.jsonl') && fs.lstatSync(path.join(directory, name)).isFile()).flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}
function verify(mode, runRoot, code, signal) {
  const rows = readRows(runRoot);
  const has = (event, field, value) => rows.some(row => row.event === event && (!field || row[field] === value));
  const read = name => JSON.parse(fs.readFileSync(path.join(runRoot, name), 'utf8'));
  const runtime = read('runtime.json');
  assert.equal(runtime.electron, '22.3.27'); assert.equal(runtime.node, '16.17.1');
  if (mode.startsWith('baseline-')) {
    assert.equal(code, 0); assert.equal(read('alive.json').alive, true);
    if (mode === 'baseline-uncaught') assert(read('dialog.json').content.includes('A9_62_BASELINE_EXCEPTION'));
    return { rows: 0, baselineContinued: true };
  }
  if (mode === 'early-exit' || mode === 'early-quit') {
    assert.equal(code, 0); assert.equal(signal, null);
    assert.equal(rows.filter(row => row.event === 'exit-end').length, 1, 'early exit-end count');
    assert.equal(rows.find(row => row.event === 'exit-end').exitCode, 0);
    assert(!has('startup-failed'), 'late startup continued after early exit');
    return { rows: rows.length, earlyExit: true };
  }
  assert(has('process-start'), 'process-start missing');
  assert(!JSON.stringify(rows).includes('sk-A9_62_FAKE_SECRET_0123456789'), 'fake secret leaked');
  assert(rows.every(row => row.schemaVersion === 1));
  if (mode.startsWith('kill-')) {
    assert.equal(signal, 'SIGKILL');
    const directory = path.join(runRoot, '中文 user data %#', 'diagnostics');
    const tailFile = mode === 'kill-stage' && fs.existsSync(path.join(directory, 'critical.jsonl')) ? 'critical.jsonl' : 'main.jsonl';
    const tail = JSON.parse(fs.readFileSync(path.join(directory, tailFile), 'utf8').trim().split('\n').pop());
    assert.equal(tail.event, mode === 'kill-stage' ? 'startup-stage-begin' : 'ipc-begin');
    assert.equal(tail[mode === 'kill-stage' ? 'stage' : 'action'], mode === 'kill-stage' ? 'desktop-host' : 'a9.workspace.list');
    return { rows: rows.length, tail };
  }
  assert.equal(signal, null); assert.equal(code, ['startup-failure', 'native-startup', 'slow-startup'].includes(mode) ? 1 : 0);
  assert(!has('exit-begin'), 'ambiguous exit-begin remains');
  assert(mode === 'fifo-exit' || has('exit-end'), 'exit-end missing');
  if (mode === 'smoke') assert.equal(read('smoke.json').cases[0].status, 'PASS');
  if (['startup-failure', 'native-startup', 'slow-startup'].includes(mode)) {
    assert(has('startup-failed', 'errorCode', 'ENOSPC'));
    if (mode === 'startup-failure' || mode === 'slow-startup') { assert.equal(read('smoke.json').cases[0].status, 'FAIL'); assert(!fs.existsSync(path.join(runRoot, 'dialog.json'))); }
    else { const d = read('dialog.json'); assert(d.content.includes('ENOSPC')); assert(d.content.includes('diagnostics')); }
  }
  if (mode.startsWith('stall-')) {
    const stalled = rows.filter(row => row.event === 'main-thread-stall' && row.durationMs >= 2500);
    assert(stalled.some(row => row.pending.some(item => mode === 'stall-stage' ? item.stage === 'desktop-host' : item.action === 'a9.workspace.list')), 'stall duration/action missing');
  }
  if (mode === 'native-uncaught' || mode === 'slow-uncaught') {
    assert(has('uncaught-exception', 'errorCode', 'EIO')); assert.equal(read('alive.json').alive, true);
    const d = read('dialog.json'); assert(d.content.includes('EIO')); assert(d.content.includes('diagnostics')); assert(!d.content.includes('sk-A9_62_'));
  }
  if (mode === 'ipc-failure') {
    const result = read('ipc-result.json');
    assert.equal(result.ok, false);
    assert(has('ipc-end', 'errorCode', result.error.code));
  }
  if (mode === 'rejection') { assert(has('unhandled-rejection', 'errorCode', 'EIO')); assert.equal(read('alive.json').alive, true); }
  if (mode === 'normal-exit') {
    assert.equal(read('normal-exit-requested.json').requested, true);
    for (const event of ['exit-end']) {
      assert.equal(rows.filter(row => row.event === event).length, 1, `${event} count`);
    }
    assert.equal(rows.filter(row => row.event === 'exit-end')[0].exitCode, 0);
    assert.deepEqual(read('lifecycle.json'), { beforeQuit: 1, willQuit: 1, dispose: 1 });
  }
  if (mode === 'fifo-exit') {
    assert.equal(read('fifo-ready.json').ready, true);
    assert(read('log-stats.json').writeFailureCount >= 1);
    assert.deepEqual(read('lifecycle.json'), { beforeQuit: 1, willQuit: 1, dispose: 1 });
  }
  if (mode.startsWith('cancel-quit')) {
    const cancelled = read('cancelled.json');
    assert(cancelled.alive); assert.equal(cancelled.choices, 1);
    assert(cancelled.events.includes('exit-requested'));
    assert(!cancelled.events.includes('exit-begin')); assert(!cancelled.events.includes('exit-end'));
    assert.equal(read('shutdown-choice.json').stopManaged, mode !== 'cancel-quit-leave');
    assert.equal(rows.filter(row => row.event === 'exit-end').length, 1);
    assert.deepEqual(read('lifecycle.json'), { beforeQuit: 3, willQuit: 1, dispose: 1 });
  }
  if (mode === 'steady-2m') {
    const steady = read('steady.json');
    assert(steady.durationMs >= 115000); assert(steady.requests >= 100);
    assert(steady.ipcPerMinute > 0); assert(steady.logBytes > 0);
  }
  if (mode === 'window-events') for (const event of ['window-unresponsive', 'window-responsive', 'render-process-gone']) assert(has(event), `${event} missing`);
  if (!['smoke', 'startup-failure', 'native-startup', 'slow-startup'].includes(mode)) {
    const diagnostics = read('diagnostics.json');
    assert.equal(diagnostics.schemaVersion, 1); assert(diagnostics.runtime); assert(diagnostics.activeWorkspaceRestore);
    assert(diagnostics.diagnosticLog.directory.endsWith('diagnostics')); assert(diagnostics.diagnosticLog.recordCount > 0);
  }
  return { rows: rows.length, stalls: rows.filter(row => row.event === 'main-thread-stall') };
}
async function run(mode) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-62-electron-test-'));
  const env = { ...process.env, A9_62_RUN_ROOT: runRoot, A9_62_PRODUCT_MAIN: productMain, A9_62_CASE: mode, A9_62_DIALOG_MODE: dialogMode };
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  for (const name of Object.keys(env)) if (name.startsWith('A9_SMOKE_') || name.startsWith('WIN7AGENT_A9_')) delete env[name];
  let child;
  let exited = false;
  let stdout = ''; let stderr = '';
  let timer;
  try {
    fs.writeFileSync(path.join(runRoot, 'package.json'), JSON.stringify({ name: 'a9-62-electron-test', version: '1.0.0', main: path.join(__dirname, 'a9-diagnostics-entry.cjs') }) + '\n', 'utf8');
    fs.writeFileSync(path.join(output, 'live-run.json'), JSON.stringify({ mode, runRoot }) + '\n', 'utf8');
    child = spawn(electron, ['--no-sandbox', '--disable-gpu', '--user-data-dir=' + path.join(runRoot, 'chromium'), runRoot], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
    });
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-16000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
    const deadline = mode === 'steady-2m' ? 150000 : (mode.startsWith('native-') || mode === 'baseline-uncaught' ? 180000 : 20000);
    const expired = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('ELECTRON_TEST_DEADLINE')), deadline); });
    if (mode.startsWith('kill-')) {
      const ready = (async () => { while (!fs.existsSync(path.join(runRoot, 'kill-ready.json')) && !exited) await pause(20); assert(!exited, 'process exited before kill checkpoint'); process.kill(-child.pid, 'SIGKILL'); })();
      await Promise.race([ready, expired]);
    }
    const { code, signal } = await Promise.race([done, expired]);
    let result;
    try { result = { mode, dialogMode, status: 'PASS', code, signal, ...verify(mode, runRoot, code, signal) }; }
    catch (error) { result = { mode, dialogMode, status: 'FAIL', code, signal, error: error.message }; }
    const destination = path.join(output, mode); fs.mkdirSync(destination, { recursive: true });
    for (const name of ['runtime.json', 'smoke.json', 'diagnostics.json', 'ipc-result.json', 'dialog.json', 'alive.json', 'normal-exit-requested.json', 'steady.json', 'lifecycle.json', 'driver-error.json', 'fifo-ready.json', 'cancelled.json', 'shutdown-choice.json', 'log-stats.json']) {
      const file = path.join(runRoot, name); if (fs.existsSync(file)) fs.copyFileSync(file, path.join(destination, name));
    }
    fs.writeFileSync(path.join(destination, 'records.json'), JSON.stringify(readRows(runRoot), null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(destination, 'stdout.txt'), stdout, 'utf8');
    fs.writeFileSync(path.join(destination, 'stderr.txt'), stderr, 'utf8');
    return result;
  } finally {
    clearTimeout(timer);
    // This group was created by this test, never an unrelated desktop session.
    if (child) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    fs.rmSync(runRoot, { recursive: true, force: true });
    assert(!fs.existsSync(runRoot), 'test sandbox cleanup failed');
  }
}
(async () => {
  for (const mode of cases) {
    try { results.push(await run(mode)); }
    catch (error) { results.push({ mode, status: 'FAIL', error: error.message }); }
    console.log(JSON.stringify(results[results.length - 1]));
  }
  const result = { schemaVersion: 1, sourceBaseline: 'd5b99b62abb8c7fe1a52875272811a1b01f8bc5d', mainSha256: hash(productMain), loggerSha256: hash(path.join(path.dirname(productMain), 'a9-diagnostics-log.js')), evidenceLevel: 'DEVELOPER_ELECTRON', results };
  fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  process.exitCode = results.every(item => item.status === 'PASS') ? 0 : 1;
})();
