/**
 * Phase B / B2（H-P2-15）：上下文预算按 Token 估算、计入工具定义，并扩展溢出识别。
 */
import { A9AgentLoop, A9LoopMessage, A9ModelPort, estimateContextTokens } from '../src';
import {
  assembleWithinBudget, estimateMessageTokens, estimateToolSchemaTokens, isContextOverflowError,
} from '../src/a9-context-budget';
import { estimateConservativeTokens } from '../src/token-estimator';

/** 旧实现（逐字符 Buffer.byteLength），作为新快速路径的等价基准。 */
function referenceTokens(content: string): number {
  let ascii = 0;
  let bytes = 0;
  for (const character of content) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else bytes += Buffer.byteLength(character, 'utf8');
  }
  return Math.ceil(ascii / 4) + bytes;
}

describe('Phase B2: token estimation', () => {
  it.each([
    ['empty', ''], ['ascii', 'hello world'], ['chinese', '上下文超出模型最大长度，请缩短输入'],
    ['mixed', 'fix 缺陷 #12：修复 `read` 工具'], ['emoji pair', 'a😀b'], ['lone high surrogate', 'x\ud800y'],
    ['lone low surrogate', 'x\udc00y'], ['two-byte', 'Привет café'],
  ])('fast path equals the reference conservative estimate: %s', (_label, text) => {
    expect(estimateConservativeTokens(text)).toBe(referenceTokens(text));
    expect(estimateContextTokens(text).tokens).toBe(Math.max(1, referenceTokens(text)));
  });

  it('counts tool-call name and arguments plus a fixed per-message overhead', () => {
    const plain: A9LoopMessage = { role: 'assistant', content: '' };
    const withCall: A9LoopMessage = { ...plain, toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"文件.txt"}' }] };
    expect(estimateMessageTokens(withCall)).toBeGreaterThan(estimateMessageTokens(plain));
    expect(estimateToolSchemaTokens([])).toBe(0);
    expect(estimateToolSchemaTokens([{ name: 'read', description: '读取文件' }])).toBeGreaterThan(10);
  });
});

describe('Phase B2: token-aware assembly', () => {
  const chineseRounds = (count: number): A9LoopMessage[] => {
    const messages: A9LoopMessage[] = [{ role: 'system', content: 'sys' }];
    for (let round = 0; round < count; round += 1) {
      messages.push({ role: 'user', content: `第${round}轮：` + '数据'.repeat(500) });
      messages.push({ role: 'assistant', content: '好的：' + '结果'.repeat(500) });
    }
    return messages;
  };

  it('trims a Chinese conversation by tokens even when the character budget is far from reached', () => {
    const messages = chineseRounds(40); // ≈ 80k 字符，远低于 400k 字符预算
    const byChars = assembleWithinBudget(messages, { budgetChars: 400_000, fixedPrefixCount: 1 });
    expect(byChars.stats.omittedRounds).toBe(0);
    const byTokens = assembleWithinBudget(messages, { budgetChars: 400_000, budgetTokens: 30_000, fixedPrefixCount: 1 });
    expect(byTokens.budgetExceeded).toBe(false);
    expect(byTokens.stats.estimatedTokens!).toBeLessThanOrEqual(30_000);
    expect(byTokens.stats.omittedRounds).toBeGreaterThan(0);
    expect(byTokens.messages[byTokens.messages.length - 1].content).toBe(messages[messages.length - 1].content);
  });

  it('reserves tool definitions from the token budget and reports them in stats', () => {
    const messages = chineseRounds(10);
    const free = assembleWithinBudget(messages, { budgetChars: 400_000, budgetTokens: 40_000, fixedPrefixCount: 1 });
    const reserved = assembleWithinBudget(messages, {
      budgetChars: 400_000, budgetTokens: 40_000, toolSchemaTokens: 25_000, fixedPrefixCount: 1,
    });
    expect(reserved.stats.toolSchemaTokens).toBe(25_000);
    expect(reserved.stats.omittedRounds).toBeGreaterThan(free.stats.omittedRounds);
    expect(reserved.stats.estimatedTokens! + 25_000).toBeLessThanOrEqual(40_000);
  });

  it('reports budgetExceeded when the irreducible current round alone exceeds the token budget', () => {
    const result = assembleWithinBudget([{ role: 'system', content: 's' }, { role: 'user', content: '超长'.repeat(5000) }],
      { budgetChars: 400_000, budgetTokens: 10_000, fixedPrefixCount: 1 });
    expect(result.budgetExceeded).toBe(true);
  });

  it('keeps the legacy character-only behavior when no token budget is supplied', () => {
    const result = assembleWithinBudget(chineseRounds(3), { budgetChars: 400_000, fixedPrefixCount: 1 });
    expect(result.stats.budgetTokens).toBeUndefined();
    expect(result.stats.estimatedTokens).toBeUndefined();
  });
});

