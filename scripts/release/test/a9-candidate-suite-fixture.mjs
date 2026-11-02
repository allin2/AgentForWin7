import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assembleBatch2Validation, copyContractEvidence, validateA9Lock } from '../build-a9-product-v3.mjs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const require = createRequire(import.meta.url);
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const sourceCommit = '7e45ee5c353152ed255b7e829a981dac9e4d220b';
export const loadLock = (name) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'release/win7-product-v3', name), 'utf8'));
export const historicalLock = loadLock('a9-batch2-input-lock.json');
export const alpha4Lock = loadLock('a9-alpha4-input-lock.json');

// No repository copy, native inputs, dependency links or product build. The real
// producer assembles just the validation suite in this test-owned OS temp root.
export function assembleSuite(t, lock = alpha4Lock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win7-coding-agent-a944-test-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false, 'test-owned temporary root removed');
  });
  const profile = validateA9Lock(lock);
  const stage = path.join(root, '中文 空格 candidate');
  assembleBatch2Validation(repositoryRoot, stage, sourceCommit, lock, profile);
  fs.copyFileSync(path.join(repositoryRoot, 'release/win7-product-v3', profile.lockFile), path.join(stage, profile.lockFile));
  copyContractEvidence(repositoryRoot, stage, profile);
  const load = (name) => require(path.join(stage, 'validation', name));
  return { root, stage, profile, lock, load,
    fixtures: load(profile.fixturesScript), integrity: load(profile.integrityScript),
    kit: JSON.parse(fs.readFileSync(path.join(stage, profile.kitFile), 'utf8')) };
}
