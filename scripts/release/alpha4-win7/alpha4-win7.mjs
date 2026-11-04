#!/usr/bin/env node
// alpha.4 Win7 shortest-chain local entry. No transport, model, build or Electron launch.
// request -> prepare (materials from an exact local package) -> [channel actions by the caller] -> verify.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, 'driver.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error(code); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const instant = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));

export const HOST = 'DCCS-CHAIZL-PC';
export const SID = 'S-1-5-21-1708701742-428676696-1831205153-1001';
export const ROOT_LIMITS = [20000000000, 24000000000];
export const MINIMUM_FREE = 50000000000;
export const PHASES = ['controller', 'first', 'second', 'a945'];
export const RECOVERED = ['controller.json', 'first.json', 'second.json', 'a945.json', 'light.png', 'dark.png', 'restored-dark.png', 'final-light.png', 'a945.png',
  'first-stdout.bin', 'first-stderr.bin', 'second-stdout.bin', 'second-stderr.bin', 'a945-stdout.bin', 'a945-stderr.bin'];
export const CHECK_COUNTS = { controller: 12, first: 9, second: 9, a945: 15 };

export function driverBytes() { return fs.readFileSync(DRIVER); }

export function request(rootLimit = 20000000000) {
  const runId = randomUUID();
  return { schema_version: 1, task: 'A9-44+A9-45', release: '0.3.0-alpha.4', run_id: runId, holder: 'a4w-' + runId.slice(0, 8), start_utc: null, new_scenario_deadline_utc: null, deadline_utc: null, root_limit_bytes: rootLimit, minimum_free_bytes: MINIMUM_FREE, real_model_request_limit: 0, authorization: 'NOT_GRANTED' };
}

function packageIdentity(packageDir, zipFile) {
  const manifestFile = path.join(packageDir, 'release-manifest.json');
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  need(Array.isArray(manifest.files) && manifest.files.length > 0 && /^[0-9a-f]{40}$/.test(manifest.source_commit) && manifest.source_dirty === false, 'PACKAGE_MANIFEST');
  const zipBytes = fs.readFileSync(zipFile);
  const top = path.basename(packageDir);
  need(/^Win7CodingAgent-[0-9A-Za-z.-]+-win7-x64$/.test(top) && path.basename(zipFile) === top + '.zip', 'PACKAGE_NAME');
  const totalBytes = manifest.files.reduce((sum, entry) => sum + entry.size, 0);
  return { manifest, manifest_sha256: hash(manifestBytes), package_files: manifest.files.length, package_bytes: totalBytes, zip_sha256: hash(zipBytes), zip_bytes: zipBytes.length, zip_top_level: top };
}

