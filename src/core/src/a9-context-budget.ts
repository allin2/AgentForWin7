import type { A9LoopMessage } from './a9-agent-loop';
import { estimateConservativeTokens } from './token-estimator';

export interface ContextBudgetStats {
  budgetChars: number;
  estimatedChars: number;
  /** Token 预算（模型上下文窗口 × 可用比例，已扣除工具定义）；未启用 Token 预算时为 undefined。 */
  budgetTokens?: number;
  /** 本次请求消息的保守 Token 估算（不含工具定义）。 */
  estimatedTokens?: number;
  /** 工具定义（schema）的保守 Token 估算，已从 Token 预算中预留。 */
  toolSchemaTokens?: number;
  includedRounds: number;
  omittedRounds: number;
  elidedToolResults: number;
}

/** 单条消息在 Provider 协议里的固定结构开销（role、分隔符、tool_call 外壳）的保守估算。 */
const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 8;

const estimateMessage = (message: A9LoopMessage): number => message.content.length
  + (message.toolCalls || []).reduce((sum, call) => sum + call.arguments.length, 0);

/** 消息的保守 Token 估算：内容 + tool call 名称与参数 + 固定结构开销。 */
export function estimateMessageTokens(message: A9LoopMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateConservativeTokens(message.content);
  for (const call of message.toolCalls || []) {
    tokens += TOOL_CALL_OVERHEAD_TOKENS + estimateConservativeTokens(call.name || '')
      + estimateConservativeTokens(call.arguments);
  }
  return tokens;
}

/** 工具定义随每次请求发送给模型，必须计入 Token 预算。 */
export function estimateToolSchemaTokens(tools: ReadonlyArray<unknown>): number {
  return tools.length === 0 ? 0 : estimateConservativeTokens(JSON.stringify(tools));
}

function groupRounds(messages: A9LoopMessage[]): A9LoopMessage[][] {
  const rounds: A9LoopMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || rounds.length === 0) rounds.push([message]);
    else rounds[rounds.length - 1].push(message);
  }
  return rounds;
}

export function assembleWithinBudget(
  messages: A9LoopMessage[],
  options: {
    budgetChars: number;
    fixedPrefixCount: number;
    /** 消息可用的 Token 预算；缺省时只按字符预算裁剪（兼容旧调用）。 */
    budgetTokens?: number;
    /** 随请求发送、但不属于 messages 的工具定义 Token 数，从 budgetTokens 中预留。 */
    toolSchemaTokens?: number;
  },
): { messages: A9LoopMessage[]; stats: ContextBudgetStats; budgetExceeded: boolean } {
  const tokenBudgetEnabled = options.budgetTokens !== undefined;
  const toolSchemaTokens = tokenBudgetEnabled ? Math.max(0, options.toolSchemaTokens ?? 0) : 0;
  const messageTokenBudget = tokenBudgetEnabled ? options.budgetTokens! - toolSchemaTokens : Infinity;

  const prefix = messages.slice(0, options.fixedPrefixCount);
  const rounds = groupRounds(messages.slice(options.fixedPrefixCount));
  const current = rounds.pop() || [];
  const size = (items: A9LoopMessage[]) => items.reduce((sum, message) => sum + estimateMessage(message), 0);
  const tokenSize = (items: A9LoopMessage[]) => tokenBudgetEnabled
    ? items.reduce((sum, message) => sum + estimateMessageTokens(message), 0) : 0;
  let estimatedChars = size(prefix) + size(current);
  let estimatedTokens = tokenSize(prefix) + tokenSize(current);
  const selectedCurrent = current.slice();
  let elidedToolResults = 0;
  const overBudget = () => estimatedChars > options.budgetChars || estimatedTokens > messageTokenBudget;
  if (overBudget()) {
    const toolIndices = current.map((message, index) => message.role === 'tool' ? index : -1).filter((index) => index >= 0);
    for (const index of toolIndices.slice(0, -1)) {
      if (!overBudget()) break;
      const original = selectedCurrent[index];
      const placeholder = `[较早的工具输出已省略：${original.content.length} 字符，完整输出见工具日志]`;
      if (placeholder.length >= original.content.length) continue;
      const replacement = { ...original, content: placeholder };
      selectedCurrent[index] = replacement;
      estimatedChars -= original.content.length - placeholder.length;
      if (tokenBudgetEnabled) estimatedTokens -= estimateMessageTokens(original) - estimateMessageTokens(replacement);
      elidedToolResults += 1;
    }
  }
  const selected: A9LoopMessage[][] = [];
  let omittedRounds = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    const roundSize = size(round);
    const roundTokens = tokenSize(round);
    if (estimatedChars + roundSize > options.budgetChars || estimatedTokens + roundTokens > messageTokenBudget) {
      omittedRounds = index + 1;
      break;
    }
    selected.unshift(round);
    estimatedChars += roundSize;
    estimatedTokens += roundTokens;
  }
  return {
    messages: [...prefix, ...selected.flat(), ...selectedCurrent],
    budgetExceeded: overBudget(),
    stats: {
      budgetChars: options.budgetChars,
      estimatedChars,
      ...(tokenBudgetEnabled ? {
        budgetTokens: options.budgetTokens!, estimatedTokens, toolSchemaTokens,
      } : {}),
      includedRounds: selected.length + (current.length > 0 ? 1 : 0),
      omittedRounds,
      elidedToolResults,
    },
  };
}

