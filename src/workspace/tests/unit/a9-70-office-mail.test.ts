import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { OfficeBatchIdentity } from '../../src/a9-office-batch';
import type { MailExtractApprovalBinding } from '../../src/a9-office-mail';

const { A9WorkspaceService, classifyAttachmentFilename } = require('../../dist') as typeof import('../../src');

const identity: OfficeBatchIdentity = {
  workspaceId: 'ws-70-mail',
  conversationId: 'conv-70-mail',
  turnId: 'turn-70-mail',
};
const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixture(approved = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-mail-')));
  roots.push(root);
  const bindings: MailExtractApprovalBinding[] = [];
  const service = new A9WorkspaceService(root, {
    ...(approved
      ? {
        officeMailApproval: {
          async consume(id, binding) {
            bindings.push(binding);
            if (id !== 'ui-authorized') throw Object.assign(new Error('denied'), { code: 'UI_DENIED' });
            return { status: 'approved', bindingSha256: binding.bindingSha256 };
          },
        },
      }
      : {}),
  });
  return { root, service, bindings };
}

describe('OfficeMailService P5 contract', () => {
  it('marks MockMailAdapter as SURROGATE, flags email content as untrusted data and extracts sourced todos', async () => {
    const f = fixture();
    const list = await f.service.listMailSource({ source: 'mock', limit: 1 });
    expect(list.evidenceClass).toBe('SURROGATE');
    expect(list.isSurrogate).toBe(true);
    expect(list.untrustedData).toBe(true);
    expect(list.messages).toHaveLength(1);
    expect(list.hasMore).toBe(true);
    expect(list.nextCursor).toBe('1');

    const page2 = await f.service.listMailSource({ source: 'mock', cursor: list.nextCursor!, limit: 1 });
    expect(page2.messages).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    const detail = await f.service.readMailMessage({ source: 'mock', messageId: 'mock-msg-001' });
    expect(detail.evidenceClass).toBe('SURROGATE');
    expect(detail.isSurrogate).toBe(true);
    expect(detail.untrustedData).toBe(true);
    expect(detail.message.textBody).toContain('IGNORE PREVIOUS INSTRUCTIONS');
    expect(detail.extractedTodos.length).toBeGreaterThanOrEqual(2);
    for (const todo of detail.extractedTodos) {
      expect(todo.evidenceClass).toBe('SURROGATE');
      expect(todo.messageId).toBe('mock-msg-001');
      expect(todo.subject).toBe(detail.message.subject);
      expect(todo.untrustedData).toBe(true);
    }
  });

  it('rejects dangerous attachment names, scripts, traversal and overwrites; extracts safe attachments byte-for-byte with undo', async () => {
    for (const bad of [
      'run.bat', 'setup.exe', 'payload.ps1', 'macro.vbs', 'index.js', 'report.pdf.exe',
      '../escape.txt', 'sub/dir.txt', 'a\\b.txt', 'CON.txt', 'trailing.', 'space ', '.git',
    ]) {
      expect(classifyAttachmentFilename(bad).ok).toBe(false);
    }
    expect(classifyAttachmentFilename('季度汇总_#1.csv')).toEqual({ ok: true, filename: '季度汇总_#1.csv' });

    const unapproved = fixture(false);
    const p0 = await unapproved.service.planMailExtract(identity, {
      source: 'mock',
      messageId: 'mock-msg-001',
      destinationDir: '附件输出',
    });
    // att-001 (.csv) accepted; att-002 (.bat) automatically blocked!
    expect(p0.items.map(i => i.filename)).toEqual(['季度汇总指标.csv']);
    expect(p0.blocked).toEqual([expect.objectContaining({ attachmentId: 'att-002', code: 'MAIL_DANGEROUS_EXTENSION' })]);
    await expect(unapproved.service.executeMailExtract({ planId: p0.planId, identity, approvalId: 'ui-authorized' }))
      .rejects.toMatchObject({ code: 'MAIL_APPROVAL_REQUIRED' });

    // Explicitly requesting the dangerous .bat attachment must reject immediately.
    const f = fixture(true);
    await expect(f.service.planMailExtract(identity, {
      source: 'mock',
      messageId: 'mock-msg-001',
      destinationDir: '附件输出',
      attachmentIds: ['att-002'],
    })).rejects.toMatchObject({ code: 'MAIL_DANGEROUS_EXTENSION' });

    // Target overwrite protection refuses existing file.
    fs.mkdirSync(path.join(f.root, '已有目录'));
    fs.writeFileSync(path.join(f.root, '已有目录/季度汇总指标.csv'), 'existing-do-not-overwrite');
    await expect(f.service.planMailExtract(identity, {
      source: 'mock',
      messageId: 'mock-msg-001',
      destinationDir: '已有目录',
      attachmentIds: ['att-001'],
    })).rejects.toMatchObject({ code: 'MAIL_TARGET_EXISTS' });

    // Safe extraction + checkpoint undo.
    const plan = await f.service.planMailExtract(identity, {
      source: 'mock',
      messageId: 'mock-msg-002',
      destinationDir: '邮件附件/2026',
    });
    const res = await f.service.executeMailExtract({ planId: plan.planId, identity, approvalId: 'ui-authorized' });
    expect(res).toMatchObject({
      status: 'completed',
      code: 'MAIL_EXTRACT_OK',
      isSurrogate: true,
      recovery: 'recorded',
      checkpointStatus: 'recorded',
    });
    const outFile = path.join(f.root, '邮件附件/2026/会议附图.png');
    expect(fs.existsSync(outFile)).toBe(true);
    expect(sha256(fs.readFileSync(outFile))).toBe(plan.items[0].sha256);

    const undo = f.service.getCheckpointManager().undoTurn(identity.turnId);
    expect(undo.errors).toEqual([]);
    expect(fs.existsSync(outFile)).toBe(false);
  });
});
