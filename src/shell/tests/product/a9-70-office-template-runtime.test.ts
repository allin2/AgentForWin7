/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const { createTemplateWorkerPort } = require('../../product/a9-office-template');
const PizZip = require('../../office-lite/node_modules/pizzip');

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function buildDocxTemplate(options: {
  documentXml: string;
  headerXml?: string;
  footerXml?: string;
  extraParts?: Record<string, Buffer | string>;
  extraDocumentRels?: string;
}): Buffer {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      (options.headerXml ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '') +
      (options.footerXml ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '') +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    options.extraDocumentRels ||
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        (options.headerXml ? '<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : '') +
        (options.footerXml ? '<Relationship Id="rIdF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : '') +
        '</Relationships>',
  );
  zip.file('word/document.xml', options.documentXml);
  if (options.headerXml) zip.file('word/header1.xml', options.headerXml);
  if (options.footerXml) zip.file('word/footer1.xml', options.footerXml);
  if (options.extraParts) {
    for (const [name, content] of Object.entries(options.extraParts)) {
      zip.file(name, content);
    }
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

type Step =
  | { kind: 'tool'; name: string; args: any }
  | { kind: 'text'; content: string };

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const close of cleanups) await close();
});

async function setup(stepsByTurn: Step[][], mode = 'full_access') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-tpl-rt-')));
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

  const workspaceRoot = path.join(root, '办公 工作区');
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
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tpl-${turnIdx}-${stepIdx}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  runtime = createA9AgentRuntime({
    workspaceRoot,
    dataRoot,
    ownerId: `a9-70-tpl-${process.pid}-${Math.random()}`,
    openDatabase,
  });
  runtime.setMode(mode);
  await runtime.configureProvider({ baseUrl, model: 'fixture', skipProbe: true });
  const ipc = () => createA9ProductRequestHandler({ isValidRendererSender: () => true, getA9Runtime: () => runtime });
  return { root, workspaceRoot, runtime, requests, ipc, close };
}