// ---------------------------------------------------------------------------
// 上下文溢出识别
// ---------------------------------------------------------------------------

/**
 * 各厂商“上下文/输入过长”常见表述。只在 HTTP 400/422 等通用请求错误上与状态码联合使用；
 * 413 本身即表示请求体过大，不依赖文本。
 *
 * 覆盖：OpenAI / Azure（context_length_exceeded、maximum context length）、DeepSeek（maximum context length
 * … you requested）、Qwen / DashScope（Range of input length should be、input length … exceeds）、
 * 智谱 GLM（Prompt exceeds max length，错误码 1261）、vLLM / 自托管（maximum model length、prompt tokens exceeded），
 * 以及这些服务在国内网关上的中文提示。
 */
const OVERFLOW_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /context[_ -]?length[_ -]?exceeded/i,
  /maximum context length/i,
  /maximum model length/i,
  /(?:exceeds?|exceeded|exceeding|over)\s+(?:the\s+)?(?:model'?s?\s+)?(?:maximum\s+|max\s+)?(?:context|input)\s+(?:length|window|limit|size)/i,
  /(?:context|input|prompt)\s+(?:length|window|size)\s+(?:is\s+)?(?:too\s+(?:long|large)|exceeds?|exceeded|over)/i,
  /too many (?:input )?tokens/i,
  /prompt is too long/i,
  /input is too long/i,
  /prompt exceeds max(?:imum)? length/i,
  /prompt[_ ]tokens?\s+(?:limit\s+)?(?:exceeded|exceeds|over)/i,
  /(?:input|prompt|request)[\w ]{0,20}tokens?\s+(?:count\s+)?(?:exceeds?|exceeded|is greater than|over)/i,
  /range of input length should be/i,
  /reduce the length of the (?:messages|prompt|input)/i,
  /requested token count exceeds/i,
  /上下文.{0,8}(?:超出|超过|超限|过长|溢出|已满)/,
  /(?:超出|超过|超限).{0,8}上下文/,
  /(?:超出|超过|超限).{0,6}模型.{0,6}(?:最大|最长)?.{0,4}(?:长度|窗口|上限|限制)/,
  /(?:输入|提示词?|请求内容?|消息内容?|prompt)\s*(?:文本|字符|长度|token|令牌|内容)?\s*(?:过长|太长|超长|超出上下文|超过上下文|超出模型上限|超过模型上限)/i,
  /(?:输入|请求|prompt)?\s*(?:的\s*)?(?:token|令牌)\s*数?.{0,8}(?:超出|超过|超限|过多|上限)/i,
  /(?:超出|超过|超限).{0,8}(?:输入|请求|prompt)?\s*(?:的\s*)?(?:token|令牌)/i,
];

/** 明确排除输出 Token、参数范围、图片等与输入上下文超限无关的错误。 */
const EXCLUSION_PATTERNS = /\b(?:max_tokens|max_output_tokens|output_tokens?)\b|输出\s*(?:token|令牌)|(?:image|图片)/i;

function statusCodeOf(error: any): number | undefined {
  for (const candidate of [error?.statusCode, error?.status, error?.response?.status]) {
    if (Number.isInteger(candidate)) return candidate as number;
  }
  const match = /\bstatus(?:\s+code)?\s*[:=]?\s*(\d{3})\b/i.exec(String(error?.message || ''));
  return match ? Number(match[1]) : undefined;
}

/** Provider 返回“输入超过模型上下文上限”的可恢复错误；命中后进入折半预算重试链路。 */
export function isContextOverflowError(error: any): boolean {
  const status = statusCodeOf(error);
  const text = [error?.message, error?.code, error?.type, error?.error?.message, error?.error?.code]
    .filter((part) => typeof part === 'string').join(' ');
  if (typeof error?.code === 'string' && /^context_length_exceeded$/i.test(error.code)) return true;
  if (status === 413) return true;
  if (status === 400 || status === 422) {
    if (EXCLUSION_PATTERNS.test(text)) return false;
    return OVERFLOW_TEXT_PATTERNS.some((pattern) => pattern.test(text));
  }
  return false;
}
