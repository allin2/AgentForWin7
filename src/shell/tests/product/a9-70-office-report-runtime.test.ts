/// <reference path="./better-sqlite3.d.ts" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');
const { readPptxSummary } = require('../../product/office-template-core');
const PizZip = require('../../office-lite/node_modules/pizzip');

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function buildMinimalPptxTemplate(slideXml: string): Buffer {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'ppt/presentation.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
  );
  zip.file('ppt/slides/slide1.xml', slideXml);
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-rep-rt-')));
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

  const workspaceRoot = path.join(root, '汇报 工作区');
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
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `rep-${turnIdx}-${stepIdx}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  runtime = createA9AgentRuntime({
    workspaceRoot,
    dataRoot,
    ownerId: `a9-70-rep-${process.pid}-${Math.random()}`,
    openDatabase,
  });
  runtime.setMode(mode);
  await runtime.configureProvider({ baseUrl, model: 'fixture', skipProbe: true });
  const ipc = () => createA9ProductRequestHandler({ isValidRendererSender: () => true, getA9Runtime: () => runtime });
  return { root, workspaceRoot, runtime, requests, ipc, close };
}

describe('A9-70 P4 real Runtime/Core/Worker/pptxgenjs/HTML chain', () => {
  it('Read Only never exposes presentation_create or html_report_create', async () => {
    const f = await setup([[{ kind: 'text', content: 'ok' }]], 'read_only');
    await f.runtime.submitTurn('list tools');
    const names = f.requests[0].tools.map((t: any) => t.function.name);
    expect(names).toContain('template_inspect');
    expect(names).not.toContain('presentation_create');
    expect(names).not.toContain('html_report_create');
    await f.close();
  });

  it('builds 5-layout PPTX with real image-size+pptxgenjs Worker, fills PPTX template, creates escaped HTML dashboard and validates IPC preview', async () => {
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const pptxTpl = buildMinimalPptxTemplate(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{标题}</a:t></a:r></a:p><a:p><a:r><a:t>来源：{来源}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    );
    const tplSha = sha256(pptxTpl);

    const f = await setup([
      // Turn 1: create 5-layout PPTX
      [
        {
          kind: 'tool',
          name: 'presentation_create',
          args: {
            request: JSON.stringify({
              mode: 'layouts',
              outputPath: '汇报/部门周报.pptx',
              title: '部门周报',
              slides: [
                { layout: 'cover', title: '研发部周报', subtitle: '第 46 周', imagePath: 'assets/logo.png', sources: ['周报汇总.md'] },
                { layout: 'toc', title: '议程目录', items: ['交付进度', '质量指标'], sources: ['周报汇总.md'] },
                { layout: 'two_column', title: '进展对比', left: { heading: '本周完成', items: ['流式 ZIP'] }, right: { heading: '下周计划', items: ['只读邮件'] }, sources: ['研发纪要.md'] },
                { layout: 'table', title: '模块统计', headers: ['模块', '状态'], rows: [['P2', '已验证'], ['P3', '已验证']], sources: ['台账.csv'] },
                { layout: 'summary', title: '总结', takeaways: ['关键路径稳定'], nextSteps: ['推进 P5'], sources: ['结论.md'] },
              ],
            }),
          },
        },
        { kind: 'text', content: 'layouts pptx ok' },
      ],
      // Turn 2: inspect PPTX template + fill PPTX template
      [
        { kind: 'tool', name: 'template_inspect', args: { request: JSON.stringify({ path: '模板/母版.pptx' }) } },
        {
          kind: 'tool',
          name: 'presentation_create',
          args: (req: any) => {
            const insp = JSON.parse(req.messages.filter((m: any) => m.role === 'tool' && m.name === 'template_inspect').pop().content);
            return {
              request: JSON.stringify({
                mode: 'template',
                templatePath: '模板/母版.pptx',
                templateSha256: insp.templateSha256,
                outputPath: '汇报/母版成稿.pptx',
                data: { 标题: '季度盘点 & 复盘', 来源: '台账.xlsx' },
                sources: ['台账.xlsx'],
              }),
            };
          },
        },
        { kind: 'text', content: 'template pptx ok' },
      ],
      // Turn 3: create offline escaped HTML dashboard
      [
        {
          kind: 'tool',
          name: 'html_report_create',
          args: {
            request: JSON.stringify({
              outputPath: '汇报/看板.html',
              title: '交付质量看板',
              sources: ['台账.csv'],
              kpis: [{ label: '用例通过', value: '100', unit: '项', source: '台账.csv' }],
              charts: [
                { kind: 'bar', title: '模块完成度', unit: '%', source: '台账.csv', series: [{ label: 'P2', value: 100 }, { label: 'P3', value: 100 }] },
                { kind: 'line', title: '趋势', source: '台账.csv', series: [{ label: '周一', value: 10 }, { label: '周二', value: 22 }] },
              ],
              tables: [{ title: '风险与限制', source: '台账.csv', headers: ['条目', '说明'], rows: [['<script>bad</script>', '已转义']] }],
            }),
          },
        },
        { kind: 'text', content: 'html ok' },
      ],
    ]);

    fs.mkdirSync(path.join(f.workspaceRoot, 'assets'));
    fs.writeFileSync(path.join(f.workspaceRoot, 'assets/logo.png'), png1x1);
    fs.mkdirSync(path.join(f.workspaceRoot, '模板'));
    fs.writeFileSync(path.join(f.workspaceRoot, '模板/母版.pptx'), pptxTpl);

    // Turn 1: 5-layout PPTX
    const t1 = await f.runtime.submitTurn('生成五版式周报');
    expect(t1.result.outcome).toBe('needs_approval');
    const a1 = f.runtime.getSnapshot().pendingApproval;
    const t1r = await f.runtime.resumeApproval({ ...a1, decision: 'approved' });
    expect(t1r.ok).toBe(true);
    const pptx1Buf = fs.readFileSync(path.join(f.workspaceRoot, '汇报/部门周报.pptx'));
    const read1 = readPptxSummary(pptx1Buf);
    expect(read1.slideCount).toBe(5);
    expect(read1.slides[0].texts.join('\n')).toContain('研发部周报');
    expect(read1.slides[0].texts.join('\n')).toContain('来源：周报汇总.md');
    expect(read1.slides[2].texts.join('\n')).toContain('来源：研发纪要.md');
    expect(read1.slides[3].texts.join('\n')).toContain('模块统计');
    expect(read1.slides[3].texts.join('\n')).toContain('来源：台账.csv');
    expect(read1.slides[4].notesTexts.join('\n')).toContain('来源：结论.md');

    // Turn 2: template inspect + PPTX template fill
    const t2 = await f.runtime.submitTurn('检查并填充 PPTX 模板');
    expect(t2.result.outcome).toBe('needs_approval');
    const a2 = f.runtime.getSnapshot().pendingApproval;
    const t2r = await f.runtime.resumeApproval({ ...a2, decision: 'approved' });
    expect(t2r.ok).toBe(true);
    const read2 = readPptxSummary(fs.readFileSync(path.join(f.workspaceRoot, '汇报/母版成稿.pptx')));
    expect(read2.slideCount).toBe(1);
    expect(read2.slides[0].texts.join('\n')).toContain('季度盘点 & 复盘');
    expect(read2.slides[0].texts.join('\n')).toContain('来源：台账.xlsx');
    expect(sha256(fs.readFileSync(path.join(f.workspaceRoot, '模板/母版.pptx')))).toBe(tplSha);

    // Turn 3: offline HTML dashboard + IPC preview validation
    const t3 = await f.runtime.submitTurn('生成离线看板');
    expect(t3.result.outcome).toBe('needs_approval');
    const a3 = f.runtime.getSnapshot().pendingApproval;
    const t3r = await f.runtime.resumeApproval({ ...a3, decision: 'approved' });
    expect(t3r.ok).toBe(true);
    const html = fs.readFileSync(path.join(f.workspaceRoot, '汇报/看板.html'), 'utf8');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');

    const scope = f.runtime.getSnapshot().scope;
    const previewOk = await f.ipc()({}, { schemaVersion: 9, scope, action: 'a9.office.previewHtml', payload: { path: '汇报/看板.html' } });
    expect(previewOk).toMatchObject({ ok: true, previewed: '汇报/看板.html', restricted: true });

    const previewEscape = await f.ipc()({}, { schemaVersion: 9, scope, action: 'a9.office.previewHtml', payload: { path: '../outside.html' } });
    expect(previewEscape.ok).toBe(false);

    // Checkpoint undo cleans up HTML report
    const undo = await f.ipc()({}, { schemaVersion: 9, scope, action: 'a9.checkpoint.undoTurn', payload: { turnId: t3.result.turnId } });
    expect(undo.ok).toBe(true);
    expect(fs.existsSync(path.join(f.workspaceRoot, '汇报/看板.html'))).toBe(false);
    await f.close();
  });
});