function preparePs(scope, identity, driver, config) {
  const run8 = scope.run_id.slice(0, 8);
  const cand = identity.zip_sha256.slice(0, 16);
  const reserve = Math.max(800000000, identity.package_bytes * 2 + 100000000);
  const write = (name, bytes) => `Write-Text ($run + '\\t\\${name}') ($Utf8.GetString([Convert]::FromBase64String('${Buffer.from(bytes).toString('base64')}')))`;
  return [
    `if ([DateTime]::UtcNow -ge [DateTime]::Parse('${scope.new_scenario_deadline_utc}').ToUniversalTime()) { throw 'A4W_SCENARIO_WINDOW' }`,
    `$space = Capacity ${reserve}`,
    `if ([long]$space[1] + ${reserve} -gt ${scope.root_limit_bytes} -or [long]$space[0] - ${reserve} -lt ${MINIMUM_FREE}) { throw 'A4W_CAPACITY' }`,
    '$session = Console-Session',
    "if ($session -ne 1) { throw 'A4W_SESSION_CHANGED' }",
    "if (@(Dev-Processes).Count -ne 0 -or @(Dev-Tasks).Count -ne 0) { throw 'A4W_LIFECYCLE_CHANGED' }",
    "if ([IO.File]::Exists((Safe ($Root + '\\.channel\\extraction-active')))) { throw 'EXTRACTION_LIFECYCLE_UNKNOWN' }",
    `$run = Safe ($Root + '\\run\\${run8}')`,
    "if ([IO.Directory]::Exists($run)) { throw 'A4W_RUN_EXISTS' }",
    `$input = Safe ($Root + '\\cand\\${cand}\\expanded\\${identity.zip_top_level}')`,
    `if ((Hash ($Root + '\\cand\\${cand}\\package.zip')) -cne '${identity.zip_sha256}') { throw 'A4W_ZIP_HASH' }`,
    "foreach ($name in @('p','t','e','runtime')) { Make-Dir ($run + '\\' + $name) }",
    '$files = @(Tree $input)',
    `if ($files.Count -ne ${identity.package_files + 1}) { throw 'A4W_PACKAGE_COUNT' }`,
    'foreach ($f in $files) {',
    ' $rel = $f.FullName.Substring($input.Length + 1)',
    " $dest = Safe ($run + '\\p\\' + $rel)",
    ' Make-Dir ([IO.Path]::GetDirectoryName($dest))',
    ' [IO.File]::Copy($f.FullName,$dest,$false)',
    '}',
    "$manifest = Safe ($run + '\\p\\release-manifest.json')",
    `if ((Hash $manifest) -cne '${identity.manifest_sha256}') { throw 'A4W_MANIFEST_HASH' }`,
    '$runtimeCount = 0',
    'foreach ($f in $files) {',
    ' $rel = $f.FullName.Substring($input.Length + 1)',
    " if ($rel.IndexOf('\\') -lt 0 -or $rel.StartsWith('locales\\') -or $rel.StartsWith('swiftshader\\') -or $rel -ceq 'resources\\default_app.asar') {",
    "  $dest = Safe ($run + '\\runtime\\' + $rel)",
    '  Make-Dir ([IO.Path]::GetDirectoryName($dest))',
    '  [IO.File]::Copy($f.FullName,$dest,$false)',
    "  if ((Hash $f.FullName) -cne (Hash $dest)) { throw 'A4W_RUNTIME_COPY_HASH' }",
    '  $runtimeCount++',
    ' }',
    '}',
    write('driver.cjs', driver),
    write('config.json', json(config)),
    `if ((Hash ($run + '\\t\\driver.cjs')) -cne '${config.driver_sha256}') { throw 'A4W_DRIVER_HASH' }`,
    `if ((Hash ($run + '\\t\\config.json')) -cne '${hash(json(config))}') { throw 'A4W_CONFIG_HASH' }`,
    "Make-Dir ($run + '\\runtime\\resources\\app')",
    "Write-Text ($run + '\\runtime\\resources\\app\\package.json') '{\"name\":\"a4w-driver\",\"version\":\"1.0.0\",\"main\":\"index.cjs\",\"private\":true}'",
    "Write-Text ($run + '\\runtime\\resources\\app\\index.cjs') \"require('../../../t/driver.cjs');\"",
    "Emit ('\"ok\":true,\"stage\":\"a4w-prepared\",\"package_files\":' + $files.Count + ',\"runtime_files\":' + $runtimeCount + ',\"session\":' + $session)",
    '',
  ].join('\n');
}

