'use strict';

/**
 * 模型调用失败的中文指引（Phase C / C1 拆分自 a9-agent-runtime.js）。
 * 纯函数、无状态；a9-agent-runtime.js 重新导出 describeModelFailure / presentModelFailureText 以保持对外接口不变。
 */

/**
 * B3：把常见网络/模型调用错误映射为“错误原因 + 下一步操作”的中文指引。
 *
 * 只依据错误文本归类（Core 只把 `err.message` 带到界面层）；Gateway 会在消息中保留
 * HTTP 状态、Node 错误码与 TLS 码。顺序即优先级：先具体（状态码/证书码），后宽泛（超时、截断）。
 * 返回 null 表示没有可靠归类，调用方沿用原始错误文本。
 */
const MODEL_FAILURE_GUIDANCE = [
  { code: 'A9_ERR_PROXY_AUTH', test: /\bstatus 407\b|Proxy Authentication Required|PROXY_AUTH/i,
    title: '代理服务器要求身份验证（HTTP 407）',
    advice: '在“企业网络”中核对代理主机与端口；代理需要账号密码时，请向 IT 获取并配置代理凭据，或改用无需认证的代理。' },
  { code: 'A9_ERR_AUTH', test: /\bstatus 401\b|AUTH_INVALID_CREDENTIALS|invalid[_ ]api[_ ]key|incorrect api key|(?<!status\s+[2-9]\d\d[^\n]*)\bunauthorized\b/i,
    title: 'API Key 无效或已过期（HTTP 401）',
    advice: '请在“模型设置”中重新输入有效的 API Key，并确认它属于当前 Base URL 对应的服务、未被撤销且账户未欠费。' },
  { code: 'A9_ERR_FORBIDDEN', test: /\bstatus 403\b/i,
    title: '没有访问该模型或接口的权限（HTTP 403）',
    advice: '请确认 API Key 已开通所选模型的权限，并检查服务端的 IP 白名单或企业网关策略。' },
  { code: 'A9_ERR_RATE_LIMIT', test: /\bstatus 429\b|rate.?limit/i,
    title: '请求过于频繁或额度已用尽（HTTP 429）',
    advice: '请稍后重试；若持续出现，请检查账户额度、并发限制，或联系服务提供方提高配额。' },
  { code: 'A9_ERR_NOT_FOUND', test: /\bstatus 404\b|model_not_found|model .{0,60}does not exist/i,
    title: '找不到模型或接口地址（HTTP 404）',
    advice: '请核对“模型 ID”；Base URL 可填到 /v1，或者直接填完整的 …/chat/completions 地址（例如智谱 GLM 的 /v4 路径）。' },
  { code: 'A9_ERR_SERVER', test: /\bstatus 5\d\d\b/i,
    title: '模型服务暂时不可用（HTTP 5xx）',
    advice: '这是服务端故障，请稍后重试；持续失败时请联系服务提供方或检查内网推理服务状态。' },
  { code: 'A9_ERR_TLS_EXPIRED', test: /CERT_HAS_EXPIRED|certificate has expired|CERT_NOT_YET_VALID|certificate is not yet valid/i,
    title: '服务器证书已过期或尚未生效',
    advice: '先检查本机系统日期、时间和时区是否正确（Windows 7 电脑电池失效后常见）；日期无误则请联系服务管理员更新证书。本产品不允许关闭证书校验。' },
  { code: 'A9_ERR_TLS_UNTRUSTED', test: /DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|self[- ]signed certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|unable to verify the (?:first|leaf) certificate|unable to get local issuer certificate/i,
    title: '无法验证服务器证书（自签名证书或企业根证书未受信任）',
    advice: '请在“企业网络 → CA bundle 路径”中配置企业根 CA（PEM 格式）；如经企业代理，请向 IT 获取代理使用的根证书。本产品不允许关闭证书校验。' },
  { code: 'A9_ERR_TLS_HOSTNAME', test: /ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate|Hostname\/IP does not match/i,
    title: '服务器证书与访问地址不匹配',
    advice: '请使用证书中登记的域名访问（避免直接填 IP 或别名），或联系管理员为该地址签发证书。' },
  { code: 'A9_ERR_DNS', test: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    title: '无法解析模型服务的域名（ENOTFOUND）',
    advice: '请检查 Base URL 拼写、本机网络与 DNS；内网服务请确认已连接公司网络/VPN，必要时改用服务器 IP 或在“企业网络”中配置代理。' },
  { code: 'A9_ERR_REFUSED', test: /ECONNREFUSED|connection refused/i,
    title: '模型服务拒绝了连接（ECONNREFUSED）',
    advice: '请确认服务已启动、端口正确，并检查本机防火墙与代理设置。' },
  { code: 'A9_ERR_IDLE_TIMEOUT', test: /No SSE data received for (\d+)ms/i,
    title: (match) => `模型长时间没有返回数据（空闲超时 ${Math.round(Number(match[1]) / 1000)} 秒）`,
    advice: '模型可能仍在推理（CPU 推理或深度思考较慢）。可在“模型设置 → 高级设置”调大“空闲超时”（60～1800 秒），或降低思考强度、改用更快的模型。' },
  { code: 'A9_ERR_TOTAL_TIMEOUT', test: /Total timeout of (\d+)ms/i,
    title: (match) => `单次请求总耗时超过上限（${Math.round(Number(match[1]) / 1000)} 秒）`,
    advice: '可在“模型设置 → 高级设置”调大“总超时”（60～1800 秒），或缩短输入、降低思考强度后重试。' },
  { code: 'A9_ERR_TIMEOUT', test: /ETIMEDOUT|ESOCKETTIMEDOUT|CONNECTION_TIMEOUT|(?<!status\s+[2-9]\d\d[^\n]*)\btimed out\b/i,
    title: '连接模型服务超时（ETIMEDOUT）',
    advice: '请检查网络连通性、防火墙与代理设置，并确认 Base URL 可从本机访问；网络较慢时可在“高级设置”调大超时。' },
  { code: 'A9_ERR_STREAM_TRUNCATED', test: /(?<!status\s+5\d\d[^\n]*)(?:stream ended without a finish_reason|Gateway stream (?:emitted|returned)|Malformed SSE|socket hang up|ECONNRESET|ECONNABORTED|premature close|aborted|EPIPE)/i,
    title: '模型响应在传输中途被截断或中断',
    advice: '通常是网络波动，或网关/代理提前断开了流式连接。请重试一次；若频繁出现，请检查代理对长连接（SSE）的超时设置，或调大“空闲超时”。' },
];

