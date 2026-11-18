'use strict';

/**
 * 重启/切换时恢复给 Provider 的文本上下文选择（Phase C / C1 拆分自 a9-agent-runtime.js）。
 * 纯函数、无状态；a9-agent-runtime.js 重新导出两个 build 函数以保持对外接口不变。
 */

const PROVIDER_CONTEXT_MAX_ROUNDS = 20;
const PROVIDER_CONTEXT_MAX_CHARS = 32_000;

/**
 * A9-66 F-007: same selection/statistics as buildPersistedTextContext, from the
 * bounded asynchronous scan summary (newest complete rounds in ascending order,
 * exact complete/visible counts). buildPersistedTextContext stays the
 * independent synchronous oracle.
 */
function buildPersistedTextContextFromSummary(summary) {
  const recent = summary.recent;
  const selected = [];
  let includedChars = 0;
  for (let index = recent.length - 1; index >= 0 && selected.length < PROVIDER_CONTEXT_MAX_ROUNDS; index -= 1) {
    const fact = recent[index];
    const roundChars = fact.requestPrompt.length + fact.finalMessage.length;
    if (includedChars + roundChars > PROVIDER_CONTEXT_MAX_CHARS) break;
    selected.push(fact);
    includedChars += roundChars;
  }
  selected.reverse();
  const omittedRounds = Math.max(0, summary.completeRounds - selected.length);
  return {
    messages: selected.flatMap((fact) => [
      { role: 'user', content: fact.requestPrompt },
      { role: 'assistant', content: fact.finalMessage },
    ]),
    stats: {
      includedRounds: selected.length,
      includedChars,
      omittedRounds,
      visibleRounds: summary.visibleRounds,
      maxRounds: PROVIDER_CONTEXT_MAX_ROUNDS,
      maxChars: PROVIDER_CONTEXT_MAX_CHARS,
      ...(omittedRounds > 0 ? { note: `更早的 ${omittedRounds} 个完整轮次仅在本地可见，未恢复给 Provider。` } : {}),
    },
  };
}

/**
 * 重启/切换时只恢复完整用户+助手文本轮；工具、审批和副作用不进入模型上下文。
 */
function buildPersistedTextContext(facts, providerContextGeneration = 0) {
  const complete = (Array.isArray(facts) ? facts : []).filter((fact) =>
    (Number.isSafeInteger(fact.providerContextGeneration) ? fact.providerContextGeneration : 0) === providerContextGeneration
    &&
    typeof fact.requestPrompt === 'string' && fact.requestPrompt.length > 0
    && typeof fact.finalMessage === 'string' && fact.finalMessage.length > 0);
  const selected = [];
  let includedChars = 0;
  for (let index = complete.length - 1; index >= 0 && selected.length < 20; index -= 1) {
    const fact = complete[index];
    const roundChars = fact.requestPrompt.length + fact.finalMessage.length;
    if (includedChars + roundChars > 32_000) break;
    selected.push(fact);
    includedChars += roundChars;
  }
  selected.reverse();
  const omittedRounds = Math.max(0, complete.length - selected.length);
  return {
    messages: selected.flatMap((fact) => [
      { role: 'user', content: fact.requestPrompt },
      { role: 'assistant', content: fact.finalMessage },
    ]),
    stats: {
      includedRounds: selected.length,
      includedChars,
      omittedRounds,
      visibleRounds: Array.isArray(facts) ? facts.length : 0,
      maxRounds: 20,
      maxChars: 32_000,
      ...(omittedRounds > 0 ? { note: `更早的 ${omittedRounds} 个完整轮次仅在本地可见，未恢复给 Provider。` } : {}),
    },
  };
}

module.exports = { PROVIDER_CONTEXT_MAX_ROUNDS, PROVIDER_CONTEXT_MAX_CHARS, buildPersistedTextContext, buildPersistedTextContextFromSummary };
