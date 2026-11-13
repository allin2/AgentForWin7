/**
 * A9-67 F-009/F-026/F-027 on the real GatewayProvider + transport + Node HTTP
 * stack against a local slow/unbounded server. Only F-026 uses an injected
 * network stack, because the default Node stack already caps the body.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import { GatewayProvider, InMemoryCredentialStore, ErrorCode, INetworkStack, NetworkRequestOptions, NetworkResponse } from '../src';

const request = { id: 'req-a9-67', model: 'm', messages: [{ role: 'user', content: 'hi' }] } as any;
const noRetry = { initialDelayMs: 10, maxDelayMs: 10, maxRetries: 0, backoffMultiplier: 1 };

function credentials(): InMemoryCredentialStore {
  const store = new InMemoryCredentialStore();
  store.setApiKey('test-key-not-secret');
  return store;
}

async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => { (server as any).closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function guard<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`GUARD_TIMEOUT_${ms}MS`)), ms); }),
  ]);
}

describe('A9-67 transport and provider boundaries', () => {
  it('F-009: a steady trickle cannot extend totalTimeout; the socket is torn down', async () => {
    let socketClosed = false;
    let interval: NodeJS.Timeout | undefined;
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      interval = setInterval(() => res.write(': keep\n'), 30);
      res.on('close', () => { socketClosed = true; if (interval) clearInterval(interval); });
    });
    try {
      const provider = new GatewayProvider({ gatewayUrl: server.url, credentialStore: credentials(),
        timeoutMs: 300, totalTimeoutMs: 700, retryConfig: noRetry });
      const started = Date.now();
      const error: any = await guard(provider.sendStreamRequest(request, () => undefined), 4000).catch((e) => e);
      const elapsed = Date.now() - started;
      expect(error?.message).not.toMatch(/GUARD_TIMEOUT/);
      expect(error?.code).toBe(ErrorCode.CONNECTION_TIMEOUT);
      expect(elapsed).toBeLessThan(2000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(socketClosed).toBe(true);
    } finally {
      if (interval) clearInterval(interval);
      await server.close();
    }
  });

  it('F-027: an unfinished multibyte SSE frame beyond the parser budget aborts the connection early', async () => {
    let written = 0;
    let socketClosed = false;
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = Buffer.from('data: ' + '汉'.repeat(21_000), 'utf8');
      const pump = () => {
        while (!socketClosed && written < 8 * 1024 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        if (!socketClosed) res.end();
      };
      res.on('close', () => { socketClosed = true; });
      pump();
    });
    try {
      const provider = new GatewayProvider({ gatewayUrl: server.url, credentialStore: credentials(), retryConfig: noRetry });
      const error: any = await guard(provider.sendStreamRequest(request, () => undefined), 10000).catch((e) => e);
      expect(error?.code).toBe(ErrorCode.INVALID_FRAME);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(socketClosed).toBe(true);
      expect(written).toBeLessThan(6 * 1024 * 1024);
    } finally {
      await server.close();
    }
  });

  it('F-026: a provider body beyond the transport budget is rejected and the request is cancelled', async () => {
    let aborted = false;
    let delivered = 0;
    const stack: INetworkStack = {
      name: 'unbounded-test-peripheral',
      async request(_url: string, options: NetworkRequestOptions): Promise<NetworkResponse> {
        const piece = '"'.repeat(1024 * 1024);
        for (let i = 0; i < 16; i += 1) {
          if (options.signal?.aborted) {
            aborted = true;
            throw Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' });
          }
          delivered += piece.length;
          options.onData?.(piece);
          await new Promise((resolve) => setImmediate(resolve));
        }
        return { statusCode: 200, headers: {}, body: '' };
      },
    };
    const provider = new GatewayProvider({ gatewayUrl: 'http://127.0.0.1:9/v1', credentialStore: credentials(),
      networkStack: stack, retryConfig: noRetry });
    const error: any = await provider.sendRequest(request).catch((e) => e);
    expect(String(error?.message)).toContain('A9_RESPONSE_SIZE_LIMIT');
    expect(aborted).toBe(true);
    expect(delivered).toBeLessThanOrEqual(11 * 1024 * 1024);
  });
});
