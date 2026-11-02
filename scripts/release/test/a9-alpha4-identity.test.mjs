import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { candidateIdentity, createCandidateContract } from '../a9-candidate-suite.mjs';
import { packageApplicationName, validateA9Lock, verifyV26CommittedInputs } from '../build-a9-product-v3.mjs';
import { alpha4Lock, assembleSuite, historicalLock, repositoryRoot, require, sha256, sourceCommit } from './a9-candidate-suite-fixture.mjs';

const original = require('../../../release/win7-product-v3/a9-batch2-fixtures.cjs');
const plain = (value) => JSON.parse(JSON.stringify(value));
// Frozen template pins from 7e45ee5c. These detect changes to the historical
// oracle itself, rather than merely comparing two reads of the same new bytes.
const HISTORICAL_SUITE = {
  'A9_BATCH2_WIN7_VALIDATION.md': '6465801e76fd821acb8bba4b566c3bb856f74e83bf92dc0356434cff4c479202',
  'RUN_A9_BATCH2_INTEGRITY.cmd': 'de37e7405f0de1d26cfa5dccf8cac26c24fbbc98c04cca58b16f484ea6d6e454',
  'RUN_A9_BATCH2_SMOKE.cmd': '484bf8c7b5f164099a0848581608dcc21e304a2c4782c8c0a21b323a32812b8b',
  'RUN_A9_BATCH2_REPORT_VERIFY.cmd': '66a283f638c3568810c560e6b46e778a5f34fb42c191103ecb64aab96d9666d2',
  'validation/a9-batch2-fixtures.cjs': 'cc023e446213b1c13dce7c03b72d7075767e89770f1c820b178d0ce2bee07094',
  'validation/a9-batch2-package-integrity.cjs': 'dc1771aa1ba861ebe377d1b1d0b79f7684918d428a56e726c819b49651f2e637',
  'validation/a9-batch2-report.cjs': 'bbd1512ccb49a3b1cea4894070ac5beb86e9b0cdfc5038fe878a40f96f6abcdd',
  'validation/a9-batch2-smoke.cjs': 'a9fc5d0642c2d9222f835255028cacb9767397a2d308253d6c24d826a9ca55cc',
  'validation/a9-batch2-desktop-request.cjs': 'd5f645bf9d57ce4cbba57d7fa59c143d2fce86516e91dd71167c5f1254cbdd2e',
  'validation/a9-batch2-desktop-controller.ps1': '15fc17c9c7cb5a2bf15430a0dbdb6d69cebda53e26b5fb12e89847164ea6e6e0',
  'validation/a9-batch2-driver.cjs': '2097bb2b4e32e8d6eae57d20ac5e189f1f348374eb124b995c6b2bc408689bf9',
};

test('historical Profile and kit serialize exactly as the original WIN7-56 producer', (t) => {
  const suite = assembleSuite(t, historicalLock);
  const producerPath = 'scripts/release/build-a9-product-v3.mjs';
  const previous = execFileSync('git', ['show', `${sourceCommit}:${producerPath}`], { cwd: repositoryRoot, encoding: 'utf8' });
  const current = fs.readFileSync(path.join(repositoryRoot, producerPath), 'utf8');
  const profileBlock = (text) => text.match(/  'A9-BATCH2-INPUTS-D013-V26-MANAGED': \{[\s\S]*?\n  \},/)[0];
  assert.equal(profileBlock(current), profileBlock(previous));
  // Execute only the old pure kit function against the unchanged real fixture;
  // no old build entry point, compilation or package creation is invoked.
  const oldKitFunction = previous.slice(previous.indexOf('function createBatch2ValidationKit('), previous.indexOf('\nfunction createWin42ValidationKit('));
  const context = { loadBatch2Fixtures: () => original };
  vm.runInNewContext(`${oldKitFunction}\nthis.makeKit = createBatch2ValidationKit;`, context, { timeout: 1000 });
  const oldKit = context.makeKit(repositoryRoot, sourceCommit, historicalLock, suite.profile, suite.kit.suite_sha256);
  assert.deepEqual(fs.readFileSync(path.join(suite.stage, suite.profile.kitFile)), Buffer.from(`${JSON.stringify(oldKit, null, 2)}\n`));
});

