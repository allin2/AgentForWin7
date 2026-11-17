'use strict';
const crypto = require('crypto');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !(k in value))) fail('A9_OFFICE_REQUEST_INVALID');
}
function parse(args) {
  object(args, ['request'], ['request']);
  if (typeof args.request !== 'string' || Buffer.byteLength(args.request) > 128 * 1024) fail('A9_OFFICE_REQUEST_LIMIT');
  let value; try { value = JSON.parse(args.request); } catch (_) { fail('A9_OFFICE_REQUEST_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('A9_OFFICE_REQUEST_INVALID');
  return value;
}
/** Lives only in trusted main. The model-facing request never contains this grant. */
function createOfficeApprovalAuthority() {
  let active = null;
  return {
    port: { async consume(approvalId, binding) {
      if (!active || active.used || active.approvalId !== approvalId || active.bindingSha256 !== binding.bindingSha256) fail('A9_OFFICE_APPROVAL_REQUIRED');
      active.used = true;
      return { status: 'approved', bindingSha256: binding.bindingSha256 };
    } },
    async run(grant, operation) {
      if (active || !grant || typeof grant.approvalId !== 'string' || !/^[a-f0-9]{64}$/.test(grant.bindingSha256)) fail('A9_OFFICE_APPROVAL_REQUIRED');
      active = { ...grant, used: false };
      try { return await operation(); } finally { active = null; }
    },
  };
}
const HELP = Object.freeze({
  schemaVersion: 1,
  workspace_scan_metadata: { request: { path: '', hash: 'size_groups', maxFiles: 2000 } },
  batch_organize_plan: { request: { actions: [{ kind: 'move', source: '来源.txt', destination: '整理/文件.txt' }] },
    kinds: ['move', 'rename', 'quarantine_duplicate', 'skip_conflict'],
    note: 'quarantine_duplicate 必须指定 duplicateOf，只确认相同字节且有业务依据的副本；不按文件名自动删旧稿。' },
  batch_organize: { request: { planId: '上一步返回的 planId', selectedActionIds: ['a001'] } },
  archive_plan: {
    request: { sources: ['目录或文件.txt'], destination: '归档/交接包.zip', manifestPath: '归档/交接清单.md' },
    note: 'manifestPath 可选；始终排除输出自身、临时文件、.git、恢复目录、Office 锁文件与重解析路径。首批限制 ZIP32。',
  },
  archive_create_zip: { request: { planId: 'archive_plan 返回的 planId' } },
  template_inspect: { request: { path: '模板/通知模板.docx' } },
  template_render_sample: {
    request: {
      templatePath: '模板/通知模板.docx',
      templateSha256: 'template_inspect 返回的 templateSha256',
      mapping: { 客户名称: 'name' },
      normalRecord: { name: '普通样本' },
      boundaryRecord: { name: '超长边界样本...' },
      normalOutputPath: '样张/普通样张.docx',
      boundaryOutputPath: '样张/边界样张.docx',
      outputRule: { directory: '批量输出', filenamePattern: '{name}_{index}.docx' },
      viewerEnvironment: 'Microsoft Word / WPS Office',
    },
    note: '可选传 records 或 dataPath（JSON 数组路径）以在样张阶段即绑定批量数据；输出样张后须由操作员在指定查看环境确认，才允许批量输出。',
  },
  batch_render_templates: {
    request: { sampleId: '已确认的 sampleId', records: [{ name: '张三' }] },
    note: '模板 SHA、映射、输出规则及已绑定数据任一变化必须重新生成并确认样张。',
  },
  presentation_create: {
    request: {
      mode: 'layouts',
      outputPath: '汇报/季度汇报.pptx',
      title: '季度汇报',
      slides: [
        { layout: 'cover', title: '季度总结', subtitle: '第一部分', sources: ['汇报材料.md'] },
        { layout: 'toc', title: '目录', items: ['进展', '计划'], sources: ['汇报材料.md'] },
        { layout: 'two_column', title: '对比', left: { heading: '现状', items: ['已完成'] }, right: { heading: '风险', items: ['待核验'] }, sources: ['纪要.md'] },
        { layout: 'table', title: '指标表', headers: ['项', '值'], rows: [['任务', '100%']], sources: ['统计.csv'] },
        { layout: 'summary', title: '总结', takeaways: ['按期完成'], nextSteps: ['下阶段跟踪'], sources: ['纪要.md'] },
      ],
    },
    note: 'mode 为 layouts 时必须使用 cover/toc/two_column/table/summary 五种版式且每页带 sources；mode 为 template 时需传 templatePath、templateSha256、outputPath 与 data。',
  },
  html_report_create: {
    request: {
      outputPath: '汇报/数据看板.html',
      title: '季度数据看板',
      sources: ['数据表.csv'],
      kpis: [{ label: '完成率', value: '98%', source: '数据表.csv' }],
      charts: [{ kind: 'bar', title: '月度完成', source: '数据表.csv', series: [{ label: '1月', value: 12 }] }],
    },
    note: '生成零外部资源、无脚本执行、全字段转义的离线单文件 HTML 看板（查看基线为应用内 Chromium 108 受限预览）。',
  },
  limits: {
    actions: 100,
    fileBytes: 16777216,
    planBytes: 131072,
    pathCharacters: 240,
    archiveMaxFiles: 2000,
    archiveFileBytes: 67108864,
    archiveTotalBytes: 134217728,
    archiveFormat: 'ZIP32',
    templateMaxBytes: 4194304,
    templateBatchMaxRecords: 200,
    pptxMaxSlides: 40,
    pptxMaxOutputBytes: 16777216,
    htmlMaxOutputBytes: 4194304,
  },
});
function createOfficeWorkflow({ service, identity, authority, containsSensitiveData, assertAvailable,
  workspaceModule, transferWorkspaces, withTransferReservation, archiveAvailable, templateAvailable, reportAvailable }) {
  const transfers = workspaceModule?.OfficeTransferService && transferWorkspaces && withTransferReservation
    ? new workspaceModule.OfficeTransferService(transferWorkspaces, { async consume(id, binding) {
      await authority.port.consume(id, { bindingSha256: binding.digest }); return true;
    } }) : null;
  const transferTools = transfers ? ['transfer_plan', 'transfer_reconcile', 'transfer_undo_plan', 'transfer_execute', 'transfer_undo'] : [];
  const archiveTools = archiveAvailable && typeof service.planArchive === 'function' ? ['archive_plan', 'archive_create_zip'] : [];
  const templateTools = templateAvailable && typeof service.inspectTemplate === 'function'
    ? ['template_inspect', 'template_render_sample', 'batch_render_templates']
    : [];
  const reportTools = [
    ...(reportAvailable && typeof service.planPresentation === 'function' ? ['presentation_create'] : []),
    ...(typeof service.planHtmlReport === 'function' ? ['html_report_create'] : []),
  ];
  const pendingCachedPlans = new Map();
  function cachedPlanKey(name, args, turnId) {
    return crypto.createHash('sha256').update(JSON.stringify([turnId, name, String(args && args.request || '')])).digest('hex');
  }
  function transferIdentity(turnId) { const who = identity(turnId); return { conversationId: who.conversationId, turnId: who.turnId }; }
  function transferBinding(input, turnId) { return transfers.getApprovalBinding(input.planId, transferIdentity(turnId)); }
  function transferSummary(binding) {
    return JSON.stringify({ purpose: binding.purpose, planId: binding.planId,
      sourceWorkspace: binding.sourceRoot.real, source: binding.source.relativePath,
      targetWorkspace: binding.targetRoot.real, destination: binding.target.relativePath,
      sourceSha256: binding.sourceSha256, identity: binding.identity }, null, 2);
  }
  function archiveSummary(binding) {
    const header = {
      workspace: binding.workspaceRoot,
      identity: binding.identity,
      planId: binding.planId,
      destination: binding.destination,
      ...(binding.manifestPath ? { manifestPath: binding.manifestPath } : {}),
      zipFormat: binding.zipFormat,
      entryCount: binding.entryCount,
      totalSourceBytes: binding.totalSourceBytes,
    };
    const entries = [];
    for (const entry of binding.entries) {
      const candidate = JSON.stringify({ ...header, entries: [...entries, entry], omittedEntries: binding.entries.length - entries.length - 1 }, null, 2);
      if (Buffer.byteLength(candidate, 'utf8') > 64 * 1024) break;
      entries.push(entry);
    }
    return JSON.stringify({
      ...header,
      entries,
      ...(entries.length < binding.entries.length ? { omittedEntries: binding.entries.length - entries.length } : {}),
    }, null, 2);
  }
  function templateSummary(binding) {
    const base = {
      purpose: binding.purpose,
      workspace: binding.workspaceRoot,
      identity: binding.identity,
      planId: binding.planId,
      ...(binding.sampleId ? { sampleId: binding.sampleId } : {}),
      templatePath: binding.templatePath,
      templateSha256: binding.templateSha256,
      viewerEnvironment: binding.viewerEnvironment,
      outputRule: binding.outputRule,
      mapping: binding.mapping,
      dataSha256: binding.dataSha256,
      outputCount: binding.outputs.length,
    };
    const outputs = [];
    for (const item of binding.outputs) {
      const candidate = JSON.stringify({ ...base, outputs: [...outputs, item] }, null, 2);
      if (Buffer.byteLength(candidate, 'utf8') > 64 * 1024) break;
      outputs.push(item);
    }
    return JSON.stringify({
      ...base,
      outputs,
      ...(outputs.length < binding.outputs.length ? { omittedOutputs: binding.outputs.length - outputs.length } : {}),
    }, null, 2);
  }
  function reportSummary(binding) {
    return JSON.stringify({
      purpose: binding.purpose,
      workspace: binding.workspaceRoot,
      identity: binding.identity,
      planId: binding.planId,
      outputPath: binding.outputPath,
      ...(binding.mode ? { mode: binding.mode } : {}),
      ...(binding.templatePath ? { templatePath: binding.templatePath, templateSha256: binding.templateSha256 } : {}),
      ...(binding.slideCount !== undefined ? { slideCount: binding.slideCount } : {}),
      sources: binding.sources,
      dataSha256: binding.dataSha256,
    }, null, 2);
  }
  function check() { assertAvailable?.(); }
  function request(name, args) {
    check(); const input = parse(args);
    if (name === 'office_workflow_help') object(input, []);
    else if (name === 'transfer_plan' && transfers) {
      object(input, ['source', 'destination', 'targetWorkspaceId'], ['source', 'destination', 'targetWorkspaceId']);
      if ([input.source, input.destination].some(p => typeof p !== 'string' || containsSensitiveData?.(p))) fail('A9_OFFICE_SENSITIVE_PATH');
    } else if (['transfer_reconcile', 'transfer_undo_plan'].includes(name) && transfers) {
      object(input, ['transferId', 'sourceWorkspaceId', 'targetWorkspaceId'], ['transferId', 'sourceWorkspaceId', 'targetWorkspaceId']);
    } else if (['transfer_execute', 'transfer_undo'].includes(name) && transfers) object(input, ['planId'], ['planId']);
    else if (name === 'workspace_scan_metadata') object(input, ['path', 'hash', 'maxFiles', 'maxFileBytes', 'maxReturnBytes']);
    else if (name === 'batch_organize_plan') {
      object(input, ['actions'], ['actions']);
      if (!Array.isArray(input.actions) || input.actions.length > 100) fail('A9_OFFICE_REQUEST_INVALID');
      for (const action of input.actions) {
        object(action, ['kind', 'source', 'destination', 'duplicateOf'], ['kind', 'source']);
        if ([action.source, action.destination, action.duplicateOf].some(p => p !== undefined && containsSensitiveData?.(p))) fail('A9_OFFICE_SENSITIVE_PATH');
      }
    } else if (name === 'batch_organize') object(input, ['planId', 'selectedActionIds'], ['planId', 'selectedActionIds']);
    else if (name === 'archive_plan' && archiveTools.length) {
      object(input, ['sources', 'destination', 'manifestPath', 'maxFiles', 'maxFileBytes', 'maxTotalBytes'], ['sources', 'destination']);
      if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 100
        || typeof input.destination !== 'string'
        || (input.manifestPath !== undefined && typeof input.manifestPath !== 'string')) {
        fail('A9_OFFICE_REQUEST_INVALID');
      }
      for (const s of input.sources) {
        if (typeof s !== 'string' || containsSensitiveData?.(s)) fail('A9_OFFICE_SENSITIVE_PATH');
      }
      if (containsSensitiveData?.(input.destination) || (input.manifestPath !== undefined && containsSensitiveData?.(input.manifestPath))) {
        fail('A9_OFFICE_SENSITIVE_PATH');
      }
    } else if (name === 'archive_create_zip' && archiveTools.length) {
      object(input, ['planId'], ['planId']);
      if (typeof input.planId !== 'string' || !input.planId || input.planId.length > 128) fail('A9_OFFICE_REQUEST_INVALID');
    } else if (name === 'template_inspect' && templateTools.length) {
      object(input, ['path'], ['path']);
      if (typeof input.path !== 'string' || containsSensitiveData?.(input.path)) fail('A9_OFFICE_SENSITIVE_PATH');
    } else if (name === 'template_render_sample' && templateTools.length) {
      object(input, [
        'templatePath', 'templateSha256', 'mapping', 'normalRecord', 'boundaryRecord',
        'normalOutputPath', 'boundaryOutputPath', 'outputRule', 'viewerEnvironment', 'records', 'dataPath',
      ], [
        'templatePath', 'templateSha256', 'mapping', 'normalRecord', 'boundaryRecord',
        'normalOutputPath', 'boundaryOutputPath', 'outputRule', 'viewerEnvironment',
      ]);
      if ([input.templatePath, input.normalOutputPath, input.boundaryOutputPath, input.dataPath].some(p => p !== undefined && (typeof p !== 'string' || containsSensitiveData?.(p)))) {
        fail('A9_OFFICE_SENSITIVE_PATH');
      }
    } else if (name === 'batch_render_templates' && templateTools.length) {
      object(input, ['sampleId', 'templatePath', 'templateSha256', 'mapping', 'outputRule', 'records', 'dataPath'], ['sampleId']);
      if ([input.templatePath, input.dataPath].some(p => p !== undefined && (typeof p !== 'string' || containsSensitiveData?.(p)))) {
        fail('A9_OFFICE_SENSITIVE_PATH');
      }
    } else if (name === 'presentation_create' && reportTools.includes('presentation_create')) {
      if (input.mode === 'template') {
        object(input, ['mode', 'templatePath', 'templateSha256', 'outputPath', 'data', 'sources'], ['mode', 'templatePath', 'templateSha256', 'outputPath', 'data']);
      } else if (input.mode === 'layouts') {
        object(input, ['mode', 'outputPath', 'title', 'subtitle', 'author', 'slides'], ['mode', 'outputPath', 'title', 'slides']);
      } else fail('A9_OFFICE_REQUEST_INVALID');
      if ([input.templatePath, input.outputPath].some(p => p !== undefined && (typeof p !== 'string' || containsSensitiveData?.(p)))) {
        fail('A9_OFFICE_SENSITIVE_PATH');
      }
      if (Array.isArray(input.slides) && input.slides.some(s => s && typeof s === 'object' && s.imagePath !== undefined && (typeof s.imagePath !== 'string' || containsSensitiveData?.(s.imagePath)))) {
        fail('A9_OFFICE_SENSITIVE_PATH');
      }
    } else if (name === 'html_report_create' && reportTools.includes('html_report_create')) {
      object(input, ['outputPath', 'title', 'subtitle', 'generatedAt', 'sources', 'kpis', 'charts', 'tables', 'notes'], ['outputPath', 'title', 'sources']);
      if (typeof input.outputPath !== 'string' || containsSensitiveData?.(input.outputPath)) {
        fail('A9_OFFICE_SENSITIVE_PATH');
      }
    } else fail('A9_OFFICE_UNAVAILABLE');
    if (input.path !== undefined && containsSensitiveData?.(input.path)) fail('A9_OFFICE_SENSITIVE_PATH');
    return input;
  }
  function executionOptions(input, turnId, signal) {
    return { planId: input.planId, selectedActionIds: input.selectedActionIds, identity: identity(turnId), signal };
  }
  return {
    supportedTools: ['office_workflow_help', 'workspace_scan_metadata', 'batch_organize_plan', 'batch_organize', ...transferTools, ...archiveTools, ...templateTools, ...reportTools],
    async read(name, args, turnId, signal) {
      const input = request(name, args);
      if (name === 'office_workflow_help') return { ...HELP, ...(transfers ? {
        registeredWorkspaces: transferWorkspaces.list?.() || [],
        transfer_plan: { request: { source: '源文件.txt', destination: '目标文件.txt', targetWorkspaceId: '已打开目标工作区的 ID' }, note: '两个工作区均须 Full Access 且目标空闲。父目录须已存在；每计划一个文件。' },
        transfer_execute: { request: { planId: '配对计划 ID' } },
        transfer_reconcile: { request: { transferId: '转移结果中的 ID', sourceWorkspaceId: '当前源工作区 ID', targetWorkspaceId: '原目标工作区 ID' } },
        transfer_undo_plan: { request: { transferId: '转移结果中的 ID', sourceWorkspaceId: '当前源工作区 ID', targetWorkspaceId: '原目标工作区 ID' } },
        transfer_undo: { request: { planId: '新撤销计划 ID' } },
      } : {}) };
      if (name === 'transfer_plan') {
        const who = identity(turnId);
        return transfers.plan({ source: { workspaceId: who.workspaceId, relativePath: input.source, turnId: who.turnId },
          target: { workspaceId: input.targetWorkspaceId, relativePath: input.destination, turnId: 'xfer-' + crypto.createHash('sha256').update(JSON.stringify([who.workspaceId, who.conversationId, who.turnId])).digest('hex').slice(0, 16) } }, transferIdentity(turnId));
      }
      if (name === 'transfer_reconcile' || name === 'transfer_undo_plan') {
        if (input.sourceWorkspaceId !== identity(turnId).workspaceId) fail('A9_OFFICE_SCOPE_STALE');
        return name === 'transfer_reconcile'
          ? transfers.reconcile(input.transferId, input.sourceWorkspaceId, input.targetWorkspaceId)
          : transfers.planUndo(input.transferId, input.sourceWorkspaceId, input.targetWorkspaceId, transferIdentity(turnId));
      }
      if (name === 'workspace_scan_metadata') {
        const { path = '', ...options } = input;
        return service.scanMetadata(path, { ...options, signal });
      }
      if (name === 'batch_organize_plan') return service.planOrganize(identity(turnId), input.actions, signal);
      if (name === 'archive_plan') return service.planArchive(identity(turnId), input, signal);
      if (name === 'template_inspect') return service.inspectTemplate(input.path, signal);
      fail('A9_OFFICE_UNAVAILABLE');
    },
    async prepare(name, args, turnId) {
      const input = request(name, args);
      if (name === 'transfer_execute' || name === 'transfer_undo') {
        const binding = transferBinding(input, turnId); check();
        if (binding.source.workspaceId !== identity(turnId).workspaceId ||
            binding.purpose !== (name === 'transfer_execute' ? 'move' : 'undo')) fail('A9_OFFICE_SCOPE_STALE');
        return { bindingSha256: binding.digest, summary: transferSummary(binding) };
      }
      if (name === 'archive_create_zip') {
        const binding = await service.prepareArchive(input.planId, identity(turnId));
        check();
        return { bindingSha256: binding.bindingSha256, summary: archiveSummary(binding) };
      }
      if (['template_render_sample', 'batch_render_templates', 'presentation_create', 'html_report_create'].includes(name)) {
        const cacheKey = cachedPlanKey(name, args, turnId);
        let planId = pendingCachedPlans.get(cacheKey);
        if (!planId) {
          if (pendingCachedPlans.size >= 32) {
            const first = pendingCachedPlans.keys().next().value;
            if (first) pendingCachedPlans.delete(first);
          }
          const plan = name === 'template_render_sample'
            ? await service.planTemplateSample(identity(turnId), input)
            : name === 'batch_render_templates'
              ? await service.planTemplateBatch(identity(turnId), input)
              : name === 'presentation_create'
                ? await service.planPresentation(identity(turnId), input)
                : await service.planHtmlReport(identity(turnId), input);
          planId = plan.planId;
          pendingCachedPlans.set(cacheKey, planId);
        }
        let binding;
        try {
          binding = name === 'template_render_sample'
            ? await service.prepareTemplateSample(planId, identity(turnId))
            : name === 'batch_render_templates'
              ? await service.prepareTemplateBatch(planId, identity(turnId))
              : name === 'presentation_create'
                ? await service.preparePresentation(planId, identity(turnId))
                : await service.prepareHtmlReport(planId, identity(turnId));
        } catch (err) {
          pendingCachedPlans.delete(cacheKey);
          throw err;
        }
        check();
        const isReport = name === 'presentation_create' || name === 'html_report_create';
        return { bindingSha256: binding.bindingSha256, summary: isReport ? reportSummary(binding) : templateSummary(binding) };
      }
      if (name !== 'batch_organize') fail('A9_OFFICE_UNAVAILABLE');
      const binding = await service.prepareOrganize(executionOptions(input, turnId));
      check();
      return { bindingSha256: binding.bindingSha256,
        selection: { schemaVersion: 1, planId: binding.planId, actions: binding.selectedActions.map(action => ({
          actionId: action.actionId, source: action.source, destination: action.destination, kind: action.kind, sourceSha256: action.sourceSha256,
        })) },
        summary: JSON.stringify({ workspace: binding.workspaceRoot, identity: binding.identity,
          planId: binding.planId, version: binding.version, selectedActions: binding.selectedActions }, null, 2) };
    },
    async execute(name, args, turnId, grant, signal) {
      const input = request(name, args);
      if (name === 'transfer_execute' || name === 'transfer_undo') {
        const binding = transferBinding(input, turnId); check();
        if (binding.source.workspaceId !== identity(turnId).workspaceId || binding.digest !== grant?.bindingSha256) fail('A9_OFFICE_APPROVAL_STALE');
        return withTransferReservation([binding.source.workspaceId, binding.target.workspaceId], () => authority.run(grant, () =>
          name === 'transfer_execute'
            ? transfers.execute(input.planId, transferIdentity(turnId), grant.approvalId, signal)
            : transfers.executeUndo(input.planId, transferIdentity(turnId), grant.approvalId, signal)));
      }
      if (name === 'archive_create_zip') {
        const fresh = await service.prepareArchive(input.planId, identity(turnId), signal);
        check();
        if (fresh.bindingSha256 !== grant?.bindingSha256) fail('A9_OFFICE_APPROVAL_STALE');
        return authority.run(grant, () => service.executeArchive({
          planId: input.planId,
          identity: identity(turnId),
          approvalId: grant.approvalId,
          signal,
        }));
      }
      if (['template_render_sample', 'batch_render_templates', 'presentation_create', 'html_report_create'].includes(name)) {
        const cacheKey = cachedPlanKey(name, args, turnId);
        const planId = pendingCachedPlans.get(cacheKey);
        if (!planId) fail('A9_OFFICE_APPROVAL_STALE');
        const fresh = name === 'template_render_sample'
          ? await service.prepareTemplateSample(planId, identity(turnId), signal)
          : name === 'batch_render_templates'
            ? await service.prepareTemplateBatch(planId, identity(turnId), signal)
            : name === 'presentation_create'
              ? await service.preparePresentation(planId, identity(turnId), signal)
              : await service.prepareHtmlReport(planId, identity(turnId), signal);
        check();
        if (fresh.bindingSha256 !== grant?.bindingSha256) fail('A9_OFFICE_APPROVAL_STALE');
        pendingCachedPlans.delete(cacheKey);
        return authority.run(grant, () => (name === 'template_render_sample'
          ? service.executeTemplateSample({ planId, identity: identity(turnId), approvalId: grant.approvalId, signal })
          : name === 'batch_render_templates'
            ? service.executeTemplateBatch({ planId, identity: identity(turnId), approvalId: grant.approvalId, signal })
            : name === 'presentation_create'
              ? service.executePresentation({ planId, identity: identity(turnId), approvalId: grant.approvalId, signal })
              : service.executeHtmlReport({ planId, identity: identity(turnId), approvalId: grant.approvalId, signal })));
      }
      if (name !== 'batch_organize') fail('A9_OFFICE_UNAVAILABLE');
      const fresh = await service.prepareOrganize(executionOptions(input, turnId, signal));
      check();
      if (fresh.bindingSha256 !== grant?.bindingSha256) fail('A9_OFFICE_APPROVAL_STALE');
      return authority.run(grant, () => service.executeOrganize({ ...executionOptions(input, turnId, signal), approvalId: grant.approvalId }));
    },
  };
}
module.exports = { createOfficeWorkflow, createOfficeApprovalAuthority };
