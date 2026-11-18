'use strict';

/**
 * Provider Base URL 校验与诊断文本/秘密脱敏（Phase C / C1 拆分自 a9-agent-runtime.js）。
 * 纯函数、无状态；a9-agent-runtime.js 重新导出 redactUrlUserinfo 以保持对外接口不变。
 */

function validateProviderBaseUrl(value) {
  if (typeof value !== 'string') {
    const err = new Error('A9_PROVIDER_CONFIG_INVALID: baseUrl 必须是 http(s) URL（允许任意 Base URL）');
    err.code = 'A9_PROVIDER_CONFIG_INVALID';
    throw err;
  }
  const trimmed = value.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_err) {
    const err = new Error('A9_PROVIDER_CONFIG_INVALID: baseUrl 必须是有效的 http(s) URL');
    err.code = 'A9_PROVIDER_CONFIG_INVALID';
    throw err;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    const err = new Error('A9_PROVIDER_CONFIG_INVALID: baseUrl 必须是有效的 http(s) URL');
    err.code = 'A9_PROVIDER_CONFIG_INVALID';
    throw err;
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    const err = new Error('A9_PROVIDER_BASE_URL_CREDENTIALS_FORBIDDEN: baseUrl 不得包含 userinfo、query 或 fragment；请使用 API Key/Header/代理秘密字段');
    err.code = 'A9_PROVIDER_BASE_URL_CREDENTIALS_FORBIDDEN';
    throw err;
  }
  return trimmed;
}

// A9-21 M1b：与旧正则 /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi 等价的线性扫描。
// 第 1 版 {0,31} 不等价（:// 前 32 字符内无字母时旧正则仍脱敏）；反向断言单正则在 V8 上仍二次。
// 字符判定必须用正则字符类（保留 i 与 \s 的 Unicode 语义），不得改用 charCodeAt / toLowerCase。
// 依据：协议名字符不含 ':'，任一起点只能对应所在段末尾的 '://'；段内最左字母为起点，其余起点输出相同。
// 线性：各 '://' 的协议名段互不重叠；粘连匹配至多扫到下一个 '/'，而 '://' 本身含 '/'。
const URL_USERINFO_TAIL = /[^\s/@:]+:[^\s/@]+@/iy;
const PROTO_NAME_CHAR = /[a-z0-9+.-]/i;
const SCHEME_LETTER = /[a-z]/i;

function redactUrlUserinfo(text) {
  const s = String(text == null ? '' : text);
  let copied = 0;
  let from = 0;
  let out = '';
  for (;;) {
    const k = s.indexOf('://', from);
    if (k < 0) {
      out += s.slice(copied);
      return out;
    }
    let hasLetter = false;
    for (let i = k - 1; i >= copied; i--) {
      const ch = s.charAt(i);
      if (!PROTO_NAME_CHAR.test(ch)) break;
      if (SCHEME_LETTER.test(ch)) {
        hasLetter = true;
        break;
      }
    }
    if (hasLetter) {
      URL_USERINFO_TAIL.lastIndex = k + 3;
      if (URL_USERINFO_TAIL.test(s)) {
        out += s.slice(copied, k + 3) + '***redacted***@';
        copied = URL_USERINFO_TAIL.lastIndex;
        from = copied;
        continue;
      }
    }
    from = k + 1;
  }
}

function boundedDiagnosticText(value) {
  return redactUrlUserinfo(value)
    .replace(/((?:authorization|api[-_]?key|password|secret|access[-_]?token|refresh[-_]?token)\s*[:=]\s*)(?:bearer\s+)?[^\s,;&]+/gi, '$1***redacted***')
    .replace(/([?&](?:api[-_]?key|password|secret|access[-_]?token|refresh[-_]?token)=)[^&#\s]*/gi, '$1***redacted***')
    .slice(0, 600);
}

function percentEquivalentRegex(value) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const percentBytes = (text) => Array.from(Buffer.from(text, 'utf8'))
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  // Each Unicode code point may appear literally or as its complete UTF-8
  // percent sequence. This covers legal mixed forms such as `%61b%2F...`
  // without making unescaped secret characters case-insensitive.
  const pattern = Array.from(value).map((character) => {
    const encoded = percentBytes(character);
    const encodedPattern = encoded.replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`);
    const alternatives = [escape(character), encodedPattern];
    if (character === ' ') alternatives.push('\\+');
    return `(?:${alternatives.join('|')})`;
  }).join('');
  return new RegExp(pattern, 'g');
}

module.exports = { validateProviderBaseUrl, redactUrlUserinfo, boundedDiagnosticText, percentEquivalentRegex };
