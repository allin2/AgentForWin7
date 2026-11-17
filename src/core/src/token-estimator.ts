export type TokenEstimateSource = 'provided' | 'conservative_utf8';

export interface TokenEstimate {
  tokens: number;
  source: TokenEstimateSource;
}

/**
 * Tokenizer-independent fallback. ASCII runs receive the familiar 4 chars per
 * token estimate; every non-ASCII UTF-8 byte counts as one token. This is
 * intentionally conservative for Chinese and mixed-language project rules.
 */
export function estimateContextTokens(content: string, provided?: number): TokenEstimate {
  if (provided !== undefined) {
    if (!Number.isInteger(provided) || provided < 1) {
      throw new Error('Provided token estimate must be a positive integer');
    }
    return { tokens: provided, source: 'provided' };
  }
  return { tokens: Math.max(1, estimateConservativeTokens(content)), source: 'conservative_utf8' };
}

/**
 * `estimateContextTokens` 的无供给值路径：单次遍历 UTF-16 码元，按 UTF-8 字节计数，
 * 不为每个非 ASCII 字符调用 Buffer，适合在每次请求前对整段历史估算。
 * 孤立代理项与 Buffer.byteLength 一致，按 U+FFFD 的 3 字节计；空串为 0（下限 1 由 estimateContextTokens 施加）。
 */
export function estimateConservativeTokens(content: string): number {
  let asciiChars = 0;
  let nonAsciiBytes = 0;
  const length = content.length;
  for (let index = 0; index < length; index += 1) {
    const unit = content.charCodeAt(index);
    if (unit <= 0x7f) asciiChars += 1;
    else if (unit <= 0x7ff) nonAsciiBytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < length
      && (content.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      nonAsciiBytes += 4;
      index += 1;
    } else nonAsciiBytes += 3;
  }
  return Math.ceil(asciiChars / 4) + nonAsciiBytes;
}
