/**
 * 供 Provider 共用的网络安全策略（ADR-0340）。
 *
 * OpenAICompatibleProvider 与 DeepSeekOpenAIProvider 过去各自合并、校验 TLS 配置：
 * 前者把缺省字段补齐并检查 CA 文件，后者直接校验调用方传入的整份配置，部分字段缺失时行为不一致。
 * 两者现在都经由本函数得到同一份生效的 TLS 配置：证书校验恒为开启，最低版本不低于 TLS 1.2，
 * 自定义 CA 文件必须存在。本模块不提供任何关闭校验或降低版本的入口。
 */
import * as fs from 'fs';
import { ErrorCode, GatewayError } from '../types';
import { defaultTLSConfig, TLSConfig, validateTLSConfig } from '../security';

export function resolveProviderTlsConfig(partial?: Partial<TLSConfig>): TLSConfig {
  const tlsConfig = validateTLSConfig({ ...defaultTLSConfig(), ...(partial ?? {}) });
  if (tlsConfig.caBundle) {
    try {
      const stat = fs.statSync(tlsConfig.caBundle);
      if (!stat.isFile()) {
        throw new Error('Not a file');
      }
      fs.accessSync(tlsConfig.caBundle, fs.constants.R_OK);
    } catch {
      throw new GatewayError(
        ErrorCode.TLS_VERIFY_FAILED,
        `CA bundle does not exist or is not readable: ${tlsConfig.caBundle}`,
      );
    }
  }
  return tlsConfig;
}
