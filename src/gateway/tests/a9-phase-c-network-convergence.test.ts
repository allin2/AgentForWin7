/**
 * Phase C / C4（ADR-0340）：DeepSeekOpenAIProvider 与 OpenAICompatibleProvider 共用同一份
 * TLS 策略与超时默认值；DeepSeek 经代理隧道时仍强制 TLS 证书校验。
 */
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { DEEPSEEK_BASE_URL, DeepSeekOpenAIProvider } from '../src/provider/deepseek-openai';
import {
  DEFAULT_NO_DATA_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  OpenAICompatibleProvider,
} from '../src/provider/openai-compatible';
import { resolveProviderTlsConfig } from '../src/provider/network-policy';
import { ErrorCode, GatewayError } from '../src/types';
import { InMemoryCredentialStore, TLSVersion } from '../src/security';
import { INetworkStack, NetworkRequestOptions, NetworkResponse } from '../src/transport';

const NO_RETRY = { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 };

function deepSeekRequest() {
  return { id: 'c4-1', model: 'deepseek-v4-flash' as const, messages: [{ role: 'user' as const, content: 'hi' }] };
}

function sseBody(): string {
  return [
    `data: ${JSON.stringify({ id: 'r1', choices: [{ index: 0, delta: { content: 'tunnel-ok' }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function keyedStore(): InMemoryCredentialStore {
  const store = new InMemoryCredentialStore();
  store.setApiKey('c4-test-secret');
  return store;
}

describe('C4 共享 TLS 策略', () => {
  it('缺省字段补齐为 TLS 1.2 且证书校验开启', () => {
    expect(resolveProviderTlsConfig()).toEqual({ verifyCertificate: true, minTLSVersion: TLSVersion.TLS_1_2 });
    expect(resolveProviderTlsConfig({ minTLSVersion: TLSVersion.TLS_1_3 }).minTLSVersion).toBe(TLSVersion.TLS_1_3);
  });

  it('两个 Provider 对关闭校验、低于 TLS 1.2 和缺失 CA 文件给出相同的拒绝', () => {
    const missingCa = path.join(os.tmpdir(), 'c4-missing-ca.pem');
    const cases: Array<Record<string, unknown>> = [
      { verifyCertificate: false },
      { minTLSVersion: 'TLSv1.1' },
      { caBundle: missingCa },
    ];
    for (const tlsConfig of cases) {
      const build = (kind: 'deepseek' | 'compatible') => () => (kind === 'deepseek'
        ? new DeepSeekOpenAIProvider({ baseUrl: DEEPSEEK_BASE_URL, model: 'deepseek-v4-flash', tlsConfig: tlsConfig as never })
        : new OpenAICompatibleProvider({ baseUrl: 'https://example.invalid', model: 'm', tlsConfig: tlsConfig as never }));
      for (const kind of ['deepseek', 'compatible'] as const) {
        try {
          build(kind)();
          throw new Error(`${kind} accepted ${JSON.stringify(tlsConfig)}`);
        } catch (error) {
          expect(error).toBeInstanceOf(GatewayError);
          expect((error as GatewayError).code).toBe(ErrorCode.TLS_VERIFY_FAILED);
        }
      }
    }
  });

  it('DeepSeek 接受只写部分字段的 TLS 配置（与 OpenAI-compatible 一致补齐）', () => {
    expect(() => new DeepSeekOpenAIProvider({
      baseUrl: DEEPSEEK_BASE_URL,
      model: 'deepseek-v4-flash',
      tlsConfig: { minTLSVersion: TLSVersion.TLS_1_3 } as never,
    })).not.toThrow();
  });
});

describe('C4 共享超时默认值', () => {
  class RecordingStack implements INetworkStack {
    readonly name = 'recording';
    options: NetworkRequestOptions | undefined;
    async request(_url: string, options: NetworkRequestOptions): Promise<NetworkResponse> {
      this.options = options;
      return { statusCode: 200, headers: {}, body: sseBody() };
    }
  }

  it('DeepSeek 默认空闲/总超时与 OpenAI-compatible 的共享常量一致', async () => {
    const stack = new RecordingStack();
    const provider = new DeepSeekOpenAIProvider({
      baseUrl: DEEPSEEK_BASE_URL, model: 'deepseek-v4-flash', credentialStore: keyedStore(), networkStack: stack, retryConfig: NO_RETRY,
    });
    await provider.sendStreamRequest(deepSeekRequest(), () => undefined);
    expect(stack.options?.timeoutMs).toBe(DEFAULT_NO_DATA_TIMEOUT_MS);
    expect((provider as any).connection?._config?.totalTimeoutMs).toBe(DEFAULT_TOTAL_TIMEOUT_MS);
    expect(DEFAULT_TOTAL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_NO_DATA_TIMEOUT_MS);
  });

  it('显式 timeoutMs / totalTimeoutMs 仍然生效', async () => {
    const stack = new RecordingStack();
    const provider = new DeepSeekOpenAIProvider({
      baseUrl: DEEPSEEK_BASE_URL, model: 'deepseek-v4-flash', credentialStore: keyedStore(), networkStack: stack,
      retryConfig: NO_RETRY, timeoutMs: 7_000, totalTimeoutMs: 20_000,
    });
    await provider.sendStreamRequest(deepSeekRequest(), () => undefined);
    expect(stack.options?.timeoutMs).toBe(7_000);
    expect((provider as any).connection?._config?.totalTimeoutMs).toBe(20_000);
  });
});

describe('C4 DeepSeek 经代理隧道的 TLS 校验', () => {
  let dir: string;
  let certPath: string;
  let keyPem: string;
  let certPem: string;
  let backend: https.Server;
  let backendPort = 0;
  let proxy: http.Server;
  let proxyPort = 0;
  let connectTargets: string[] = [];
  let requestBodies = 0;
  const sockets = new Set<net.Socket>();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-c-tls-'));
    const keyPath = path.join(dir, 'key.pem');
    certPath = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', keyPath, '-out', certPath, '-subj', '/CN=api.deepseek.com',
      '-addext', 'subjectAltName=DNS:api.deepseek.com',
    ], { stdio: 'pipe' });
    keyPem = fs.readFileSync(keyPath, 'utf8');
    certPem = fs.readFileSync(certPath, 'utf8');

    backend = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
      requestBodies += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sseBody());
      });
    });
    backend.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    backendPort = (backend.address() as net.AddressInfo).port;

    // 代理忽略 CONNECT 目标，统一转到本地后端，使固定的 api.deepseek.com:443 可在本机验证。
    proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    proxy.on('connect', (req, client: net.Socket, head) => {
      connectTargets.push(String(req.url));
      const upstream = net.connect(backendPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(client); sockets.add(upstream);
      const drop = (): void => { client.destroy(); upstream.destroy(); };
      upstream.on('error', drop);
      client.on('error', drop);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyPort = (proxy.address() as net.AddressInfo).port;
  });

  beforeEach(() => { connectTargets = []; requestBodies = 0; });

  afterAll(async () => {
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((done) => proxy.close(() => done()));
    await new Promise<void>((done) => backend.close(() => done()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function provider(withCa: boolean): DeepSeekOpenAIProvider {
    return new DeepSeekOpenAIProvider({
      baseUrl: DEEPSEEK_BASE_URL,
      model: 'deepseek-v4-flash',
      credentialStore: keyedStore(),
      retryConfig: NO_RETRY,
      proxyConfig: { host: '127.0.0.1', port: proxyPort },
      ...(withCa ? { tlsConfig: { verifyCertificate: true, minTLSVersion: TLSVersion.TLS_1_2, caBundle: certPath } } : {}),
    });
  }

  it('证书被 CA 信任且主机名匹配时，经 CONNECT 隧道完成请求', async () => {
    const result = await provider(true).sendStreamRequest(deepSeekRequest(), () => undefined);
    expect(result.content).toBe('tunnel-ok');
    expect(connectTargets).toEqual(['api.deepseek.com:443']);
    expect(requestBodies).toBe(1);
  });

  it('证书不被信任时以 TLS_VERIFY_FAILED 失败，且请求体不会送达后端', async () => {
    await expect(provider(false).sendStreamRequest(deepSeekRequest(), () => undefined))
      .rejects.toMatchObject({ code: ErrorCode.TLS_VERIFY_FAILED });
    expect(requestBodies).toBe(0);
  });

  it('NODE_TLS_REJECT_UNAUTHORIZED=0 不能关闭隧道内的证书校验', async () => {
    const distEntry = path.resolve(__dirname, '..', 'dist', 'index.js');
    if (!fs.existsSync(distEntry)) {
      throw new Error(`dist entry not found: ${distEntry}. Run build first.`);
    }
    const script = `
const { DeepSeekOpenAIProvider, InMemoryCredentialStore } = require(process.argv[1]);
const store = new InMemoryCredentialStore();
store.setApiKey('c4-test-secret');
const provider = new DeepSeekOpenAIProvider({
  baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', credentialStore: store,
  retryConfig: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 },
  proxyConfig: { host: '127.0.0.1', port: Number(process.argv[2]) },
});
provider.sendStreamRequest({ id: 'c4-env', model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }] }, () => {})
  .then(() => process.stdout.write(JSON.stringify({ ok: true })),
        (e) => process.stdout.write(JSON.stringify({ ok: false, code: e && e.code })));
`;
    const outcome = await new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        ['-e', script, '--', distEntry, String(proxyPort)],
        { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, timeout: 30_000 },
        (error, stdout, stderr) => {
          if (error) { reject(new Error(`child failed: ${error.message}\n${stderr}`)); return; }
          resolve(JSON.parse(stdout));
        },
      );
    });
    expect(outcome).toEqual({ ok: false, code: ErrorCode.TLS_VERIFY_FAILED });
    expect(requestBodies).toBe(0);
  });
});
