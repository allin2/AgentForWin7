import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { OfficeBatchIdentity } from '../../src/a9-office-batch';
import type { OfficeReportWorkerPort, ReportApprovalBinding } from '../../src/a9-office-report';

const { A9WorkspaceService } = require('../../dist') as typeof import('../../src');

const identity: OfficeBatchIdentity = {
  workspaceId: 'ws-70-report',
  conversationId: 'conv-70-report',
  turnId: 'turn-70-report',
};
const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fakeReportWorker(): OfficeReportWorkerPort {
  return {
    async createLayoutsPresentation(input) {
      const payload = Buffer.from(JSON.stringify({ mode: 'layouts', title: input.title, slideCount: input.slides.length }), 'utf8');
      const fd = fs.openSync(input.tempPath, 'r+');
      try {
        fs.writeSync(fd, payload, 0, payload.length, 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        tempPath: input.tempPath,
        bytes: payload.length,
        sha256: sha256(payload),
        slideCount: input.slides.length,
        slides: input.slides.map((s, idx) => ({
          index: idx + 1,
          partName: `ppt/slides/slide${idx + 1}.xml`,
          texts: [s.title, `来源：${s.sources.join('、')}`],
          notesTexts: [`来源：${s.sources.join('、')}`],
        })),
        workerExitCode: 0,
      };
    },
    async fillTemplatePresentation(input) {
      const payload = Buffer.from(JSON.stringify({ mode: 'template', tplSha: sha256(input.templateBuffer), data: input.data }), 'utf8');
      const fd = fs.openSync(input.tempPath, 'r+');
      try {
        fs.writeSync(fd, payload, 0, payload.length, 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        tempPath: input.tempPath,
        bytes: payload.length,
        sha256: sha256(payload),
        slideCount: 1,
        slides: [{ index: 1, partName: 'ppt/slides/slide1.xml', texts: ['filled'], notesTexts: [] }],
        workerExitCode: 0,
      };
    },
  };
}

function fixture(approved = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-rep-')));
  roots.push(root);
  const bindings: ReportApprovalBinding[] = [];
  const service = new A9WorkspaceService(root, {
    ...(approved
      ? {
        officeReportApproval: {
          async consume(id, binding) {
            bindings.push(binding);
            if (id !== 'ui-authorized') throw Object.assign(new Error('denied'), { code: 'UI_DENIED' });
            return { status: 'approved', bindingSha256: binding.bindingSha256 };
          },
        },
      }
      : {}),
    officeReportWorker: fakeReportWorker(),
  });
  return { root, service, bindings };
}

describe('OfficeReportService P4 contract', () => {
  it('validates 5 PPTX layouts with mandatory per-slide sources, rejects invalid inputs and supports checkpoint undo', async () => {
    const f = fixture(true);
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(f.root, 'logo.png'), png1x1);

    // Slide without sources must be rejected.
    await expect(f.service.planPresentation(identity, {
      mode: 'layouts',
      outputPath: 'out.pptx',
      title: '缺少来源',
      slides: [{ layout: 'cover', title: '封面', sources: [] }],
    })).rejects.toMatchObject({ code: 'REPORT_SOURCES_REQUIRED' });

    // Unknown layout must be rejected.
    await expect(f.service.planPresentation(identity, {
      mode: 'layouts',
      outputPath: 'out.pptx',
      title: '非法版式',
      slides: [{ layout: 'blank' as any, title: '空', sources: ['a.md'] }],
    })).rejects.toMatchObject({ code: 'REPORT_LAYOUT_UNSUPPORTED' });

    const plan = await f.service.planPresentation(identity, {
      mode: 'layouts',
      outputPath: '汇报/五版式.pptx',
      title: '季度汇报',
      author: '办公团队',
      slides: [
        { layout: 'cover', title: '2026 Q4 汇报', subtitle: '项目总结', imagePath: 'logo.png', sources: ['封面材料.md'] },
        { layout: 'toc', title: '目录', items: ['工作进展', { title: '数据对比', detail: '分部门' }], sources: ['大纲.md'] },
        { layout: 'two_column', title: '方案对比', left: { heading: '现状', items: ['手工整理'] }, right: { heading: '改造后', items: ['批量可撤销'] }, sources: ['纪要A.md', '纪要B.md'] },
        { layout: 'table', title: '指标表', headers: ['部门', '完成率'], rows: [['研发', '98%']], sources: ['指标.csv'] },
        { layout: 'summary', title: '结论与下一步', takeaways: ['目标达成'], nextSteps: ['推广模板'], sources: ['总结.md'] },
      ],
    });
    expect(plan.slideCount).toBe(5);
    expect(plan.layouts).toEqual(['cover', 'toc', 'two_column', 'table', 'summary']);

    // Image drift after plan must reject prepare & execute.
    fs.writeFileSync(path.join(f.root, 'logo.png'), Buffer.from('changed'));
    await expect(f.service.preparePresentation(plan.planId, identity)).rejects.toMatchObject({ code: 'REPORT_IMAGE_DRIFT' });
    fs.writeFileSync(path.join(f.root, 'logo.png'), png1x1);

    const res = await f.service.executePresentation({ planId: plan.planId, identity, approvalId: 'ui-authorized' });
    expect(res).toMatchObject({
      status: 'completed',
      code: 'REPORT_PPTX_OK',
      published: true,
      slideCount: 5,
      recovery: 'recorded',
      checkpointStatus: 'recorded',
    });
    expect(fs.existsSync(path.join(f.root, '汇报/五版式.pptx'))).toBe(true);

    const undo = f.service.getCheckpointManager().undoTurn(identity.turnId);
    expect(undo.errors).toEqual([]);
    expect(fs.existsSync(path.join(f.root, '汇报/五版式.pptx'))).toBe(false);
  });

  it('escapes all HTML/SVG fields against XSS, forbids external resources and supports checkpoint undo', async () => {
    const f = fixture(true);
    const xss = '<script>alert(1)</script><img src="https://evil.invalid/x.png" onerror="alert(2)">"&\'\'';
    const plan = await f.service.planHtmlReport({ ...identity, turnId: 'turn-html' }, {
      outputPath: '汇报/看板.html',
      title: `季度看板 ${xss}`,
      subtitle: `副标题 ${xss}`,
      generatedAt: '2026-11-17 10:00',
      sources: [`来源_${xss}.csv`],
      kpis: [{ label: `指标 ${xss}`, value: '99%', unit: '率', delta: '+5%', source: `表_${xss}` }],
      charts: [
        { kind: 'bar', title: `柱状图 ${xss}`, unit: '件', source: '数据源A.csv', series: [{ label: `项 ${xss}`, value: 42 }, { label: '二月', value: 68 }] },
        { kind: 'line', title: '趋势图', source: '数据源B.csv', series: [{ label: 'W1', value: 10 }, { label: 'W2', value: 25 }] },
      ],
      tables: [{ title: `明细 ${xss}`, source: '明细.csv', headers: ['名称', '结果'], rows: [[xss, '通过']] }],
      notes: [`备注 ${xss}`],
    });
    const res = await f.service.executeHtmlReport({
      planId: plan.planId,
      identity: { ...identity, turnId: 'turn-html' },
      approvalId: 'ui-authorized',
    });
    expect(res).toMatchObject({
      status: 'completed',
      code: 'REPORT_HTML_OK',
      published: true,
      previewBaseline: 'chromium_108_restricted',
      recovery: 'recorded',
    });
    const html = fs.readFileSync(path.join(f.root, '汇报/看板.html'), 'utf8');
    expect(html).toContain("script-src 'none'");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img ');
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<svg ');
    expect(html).toContain('<polyline ');
    expect(html).toContain('<rect ');

    const undo = f.service.getCheckpointManager().undoTurn('turn-html');
    expect(undo.errors).toEqual([]);
    expect(fs.existsSync(path.join(f.root, '汇报/看板.html'))).toBe(false);
  });
});
