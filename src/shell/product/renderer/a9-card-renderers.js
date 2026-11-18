'use strict';
// A9 对话时间线的纯渲染/文案构造器（Phase C / C1 拆分自 a9-workbench.js）。
// 只做“事件数据 → 文案 / DOM 节点”的无状态转换：不读写工作台 state、不调用 IPC、不访问网络。
// 不可信文本一律 textContent。工作台通过 <script src="a9-card-renderers.js"> 在 a9-workbench.js
// 之前加载，并以 root.win7AgentCardRenderers 取用；测试环境可直接 require。
(function expose(root) {
  const OUTCOME_LABELS = Object.freeze({
    completed: '完成',
    completed_with_warnings: '完成（有警告）',
    blocked: '受阻',
    failed: '失败',
    cancelled: '已停止',
    interrupted: '已中断',
    needs_approval: '等待批准',
    needs_input: '等待回答',
    running: '运行中',
  });

  function clampText(value, limit) {
    const content = String(value == null ? '' : value);
    if (content.length <= limit) return content;
    return `${content.slice(0, limit)}\n[已截断；完整内容见持久化事件与日志]`;
  }
  function toolHeadline(data) {
    const name = data && data.toolName ? String(data.toolName) : 'tool';
    const args = (data && data.args) || {};
    switch (name) {
      case 'read': return `读取 ${args.path || ''}`.trim();
      case 'list': return `列出 ${args.path || '.'}`;
      case 'search': return `搜索 ${args.pattern || ''}`.trim();
      case 'write': return `写入 ${args.path || ''}`.trim();
      case 'edit': return `编辑 ${args.path || ''}`.trim();
      case 'copy': return `复制 ${args.source || ''} → ${args.destination || ''}`;
      case 'move': return `移动 ${args.source || ''} → ${args.destination || ''}`;
      case 'delete': return `删除 ${args.path || ''}`.trim();
      case 'shell': return `运行命令 ${String(args.command || '').slice(0, 80)}`;
      case 'update_plan': return '更新计划';
      default: return name;
    }
  }

  function toolDetailText(data) {
    const parts = [];
    if (data.error) parts.push(String(data.error));
    if (data.result) parts.push(String(data.result));
    const shell = data.shell;
    if (shell && typeof shell === 'object') {
      if (typeof shell.stdout === 'string' && shell.stdout) parts.push(shell.stdout);
      if (typeof shell.stderr === 'string' && shell.stderr) parts.push(`[stderr]\n${shell.stderr}`);
      if (shell.exitCode !== undefined) parts.push(`exit=${shell.exitCode}`);
      if (shell.truncated) parts.push('[输出预览已截断；完整字节见日志路径]');
    }
    if (data.externalChanges && Array.isArray(data.externalChanges) && data.externalChanges.length > 0) {
      parts.push(`外部文件变更 ${data.externalChanges.length} 处`);
    }
    return parts.join('\n').trim();
  }

  function toolEndStatus(data) {
    const shell = data.shell || {};
    let resultError = false;
    if (typeof data.result === 'string') {
      try {
        const result = JSON.parse(data.result);
        resultError = Boolean(result && typeof result === 'object' && result.error);
      } catch (_error) {
        // The runtime caps result at 1000 characters, which can truncate its
        // exception envelope. File contents remain nested in a content field.
        resultError = /^\s*\{\s*"error"\s*:\s*\{/.test(data.result);
      }
    }
    if (data.residueRisk || shell.residueRisk) return ['failed', '清理未确认'];
    if (data.cancelled === true || ['cancelled', 'canceled', 'interrupted'].includes(shell.status)) return ['stopped', '已停止'];
    if (data.denied) return ['denied', '已拒绝'];
    if (data.error || resultError || ['failed', 'error', 'timeout', 'timed_out'].includes(shell.status)
        || (typeof shell.exitCode === 'number' && shell.exitCode !== 0)
        || /^Tool execution error:|^Error:/i.test(String(data.result || ''))) return ['failed', '失败'];
    if (data.shell && shell.status !== 'completed' && shell.status !== 'success' && shell.exitCode !== 0) return ['interrupted', '结果未确认'];
    return ['success', ({ read: '已读取', list: '已列出', search: '已搜索' })[data.toolName] || '执行成功'];
  }

  function timelineEntryLabel(event) {
    const data = event.data || {};
    const shell = data.shell && data.shell.schemaVersion === 1 ? data.shell : null;
    switch (event.type) {
      case 'turn_started': return '任务开始';
      case 'turn_completed': return `任务${OUTCOME_LABELS[data.outcome] || '结束（结果未确认）'}`;
      case 'turn_failed': return `任务失败 · ${data.guidance && typeof data.guidance.title === 'string'
        ? data.guidance.title.slice(0, 120) : String(data.error || '').slice(0, 120)}`;
      case 'model_note': return '模型说明';
      case 'model_chunk': return '模型输出（汇总）';
      case 'plan_updated': return '更新计划';
      case 'approval_required': return `准备执行 · 等待批准 · ${data.toolName || '-'}`;
      case 'approval_resolved': return `审批${data.decision === 'approved' ? '已批准' : '已拒绝'} · ${data.toolName || '-'}`;
      case 'approval_invalidated': return `审批已失效，未执行 · ${data.toolName || '-'}`;
      case 'tool_start': return `正在${toolHeadline(data)}`;
      case 'tool_end':
        return `${toolHeadline(data)} · ${toolEndStatus(data)[1]}${shell && shell.exitCode !== undefined ? ` · exit=${shell.exitCode}` : ''}`;
      default: return event.type || 'event';
    }
  }

  function buildPlanCard(data) {
    const card = document.createElement('div');
    card.className = 'plan-card';
    const title = document.createElement('p');
    title.className = 'plan-title';
    title.textContent = '计划';
    title.title = '计划仅记录步骤，不代表工具已执行成功。';
    card.appendChild(title);
    const steps = document.createElement('ol');
    steps.className = 'plan-steps';
    (Array.isArray(data && data.plan) ? data.plan : []).forEach((line) => {
      const step = document.createElement('li');
      step.className = 'plan-step';
      step.textContent = String(line || '');
      steps.appendChild(step);
    });
    card.appendChild(steps);
    if (data && data.explanation) {
      const explanation = document.createElement('p');
      explanation.className = 'plan-explanation';
      explanation.textContent = clampText(data.explanation, 2000);
      card.appendChild(explanation);
    }
    return card;
  }

  function buildApprovalRecord(kind, headline, detailText) {
    const record = document.createElement('p');
    record.className = `approval-record ${kind}`;
    const body = document.createElement('span');
    body.className = 'approval-record-body';
    const strong = document.createElement('strong');
    strong.textContent = headline;
    body.appendChild(strong);
    if (detailText) {
      const detail = document.createElement('span');
      detail.className = 'approval-record-detail';
      detail.textContent = detailText;
      body.appendChild(detail);
    }
    record.appendChild(body);
    return record;
  }

  const api = Object.freeze({
    OUTCOME_LABELS, clampText, toolHeadline, toolDetailText, toolEndStatus, timelineEntryLabel,
    buildPlanCard, buildApprovalRecord,
  });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.win7AgentCardRenderers = api;
}(typeof window === 'object' ? window : globalThis));
