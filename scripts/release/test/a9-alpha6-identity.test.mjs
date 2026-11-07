import assert from 'node:assert/strict';
import test from 'node:test';
import { validateA9Lock, packageApplicationName, verifyV26CommittedInputs } from '../build-a9-product-v3.mjs';
import { alpha4Lock, loadLock, assembleSuite, repositoryRoot } from './a9-candidate-suite-fixture.mjs';

const lock = loadLock('a9-alpha6-input-lock.json');

test('alpha.6 binds WIN7-59 while preserving the approved native inputs', () => {
  const profile = validateA9Lock(lock);
  assert.equal(profile.task, 'A9-51');
  assert.equal(profile.candidate, 'WIN7-59');
  assert.equal(profile.version, '0.3.0-alpha.6');
  assert.equal(packageApplicationName(profile), 'win7-coding-agent-a9-alpha6');
  assert.deepEqual(lock.inputs, alpha4Lock.inputs);
  assert.deepEqual(lock.runtime_profiles, alpha4Lock.runtime_profiles);
  verifyV26CommittedInputs(repositoryRoot, lock);
});

test('alpha.6 assembles the actual suite with its identity and unchanged acceptance cases', (t) => {
  const suite = assembleSuite(t, lock);
  const previous = assembleSuite(t, alpha4Lock);
  assert.equal(suite.fixtures.CONTRACT.candidate, 'WIN7-59');
  assert.equal(suite.fixtures.CONTRACT.version, '0.3.0-alpha.6');
  assert.equal(suite.fixtures.CONTRACT.task, 'A9-51');
  for (const field of ['CASES', 'PHASES', 'CHAIN_STEPS', 'LIMITS', 'GATES', 'KNOWN_LIMITS']) {
    assert.deepEqual(suite.fixtures[field], previous.fixtures[field], field);
  }
  assert.equal(suite.kit.kit_id, 'A9-51-WIN7-59-BATCH2-1');
});
