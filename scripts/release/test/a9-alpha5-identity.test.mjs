import assert from 'node:assert/strict';
import test from 'node:test';
import { validateA9Lock, packageApplicationName, verifyV26CommittedInputs } from '../build-a9-product-v3.mjs';
import { alpha4Lock, loadLock, assembleSuite, repositoryRoot } from './a9-candidate-suite-fixture.mjs';

const lock = loadLock('a9-alpha5-input-lock.json');

test('alpha.5 binds WIN7-58 while preserving the approved native inputs', () => {
  const profile = validateA9Lock(lock);
  assert.equal(profile.task, 'A9-48');
  assert.equal(profile.candidate, 'WIN7-58');
  assert.equal(profile.version, '0.3.0-alpha.5');
  assert.equal(packageApplicationName(profile), 'win7-coding-agent-a9-alpha5');
  assert.deepEqual(lock.inputs, alpha4Lock.inputs);
  assert.deepEqual(lock.runtime_profiles, alpha4Lock.runtime_profiles);
  verifyV26CommittedInputs(repositoryRoot, lock);
});

test('alpha.5 assembles the actual suite with its identity and unchanged acceptance cases', (t) => {
  const suite = assembleSuite(t, lock);
  const previous = assembleSuite(t, alpha4Lock);
  assert.equal(suite.fixtures.CONTRACT.candidate, 'WIN7-58');
  assert.equal(suite.fixtures.CONTRACT.version, '0.3.0-alpha.5');
  assert.equal(suite.fixtures.CONTRACT.task, 'A9-48');
  for (const field of ['CASES', 'PHASES', 'CHAIN_STEPS', 'LIMITS', 'GATES', 'KNOWN_LIMITS']) {
    assert.deepEqual(suite.fixtures[field], previous.fixtures[field], field);
  }
  assert.equal(suite.kit.kit_id, 'A9-48-WIN7-58-BATCH2-1');
});