test('WIN7-56 generated CONTRACT and all 11 suite files retain their frozen bytes', (t) => {
  const suite = assembleSuite(t, historicalLock);
  assert.deepEqual(createCandidateContract(candidateIdentity(historicalLock.lock_id, suite.profile)), original.CONTRACT);
  assert.deepEqual(Object.keys(suite.kit.suite_sha256).sort(), Object.keys(HISTORICAL_SUITE).sort());
  for (const [name, expected] of Object.entries(HISTORICAL_SUITE)) {
    const emitted = fs.readFileSync(path.join(suite.stage, name));
    const source = name.endsWith('a9-batch2-driver.cjs') ? 'src/shell/tests/product/a9-batch2-driver-entry.cjs'
      : `release/win7-product-v3/${path.basename(name)}`;
    assert.deepEqual(emitted, fs.readFileSync(path.join(repositoryRoot, source)), name);
    assert.equal(sha256(emitted), expected, name);
    assert.equal(suite.kit.suite_sha256[name], expected, name);
  }
  assert.equal(sha256(fs.readFileSync(path.join(suite.stage, suite.profile.lockFile))), '5311847ee52fb2a92a45f41ca8f895892bbfe1ba4d5d33dff782c3f903f1aa29');
  assert.equal(packageApplicationName(suite.profile), 'win7-coding-agent-a9-alpha3');
  assert.equal(suite.kit.kit_id, 'A9-43-WIN7-56-BATCH2-1');
});

test('alpha.4 lock and Profile select the new identity and preserve every native input binding', () => {
  const profile = validateA9Lock(alpha4Lock);
  assert.equal(profile.task, 'A9-44'); assert.equal(profile.candidate, 'WIN7-57');
  assert.equal(profile.candidateTentative, true);
  assert.equal(profile.releaseId, 'WIN7-CODING-AGENT-A9-ALPHA4');
  assert.equal(profile.version, '0.3.0-alpha.4');
  assert.equal(packageApplicationName(profile), 'win7-coding-agent-a9-alpha4');
  assert.deepEqual(alpha4Lock.inputs, historicalLock.inputs);
  assert.deepEqual(alpha4Lock.runtime_profiles, historicalLock.runtime_profiles);
  const restored = plain(alpha4Lock);
  for (const key of ['lock_id', 'release_id', 'version', 'provenance', 'gates']) restored[key] = historicalLock[key];
  assert.deepEqual(restored, historicalLock);
  assert.equal(alpha4Lock.inputs.runner_return_zip.source_commit, '10114503a1e79706131ea4a11a5b96bd2958807a');
  verifyV26CommittedInputs(repositoryRoot, alpha4Lock);
});

