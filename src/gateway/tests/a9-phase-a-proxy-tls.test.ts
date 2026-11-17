/**
 * Phase A1（H-P1-02）：HTTPS 代理 CONNECT 隧道必须显式校验证书，
 * NODE_TLS_REJECT_UNAUTHORIZED=0 不得静默关闭校验，并留下安全诊断。
 */
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';

/**
 * Jest 沙箱的 process.env 是副本，Node 内部的 TLS 层读不到其中的修改。
 * 因此在子进程中用真实环境变量运行已编译的 Provider，父进程只托管代理与后端。
 */
const CHILD_SCRIPT = `
const { OpenAICompatibleProvider } = require(process.argv[1]);
const [, , backendPort, proxyPort, caBundle, proxyProtocol] = process.argv;
const warnings = [];
process.on('warning', (w) => warnings.push({ code: w.code, message: w.message }));
(async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://127.0.0.1:' + backendPort,
    model: 'm',
    retryConfig: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 },
    proxyConfig: { host: '127.0.0.1', port: Number(proxyPort), ...(proxyProtocol ? { protocol: proxyProtocol } : {}) },
    ...(caBundle ? { tlsConfig: { minTLSVersion: 'TLSv1.2', caBundle } } : {}),
  });
  let outcome;
  try {
    const r = await provider.sendStreamRequest({ id: 'r', model: 'm', messages: [{ role: 'user', content: 'x' }] }, () => {});
    outcome = { ok: true, content: r.content };
  } catch (e) {
    outcome = { ok: false, message: String(e && e.message) };
  }
  await new Promise((r) => setImmediate(r));
  process.stdout.write(JSON.stringify({ outcome, warnings }));
})();
`;

interface ChildResult {
  outcome: { ok: boolean; content?: string; message?: string };
  warnings: Array<{ code?: string; message: string }>;
}

function runProviderInChild(backendPort: number, proxyPort: number, env: NodeJS.ProcessEnv, caBundle?: string, proxyProtocol?: string): Promise<ChildResult> {
  const distEntry = path.resolve(__dirname, '..', 'dist', 'index.js');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', CHILD_SCRIPT, '--', distEntry, String(backendPort), String(proxyPort), ...(caBundle ? [caBundle] : ['']), ...(proxyProtocol ? [proxyProtocol] : [])],
      { env, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) { reject(new Error(`child failed: ${error.message}\n${stderr}`)); return; }
        resolve(JSON.parse(stdout) as ChildResult);
      },
    );
  });
}

interface TlsFixture { dir: string; key: string; cert: string; certPath: string }

function createSelfSignedFixture(): TlsFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-a-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'pipe' });
  return { dir, key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8'), certPath };
}

async function startTlsBackend(fx: TlsFixture): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = https.createServer({ key: fx.key, cert: fx.cert }, (req, res) => {
    hits += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tunnel-ok' }, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  // 握手失败的客户端会触发 tlsClientError，不应使测试进程抛出。
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    hits: () => hits,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function startConnectProxy(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket: net.Socket, head) => {
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(clientSocket); sockets.add(upstream);
    const drop = (): void => { clientSocket.destroy(); upstream.destroy(); };
    upstream.on('error', drop);
    clientSocket.on('error', drop);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((done) => {
      sockets.forEach((s) => s.destroy());
      server.close(() => done());
    }),
  };
}

async function startHttpsConnectProxy(fx: TlsFixture): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = https.createServer({ key: fx.key, cert: fx.cert }, (_req, res) => { res.writeHead(405); res.end(); });
  server.on('tlsClientError', () => undefined);
  server.on('connect', (req, clientSocket: net.Socket, head) => {
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(clientSocket); sockets.add(upstream);
    const drop = (): void => { clientSocket.destroy(); upstream.destroy(); };
    upstream.on('error', drop);
    clientSocket.on('error', drop);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((done) => {
      sockets.forEach((s) => s.destroy());
      server.close(() => done());
    }),
  };
}

describe('Phase A1: proxy CONNECT tunnel TLS verification', () => {
  let fx: TlsFixture;

  beforeAll(() => { fx = createSelfSignedFixture(); });
  afterAll(() => { fs.rmSync(fx.dir, { recursive: true, force: true }); });

  const baseEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    return env;
  };

  it('rejects a self-signed certificate behind the proxy even when NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
    const backend = await startTlsBackend(fx);
    const proxy = await startConnectProxy();
    try {
      const result = await runProviderInChild(backend.port, proxy.port, { ...baseEnv(), NODE_TLS_REJECT_UNAUTHORIZED: '0' });
      expect(result.outcome.ok).toBe(false);
      expect(result.outcome.message).toMatch(/self[- ]signed|certificate/i);
      expect(backend.hits()).toBe(0);
      const securityWarnings = result.warnings.filter((w) => w.code === 'A9_TLS_ENV_VERIFICATION_DISABLED');
      expect(securityWarnings).toHaveLength(1);
      expect(securityWarnings[0].message).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0');
    } finally {
      await proxy.close();
      await backend.close();
    }
  });

  it('succeeds through the same proxy when the CA bundle trusts the server certificate, without a security warning', async () => {
    const backend = await startTlsBackend(fx);
    const proxy = await startConnectProxy();
    try {
      const result = await runProviderInChild(backend.port, proxy.port, baseEnv(), fx.certPath);
      expect(result.outcome).toEqual({ ok: true, content: 'tunnel-ok' });
      expect(backend.hits()).toBe(1);
      expect(result.warnings.filter((w) => w.code === 'A9_TLS_ENV_VERIFICATION_DISABLED')).toHaveLength(0);
    } finally {
      await proxy.close();
      await backend.close();
    }
  });

  it('rejects an untrusted HTTPS proxy itself even when NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
    const backend = await startTlsBackend(fx);
    const proxy = await startHttpsConnectProxy(fx);
    try {
      const result = await runProviderInChild(backend.port, proxy.port, { ...baseEnv(), NODE_TLS_REJECT_UNAUTHORIZED: '0' }, undefined, 'https');
      expect(result.outcome.ok).toBe(false);
      expect(result.outcome.message).toMatch(/self[- ]signed|certificate/i);
      expect(backend.hits()).toBe(0);
      const securityWarnings = result.warnings.filter((w) => w.code === 'A9_TLS_ENV_VERIFICATION_DISABLED');
      expect(securityWarnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      await proxy.close();
      await backend.close();
    }
  });
});