function postflightPs(scope) {
  const run8 = scope.run_id.slice(0, 8);
  return [
    `$run = Safe ($Root + '\\run\\${run8}')`,
    "$procs = @(); foreach ($p in @(Dev-Processes)) { $procs += ('{\"pid\":' + $p.ProcessId + ',\"image\":' + (J $p.ExecutablePath) + '}') }",
    '$tasks = @(); foreach ($t in @(Dev-Tasks)) { $tasks += (J $t.Name) }',
    '$rows = @(Lock-Rows)',
    `if ($rows.Count -ne 4 -or $rows[1] -cne '${scope.holder}') { throw 'A4W_POSTFLIGHT_LOCK' }`,
    '$files = @()',
    "$e = Safe ($run + '\\e')",
    'if ([IO.Directory]::Exists($e)) {',
    " foreach ($f in @(Tree $e)) { $files += ('{\"path\":' + (J $f.Name) + ',\"bytes\":' + $f.Length + ',\"sha256\":' + (J (Hash $f.FullName)) + '}') }",
    '}',
    `$json = '{"schema_version":1,"evidence_class":"DEV_CHANNEL","run_id":"${scope.run_id}","utc":' + (J ([DateTime]::UtcNow.ToString('o'))) + ',"root_processes":[' + ($procs -join ',') + '],"dev_tasks":[' + ($tasks -join ',') + '],"extraction_lifecycle_unknown":' + (B ([IO.File]::Exists((Safe ($Root + '\\.channel\\extraction-active'))))) + ',"lock_holder":' + (J $rows[1]) + ',"files":[' + ($files -join ',') + ']}'`,
    "Write-Text ($run + '\\postflight.json') $json",
    "if ($procs.Count -ne 0 -or $tasks.Count -ne 0 -or [IO.File]::Exists((Safe ($Root + '\\.channel\\extraction-active')))) { throw 'A4W_POSTFLIGHT_RESIDUAL' }",
    "Emit '\"ok\":true,\"stage\":\"a4w-postflight\"'",
    '',
  ].join('\n');
}

export function prepare(scope, packageDir, zipFile, output, now = Date.now()) {
  need(scope.schema_version === 1 && scope.task === 'A9-44+A9-45' && uuid.test(scope.run_id) && scope.holder === 'a4w-' + scope.run_id.slice(0, 8), 'REQUEST_IDENTITY');
  need(scope.authorization === 'NOT_GRANTED' && scope.real_model_request_limit === 0, 'LOCAL_PREPARATION_ONLY');
  need(ROOT_LIMITS.includes(scope.root_limit_bytes) && scope.minimum_free_bytes === MINIMUM_FREE, 'CAPACITY_SCOPE');
  need([scope.start_utc, scope.new_scenario_deadline_utc, scope.deadline_utc].every(instant), 'EXPLICIT_NEW_WINDOW_REQUIRED');
  const start = Date.parse(scope.start_utc), scenario = Date.parse(scope.new_scenario_deadline_utc), end = Date.parse(scope.deadline_utc);
  need(end > now && end > start && end - start <= 5400000 && scenario === end - 600000 && scenario - Math.max(start, now) >= 900000, 'NEW_WINDOW_BUDGET');
  const identity = packageIdentity(packageDir, zipFile);
  const driver = driverBytes();
  new Script(driver.toString('utf8'), { filename: 'driver.cjs' }); // Parse only; never execute here.
  need(!/[^\x09\x0a\x0d\x20-\x7e]/.test(driver.toString('utf8')), 'DRIVER_ASCII');
  const config = { schema_version: 1, evidence_class: 'DEV_CHANNEL', run_id: scope.run_id, source_commit: identity.manifest.source_commit, version: identity.manifest.version, external_acceptance_eligible: identity.manifest.external_acceptance_eligible, zip_sha256: identity.zip_sha256, zip_top_level: identity.zip_top_level, manifest_sha256: identity.manifest_sha256, package_files: identity.package_files, driver_sha256: hash(driver), session: 1, deadline_utc: scope.deadline_utc, new_scenario_deadline_utc: scope.new_scenario_deadline_utc, real_model_request_limit: 0 };
  const artifacts = { 'driver.cjs': driver, 'config.json': json(config), 'prepare.ps1': preparePs(scope, identity, driver, config), 'postflight.ps1': postflightPs(scope) };
  const plan = { schema_version: 1, task: scope.task, preparation_only: true, execution_authorization: 'NOT_GRANTED', request: scope, source_commit: config.source_commit, version: config.version, zip_sha256: identity.zip_sha256, zip_bytes: identity.zip_bytes, manifest_sha256: identity.manifest_sha256, package_files: identity.package_files, remote_run_root: `C:\\A9-DEV\\run\\${scope.run_id.slice(0, 8)}`, remote_candidate_root: `C:\\A9-DEV\\cand\\${identity.zip_sha256.slice(0, 16)}`, files: Object.entries(artifacts).map(([file, bytes]) => ({ file, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) })) };
  const out = path.resolve(output);
  need(!fs.existsSync(out), 'OUTPUT_MUST_BE_NEW');
  need(fs.statSync(path.dirname(out)).isDirectory(), 'OUTPUT_PARENT_REQUIRED');
  fs.mkdirSync(out, { mode: 0o700 });
  for (const [name, bytes] of Object.entries({ ...artifacts, 'PREPARATION.json': json(plan) })) fs.writeFileSync(path.join(out, name), bytes, { flag: 'wx', mode: 0o600 });
  return { result: 'PASS', operation: 'LOCAL_PREPARATION', run_id: scope.run_id, holder: scope.holder, output: out, files: 5, driver_sha256: config.driver_sha256, execution_authorization: 'NOT_GRANTED' };
}

