/**
 * Phase B / B3：Provider 超时范围合同，以及网络错误携带可归类的错误码/状态（供界面层给出中文下一步指引）。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_NO_DATA_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS, ErrorCode, OpenAICompatibleProvider,
  PROVIDER_TIMEOUT_MAX_MS, PROVIDER_TIMEOUT_MIN_MS, isValidProviderTimeoutMs,
} from '../src';

const request = { id: 'b3', messages: [{ role: 'user' as const, content: 'hi' }] };
const noRetry = { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 };

describe('Phase B3: configurable Provider timeouts', () => {
  it('publishes the 60s–1800s range and keeps the historical defaults', () => {
    expect(PROVIDER_TIMEOUT_MIN_MS).toBe(60_000);
    expect(PROVIDER_TIMEOUT_MAX_MS).toBe(1_800_000);
    expect(DEFAULT_TOTAL_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_NO_DATA_TIMEOUT_MS).toBe(120_000);
  });

  it.each([
    [60_000, true], [1_800_000, true], [300_000, true],
    [59_999, false], [1_800_001, false], [0, false], [-1, false], [120_000.5, false],
    [NaN, false], [Infinity, false], ['300000', false], [null, false], [undefined, false],
  ])('validates %p -> %p', (value, expected) => {
    expect(isValidProviderTimeoutMs(value)).toBe(expected);
  });

  describe('slow SSE stream', () => {
    let server: http.Server;
    let baseUrl: string;
    const sockets = new Set<net.Socket>();

    beforeEach(async () => {
      server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          // 模拟 CPU 推理/深度思考：首个数据块 400 ms 后才到达。
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'slow-ok' }, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }, 400);
        });
      });
      server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    });
    afterEach(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('is cut off by a short idle timeout but completes when the idle timeout is raised', async () => {
      const short = new OpenAICompatibleProvider({ baseUrl, model: 'm', noDataTimeoutMs: 150, retryConfig: noRetry });
      await expect(short.sendStreamRequest(request, () => undefined)).rejects.toMatchObject({
        code: ErrorCode.CONNECTION_TIMEOUT, message: expect.stringContaining('No SSE data received for 150ms'),
      });
      const raised = new OpenAICompatibleProvider({ baseUrl, model: 'm', noDataTimeoutMs: 3_000, totalTimeoutMs: 10_000, retryConfig: noRetry });
      const response = await raised.sendStreamRequest(request, () => undefined);
      expect(response.content).toBe('slow-ok');
    });

    it('is cut off by a short total timeout', async () => {
      const short = new OpenAICompatibleProvider({ baseUrl, model: 'm', totalTimeoutMs: 150, noDataTimeoutMs: 5_000, retryConfig: noRetry });
      await expect(short.sendStreamRequest(request, () => undefined)).rejects.toMatchObject({
        code: ErrorCode.CONNECTION_TIMEOUT, message: expect.stringContaining('Total timeout of 150ms'),
      });
    });
  });

  describe('classifiable network errors', () => {
    it('keeps the proxy CONNECT status in the message so 407 can be recognized', async () => {
      const proxy = http.createServer();
      proxy.on('connect', (_req, socket: net.Socket) => {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\n\r\n');
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      try {
        const provider = new OpenAICompatibleProvider({
          baseUrl: 'https://model.invalid/v1', model: 'm', retryConfig: noRetry,
          proxyConfig: { host: '127.0.0.1', port: (proxy.address() as net.AddressInfo).port },
        });
        await expect(provider.sendStreamRequest(request, () => undefined)).rejects.toMatchObject({
          message: expect.stringMatching(/Proxy CONNECT failed with status 407/),
        });
      } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    });

    it('appends the TLS error code when the library message omits it (self-signed certificate)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-b-tls-'));
      const keyPath = path.join(dir, 'key.pem');
      const certPath = path.join(dir, 'cert.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', keyPath,
        '-out', certPath, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' });
      const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (_req, res) => res.end());
      server.on('tlsClientError', () => undefined);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const provider = new OpenAICompatibleProvider({
          baseUrl: `https://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`, model: 'm', retryConfig: noRetry,
        });
        await expect(provider.sendStreamRequest(request, () => undefined)).rejects.toMatchObject({
          message: expect.stringMatching(/DEPTH_ZERO_SELF_SIGNED_CERT/),
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