function describeModelFailure(rawMessage) {
  const text = String(rawMessage == null ? '' : rawMessage);
  for (const rule of MODEL_FAILURE_GUIDANCE) {
    const match = rule.test.exec(text);
    if (!match) continue;
    return {
      code: rule.code,
      title: typeof rule.title === 'function' ? rule.title(match) : rule.title,
      advice: rule.advice,
    };
  }
  return null;
}

/** 界面文案：中文原因与下一步在前；原始英文错误放在“原始错误：”之后，渲染层把它折叠到详情里。 */
const MODEL_FAILURE_DETAIL_MARKER = '\n\n原始错误：';
function presentModelFailureText(rawMessage, guidance = describeModelFailure(rawMessage)) {
  const raw = String(rawMessage == null ? '' : rawMessage);
  if (!guidance) return raw;
  return `${guidance.title}\n下一步：${guidance.advice}${MODEL_FAILURE_DETAIL_MARKER}${raw}`;
}

const MODEL_INVOCATION_FAILED_PREFIX = 'Model invocation failed: ';

module.exports = {
  MODEL_FAILURE_GUIDANCE, MODEL_FAILURE_DETAIL_MARKER, MODEL_INVOCATION_FAILED_PREFIX,
  describeModelFailure, presentModelFailureText,
};