function relativeFile(base, name) {
  need(typeof name === 'string' && name.length > 0 && !path.isAbsolute(name) && !name.includes('\\') && !name.includes('\0'), 'EVIDENCE_PATH');
  need(name.split('/').every((part) => part && part !== '.' && part !== '..'), 'EVIDENCE_PATH');
  const root = fs.realpathSync(base);
  const target = path.resolve(root, name);
  for (let at = target; at !== root; at = path.dirname(at)) need(!fs.lstatSync(at).isSymbolicLink(), 'EVIDENCE_LINK');
  need(fs.lstatSync(target).isFile(), 'EVIDENCE_FILE');
  return target;
}

export function verify(directory) {
  const dir = path.resolve(directory);
  const load = (name) => read(relativeFile(dir, name));
  const scope = load('EXECUTION_SCOPE.json');
  const config = load('config.json');
  need(uuid.test(scope.run_id) && config.run_id === scope.run_id && scope.evidence_class === 'DEV_CHANNEL' && config.evidence_class === 'DEV_CHANNEL', 'RUN_BINDING');
  need(config.source_commit === scope.source_commit && config.zip_sha256 === scope.zip_sha256 && config.session === 1, 'PRODUCT_BINDING');
  need(hash(fs.readFileSync(relativeFile(dir, 'driver.cjs'))) === config.driver_sha256 && config.driver_sha256 === hash(driverBytes()), 'DRIVER_BINDING');
  need([scope.start_utc, scope.new_scenario_deadline_utc, scope.deadline_utc].every(instant) && Date.parse(scope.new_scenario_deadline_utc) === Date.parse(scope.deadline_utc) - 600000, 'SCOPE_WINDOW');
  need(config.deadline_utc === scope.deadline_utc && scope.real_model_request_limit === 0 && config.real_model_request_limit === 0 && ROOT_LIMITS.includes(scope.root_limit_bytes), 'CONFIG_SCOPE');
  const reports = Object.fromEntries(PHASES.map((p) => [p, load('recovered/' + p + '.json')]));
  const runRoot = `C:\\A9-DEV\\run\\${scope.run_id.slice(0, 8)}`;
  for (const p of PHASES) {
    const r = reports[p];
    need(r.phase === p && r.run_id === scope.run_id && r.source_commit === scope.source_commit && r.zip_sha256 === scope.zip_sha256 && r.driver_sha256 === config.driver_sha256 && r.evidence_class === 'DEV_CHANNEL', 'REPORT_IDENTITY');
    need(r.normal_quit === true && r.quit_code === 0 && !r.error, 'NORMAL_QUIT');
    need(r.status === (p === 'controller' ? 'PASS' : 'CHECKS_COMPLETE') && r.checks.length === CHECK_COUNTS[p] && r.checks.every((c) => c.ok === true), 'FAILED_CHECK');
    need(r.real_model_requests === 0, 'MODEL_REQUEST');
    const id = r.identity;
    need(id.session === 1 && id.integrity === 'Medium' && id.sid === SID && id.host.toUpperCase() === HOST && id.os === '6.1.7601' && id.electron === '22.3.27' && id.node === '16.17.1' && id.image.toLowerCase().startsWith(runRoot.toLowerCase() + '\\'), 'PROCESS_IDENTITY');
    need([r.started_utc, r.ended_utc].every((v) => typeof v === 'string' && Number.isFinite(Date.parse(v))) && Date.parse(r.started_utc) >= Date.parse(scope.start_utc) && Date.parse(r.started_utc) < Date.parse(scope.new_scenario_deadline_utc) && Date.parse(r.ended_utc) < Date.parse(scope.deadline_utc), 'REPORT_WINDOW');
  }
  const { controller, first, second, a945 } = reports;
  need(controller.verified_files === config.package_files && JSON.stringify(controller.loaded_modules) === JSON.stringify(['core', 'gateway', 'workspace', 'runner', 'state', 'git-adapter']) && typeof controller.sqlite_version === 'string', 'PACKAGE_CLOSURE');
  need(first.initial.theme === 'light' && first.initial.record === null && first.after.theme === 'dark' && first.after.record === '{"schemaVersion":1,"theme":"dark"}', 'FIRST_THEME');
  need(second.initial.theme === 'dark' && second.initial.record === '{"schemaVersion":1,"theme":"dark"}' && second.after.theme === 'light' && second.after.record === '{"schemaVersion":1,"theme":"light"}', 'RESTART_THEME');
  for (const ui of [first, second, a945]) {
    need(ui.constructor_preferences.preload === path.win32.join(runRoot, 'p/resources/app/product/preload.js'), 'PRELOAD_BINDING');
    for (const prefs of [ui.constructor_preferences, ui.preferences]) need(prefs.nodeIntegration === false && prefs.contextIsolation === true && prefs.sandbox === true && prefs.webSecurity === true && prefs.allowRunningInsecureContent === false, 'RENDERER_ISOLATION');
    need(!ui.preload_error, 'PRELOAD_ERROR');
  }
  for (const ui of [first, second]) need(!ui.ipc_actions.some((a) => /(?:settings\.set|provider\.(?:set|save|probe|configure)|turn\.submit)/i.test(a)), 'THEME_PROVIDER_OR_MODEL_ACTION');
  const requests = a945.fixture_requests;
  const turns = requests.filter((r) => r.kind === 'turn');
  need(requests.length > 0 && requests.length < 40 && requests.every((r) => r.path.startsWith('/v1/chat/completions')), 'FIXTURE_REQUESTS');
  need(turns.length >= 2 && turns.every((r) => r.status === 200 && r.systems === 1 && r.roles[0] === 'system' && r.system_only_at_head && r.environment_in_system && r.agents_in_system), 'A945_WIRE');
  need(requests.filter((r) => r.status !== 200).length === 1 && a945.control_passthrough_error.includes('System message must be at the beginning.'), 'A945_CONTROL');
  const run = load('AGENT_RUN_RESULT.json');
  const post = load('recovered/postflight.json');
  const final = load('FINAL_STATUS_RESULT.json');
  need(run.ok && run.completed && run.exit_code === 0 && run.console_session === 1 && run.task_deleted, 'AGENT_TASK');
  need(post.run_id === scope.run_id && post.lock_holder === scope.holder && !post.root_processes.length && !post.dev_tasks.length && !post.extraction_lifecycle_unknown, 'POSTFLIGHT_LIFECYCLE');
  need(final.ok && final.hostname === HOST && final.build === '7601' && !final.processes.length && !final.tasks.length && !final.extraction_lifecycle_unknown, 'FINAL_LIFECYCLE');
  need(final.lock.holder === scope.holder && !final.lock.active && final.root_bytes <= scope.root_limit_bytes && final.free_bytes >= MINIMUM_FREE, 'FINAL_LOCK_CAPACITY');
  need(post.files.length === RECOVERED.length && JSON.stringify(post.files.map((row) => row.path).sort()) === JSON.stringify([...RECOVERED].sort()), 'RECOVERY_COMPLETENESS');
  for (const entry of post.files) {
    const bytes = fs.readFileSync(relativeFile(dir, 'recovered/' + entry.path));
    const get = load('GET_' + entry.path.replaceAll('.', '_') + '.json');
    need(get.ok && get.bytes === bytes.length && get.sha256 === hash(bytes) && entry.bytes === bytes.length && entry.sha256 === hash(bytes), 'RECOVERED_BYTES');
    if (entry.path.endsWith('.png')) need(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0, 'PNG_FORMAT');
  }
  const total = PHASES.reduce((sum, p) => sum + reports[p].checks.length, 0);
  return { schema_version: 1, result: 'PASS', evidence_layer: '开发机', operation: 'LOCAL_READ_ONLY_VERIFICATION', target_evidence_class: 'DEV_CHANNEL', run_id: scope.run_id, source_commit: scope.source_commit, zip_sha256: scope.zip_sha256, checks: total, recovered_files: RECOVERED.length, png_files: 5, a945_turn_requests: turns.length, fixture_requests: requests.length, visual_review: 'NOT_PERFORMED', authorization_verified: false, files_written: 0 };
}

