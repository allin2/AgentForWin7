import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { alpha4Lock, assembleSuite, historicalLock, sha256, sourceCommit } from '../../release/test/a9-candidate-suite-fixture.mjs';

const runId = '3f1c2a52-6b0e-4c1e-9f5e-0d7b8a1c2e44';
const now = new Date('2026-11-01T12:00:00.000Z');
const target = { machine_name: 'TEST-ONLY-HOST', account_name: 'TEST-ONLY\\agent', account_sid: 'S-1-5-21-1-2-3-1001',
  integrity_level: 'Medium', session_id: 1, elevated: false, in_job: false };

function requestInput(suite, phase = 'p01-env', requestIndex = 1) {
  const externalFiles = Object.fromEntries(['package_zip', 'formal_input_lock', 'approval_registry', 'release_authority']
    .map((name) => [name, { path: path.join(suite.root, 'external', name), sha256: sha256(name) }]));
  return { phase, requestIndex, runId, now, sourceCommit, target, candidateRoot: suite.stage,
    evidenceRoot: path.join(suite.root, '中文 空格 evidence'), externalFiles,
    packageSha256: sha256('package_zip'), manifestSha256: sha256('manifest'), kitSha256: sha256('kit'),
    releaseAuthoritySha256: externalFiles.release_authority.sha256 };
}

test('alpha.4 offline request channel binds WIN7-57 and rejects WIN7-56 requests', (t) => {
  const suite = assembleSuite(t);
  const requests = suite.load(suite.profile.requestScript);
  const input = requestInput(suite);
  const request = requests.createRequest(input);
  assert.equal(request.candidate, 'WIN7-57'); assert.equal(request.lock_id, alpha4Lock.lock_id);
  assert.equal(request.kind, 'A9_BATCH2_PHASE_REQUEST');
  assert.equal(requests.verifyRequest(request, { now, runId, ledger: [], actual: { target } }).ok, true);
  const old = { ...request, candidate: 'WIN7-56', lock_id: historicalLock.lock_id };
  old.digest = requests.requestDigest(old);
  const refused = requests.verifyRequest(old, { now, runId, ledger: [] });
  assert.equal(refused.ok, false); assert.ok(refused.problems.includes('CANDIDATE')); assert.ok(refused.problems.includes('LOCK_ID'));
  const actual = { target: { ...target, account_sid: 'S-1-5-21-1-2-3-9999' } };
  assert.ok(requests.verifyRequest(request, { now, runId, ledger: [], actual }).problems.includes('TARGET_MISMATCH:account_sid'));
  const injected = { ...request, command: 'TEST_ONLY forbidden free text' };
  injected.digest = requests.requestDigest(injected);
  assert.ok(requests.structuralProblems(injected).includes('UNKNOWN_FIELD:command'));
});

test('all alpha.4 phases route to the generated scripts with unchanged argv and environment rules', (t) => {
  const suite = assembleSuite(t);
  const requests = suite.load(suite.profile.requestScript);
  for (const [index, phase] of suite.fixtures.PHASES.entries()) {
    const request = requests.createRequest(requestInput(suite, phase.id, index + 1));
    assert.deepEqual(requests.structuralProblems(request), []);
    const derived = requests.argvForRequest(request);
    const script = { smoke: suite.profile.smokeScript, integrity: suite.profile.integrityScript, report: suite.profile.reportScript }[phase.script];
    assert.equal(derived.program, path.join(suite.stage, 'electron.exe'));
    assert.equal(derived.args[0], path.join(suite.stage, 'validation', script));
    assert.deepEqual(derived.env, { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' });
    assert.ok(derived.args.includes(`--phase=${phase.id}`));
    if (['integrity', 'report'].includes(phase.script)) {
      assert.ok(derived.args.includes(`--release-authority=${request.external_files.release_authority.path}`));
      assert.ok(derived.args.includes(`--release-authority-sha256=${request.bindings.release_authority_sha256}`));
    }
  }
  const controller = fs.readFileSync(path.join(suite.stage, 'validation', suite.profile.controllerScript), 'utf8');
  assert.ok(controller.includes(`$requestScript = Join-Path $scriptDir '${suite.profile.requestScript}'`));
  const smoke = fs.readFileSync(path.join(suite.stage, 'validation', suite.profile.smokeScript), 'utf8');
  assert.ok(smoke.includes(`'${suite.profile.driverFile}'`));
  const cmd = fs.readFileSync(path.join(suite.stage, suite.profile.integrityCommand), 'utf8');
  assert.ok(cmd.includes(suite.profile.integrityScript)); assert.ok(cmd.includes(suite.profile.evidenceDirectory));
});

test('generated channel keeps exclusive request consumption and replay refusal', (t) => {
  const suite = assembleSuite(t);
  const requests = suite.load(suite.profile.requestScript);
  const input = requestInput(suite);
  const request = requests.createRequest(input);
  const attempt = requests.consumeRequest(request, input.evidenceRoot, now);
  assert.ok(fs.existsSync(path.join(attempt, 'request.json')));
  const ledger = requests.readLedger(input.evidenceRoot);
  assert.equal(ledger.length, 1); assert.equal(ledger[0].digest, request.digest);
  assert.throws(() => requests.consumeRequest(request, input.evidenceRoot, now), /A9_BATCH2_REQUEST_ALREADY_CLAIMED/);
  const replay = requests.verifyRequest(request, { now, runId, ledger });
  assert.equal(replay.ok, false); assert.ok(replay.problems.includes('REPLAYED'));
  assert.equal(requests.readLedger(input.evidenceRoot).length, 1);
});
