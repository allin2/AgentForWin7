'use strict';
(function expose(root) {
  const agentStatus = typeof module === 'object' && module.exports
    ? require('./a9-agent-status') : root.win7AgentStatus;
  function controls(snapshot, running, text) {
    const ready = Boolean(snapshot && snapshot.status === 'ready'
      && ['full_access', 'read_only'].includes(snapshot.mode));
    const blocked = !ready || Boolean(snapshot.pendingApproval || snapshot.pendingQuestion
      || agentStatus.isAwaitingUser(snapshot.agentStatus) || snapshot.agentStatus === 'cancelling');
    const provider = ready && snapshot.provider && snapshot.provider.configured
      && snapshot.provider.probe && snapshot.provider.probe.classification === 'tool_calling';
    const hasText = typeof text === 'string' && Boolean(text.trim());
    const items = snapshot && snapshot.queue ? snapshot.queue.items : [];
    return {
      canDraft: !blocked,
      canSend: !blocked && Boolean(provider) && !running && hasText,
      canQueue: !blocked && Boolean(provider) && running && hasText && items.length < 8,
    };
  }
  const api = Object.freeze({ controls });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.win7AgentComposerController = api;
}(typeof window === 'object' ? window : globalThis));