export function selfCheck() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'win7-coding-agent-alpha4-self-'));
  const checks = [];
  try {
    const top = 'Win7CodingAgent-0.3.0-alpha.4-win7-x64';
    const pkg = path.join(root, top);
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'a.txt'), 'fixture\n');
    const manifest = { source_commit: 'a'.repeat(40), source_dirty: false, version: '0.3.0-alpha.4', external_acceptance_eligible: true, files: [{ path: 'a.txt', size: 8, sha256: hash(Buffer.from('fixture\n')) }] };
    fs.writeFileSync(path.join(pkg, 'release-manifest.json'), JSON.stringify(manifest));
    const zip = path.join(root, top + '.zip');
    fs.writeFileSync(zip, 'not-a-real-zip');
    const input = request();
    const start = Date.now() + 600000;
    Object.assign(input, { start_utc: new Date(start).toISOString(), new_scenario_deadline_utc: new Date(start + 3000000).toISOString(), deadline_utc: new Date(start + 3600000).toISOString() });
    const out = path.join(root, 'materials');
    prepare(input, pkg, zip, out);
    const plan = read(path.join(out, 'PREPARATION.json'));
    for (const item of plan.files) {
      const bytes = fs.readFileSync(path.join(out, item.file));
      need(bytes.length === item.bytes && hash(bytes) === item.sha256, 'SELF_CHECK_ARTIFACT');
    }
    need(fs.readFileSync(path.join(out, 'driver.cjs')).equals(driverBytes()), 'SELF_CHECK_DRIVER_FIXED_BYTES');
    checks.push('materials_hashes_and_fixed_driver');
    const ps = fs.readFileSync(path.join(out, 'prepare.ps1'), 'utf8');
    for (const name of ['driver.cjs', 'config.json']) {
      const line = ps.split('\n').find((row) => row.startsWith('Write-Text ') && row.includes("'\\t\\" + name + "'"));
      const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(line)?.[1];
      need(encoded && Buffer.from(encoded, 'base64').equals(fs.readFileSync(path.join(out, name))), 'SELF_CHECK_EMBEDDED_PAYLOAD');
    }
    need(!/[^\x09\x0a\x0d\x20-\x7e]/.test(ps) && ps.includes(input.run_id.slice(0, 8)) && fs.readFileSync(path.join(out, 'postflight.ps1'), 'utf8').includes(input.holder), 'SELF_CHECK_SCRIPT_BINDING');
    checks.push('powershell_payload_and_run_binding');
    const expectedFailure = (action, code) => { let caught; try { action(); } catch (error) { caught = error; } need(caught?.message === code, 'EXPECTED_REJECTION_' + code); checks.push(code); };
    expectedFailure(() => prepare(input, pkg, zip, out), 'OUTPUT_MUST_BE_NEW');
    expectedFailure(() => prepare({ ...input, holder: 'a4w-00000000' }, pkg, zip, path.join(root, 'holder')), 'REQUEST_IDENTITY');
    expectedFailure(() => prepare({ ...input, deadline_utc: null }, pkg, zip, path.join(root, 'no-window')), 'EXPLICIT_NEW_WINDOW_REQUIRED');
    expectedFailure(() => prepare({ ...input, authorization: 'APPROVED' }, pkg, zip, path.join(root, 'approval')), 'LOCAL_PREPARATION_ONLY');
    expectedFailure(() => prepare({ ...input, real_model_request_limit: 1 }, pkg, zip, path.join(root, 'model')), 'LOCAL_PREPARATION_ONLY');
    expectedFailure(() => prepare({ ...input, root_limit_bytes: 35000000000 }, pkg, zip, path.join(root, 'capacity')), 'CAPACITY_SCOPE');
    expectedFailure(() => prepare({ ...input, new_scenario_deadline_utc: input.deadline_utc }, pkg, zip, path.join(root, 'closeout')), 'NEW_WINDOW_BUDGET');
    const old = Date.now() - 7200000;
    expectedFailure(() => prepare({ ...input, start_utc: new Date(old).toISOString(), new_scenario_deadline_utc: new Date(old + 3000000).toISOString(), deadline_utc: new Date(old + 3600000).toISOString() }, pkg, zip, path.join(root, 'expired')), 'NEW_WINDOW_BUDGET');
    fs.writeFileSync(path.join(pkg, 'release-manifest.json'), JSON.stringify({ ...manifest, source_dirty: true }));
    expectedFailure(() => prepare(input, pkg, zip, path.join(root, 'dirty')), 'PACKAGE_MANIFEST');
    return { result: 'PASS', evidence_layer: '开发机', operation: 'OFFLINE_SELF_CHECK', checks, temporary_directory_removed: true, win7_validation: 'NOT_PERFORMED', remote_actions: 0 };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    need(!fs.existsSync(root), 'TEMP_CLEANUP');
  }
}

export function main(argv = process.argv.slice(2)) {
  need(process.versions.node === '20.17.0', 'NODE_20_17_REQUIRED');
  if (argv.length === 1 && argv[0] === 'request') return request();
  if (argv.length === 2 && argv[0] === 'request') return request(Number(argv[1]));
  if (argv.length === 1 && argv[0] === 'self-check') return selfCheck();
  if (argv.length === 3 && argv[0] === 'verify' && argv[1] === '--dir') return verify(argv[2]);
  if (argv.length === 9 && argv[0] === 'prepare' && argv[1] === '--request' && argv[3] === '--package-dir' && argv[5] === '--zip' && argv[7] === '--out') return prepare(read(argv[2]), argv[4], argv[6], argv[8]);
  return { local_only: true, commands: { request: 'request [rootLimitBytes]', prepare: 'prepare --request FILE --package-dir EXPANDED_DIR --zip ZIP --out NEW_DIRECTORY', verify: 'verify --dir DIRECTORY', 'self-check': 'offline self check under system tmp' } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(json(main())); }
  catch (error) { process.stdout.write(json({ result: 'FAIL', error: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_INPUT_OR_IO_ERROR', remote_actions: 0 })); process.exitCode = 1; }
}
