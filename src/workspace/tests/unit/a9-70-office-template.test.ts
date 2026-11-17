import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { OfficeBatchIdentity } from '../../src/a9-office-batch';
import type { OfficeTemplateWorkerPort, TemplateApprovalBinding } from '../../src/a9-office-template';

const { A9WorkspaceService } = require('../../dist') as typeof import('../../src');

const identity1: OfficeBatchIdentity = { workspaceId: 'ws-tpl', conversationId: 'conv-tpl', turnId: 'turn-sample' };
const identity2: OfficeBatchIdentity = { workspaceId: 'ws-tpl', conversationId: 'conv-tpl', turnId: 'turn-batch' };
const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fakeWorker(fields: any[] = [
  { name: '客户名称', path: '客户名称', kind: 'scalar', occurrences: 1, parts: ['word/document.xml'] },
  {
    name: '明细',
    path: '明细',
    kind: 'loop',
    occurrences: 1,
    parts: ['word/document.xml'],
    children: [{ name: '项目', path: '明细.项目', kind: 'scalar', occurrences: 1, parts: ['word/document.xml'] }],
  },
  { name: '附加说明', path: '附加说明', kind: 'loop', occurrences: 1, parts: ['word/document.xml'], children: [] },
]): OfficeTemplateWorkerPort {
  return {
    async inspectTemplate() {
      return {
        schemaVersion: 1,
        format: 'docx',
        fields,
        templatedFiles: ['word/document.xml'],
        supportedFeatures: ['paragraphs', 'tables', 'headers_footers', 'cross_run_placeholders', 'section_loops'],
        limitations: ['no pagination guarantee'],
        warnings: [],
      };
    },
    async renderBatch(input) {
      const items = input.items.map((item) => {
        const payload = Buffer.from(JSON.stringify({ tpl: sha256(input.templateBuffer), data: item.data }), 'utf8');
        const fd = fs.openSync(item.tempPath, 'r+');
        try {
          fs.writeSync(fd, payload, 0, payload.length, 0);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return { tempPath: item.tempPath, bytes: payload.length, sha256: sha256(payload) };
      });
      return { schemaVersion: 1, format: 'docx', items };
    },
  };
}

function fixture(fields?: any[]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-70-tpl-')));
  roots.push(root);
  const bindings: TemplateApprovalBinding[] = [];
  const service = new A9WorkspaceService(root, {
    officeTemplateApproval: {
      async consume(id, binding) {
        bindings.push(binding);
        if (id !== 'ui-authorized') throw Object.assign(new Error('denied'), { code: 'UI_DENIED' });
        return { status: 'approved', bindingSha256: binding.bindingSha256 };
      },
    },
    officeTemplateWorker: fakeWorker(fields),
  });
  const tplRel = '模板/通知.docx';
  const tplAbs = path.join(root, tplRel);
  fs.mkdirSync(path.dirname(tplAbs), { recursive: true });
  fs.writeFileSync(tplAbs, Buffer.from('PK-TEMPLATE-BYTES'));
  const tplSha = sha256(fs.readFileSync(tplAbs));
  return { root, service, tplRel, tplAbs, tplSha, bindings };
}

describe('OfficeTemplateService P3 contract', () => {
  it('validates mapping completeness, rejects prototype/expression keys and enforces sample confirmation before batch output', async () => {
    const f = fixture();
    const mapping = {
      客户名称: 'customer',
      明细: { source: 'items', fields: { 项目: 'title' } },
      附加说明: 'hasNotes',
    };
    const normalRecord = { customer: '张三', items: [{ title: '笔记本' }], hasNotes: true };
    const boundaryRecord = { customer: '超长'.repeat(50), items: [], hasNotes: false };
    const outputRule = { directory: '批量输出', filenamePattern: '{customer}_{index}.docx' };

    await expect(f.service.planTemplateSample(identity1, {
      templatePath: f.tplRel,
      templateSha256: f.tplSha,
      mapping: { 客户名称: 'customer' },
      normalRecord,
      boundaryRecord,
      normalOutputPath: '样张/普通.docx',
      boundaryOutputPath: '样张/边界.docx',
      outputRule,
      viewerEnvironment: 'WPS Office',
    })).rejects.toMatchObject({ code: 'TEMPLATE_MAPPING_INCOMPLETE' });

    await expect(f.service.planTemplateSample(identity1, {
      templatePath: f.tplRel,
      templateSha256: f.tplSha,
      mapping: { ...mapping, 客户名称: '__proto__.pollute' },
      normalRecord,
      boundaryRecord,
      normalOutputPath: '样张/普通.docx',
      boundaryOutputPath: '样张/边界.docx',
      outputRule,
      viewerEnvironment: 'WPS Office',
    })).rejects.toMatchObject({ code: 'TEMPLATE_MAPPING_INVALID' });

    await expect(f.service.planTemplateSample(identity1, {
      templatePath: f.tplRel,
      templateSha256: f.tplSha,
      mapping,
      normalRecord,
      boundaryRecord: { customer: '短', items: [], hasNotes: false },
      normalOutputPath: '样张/普通.docx',
      boundaryOutputPath: '样张/边界.docx',
      outputRule,
      viewerEnvironment: 'WPS Office',
      records: [{ customer: '比边界样张更长的批量数据字段', items: [], hasNotes: false }],
    })).rejects.toMatchObject({ code: 'TEMPLATE_BOUNDARY_UNDERSIZED' });

    await expect(f.service.planTemplateSample(identity1, {
      templatePath: f.tplRel,
      templateSha256: f.tplSha,
      mapping,
      normalRecord,
      boundaryRecord,
      normalOutputPath: '样张/普通.docx',
      boundaryOutputPath: '样张/边界.docx',
      outputRule,
      viewerEnvironment: 'WPS Office',
    })).rejects.toMatchObject({ code: 'TEMPLATE_DATA_REQUIRED' });

    const records = [
      { customer: '甲公司', items: [{ title: 'A' }], hasNotes: true },
      { customer: '乙公司', items: [{ title: 'B' }, { title: 'C' }], hasNotes: false },
    ];
    const samplePlan = await f.service.planTemplateSample(identity1, {
      templatePath: f.tplRel,
      templateSha256: f.tplSha,
      mapping,
      normalRecord,
      boundaryRecord,
      normalOutputPath: '样张/普通.docx',
      boundaryOutputPath: '样张/边界.docx',
      outputRule,
      viewerEnvironment: 'WPS Office',
      records,
    });
    const sampleRes = await f.service.executeTemplateSample({
      planId: samplePlan.planId,
      identity: identity1,
      approvalId: 'ui-authorized',
    });
    expect(sampleRes.status).toBe('completed');
    expect(sampleRes.confirmedInViewer).toBe(false);

    // Batch blocked until operator confirms samples in viewerEnvironment.
    await expect(f.service.planTemplateBatch(identity2, { sampleId: sampleRes.sampleId })).rejects.toMatchObject({
      code: 'TEMPLATE_SAMPLE_NOT_CONFIRMED',
    });

    // Wrong viewer or wrong sample SHA rejected.
    await expect(f.service.confirmTemplateSample({
      workspaceId: identity1.workspaceId,
      conversationId: identity1.conversationId,
      sampleId: sampleRes.sampleId,
      viewerEnvironment: 'Other',
      normalSampleSha256: sampleRes.normalSampleSha256!,
      boundarySampleSha256: sampleRes.boundarySampleSha256!,
    })).rejects.toMatchObject({ code: 'TEMPLATE_VIEWER_MISMATCH' });

    const confirmed = await f.service.confirmTemplateSample({
      workspaceId: identity1.workspaceId,
      conversationId: identity1.conversationId,
      sampleId: sampleRes.sampleId,
      viewerEnvironment: 'WPS Office',
      normalSampleSha256: sampleRes.normalSampleSha256!,
      boundarySampleSha256: sampleRes.boundarySampleSha256!,
    });
    expect(confirmed.confirmedInViewer).toBe(true);

    // Changing mapping, outputRule, or bound data after sample confirmation must fail and require re-confirmation.
    await expect(f.service.planTemplateBatch(identity2, {
      sampleId: sampleRes.sampleId,
      outputRule: { directory: '批量输出', filenamePattern: '改名_{index}.docx' },
    })).rejects.toMatchObject({ code: 'TEMPLATE_BINDING_CHANGED' });
    await expect(f.service.planTemplateBatch(identity2, { sampleId: sampleRes.sampleId })).rejects.toMatchObject({
      code: 'TEMPLATE_SAMPLE_NOT_CONFIRMED',
    });
    await f.service.confirmTemplateSample({
      workspaceId: identity1.workspaceId,
      conversationId: identity1.conversationId,
      sampleId: sampleRes.sampleId,
      viewerEnvironment: 'WPS Office',
      normalSampleSha256: sampleRes.normalSampleSha256!,
      boundarySampleSha256: sampleRes.boundarySampleSha256!,
    });
    await expect(f.service.planTemplateBatch(identity2, {
      sampleId: sampleRes.sampleId,
      records: [{ customer: '改数据', items: [], hasNotes: false }],
    })).rejects.toMatchObject({ code: 'TEMPLATE_BINDING_CHANGED' });

    // Re-confirm after data mismatch rejected until re-confirmed.
    await expect(f.service.planTemplateBatch(identity2, { sampleId: sampleRes.sampleId })).rejects.toMatchObject({
      code: 'TEMPLATE_SAMPLE_NOT_CONFIRMED',
    });
    await f.service.confirmTemplateSample({
      workspaceId: identity1.workspaceId,
      conversationId: identity1.conversationId,
      sampleId: sampleRes.sampleId,
      viewerEnvironment: 'WPS Office',
      normalSampleSha256: sampleRes.normalSampleSha256!,
      boundarySampleSha256: sampleRes.boundarySampleSha256!,
    });

    const batchPlan = await f.service.planTemplateBatch(identity2, { sampleId: sampleRes.sampleId });
    expect(batchPlan.outputs.map(o => o.outputPath)).toEqual(['批量输出/甲公司_1.docx', '批量输出/乙公司_2.docx']);
    const batchRes = await f.service.executeTemplateBatch({
      planId: batchPlan.planId,
      identity: identity2,
      approvalId: 'ui-authorized',
    });
    expect(batchRes.status).toBe('completed');
    expect(batchRes.outputs.every(o => o.status === 'succeeded')).toBe(true);
    expect(sha256(fs.readFileSync(f.tplAbs))).toBe(f.tplSha);

    // Checkpoint undo removes batch outputs cleanly and preserves original template.
    const undo = f.service.getCheckpointManager().undoTurn(identity2.turnId);
    expect(undo.errors).toEqual([]);
    expect(fs.existsSync(path.join(f.root, '批量输出/甲公司_1.docx'))).toBe(false);
    expect(fs.existsSync(path.join(f.root, '批量输出/乙公司_2.docx'))).toBe(false);
    expect(sha256(fs.readFileSync(f.tplAbs))).toBe(f.tplSha);
  });

  it('rejects template drift, sample drift and data file drift before batch execution', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'data.json'), JSON.stringify([{ customer: '甲', items: [], hasNotes: false }]));
    const mapping = {
      客户名称: 'customer',
      明细: { source: 'items', fields: { 项目: 'title' } },
      附加说明: 'hasNotes',
    };
    const samplePlan = await f.service.planTemplateSample(identity1, {
      templatePath: f.tplRel,
      templateSha256: f.tplSha,
      mapping,
      normalRecord: { customer: '甲', items: [], hasNotes: false },
      boundaryRecord: { customer: '乙', items: [], hasNotes: true },
      normalOutputPath: '样张/普通.docx',
      boundaryOutputPath: '样张/边界.docx',
      outputRule: { directory: '输出', filenamePattern: '{customer}_{index}.docx' },
      viewerEnvironment: 'Microsoft Word',
      dataPath: 'data.json',
    });
    const sampleRes = await f.service.executeTemplateSample({ planId: samplePlan.planId, identity: identity1, approvalId: 'ui-authorized' });
    await f.service.confirmTemplateSample({
      workspaceId: identity1.workspaceId,
      conversationId: identity1.conversationId,
      sampleId: sampleRes.sampleId,
      viewerEnvironment: 'Microsoft Word',
      normalSampleSha256: sampleRes.normalSampleSha256!,
      boundarySampleSha256: sampleRes.boundarySampleSha256!,
    });

    // Mutate data.json on disk -> rejected!
    fs.writeFileSync(path.join(f.root, 'data.json'), JSON.stringify([{ customer: '改', items: [], hasNotes: false }]));
    await expect(f.service.planTemplateBatch(identity2, { sampleId: sampleRes.sampleId })).rejects.toMatchObject({
      code: 'TEMPLATE_DATA_DRIFT',
    });

    // Mutate template on disk -> rejected!
    fs.writeFileSync(f.tplAbs, Buffer.from('PK-TEMPLATE-DRIFT'));
    await expect(f.service.confirmTemplateSample({
      workspaceId: identity1.workspaceId,
      conversationId: identity1.conversationId,
      sampleId: sampleRes.sampleId,
      viewerEnvironment: 'Microsoft Word',
      normalSampleSha256: sampleRes.normalSampleSha256!,
      boundarySampleSha256: sampleRes.boundarySampleSha256!,
    })).rejects.toMatchObject({ code: 'TEMPLATE_SOURCE_DRIFT' });
  });

  it('normalizes shorthand loop mapping across sample and batch, and requires re-confirm if batch dataset changes after first batch', async () => {
    const f = fixture([
      { name: '客户', path: '客户', kind: 'scalar', occurrences: 1, parts: ['word/document.xml'] },
      { name: '行', path: '行', kind: 'loop', occurrences: 1, parts: ['word/document.xml'], children: [
        { name: '名称', path: '行.名称', kind: 'scalar', occurrences: 1, parts: ['word/document.xml'] },
      ] },
    ]);
    const samplePlan = await f.service.planTemplateSample(identity1, {
      templatePath: f.tplRel,
      templateSha256: f.tplSha,
      mapping: { 客户: 'customer', 行: 'rows' },
      normalRecord: { customer: '甲', rows: [{ 名称: '条目1' }] },
      boundaryRecord: { customer: '乙边界超长字段', rows: [] },
      normalOutputPath: '样张/s1.docx',
      boundaryOutputPath: '样张/s2.docx',
      outputRule: { directory: '输出A', filenamePattern: '{customer}_{index}.docx' },
      viewerEnvironment: 'WPS Office',
      records: [{ customer: '第一批', rows: [{ 名称: 'A' }] }],
    });
    const sampleRes = await f.service.executeTemplateSample({ planId: samplePlan.planId, identity: identity1, approvalId: 'ui-authorized' });
    await f.service.confirmTemplateSample({
      workspaceId: identity1.workspaceId,
      conversationId: identity1.conversationId,
      sampleId: sampleRes.sampleId,
      viewerEnvironment: 'WPS Office',
      normalSampleSha256: sampleRes.normalSampleSha256!,
      boundarySampleSha256: sampleRes.boundarySampleSha256!,
    });

    const batch1Plan = await f.service.planTemplateBatch(identity2, {
      sampleId: sampleRes.sampleId,
      mapping: { 客户: 'customer', 行: 'rows' },
      records: [{ customer: '第一批', rows: [{ 名称: 'A' }] }],
    });
    const batch1Res = await f.service.executeTemplateBatch({ planId: batch1Plan.planId, identity: identity2, approvalId: 'ui-authorized' });
    expect(batch1Res.status).toBe('completed');

    // Supplying a different dataset on the same sampleId invalidates confirmation and requires re-confirming.
    await expect(f.service.planTemplateBatch({ ...identity2, turnId: 'turn-batch-2' }, {
      sampleId: sampleRes.sampleId,
      records: [{ customer: '第二批改数据', rows: [{ 名称: 'B' }] }],
    })).rejects.toMatchObject({ code: 'TEMPLATE_BINDING_CHANGED' });
    await expect(f.service.planTemplateBatch({ ...identity2, turnId: 'turn-batch-2' }, {
      sampleId: sampleRes.sampleId,
      records: [{ customer: '第一批', rows: [{ 名称: 'A' }] }],
    })).rejects.toMatchObject({ code: 'TEMPLATE_SAMPLE_NOT_CONFIRMED' });
  });
});