describe('A9-70 P3 real Runtime/Core/Worker/docxtemplater chain', () => {
  it('rejects macros, external relationships, XXE entities and script expressions in template_inspect', async () => {
    const port = createTemplateWorkerPort();
    try {
      const macroBuf = buildDocxTemplate({
        documentXml: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{name}</w:t></w:r></w:p></w:body></w:document>',
        extraParts: { 'word/vbaProject.bin': Buffer.from('macro-bytes') },
      });
      await expect(port.inspectTemplate(macroBuf, 'docx')).rejects.toMatchObject({ code: 'A9_OFFICE_ACTIVE_CONTENT_UNSUPPORTED' });

      const extRelBuf = buildDocxTemplate({
        documentXml: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{name}</w:t></w:r></w:p></w:body></w:document>',
        extraDocumentRels: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://evil.invalid/leak" TargetMode="External"/></Relationships>',
      });
      await expect(port.inspectTemplate(extRelBuf, 'docx')).rejects.toMatchObject({ code: 'A9_OFFICE_EXTERNAL_RELATION_UNSUPPORTED' });

      const xxeBuf = buildDocxTemplate({
        documentXml: '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>',
      });
      await expect(port.inspectTemplate(xxeBuf, 'docx')).rejects.toMatchObject({ code: 'A9_OFFICE_XML_ENTITY_UNSUPPORTED' });

      const exprBuf = buildDocxTemplate({
        documentXml: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{a + b}</w:t></w:r></w:p></w:body></w:document>',
      });
      await expect(port.inspectTemplate(exprBuf, 'docx')).rejects.toMatchObject({ code: 'A9_OFFICE_TEMPLATE_EXPRESSION_FORBIDDEN' });

      const rawBuf = buildDocxTemplate({
        documentXml: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{@rawXml}</w:t></w:r></w:p></w:body></w:document>',
      });
      await expect(port.inspectTemplate(rawBuf, 'docx')).rejects.toMatchObject({ code: 'A9_OFFICE_TEMPLATE_EXPRESSION_FORBIDDEN' });
    } finally {
      await port.close();
    }
  });

  it('inspects cross-run/header/footer/loop DOCX, renders normal+boundary samples, enforces IPC confirmation and runs batch output', async () => {
    const templateBytes = buildDocxTemplate({
      documentXml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:t>致：{客户</w:t></w:r><w:r><w:t>名称}</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>{#明细}{项目}</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>{金额}{/明细}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>',
      headerXml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>{页眉}</w:t></w:r></w:p></w:hdr>',
      footerXml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>{落款}</w:t></w:r></w:p></w:ftr>',
    });

    const mapping = {
      客户名称: 'customer',
      页眉: 'headerTitle',
      落款: 'footerText',
      明细: { source: 'items', fields: { 项目: 'item', 金额: 'amount' } },
    };
    const records = [
      { customer: '甲方有限公司', headerTitle: '正式通知', footerText: '行政部', items: [{ item: '主机', amount: '6000' }] },
      { customer: '乙&丙<中心>', headerTitle: '补充通知', footerText: '财务部', items: [{ item: '服务', amount: '1200' }, { item: '维护', amount: '800' }] },
    ];
    let sampleIdCaptured = '';
    const f = await setup([
      // Turn 1: inspect template + render normal & boundary samples
      [
        { kind: 'tool', name: 'template_inspect', args: { request: JSON.stringify({ path: '模板/通知.docx' }) } },
        {
          kind: 'tool',
          name: 'template_render_sample',
          args: (req: any) => {
            const inspectRes = JSON.parse(req.messages.filter((m: any) => m.role === 'tool' && m.name === 'template_inspect').pop().content);
            return {
              request: JSON.stringify({
                templatePath: '模板/通知.docx',
                templateSha256: inspectRes.templateSha256,
                mapping,
                normalRecord: records[0],
                boundaryRecord: {
                  customer: '超长边界&<>名称' + '测试'.repeat(20),
                  headerTitle: '边界页眉',
                  footerText: '边界落款',
                  items: [],
                },
                normalOutputPath: '样张/普通样张.docx',
                boundaryOutputPath: '样张/边界样张.docx',
                outputRule: { directory: '批量输出', filenamePattern: '通知_{index}.docx' },
                viewerEnvironment: 'WPS Office',
                records,
              }),
            };
          },
        },
        { kind: 'text', content: 'samples ready' },
      ],
      // Turn 2: try batch BEFORE confirmation -> rejected!
      [
        {
          kind: 'tool',
          name: 'batch_render_templates',
          args: () => ({ request: JSON.stringify({ sampleId: sampleIdCaptured }) }),
        },
        { kind: 'text', content: 'blocked before confirm' },
      ],
      // Turn 3: run batch AFTER IPC confirmation
      [
        {
          kind: 'tool',
          name: 'batch_render_templates',
          args: () => ({ request: JSON.stringify({ sampleId: sampleIdCaptured }) }),
        },
        { kind: 'text', content: 'batch done' },
      ],
    ]);

    fs.mkdirSync(path.join(f.workspaceRoot, '模板'));
    fs.writeFileSync(path.join(f.workspaceRoot, '模板/通知.docx'), templateBytes);
    const origSha = sha256(templateBytes);

    // Turn 1: inspect + sample approval
    const t1 = await f.runtime.submitTurn('检查模板并生成普通与边界样张');
    expect(t1.ok).toBe(true);
    expect(t1.result.outcome).toBe('needs_approval');
    const sampleApproval = f.runtime.getSnapshot().pendingApproval;
    expect(sampleApproval.toolName).toBe('template_render_sample');

    const t1Resumed = await f.runtime.resumeApproval({ ...sampleApproval, decision: 'approved' });
    expect(t1Resumed.ok).toBe(true);
    expect(fs.existsSync(path.join(f.workspaceRoot, '样张/普通样张.docx'))).toBe(true);
    expect(fs.existsSync(path.join(f.workspaceRoot, '样张/边界样张.docx'))).toBe(true);
    expect(sha256(fs.readFileSync(path.join(f.workspaceRoot, '模板/通知.docx')))).toBe(origSha);

    const snapAfterSample = f.runtime.getSnapshot();
    expect(snapAfterSample.templateSamples).toHaveLength(1);
    const sampleInfo = snapAfterSample.templateSamples[0];
    sampleIdCaptured = sampleInfo.sampleId;
    expect(sampleInfo.confirmedInViewer).toBe(false);

    // Verify normal & boundary sample XML content (cross-run placeholder joined, XML escaped, header/footer filled).
    const normalZip = new PizZip(fs.readFileSync(path.join(f.workspaceRoot, '样张/普通样张.docx')));
    expect(normalZip.file('word/document.xml').asText()).toContain('甲方有限公司');
    expect(normalZip.file('word/header1.xml').asText()).toContain('正式通知');
    expect(normalZip.file('word/footer1.xml').asText()).toContain('行政部');
    const boundaryZip = new PizZip(fs.readFileSync(path.join(f.workspaceRoot, '样张/边界样张.docx')));
    expect(boundaryZip.file('word/document.xml').asText()).toContain('超长边界&amp;&lt;&gt;名称');

    // Turn 2: batch BEFORE sample confirmation -> tool rejected with TEMPLATE_SAMPLE_NOT_CONFIRMED
    const t2 = await f.runtime.submitTurn('未确认前直接批量生成');
    expect(t2.ok).toBe(true);
    expect(t2.result.outcome).toBe('blocked');
    expect(f.requests[f.requests.length - 1].messages.some((m: any) => m.role === 'tool' && m.content.includes('TEMPLATE_SAMPLE_NOT_CONFIRMED'))).toBe(true);
    expect(fs.existsSync(path.join(f.workspaceRoot, '批量输出'))).toBe(false);

    // Confirm sample through real product IPC
    const confirmResp = await f.ipc()({}, {
      schemaVersion: 9,
      scope: snapAfterSample.scope,
      action: 'a9.template.confirmSample',
      payload: {
        sampleId: sampleInfo.sampleId,
        viewerEnvironment: 'WPS Office',
        normalSampleSha256: sampleInfo.normalSampleSha256,
        boundarySampleSha256: sampleInfo.boundarySampleSha256,
      },
    });
    expect(confirmResp.ok).toBe(true);
    expect(confirmResp.confirmedInViewer).toBe(true);
    expect(f.runtime.getSnapshot().templateSamples[0].confirmedInViewer).toBe(true);

    // Turn 3: batch AFTER confirmation -> approval -> renders both files -> undo cleans up
    const t3 = await f.runtime.submitTurn('样张已确认，执行批量生成');
    expect(t3.ok).toBe(true);
    expect(t3.result.outcome).toBe('needs_approval');
    const batchApproval = f.runtime.getSnapshot().pendingApproval;
    expect(batchApproval.toolName).toBe('batch_render_templates');

    const t3Resumed = await f.runtime.resumeApproval({ ...batchApproval, decision: 'approved' });
    expect(t3Resumed.ok).toBe(true);

    const out1 = path.join(f.workspaceRoot, '批量输出/通知_1.docx');
    const out2 = path.join(f.workspaceRoot, '批量输出/通知_2.docx');
    expect(fs.existsSync(out1)).toBe(true);
    expect(fs.existsSync(out2)).toBe(true);
    const out2Zip = new PizZip(fs.readFileSync(out2));
    expect(out2Zip.file('word/document.xml').asText()).toContain('乙&amp;丙&lt;中心&gt;');
    expect(out2Zip.file('word/document.xml').asText()).toContain('维护');
    expect(out2Zip.file('word/header1.xml').asText()).toContain('补充通知');
    expect(sha256(fs.readFileSync(path.join(f.workspaceRoot, '模板/通知.docx')))).toBe(origSha);

    const undoBatch = await f.ipc()({}, {
      schemaVersion: 9,
      scope: snapAfterSample.scope,
      action: 'a9.checkpoint.undoTurn',
      payload: { turnId: t3.result.turnId },
    });
    expect(undoBatch.ok).toBe(true);
    expect(undoBatch.outcome.errors).toEqual([]);
    expect(fs.existsSync(out1)).toBe(false);
    expect(fs.existsSync(out2)).toBe(false);
    await f.close();
  });
});
