import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CONTRACT: historicalContract } = require('../../release/win7-product-v3/a9-batch2-fixtures.cjs');
const IDENTITY_FIELDS = ['task', 'lock_id', 'release_id', 'version', 'candidate', 'result_on_complete'];
const FILE_FIELDS = ['lockFile', 'kitFile', 'validationDoc', 'integrityCommand', 'smokeCommand', 'reportCommand',
  'integrityScript', 'reportScript', 'smokeScript', 'fixturesScript', 'requestScript', 'controllerScript', 'driverFile', 'evidenceDirectory'];

// Keep the WIN7-56 templates immutable. The generated CONTRACT changes identity only;
// decisions, ceilings, cases, refusal codes, protocol keys and driver behavior stay intact.
export function createCandidateContract(identity) {
  if (!identity || Object.keys(identity).sort().join(',') !== IDENTITY_FIELDS.slice().sort().join(',')
      || IDENTITY_FIELDS.some((key) => typeof identity[key] !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(identity[key]))) {
    throw new Error('A9_CANDIDATE_IDENTITY_INVALID');
  }
  return Object.freeze({ ...historicalContract, ...identity });
}

export function candidateIdentity(lockId, profile) {
  return {
    task: profile.task, lock_id: lockId, release_id: profile.releaseId, version: profile.version, candidate: profile.candidate,
    result_on_complete: `${profile.task.replaceAll('-', '_')}_${profile.candidate.replaceAll('-', '_')}_BATCH2_EXECUTION_CAPABILITY_PASS`,
  };
}

export function renderCandidateSuiteFile(bytes, identity, profile, historicalProfile) {
  const contract = createCandidateContract(identity);
  const replacements = new Map();
  for (const key of IDENTITY_FIELDS) replacements.set(historicalContract[key], contract[key]);
  replacements.set(historicalContract.candidate.replaceAll('-', '_'), contract.candidate.replaceAll('-', '_'));
  for (const key of FILE_FIELDS) replacements.set(historicalProfile[key], profile[key]);
  // A single pass avoids replacement cascades. No batch2-wide rename: A9_BATCH2_*
  // protocol/environment/error names and all case IDs belong to the unchanged contract.
  const changed = [...replacements].filter(([before, after]) => before !== after);
  if (!changed.length) return bytes;
  const byLength = changed.sort(([a], [b]) => b.length - a.length);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(byLength.map(([before]) => escape(before)).join('|'), 'g');
  return Buffer.from(bytes.toString('utf8').replace(pattern, (before) => replacements.get(before)), 'utf8');
}