describe('Phase B2: context overflow recognition', () => {
  const http = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

  it.each([
    ['OpenAI code', http(400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.")],
    ['OpenAI error code', http(400, 'Error code: context_length_exceeded')],
    ['DeepSeek', http(400, "Server returned status 400: This model's maximum context length is 65536 tokens. However, you requested 70000 tokens")],
    ['Qwen range', http(400, 'Server returned status 400: Range of input length should be [1, 129024]')],
    ['Qwen input length', http(400, 'Input length exceeds the model context window')],
    ['GLM', http(400, 'Prompt exceeds max length (code 1261)')],
    ['vLLM', http(400, "This model's maximum model length is 32768 tokens; request has 40000 prompt tokens")],
    ['prompt tokens exceeded', http(400, 'prompt tokens exceeded the limit')],
    ['too many tokens', http(400, 'too many tokens in the request')],
    ['prompt too long', http(400, 'prompt is too long: 210000 tokens > 200000 maximum')],
    ['Chinese 上下文超出', http(400, '请求失败：上下文超出限制')],
    ['Chinese 超出模型最大长度', http(400, '输入内容超出模型最大长度 32768')],
    ['Chinese 输入过长', http(400, '输入内容过长，请缩短后重试')],
    ['Chinese token 超限', http(422, '请求的 token 数超过上限')],
    ['status only in message', new Error('Server returned status 400: 上下文长度超限')],
    ['numeric status field', Object.assign(new Error('prompt is too long'), { status: 400 })],
    ['413 without text', http(413, 'Request Entity Too Large')],
    ['413 empty body', http(413, '')],
    ['string code', Object.assign(new Error('x'), { code: 'context_length_exceeded' })],
  ])('recognizes %s', (_label, error) => {
    expect(isContextOverflowError(error)).toBe(true);
  });

  it.each([
    ['unrelated 400', http(400, 'Invalid API parameter: temperature must be <= 2')],
    ['name length limit in Chinese', http(400, 'name 参数超出最大长度 64')],
    ['max_tokens 超过最大值', http(400, 'max_tokens 超过最大值 8192')],
    ['参数 max_tokens 超出范围', http(400, '参数 max_tokens 超出范围')],
    ['输出 token 超过上限', http(400, '输出 token 超过上限')],
    ['prompt 包含过多图片', http(400, 'prompt 参数格式错误：超过 10 张图片')],
    ['image input size exceeds limit', http(400, 'image input size exceeds limit')],
    ['request max_tokens exceeds model limit', http(400, 'request max_tokens exceeds the model limit')],
    ['overflow text on a 500', http(500, 'maximum context length exceeded')],
    ['overflow text on a 401', http(401, 'context_length_exceeded')],
    ['no status', new Error('maximum context length exceeded')],
    ['empty', new Error('')],
    ['nullish', undefined],
  ])('does not misclassify %s', (_label, error) => {
    expect(isContextOverflowError(error)).toBe(false);
  });
});

describe('Phase B2: agent loop integration', () => {
  const history = (rounds: number): A9LoopMessage[] => Array.from({ length: rounds }, (_, index) => [
    { role: 'user' as const, content: `历史${index}：` + '内容'.repeat(400) },
    { role: 'assistant' as const, content: '回答：' + '说明'.repeat(400) },
  ]).flat();

  it('enforces the Provider context window on a Chinese conversation and exposes token stats', async () => {
    const requests: A9LoopMessage[][] = [];
    const provider: A9ModelPort = { sendStreamRequest: jest.fn().mockImplementation(async (request) => {
      requests.push(request.messages);
      return { id: 'done', content: 'done', finishReason: 'stop' };
    }) };
    const events: any[] = [];
    const loop = new A9AgentLoop({ workspaceRoot: '/mock', provider, workspaceService: {} as any, runner: {} as any,
      contextWindowTokens: 40_000, onEvent: (event) => events.push(event) });
    loop.restoreConversationHistory(history(60)); // ≈ 96k 字符 ≈ 290k 保守 Token
    const result = await loop.runTurn('当前问题');
    expect(result.outcome).toBe('completed');
    const sent = requests[0].reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    const stats = events.find((event) => event.type === 'turn_started').data.context;
    expect(stats.budgetTokens).toBe(34_000);
    expect(stats.toolSchemaTokens).toBeGreaterThan(500);
    expect(sent + stats.toolSchemaTokens).toBeLessThanOrEqual(34_000);
    expect(requests[0].length).toBeLessThan(121);
    expect(requests[0][requests[0].length - 1].content).toBe('当前问题');
  });

  it('retries a DeepSeek/Qwen style Chinese overflow at half budget', async () => {
    const requests: A9LoopMessage[][] = [];
    let call = 0;
    const provider: A9ModelPort = { sendStreamRequest: jest.fn().mockImplementation(async (request) => {
      requests.push(request.messages);
      call += 1;
      if (call === 1) throw Object.assign(new Error('Server returned status 400: 输入内容超出模型最大长度'), { statusCode: 400 });
      return { id: 'done', content: 'done', finishReason: 'stop' };
    }) };
    const loop = new A9AgentLoop({ workspaceRoot: '/mock', provider, workspaceService: {} as any, runner: {} as any,
      contextWindowTokens: 60_000 });
    loop.restoreConversationHistory(history(30));
    const result = await loop.runTurn('继续');
    expect(result.outcome).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(requests[1].length).toBeLessThan(requests[0].length);
  });

  it('retries on a bare HTTP 413 and fails readably when the retry also overflows', async () => {
    const provider: A9ModelPort = { sendStreamRequest: jest.fn().mockRejectedValue(
      Object.assign(new Error('Request Entity Too Large'), { statusCode: 413 })) };
    const loop = new A9AgentLoop({ workspaceRoot: '/mock', provider, workspaceService: {} as any, runner: {} as any });
    const result = await loop.runTurn('x');
    expect(provider.sendStreamRequest).toHaveBeenCalledTimes(2);
    expect(result.finalMessage).toBe('对话过长，已尝试压缩仍超出模型上限');
  });

  it('counts tool definitions against the window so an input that would fit without them is blocked before sending', async () => {
    const probeEvents: any[] = [];
    const probe = new A9AgentLoop({ workspaceRoot: '/mock', provider: { sendStreamRequest: jest.fn().mockResolvedValue(
      { id: 'd', content: 'd', finishReason: 'stop' }) }, workspaceService: {} as any, runner: {} as any,
    contextWindowTokens: 8_000, onEvent: (event) => probeEvents.push(event) });
    await probe.runTurn('hi');
    const toolTokens: number = probeEvents.find((event) => event.type === 'turn_started').data.context.toolSchemaTokens;
    expect(toolTokens).toBeGreaterThan(1_000);
    expect(toolTokens).toBeLessThan(6_800);

    // 消息本身（约 6800 - toolTokens + 100 Token）不超过 6800，但加上工具定义后超限。
    const prompt = '字'.repeat(Math.ceil((6_800 - toolTokens) / 3) + 100);
    const provider: A9ModelPort = { sendStreamRequest: jest.fn() };
    const events: any[] = [];
    const loop = new A9AgentLoop({ workspaceRoot: '/mock', provider, workspaceService: {} as any, runner: {} as any,
      contextWindowTokens: 8_000, onEvent: (event) => events.push(event) });
    const result = await loop.runTurn(prompt);
    expect(provider.sendStreamRequest).not.toHaveBeenCalled();
    expect(result.outcome).toBe('failed');
    const failed = events.find((event) => event.type === 'turn_failed').data;
    expect(failed.code).toBe('A9_CONTEXT_BUDGET_EXCEEDED');
    expect(failed.toolSchemaTokens).toBe(toolTokens);
    expect(failed.budgetTokens).toBe(6_800);
  });
});
