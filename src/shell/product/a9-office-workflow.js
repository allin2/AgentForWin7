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
  limits: {
    actions: 100,
    fileBytes: 16777216,
    planBytes: 131072,
    pathCharacters: 240,
    archiveMaxFiles: 2000,
    archiveFileBytes: 67108864,
    archiveTotalBytes: 134217728,
    archiveFormat: 'ZIP32',
  },
});
function createOfficeWorkflow({ service, identity, authority, containsSensitiveData, assertAvailable,
  workspaceModule, transferWorkspaces, withTransferReservation, archiveAvailable }) {
  const transfers = workspaceModule?.OfficeTransferService && transferWorkspaces && withTransferReservation
    ? new workspaceModule.OfficeTransferService(transferWorkspaces, { async consume(id, binding) {
      await authority.port.consume(id, { bindingSha256: binding.digest }); return true;
    } }) : null;
  const transferTools = transfers ? ['transfer_plan', 'transfer_reconcile', 'transfer_undo_plan', 'transfer_execute', 'transfer_undo'] : [];
  const archiveTools = archiveAvailable && typeof service.planArchive === 'function' ? ['archive_plan', 'archive_create_zip'] : [];
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
    } else fail('A9_OFFICE_UNAVAILABLE');
    if (input.path !== undefined && containsSensitiveData?.(input.path)) fail('A9_OFFICE_SENSITIVE_PATH');
    return input;
  }
  function executionOptions(input, turnId, signal) {
    return { planId: input.planId, selectedActionIds: input.selectedActionIds, identity: identity(turnId), signal };
  }
  return {
    supportedTools: ['office_workflow_help', 'workspace_scan_metadata', 'batch_organize_plan', 'batch_organize', ...transferTools, ...archiveTools],
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
      if (name !== 'batch_organize') fail('A9_OFFICE_UNAVAILABLE');
      const fresh = await service.prepareOrganize(executionOptions(input, turnId, signal));
      check();
      if (fresh.bindingSha256 !== grant?.bindingSha256) fail('A9_OFFICE_APPROVAL_STALE');
      return authority.run(grant, () => service.executeOrganize({ ...executionOptions(input, turnId, signal), approvalId: grant.approvalId }));
    },
  };
}
module.exports = { createOfficeWorkflow, createOfficeApprovalAuthority };
