'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function pathKey(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function workspaceId(value) { return crypto.createHash('sha256').update(pathKey(value), 'utf8').digest('hex'); }
// Windows persistence keys workspaces by a lowercased path; reopening from that key
// must show the on-disk casing again. Only the casing is taken from the native
// realpath, so subst drives and short names keep their existing identity.
function displayCasing(resolved, platform = process.platform, nativeRealpath = fs.realpathSync.native) {
  if (platform !== 'win32' || typeof nativeRealpath !== 'function') return resolved;
  try {
    const native = nativeRealpath(resolved);
    return typeof native === 'string' && native.toLowerCase() === resolved.toLowerCase() ? native : resolved;
  } catch (_error) { return resolved; }
}
function contains(parent, child) {
  const relative = path.relative(pathKey(parent), pathKey(child));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Resolve both normal repositories and linked worktrees. Unknown metadata must
// not silently make two writers appear independent.
function gitIdentity(workspace) {
  let directory = workspace;
  for (;;) {
    const marker = path.join(directory, '.git');
    let stat;
    try {
      stat = fs.statSync(marker);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      let gitDirectory = marker;
      if (stat.isFile()) {
        if (stat.size > 4096) throw failure('A9_WORKSPACE_GIT_INVALID', 'Git 工作区指针过大。');
        const match = /^gitdir: (.+)\s*$/.exec(fs.readFileSync(marker, 'utf8').trim());
        if (!match) throw failure('A9_WORKSPACE_GIT_INVALID', 'Git 工作区指针无效。');
        gitDirectory = path.resolve(directory, match[1]);
      } else if (!stat.isDirectory()) throw failure('A9_WORKSPACE_GIT_INVALID', 'Git 元数据类型无效。');
      gitDirectory = fs.realpathSync(gitDirectory);
      const common = path.join(gitDirectory, 'commondir');
      try {
        const commonStat = fs.statSync(common);
        if (!commonStat.isFile() || commonStat.size > 4096) throw failure('A9_WORKSPACE_GIT_INVALID', 'Git 共享目录指针无效。');
        gitDirectory = fs.realpathSync(path.resolve(gitDirectory, fs.readFileSync(common, 'utf8').trim()));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return pathKey(gitDirectory);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function createA9WorkspaceRegistry(options) {
  const config = options || {};
  const entries = new Map();
  let activeId = null;
  let selectionClosed = false;
  let persistenceOutcome = null;
  let providerSource = null;
  let providerChanging = false;
  let closingAll = false;
  const closing = new Set();
  const accounting = { maxConcurrentRequests: 2, activeRequests: 0, requests: 0, usageReports: 0, missingUsageReports: 0,
    reportedTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };

  function assertExecutionAllowed() {
    if (providerChanging || closingAll) throw failure('A9_APPLICATION_BUSY', '全应用配置或退出正在进行，请稍后重试。');
  }

  function wrapProvider(provider) {
    return new Proxy(provider, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (!['sendStreamRequest', 'sendRequest'].includes(property)) return value.bind(receiver);
        return async (...args) => {
          if (accounting.activeRequests >= accounting.maxConcurrentRequests) {
            throw failure('A9_MODEL_CONCURRENCY_LIMIT', '已有两个模型请求在执行，请稍后重试；队列将暂停。');
          }
          accounting.activeRequests += 1;
          accounting.requests += 1;
          try {
            const result = await value.apply(target, args);
            const usage = result && result.usage;
            if (result.usageReported === true && usage && ['promptTokens', 'completionTokens', 'totalTokens'].every(key => Number.isFinite(usage[key]) && usage[key] >= 0)) {
              accounting.usageReports += 1;
              for (const key of Object.keys(accounting.reportedTokens)) accounting.reportedTokens[key] += usage[key];
            } else accounting.missingUsageReports += 1;
            return result;
          } catch (error) { accounting.missingUsageReports += 1; throw error; }
          finally { accounting.activeRequests -= 1; }
        };
      },
    });
  }

  function identity(workspace) {
    const resolved = displayCasing(fs.realpathSync(workspace));
    if (!fs.statSync(resolved).isDirectory()) throw failure('A9_WORKSPACE_INVALID', '工作区必须是目录。');
    return { workspaceId: workspaceId(resolved), workspaceRoot: resolved, git: gitIdentity(resolved) };
  }

  function admit(workspace) {
    const next = identity(workspace);
    if (closingAll || providerChanging || closing.has(next.workspaceId)) throw failure('A9_APPLICATION_BUSY', '工作区或全应用配置正在关闭或变更。');
    if (!entries.has(next.workspaceId) && entries.size >= 8) throw failure('A9_WORKSPACE_LIMIT', '最多同时打开八个工作区，请先关闭一个。');
    for (const entry of entries.values()) {
      if (entry.workspaceId === next.workspaceId) continue;
      if (contains(entry.workspaceRoot, next.workspaceRoot) || contains(next.workspaceRoot, entry.workspaceRoot)
        || (next.git && gitIdentity(entry.workspaceRoot) === next.git)) {
        throw failure('A9_WORKSPACE_OVERLAP', '该目录与已打开工作区重叠或共享 Git 元数据，请先关闭相关工作区。');
      }
    }
    return next;
  }

  function open(workspace) {
    const next = admit(workspace);
    let entry = entries.get(next.workspaceId);
    if (!entry) {
      const runtime = config.createRuntime(next.workspaceRoot, {
        openPersistence: (values, open) => {
          if (!persistenceOutcome) persistenceOutcome = open(values);
          return persistenceOutcome;
        },
        wrapProvider,
        assertExecutionAllowed,
        isProviderConfiguring: () => providerChanging,
      });
      entry = { ...next, runtime };
      if (providerSource && runtime.status === 'ready' && runtime.acceptProviderState) providerSource.shareProviderState(runtime.acceptProviderState);
      else if (runtime.status === 'ready' && runtime.shareProviderState) providerSource = runtime;
      entries.set(next.workspaceId, entry);
    }
    return entry;
  }

  function activate(workspace) {
    const entry = open(workspace);
    activeId = entry.workspaceId;
    selectionClosed = false;
    return entry;
  }

  // Persisted (lowercased on Windows) path -> display casing, resolved once per path.
  const displayRoots = new Map();
  function directory() {
    const paths = new Map();
    if (persistenceOutcome && persistenceOutcome.status === 'ready') {
      for (const workspace of persistenceOutcome.manager.listWorkspacePaths()) {
        if (!displayRoots.has(workspace)) displayRoots.set(workspace, displayCasing(workspace));
        paths.set(workspaceId(workspace), displayRoots.get(workspace));
      }
    }
    for (const entry of entries.values()) paths.set(entry.workspaceId, entry.workspaceRoot);
    return Array.from(paths, ([id, workspace]) => {
      const entry = entries.get(id);
      const snapshot = entry && entry.runtime.getSnapshot({ conversationPage: true });
      return { workspaceId: id, workspaceRoot: workspace, displayName: path.basename(workspace),
        opened: Boolean(entry), active: id === activeId,
        status: snapshot ? snapshot.agentStatus || snapshot.status : 'closed',
        activeConversationId: snapshot && snapshot.activeConversationId,
        canSwitch: snapshot ? Boolean(snapshot.conversationControls && snapshot.conversationControls.canSwitch) : true,
        // Bounded summaries for the cross-workspace inbox; full facts stay behind scoped requests.
        conversations: snapshot ? (snapshot.conversations || []).filter(item => item.state === 'active').slice(0, 32)
          .map(item => ({ sessionId: item.sessionId, title: item.title, activity: item.activity, updatedAt: item.updatedAt,
            settledAt: item.settledAt, lastVisitedAt: item.lastVisitedAt,
            lastCompletedAt: item.lastCompletedAt, lastActivityAt: item.lastActivityAt,
            hasDraft: item.hasDraft === true })) : [],
      };
    });
  }

  function resolve(scope) {
    const entry = entries.get(scope && scope.workspaceId);
    if (!entry || entry.workspaceId !== activeId || closing.has(entry.workspaceId) || closingAll) {
      throw failure('A9_SCOPE_STALE', '工作区查看目标已变化，请刷新后重试。');
    }
    // Revalidate aliases and shared Git identity before any scoped operation.
    if (admit(entry.workspaceRoot).workspaceId !== entry.workspaceId) throw failure('A9_SCOPE_STALE', '工作区目录身份已变化。');
    const snapshot = entry.runtime.getSnapshot({ conversationPage: true });
    if (snapshot.activeConversationId !== scope.conversationId) throw failure('A9_SCOPE_STALE', '对话目标已变化，请刷新后重试。');
    return entry.runtime;
  }

  async function configureProvider(runtime, values) {
    assertExecutionAllowed();
    if (Array.from(entries.values()).some(entry => entry.runtime.canLeaveWorkspace && !entry.runtime.canLeaveWorkspace().allowed)) {
      throw failure('A9_PROVIDER_RECONFIGURE_BUSY', '请先完成或停止所有工作区任务、队列及后台进程，再修改全应用模型配置。');
    }
    providerChanging = true;
    try { return await runtime.configureProvider(values); }
    finally {
      // Even a failed probe may have saved a new fail-closed configuration.
      if (runtime.status === 'ready' && runtime.shareProviderState) {
        providerSource = runtime;
        for (const entry of entries.values()) if (entry.runtime !== runtime && entry.runtime.status === 'ready' && entry.runtime.acceptProviderState) runtime.shareProviderState(entry.runtime.acceptProviderState);
      }
      providerChanging = false;
    }
  }

  async function close(id, shutdownOptions) {
    const entry = entries.get(id);
    if (!entry || closing.has(id) || providerChanging) throw failure('A9_WORKSPACE_UNAVAILABLE', '工作区未打开或正在处理其他操作。');
    closing.add(id);
    try {
      const result = await entry.runtime.shutdown({ ...shutdownOptions, cancelPending: true });
      if (result && ((result.unresolved || []).length || (shutdownOptions?.stopManaged !== false && (result.leftToSystem || []).length))) {
        throw failure('A9_WORKSPACE_CLEANUP_UNCONFIRMED', '工作区清理尚未确认，已保留入口和诊断。');
      }
      entries.delete(id);
      if (activeId === id) activeId = entries.keys().next().value || null;
      selectionClosed = !activeId;
      return { ok: true, activeWorkspaceId: activeId };
    } finally { closing.delete(id); }
  }

  async function shutdown(options) {
    if (providerChanging) throw failure('A9_APPLICATION_BUSY', '模型配置仍在验证，请完成后再退出。');
    closingAll = true;
    try {
      const results = await Promise.allSettled(Array.from(entries.values(), entry => entry.runtime.shutdown({ ...options, cancelPending: true })));
      const summary = { unresolved: [], leftToSystem: [], stopped: [] };
      results.forEach((result, index) => {
        if (result.status === 'rejected') summary.unresolved.push(`workspace ${index + 1}: shutdown failed`);
        else for (const key of Object.keys(summary)) summary[key].push(...(result.value && result.value[key] || []));
      });
      return summary;
    } finally { closingAll = false; }
  }

  return { admit, open, activate, resolve, directory, configureProvider, close, shutdown,
    getActive: () => entries.get(activeId) || null,
    getById: id => entries.get(id) || null,
    get size() { return entries.size; },
    get selectionClosed() { return selectionClosed; },
    accounting: () => ({ ...accounting, reportedTokens: accounting.usageReports ? { ...accounting.reportedTokens } : null }),
  };
}

module.exports = { createA9WorkspaceRegistry, workspaceId, displayCasing };
