'use strict';
// C3：事件驱动快照推送。Runtime 在状态/事件/审批/问询变化时只报告“有新事实”，
// 这里按工作区合并（默认 150 ms 内的多次变化只发一条），经 IPC 通知 Renderer 重新读取
// a9.snapshot.get。载荷只含工作区 ID、变化原因与时间戳，绝不携带会话内容、路径或秘密；
// Renderer 仍通过既有 Schema IPC 取事实，推送不是新的数据通道。
const SNAPSHOT_UPDATED_CHANNEL = 'a9:snapshot:updated';
const SNAPSHOT_PUSH_SCHEMA_VERSION = 1;
const MAX_REASONS = 8;
const MAX_REASON_LENGTH = 64;

function createSnapshotPushNotifier(options) {
  const config = options || {};
  if (typeof config.send !== 'function') throw new TypeError('A9_SNAPSHOT_PUSH_SEND_REQUIRED');
  const delayMs = Number.isFinite(config.delayMs) && config.delayMs >= 0 ? config.delayMs : 150;
  const setTimer = config.setTimer || setTimeout;
  const clearTimer = config.clearTimer || clearTimeout;
  const now = config.now || Date.now;
  const pending = new Map(); // workspaceId -> Set(reason)
  let timer = null;
  let closed = false;
  const stats = { notified: 0, sent: 0, coalesced: 0, failed: 0 };

  function fail(error) {
    stats.failed += 1;
    // 推送失败只可见、不抛出：Renderer 仍有低频保活读取，Runtime 行为不受影响。
    if (typeof config.onError === 'function') {
      try { config.onError(error); } catch (_reporterFailure) { /* 上报器自身失败无处可报，计数已保留 */ }
    }
  }
  function flush() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    const batch = Array.from(pending.entries());
    pending.clear();
    for (const [workspaceId, reasons] of batch) {
      try {
        const sent = config.send(SNAPSHOT_UPDATED_CHANNEL, {
          schemaVersion: SNAPSHOT_PUSH_SCHEMA_VERSION,
          workspaceId,
          reasons: Array.from(reasons).slice(0, MAX_REASONS),
          at: now(),
        });
        if (sent !== false) stats.sent += 1;
      } catch (error) { fail(error); }
    }
  }
  function notify(change) {
    if (closed) return;
    const workspaceId = change && typeof change.workspaceId === 'string' ? change.workspaceId : '';
    const reason = change && typeof change.reason === 'string' ? change.reason.slice(0, MAX_REASON_LENGTH) : 'unknown';
    stats.notified += 1;
    const reasons = pending.get(workspaceId);
    if (reasons) { reasons.add(reason); stats.coalesced += 1; } else pending.set(workspaceId, new Set([reason]));
    if (timer === null) timer = setTimer(flush, delayMs);
  }
  function close() {
    closed = true;
    if (timer !== null) { clearTimer(timer); timer = null; }
    pending.clear();
  }
  return Object.freeze({ notify, flush, close, stats: () => ({ ...stats }) });
}

module.exports = { createSnapshotPushNotifier, SNAPSHOT_UPDATED_CHANNEL, SNAPSHOT_PUSH_SCHEMA_VERSION };
