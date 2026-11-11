'use strict';

// ADR-0326. This module only validates and projects retained facts; no effects.
function invalid() { throw Object.assign(new Error('A9_PAYLOAD_INVALID'), { code: 'A9_PAYLOAD_INVALID' }); }
function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some(key => !required.concat(optional).includes(key))) invalid();
}
const id = value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
const query = value => id(value);
function identity(value) {
  if (!['event', 'checkpoint'].includes(value.source) || !id(value.id)) invalid();
  if (value.source === 'event' && (!/^[1-9][0-9]*$/.test(value.id) || !Number.isSafeInteger(Number(value.id)))) invalid();
}
function historyTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  // Legacy SQLite UTC text is retained verbatim: changing cursor bytes changes
  // SQL ordering. Accept only its bounded date-time form, not arbitrary dates.
  const legacy = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  const iso = legacy ? `${legacy[1]}T${legacy[2]}.${(legacy[3] || '').padEnd(3, '0')}Z` : value;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso;
}
function validateHistoryInput(method, value) {
  if (method === 'search') {
    object(value, ['query'], ['before', 'limit']);
    if (!query(value.query) || (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 50))) invalid();
    if (value.before !== undefined) {
      object(value.before, ['createdAt', 'source', 'id']); identity(value.before);
      if (!historyTimestamp(value.before.createdAt)) invalid();
    }
  } else if (method === 'locate') {
    object(value, ['conversationId', 'source', 'id'], ['query']); identity(value);
    if (!id(value.conversationId) || (value.query !== undefined && !query(value.query))) invalid();
  } else {
    object(value, ['conversationId', 'turnId']);
    if (!id(value.conversationId) || !id(value.turnId)) invalid();
  }
  return value;
}
function parse(value) { try { return JSON.parse(value || '{}') || {}; } catch (_) { return {}; } }
const text = value => typeof value === 'string' ? value : '';
function visibleHistoryText(json, type, redact) {
  const p = parse(json), d = p.data || {};
  let values = [];
  if (type === 'conversation.request') values = [p.requestPrompt];
  else if (type === 'reply') values = [p.finalMessage];
  else if (type === 'retained_reply') values = [p.requestPrompt, p.finalMessage];
  else if (type === 'tool_start') values = [d.args && d.args.command];
  else if (type === 'tool_output') values = [d.text];
  else if (type === 'turn_failed') values = [d.message, d.reason, d.code, typeof d.error === 'string' ? d.error : d.error && (d.error.message || d.error.code)];
  else if (type === 'tool_end') {
    // Never stringify an arbitrary tool payload (files, credentials, config).
    const result = parse(d.result);
    values = [d.shell && d.shell.stdout, d.shell && d.shell.stderr,
      typeof result.error === 'string' ? result.error : result.error && (result.error.message || result.error.code)];
    if (['shell', 'start_process', 'read_process_output', 'stop_process'].includes(d.toolName)) {
      values.push(result.stdout, result.stderr, result.output);
    }
  }
  // Filter/redact before SQL instr(), including known host secrets.
  return values.filter(value => typeof value === 'string').map(value => redact(value)).join('\n');
}

function deliveryProjection(facts, redact) {
  const checkpoint = parse(facts.checkpointJson), outcome = parse(facts.outcomeJson);
  const checks = [], issues = [];
  let verificationEvidence = null, checksTotal = 0, terminalSeen = false;
  for (const event of facts.events) {
    const data = parse(event.payloadJson).data || {}, start = parse(event.startJson).data || {};
    if (['turn_completed', 'turn_failed'].includes(event.eventType) && !terminalSeen) {
      terminalSeen = true;
      const evidence = data.verificationEvidence || {};
      if (typeof evidence.command === 'string' && evidence.command.trim() && evidence.exitCode === 0) verificationEvidence = {
        command: redact(evidence.command).slice(0, 2000), commandTruncated: evidence.command.length > 2000, exitCode: evidence.exitCode, eventId: event.id,
      };
    }
    if (event.eventType === 'turn_failed' && issues.length < 20) {
      const detail = text(data.error) || text(data.message) || text(data.reason) || text(data.code) || '轮次失败；具体原因未保留';
      issues.push({ eventId: event.id, text: redact(detail).slice(0, 1000), textTruncated: detail.length > 1000 });
    }
    if (data.outputTruncated === true && issues.length < 20) issues.push({ eventId: event.id, text: '本轮工具输出已截断，保留观察不完整' });
    const result = parse(data.result), shell = data.shell;
    if (event.eventType === 'tool_end' && (data.toolName === 'shell' || data.toolName === 'start_process')) {
      checksTotal += 1;
      if (checks.length < 20) checks.push({ eventId: event.id, toolName: data.toolName,
        command: text(start.args && start.args.command) ? redact(start.args.command).slice(0, 2000) : 'UNKNOWN',
        exitCode: shell && Number.isSafeInteger(shell.exitCode) ? shell.exitCode : Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
        commandTruncated: text(start.args && start.args.command).length > 2000,
        status: (text(shell && shell.status) || text(result.status) || 'UNKNOWN').slice(0, 80),
        timedOut: shell && shell.timedOut === true, residueRisk: data.residueRisk === true,
      });
    }
    const error = typeof result.error === 'string' ? result.error : text(result.error && (result.error.message || result.error.code));
    if (error && issues.length < 20) issues.push({ eventId: event.id, text: redact(error).slice(0, 1000), textTruncated: error.length > 1000 });
    if (data.residueRisk === true && issues.length < 20) issues.push({ eventId: event.id, text: '进程清理结果不确定（residueRisk）' });
    if (shell && (shell.timedOut === true || ['failed', 'cancelled', 'interrupted', 'protocol_error', 'timed_out'].includes(shell.status) || (Number.isSafeInteger(shell.exitCode) && shell.exitCode !== 0)) && issues.length < 20)
      issues.push({ eventId: event.id, text: `命令 ${text(shell.status).slice(0, 80) || 'UNKNOWN'}；exit=${Number.isSafeInteger(shell.exitCode) ? shell.exitCode : 'UNKNOWN'}` });
  }
  const verification = (text(checkpoint.verification) || text(outcome.verification) || 'UNKNOWN').slice(0, 80);
  return { conversationId: facts.conversationId, taskId: facts.taskId, turnId: facts.turnId,
    turnStatus: facts.status || 'UNKNOWN',
    outcome: (text(checkpoint.outcome) || text(outcome.outcome) || facts.status || 'UNKNOWN').slice(0, 80),
    verification: verification === 'not_applicable' ? 'NOT_PERFORMED' : verification === 'verified' && !verificationEvidence ? 'UNKNOWN' : verification,
    recordedVerification: verification,
    verificationEvidence: verification === 'verified' ? verificationEvidence : null, checks: checks.reverse(), checksRemaining: checksTotal - checks.length,
    auditTruncated: facts.auditTruncated, issues: issues.reverse(),
    issueLimitReached: issues.length >= 20, checkpointAvailable: Boolean(facts.checkpointJson) };
}
module.exports = { validateHistoryInput, visibleHistoryText, deliveryProjection };
