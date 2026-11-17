/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const { parseEmlBuffer } = require('../../product/a9-office-mail');

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

type Step =
  | { kind: 'tool'; name: string; args: any }
  | { kind: 'text'; content: string };

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const close of cleanups) await close();
});

async function setup(stepsByTurn: Step[][], mode = 'full_access') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-mail-rt-')));
  let runtime: any;
  let server: http.Server;
  const databases: Array<InstanceType<typeof Database>> = [];
  const openDatabase = (file: string, opts: any = {}) => {
    const db = new Database(file, opts);
    databases.push(db);
    return db;
  };
  const close = async () => {
    try { await runtime?.shutdown(); } finally {
      try { for (const db of databases) if ((db as any).open) db.close(); } finally {
        try { if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); } finally {
          fs.rmSync(root, { recursive: true, force: true });
          cleanups.delete(close);
        }
      }
    }
  };
  cleanups.add(close);

  const workspaceRoot = path.join(root, '邮箱 工作区');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(dataRoot);

  const requests: any[] = [];
  let turnIdx = -1;
  let stepIdx = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const lastMsg = parsed.messages[parsed.messages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        turnIdx += 1;
        stepIdx = 0;
      }
      const turnSteps = stepsByTurn[turnIdx] || [];
      const step = turnSteps[stepIdx++];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!step || step.kind === 'text') {
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: step && step.kind === 'text' ? step.content : 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const args = typeof step.args === 'function' ? step.args(parsed) : step.args;
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `mail-${turnIdx}-${stepIdx}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  runtime = createA9AgentRuntime({
    workspaceRoot,
    dataRoot,
    ownerId: `a9-70-mail-${process.pid}-${Math.random()}`,
    openDatabase,
  });
  runtime.setMode(mode);
  await runtime.configureProvider({ baseUrl, model: 'fixture', skipProbe: true });
  const ipc = () => createA9ProductRequestHandler({ isValidRendererSender: () => true, getA9Runtime: () => runtime });
  return { root, workspaceRoot, runtime, requests, ipc, close };
}

describe('A9-70 P5 real Runtime/Core/EML MIME/TextDecoder chain', () => {
  it('decodes GBK/GB2312/UTF-8 MIME headers & bodies cleanly and fails loudly on corrupted charset bytes', () => {
    // "中文测试" in GBK: d6 d0 ce c4 b2 e2 ca d4
    // "待办：核对材料" in GBK: b4 fd b0 ec a3 ba ba cb b6 d4 b2 c4 c1 cf
    const gbkSubject = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]).toString('base64');
    const gbkBody = Buffer.from([0xb4, 0xfd, 0xb0, 0xec, 0xa3, 0xba, 0xba, 0xcb, 0xb6, 0xd4, 0xb2, 0xc4, 0xc1, 0xcf]).toString('base64');
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const gbkEml = Buffer.from([
      `From: =?GBK?B?${gbkSubject}?= <sender@corp.local>`,
      `To: receiver@corp.local`,
      `Subject: =?GBK?B?${gbkSubject}?=`,
      `Date: Tue, 17 Nov 2026 09:00:00 +0800`,
      `Content-Type: multipart/mixed; boundary="gbk-bound"`,
      ``,
      `--gbk-bound`,
      `Content-Type: text/plain; charset="gb2312"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      gbkBody,
      `--gbk-bound`,
      `Content-Type: image/png; name="=?GBK?B?${gbkSubject}?=.png"`,
      `Content-Disposition: attachment; filename="=?GBK?B?${gbkSubject}?=.png"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      pngBytes.toString('base64'),
      `--gbk-bound--`,
    ].join('\r\n'), 'latin1');

    const parsed = parseEmlBuffer(gbkEml, 'eml/gbk.eml');
    expect(parsed.subject).toBe('中文测试');
    expect(parsed.textBody).toBe('待办：核对材料');
    expect(parsed.charset).toBe('gb2312');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe('中文测试.png');
    expect(parsed.attachments[0].bytes).toEqual(pngBytes);

    // Invalid GBK bytes must fail loudly instead of silently turning into replacement characters.
    const badGbkEml = Buffer.from([
      'From: a@b.local',
      'Subject: bad',
      'Content-Type: text/plain; charset="gbk"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from([0x81, 0x00]).toString('base64'),
    ].join('\r\n'), 'latin1');
    expect(() => parseEmlBuffer(badGbkEml, 'eml/bad.eml')).toThrow(expect.objectContaining({ code: 'A9_OFFICE_MAIL_ENCODING_ERROR' }));

    // Non-base64/QP raw 8bit attachment must be refused so line-ending normalization cannot silently alter bytes.
    const raw8BitAtt = Buffer.from([
      'From: a@b.local',
      'Subject: raw8',
      'Content-Type: multipart/mixed; boundary="r8"',
      '',
      '--r8',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="raw.bin"',
      'Content-Transfer-Encoding: 8bit',
      '',
      'hello\r\nworld',
      '--r8--',
    ].join('\r\n'), 'latin1');
    expect(() => parseEmlBuffer(raw8BitAtt, 'eml/raw8.eml')).toThrow(expect.objectContaining({ code: 'A9_OFFICE_MAIL_CTE_UNSUPPORTED' }));
  });

  it('Read Only exposes mail reads/plan only; Full Access reads EML, extracts safe attachments byte-for-byte, blocks scripts and undoes cleanly', async () => {
    const ro = await setup([[{ kind: 'text', content: 'ok' }]], 'read_only');
    await ro.runtime.submitTurn('check tools');
    const roTools = ro.requests[0].tools.map((t: any) => t.function.name);
    expect(roTools).toEqual(expect.arrayContaining(['mail_source_list', 'mail_source_read', 'mail_extract_plan']));
    expect(roTools).not.toContain('mail_extract_attachments');
    await ro.close();

    const gbkName = Buffer.from([0xb8, 0xbd, 0xbc, 0xfe]).toString('base64'); // "附件"
    const utf8Tail = Buffer.from('与待办', 'utf8').toString('base64');
    const gbkBody = Buffer.from([0xb4, 0xfd, 0xb0, 0xec, 0xa3, 0xba, 0xb1, 0xa3, 0xb4, 0xe6, 0xb8, 0xbd, 0xbc, 0xfe]).toString('base64'); // "待办：保存附件"
    const rawBin = crypto.randomBytes(4096);
    const emlContent = Buffer.from([
      `From: =?GBK?B?${gbkName}?= <sender@corp.local>`,
      `To: team@corp.local`,
      `Subject: =?GBK?B?${gbkName}?==?UTF-8?B?${utf8Tail}?=`,
      `Date: Tue, 17 Nov 2026 11:00:00 +0800`,
      `Content-Type: multipart/mixed; boundary="mix9"`,
      ``,
      `--mix9`,
      `Content-Type: text/plain; charset="gbk"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      gbkBody,
      `--mix9`,
      `Content-Type: application/octet-stream`,
      `Content-Disposition: attachment; filename*="utf-8''%E5%8E%9F%E5%A7%8B%E6%95%B0%E6%8D%AE.bin"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      rawBin.toString('base64'),
      `--mix9`,
      `Content-Type: text/plain`,
      `Content-Disposition: attachment; filename="../../evil.bat"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from('echo evil').toString('base64'),
      `--mix9--`,
    ].join('\r\n'), 'latin1');

    const f = await setup([
      // Turn 1: list mock (SURROGATE) & list eml + read eml + extract plan + extract attachments
      [
        { kind: 'tool', name: 'mail_source_list', args: { request: JSON.stringify({ source: 'mock' }) } },
        { kind: 'tool', name: 'mail_source_list', args: { request: JSON.stringify({ source: 'eml', emlDir: '导出邮件' }) } },
        { kind: 'tool', name: 'mail_source_read', args: { request: JSON.stringify({ source: 'eml', messageId: '导出邮件/通知.eml', emlDir: '导出邮件' }) } },
        { kind: 'tool', name: 'mail_extract_plan', args: { request: JSON.stringify({ source: 'eml', messageId: '导出邮件/通知.eml', destinationDir: '提取附件', emlDir: '导出邮件' }) } },
        {
          kind: 'tool',
          name: 'mail_extract_attachments',
          args: (req: any) => {
            const plan = JSON.parse(req.messages.filter((m: any) => m.role === 'tool' && m.name === 'mail_extract_plan').pop().content);
            return { request: JSON.stringify({ planId: plan.planId }) };
          },
        },
        { kind: 'text', content: 'extracted' },
      ],
    ]);

    fs.mkdirSync(path.join(f.workspaceRoot, '导出邮件'));
    fs.writeFileSync(path.join(f.workspaceRoot, '导出邮件/通知.eml'), emlContent);

    const t1 = await f.runtime.submitTurn('读取邮箱并提取安全附件');
    expect(t1.ok).toBe(true);
    expect(t1.result.outcome).toBe('needs_approval');

    // Verify Mock was tagged SURROGATE and EML decoded GBK & sourced todos cleanly.
    const lastMsgs = f.requests[f.requests.length - 1].messages;
    const mockListOut = JSON.parse(lastMsgs.find((m: any) => m.role === 'tool' && m.name === 'mail_source_list').content);
    expect(mockListOut.evidenceClass).toBe('SURROGATE');
    expect(mockListOut.isSurrogate).toBe(true);

    const emlReadOut = JSON.parse(lastMsgs.find((m: any) => m.role === 'tool' && m.name === 'mail_source_read').content);
    expect(emlReadOut.untrustedData).toBe(true);
    expect(emlReadOut.message.subject).toBe('附件与待办');
    expect(emlReadOut.message.textBody).toBe('待办：保存附件');
    expect(emlReadOut.extractedTodos[0]).toMatchObject({
      text: '待办：保存附件',
      evidenceClass: 'LOCAL_EML_EXPORT',
      messageId: '导出邮件/通知.eml',
      untrustedData: true,
    });

    const planOut = JSON.parse(lastMsgs.find((m: any) => m.role === 'tool' && m.name === 'mail_extract_plan').content);
    expect(planOut.items.map((i: any) => i.filename)).toEqual(['原始数据.bin']);
    expect(planOut.blocked).toEqual([expect.objectContaining({ filename: '../../evil.bat', code: 'MAIL_PATH_TRAVERSAL' })]);

    const approval = f.runtime.getSnapshot().pendingApproval;
    expect(approval.toolName).toBe('mail_extract_attachments');
    const resumed = await f.runtime.resumeApproval({ ...approval, decision: 'approved' });
    expect(resumed.ok).toBe(true);

    const savedPath = path.join(f.workspaceRoot, '提取附件/原始数据.bin');
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(sha256(fs.readFileSync(savedPath))).toBe(sha256(rawBin));
    expect(fs.existsSync(path.join(f.workspaceRoot, 'evil.bat'))).toBe(false);

    const undo = await f.ipc()({}, { schemaVersion: 9, scope: f.runtime.getSnapshot().scope, action: 'a9.checkpoint.undoTurn', payload: { turnId: t1.result.turnId } });
    expect(undo.ok).toBe(true);
    expect(fs.existsSync(savedPath)).toBe(false);
    await f.close();
  });
});
