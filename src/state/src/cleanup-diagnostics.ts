/**
 * @module cleanup-diagnostics
 * @description 清理路径（关闭数据库、删除临时/备份文件、释放锁文件）失败时的结构化诊断。
 *
 * 这些步骤发生在主错误已经上报之后或失败回滚中，不能再抛出新错误覆盖主因；但按 AGENTS §5
 * 也不允许静默吞掉。失败被记录为有界的结构化条目，并通过 Node 的 warning 通道输出（带稳定错误码）。
 * 只记录操作名、目标路径和被截断的错误消息，不记录数据库内容或任何凭据。
 */

export interface CleanupDiagnostic {
  /** 稳定错误码，如 A9_DB_CLOSE_FAILED。 */
  code: string;
  /** 发生失败的清理操作（调用点自述）。 */
  operation: string;
  detail: string;
  at: string;
}

const MAX_RECENT_DIAGNOSTICS = 32;
const MAX_DETAIL_CHARS = 240;
const recent: CleanupDiagnostic[] = [];

function describe(error: unknown, target?: string): string {
  const code = error && typeof (error as { code?: unknown }).code === 'string' ? `${(error as { code: string }).code}: ` : '';
  const message = error instanceof Error ? error.message : String(error);
  return `${code}${message}${target ? ` [${target}]` : ''}`.slice(0, MAX_DETAIL_CHARS);
}

/** 记录一次清理失败并返回该条目；不抛出。 */
export function reportCleanupFailure(code: string, operation: string, error: unknown, target?: string): CleanupDiagnostic {
  const diagnostic: CleanupDiagnostic = { code, operation, detail: describe(error, target), at: new Date().toISOString() };
  recent.push(diagnostic);
  if (recent.length > MAX_RECENT_DIAGNOSTICS) recent.shift();
  try {
    process.emitWarning(`${code} (${operation}): ${diagnostic.detail}`, { type: 'A9CleanupWarning', code });
  } catch (_warningFailure) {
    // 诊断通道本身失败时，条目仍保存在有界列表中，可经 getRecentCleanupDiagnostics 读取。
  }
  return diagnostic;
}

export function getRecentCleanupDiagnostics(): ReadonlyArray<CleanupDiagnostic> {
  return recent.slice();
}

export function clearCleanupDiagnostics(): void {
  recent.length = 0;
}