test('alpha.4 suite loads, binds the kit and task book, and keeps all acceptance criteria', (t) => {
  const suite = assembleSuite(t);
  const { profile, fixtures, kit, integrity } = suite;
  const expected = createCandidateContract(candidateIdentity(alpha4Lock.lock_id, profile));
  assert.deepEqual(fixtures.CONTRACT, expected);
  assert.equal(fixtures.CONTRACT.result_on_complete, 'A9_44_WIN7_57_BATCH2_EXECUTION_CAPABILITY_PASS');
  for (const key of ['CASES', 'PHASES', 'CHAIN_STEPS', 'LIMITS', 'GATES', 'KNOWN_LIMITS', 'FIXTURE_BOUNDS', 'SECRET_SAMPLES']) {
    assert.deepEqual(plain(fixtures[key]), plain(original[key]), key);
  }
  assert.equal(fixtures.selfCheck().ok, true);
  assert.equal(kit.kit_id, 'A9-44-WIN7-57-BATCH2-1');
  assert.equal(kit.candidate_id, alpha4Lock.release_id); assert.equal(kit.candidate_version, alpha4Lock.version);
  assert.equal(kit.lock_id, alpha4Lock.lock_id); assert.equal(kit.candidate_label, 'WIN7-57');
  assert.equal(kit.scope.task, 'A9-44'); assert.equal(kit.scope.result_on_complete, expected.result_on_complete);
  assert.equal(kit.authority, 'NOT_GRANTED_BY_PACKAGE');
  assert.equal(kit.win10, 'NOT_PERFORMED'); assert.equal(kit.win7, 'NOT_PERFORMED');
  assert.equal(integrity.PACKAGE_NAME, 'Win7CodingAgent-0.3.0-alpha.4-win7-x64.zip');
  assert.equal(integrity.LOCK_FILE, profile.lockFile); assert.equal(integrity.KIT_FILE, profile.kitFile);
  assert.equal(integrity.AUTHORITY_KIND, 'WIN7_57_EXECUTION_BINDING');
  assert.equal(suite.load(profile.reportScript).AUTHORITY_KIND, integrity.AUTHORITY_KIND);
  const files = new Map(Object.entries(kit.suite_sha256).map(([name, hash]) => {
    const bytes = fs.readFileSync(path.join(suite.stage, name));
    assert.equal(sha256(bytes), hash, name);
    if (name.endsWith('.cjs')) new vm.Script(bytes.toString('utf8'), { filename: name });
    if (name.endsWith('.cmd')) {
      assert.match(bytes.toString('utf8'), /\r\n$/); assert.doesNotMatch(bytes.toString('utf8'), /(?<!\r)\n|[^\x00-\x7f]/);
    } else assert.doesNotMatch(bytes.toString('utf8'), /\r|\uFEFF/);
    if (name.endsWith('.ps1')) assert.doesNotMatch(bytes.toString('utf8'), /[^\x00-\x7f]/);
    return [name, { sha256: hash }];
  }));
  assert.deepEqual([...files.keys()].sort(), [...integrity.SUITE_FILES].sort());
  const manifest = { release_id: alpha4Lock.release_id, version: alpha4Lock.version, source_commit: sourceCommit };
  assert.deepEqual(integrity.verifyKit(kit, manifest, files, suite.stage, fs), { cases: 37, assertions: 67 });
  const registry = fs.readFileSync(path.join(repositoryRoot, alpha4Lock.inputs.runner_return_zip.approval_registry.path));
  assert.equal(integrity.verifyLock(alpha4Lock, manifest, registry).approval.path, 'release/win7-product-v3/a9-v26-approved-build-kits.json');
  assert.deepEqual(fs.readFileSync(path.join(suite.stage, 'evidence/contracts/A9_44_WORKBENCH_DARK_THEME.md')),
    fs.readFileSync(path.join(repositoryRoot, profile.taskBook)));
  assert.equal(fs.existsSync(path.join(suite.stage, 'evidence/contracts/A9_43_ALPHA3_WIN7_56_RELEASE.md')), false);
  assert.ok(integrity.SUITE_FILES.every((name) => !/a9-batch2-|A9_BATCH2_/.test(name)));
  for (const key of ['smokeScript', 'requestScript', 'driverFile']) assert.ok(suite.load(profile[key]));
});

test('cross-candidate identity changes fail closed without accepting a historical lock or kit', (t) => {
  const suite = assembleSuite(t);
  for (const mutate of [l => l.release_id = historicalLock.release_id, l => l.version = historicalLock.version,
    l => l.provenance.candidate = 'WIN7-56', l => l.provenance.task = 'A9-43', l => l.gates.win7 = 'NOT_PERFORMED_WIN7_56',
    l => l.inputs.runner_return_zip.protocol_version = 2]) {
    const lock = plain(alpha4Lock); mutate(lock); assert.throws(() => validateA9Lock(lock), /A9_BATCH2_INPUT_LOCK_INVALID/);
  }
  assert.throws(() => validateA9Lock({ ...alpha4Lock, lock_id: 'UNKNOWN' }), /A9_INPUT_LOCK_INVALID/);
  const manifest = { release_id: alpha4Lock.release_id, version: alpha4Lock.version, source_commit: sourceCommit };
  const registry = fs.readFileSync(path.join(repositoryRoot, alpha4Lock.inputs.runner_return_zip.approval_registry.path));
  assert.throws(() => suite.integrity.verifyLock(historicalLock, manifest, registry), /A9_BATCH2_INPUT_LOCK_CONTRACT_INVALID/);
  assert.throws(() => suite.integrity.verifyKit({ ...suite.kit, candidate_label: 'WIN7-56' }, manifest, new Map(), suite.stage, fs), /A9_BATCH2_KIT_CONTRACT_INVALID/);
  const identity = candidateIdentity(alpha4Lock.lock_id, suite.profile);
  assert.throws(() => createCandidateContract({ ...identity, result_ceiling: 'PASS' }), /A9_CANDIDATE_IDENTITY_INVALID/);
  assert.throws(() => createCandidateContract({ ...identity, candidate: "WIN7-57';process.exit()" }), /A9_CANDIDATE_IDENTITY_INVALID/);
});
