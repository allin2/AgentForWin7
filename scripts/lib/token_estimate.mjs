// Conservative UTF-8 token estimator shared by the harness scripts.
// Mirrors src/core/src/token-estimator.ts (estimateContextTokens without the
// `provided` override): ASCII characters count 1/4 token, every non-ASCII
// UTF-8 byte counts as one token. scripts/test_context_project.mjs checks
// parity with the compiled core implementation when src/core/dist exists.

export function estimateTokens(content) {
  let asciiChars = 0;
  let nonAsciiBytes = 0;
  for (const character of String(content)) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) asciiChars += 1;
    else nonAsciiBytes += Buffer.byteLength(character, 'utf8');
  }
  return Math.max(1, Math.ceil(asciiChars / 4) + nonAsciiBytes);
}
