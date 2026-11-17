import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OfficeBatchIdentity } from '../../src/a9-office-batch';
import type { OfficeSkillsApprovalBinding } from '../../src/a9-office-skills';

const { A9WorkspaceService, BUILTIN_OFFICE_SKILLS, OFFICE_SKILLS_LIMITS } = require('../../dist') as typeof import('../../src');

const identity: OfficeBatchIdentity = {
  workspaceId: 'ws-70-skills',
  conversationId: 'conv-70-skills',
  turnId: 'turn-70-skills',
};
const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OfficeSkillsService P6 contract', () => {
  it('installs built-in office skills under <=32KiB, refuses overwrite and supports checkpoint undo', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-skills-')));
    roots.push(root);
    const bindings: OfficeSkillsApprovalBinding[] = [];
    const service = new A9WorkspaceService(root, {
      officeSkillsApproval: {
        async consume(id, binding) {
          bindings.push(binding);
          if (id !== 'ui-authorized') throw Object.assign(new Error('denied'), { code: 'UI_DENIED' });
          return { status: 'approved', bindingSha256: binding.bindingSha256 };
        },
      },
    });

    expect(BUILTIN_OFFICE_SKILLS).toHaveLength(3);
    for (const s of BUILTIN_OFFICE_SKILLS) {
      expect(s.bytes).toBeLessThanOrEqual(OFFICE_SKILLS_LIMITS.maxSkillBytes);
      expect(s.targetPath).toMatch(/^\.agents\/skills\/[a-z0-9-]+\/SKILL\.md$/);
    }

    const plan = await service.planInstallOfficeSkills(identity);
    expect(plan.skills).toHaveLength(3);
    const res = await service.executeInstallOfficeSkills({ planId: plan.planId, identity, approvalId: 'ui-authorized' });
    expect(res.status).toBe('completed');
    expect(res.code).toBe('SKILLS_INSTALL_OK');
    expect(res.installed.every(i => i.status === 'succeeded')).toBe(true);
    for (const s of BUILTIN_OFFICE_SKILLS) {
      expect(fs.existsSync(path.join(root, s.targetPath))).toBe(true);
    }

    // Refuses overwrite on re-install.
    await expect(service.planInstallOfficeSkills({ ...identity, turnId: 'turn-2' }))
      .rejects.toMatchObject({ code: 'SKILLS_TARGET_EXISTS' });

    // Undo cleanly removes installed files.
    const undo = service.getCheckpointManager().undoTurn(identity.turnId);
    expect(undo.errors).toEqual([]);
    for (const s of BUILTIN_OFFICE_SKILLS) {
      expect(fs.existsSync(path.join(root, s.targetPath))).toBe(false);
    }

    // Partial existing custom skill refuses overwrite.
    const customPath = path.join(root, '.agents/skills/office-file-organize/SKILL.md');
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(customPath, 'custom user skill', 'utf8');
    await expect(service.planInstallOfficeSkills({ ...identity, turnId: 'turn-3' }))
      .rejects.toMatchObject({ code: 'SKILLS_TARGET_EXISTS' });
    expect(fs.readFileSync(customPath, 'utf8')).toBe('custom user skill');
  });
});
