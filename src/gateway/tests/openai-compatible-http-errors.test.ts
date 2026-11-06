import * as http from 'http';
import { AddressInfo, Socket } from 'net';
import { ErrorCode, FinishReason, GatewayError, OpenAICompatibleProvider, OpenAIProviderConfig } from '../src';

const LIMIT = 64 * 1024;
const API_KEY = 'fixture-key-for-redaction';
const request = { id: 'http-error', messages: [{ role: 'user' as const, content: 'test' }] };
type HttpFailure = GatewayError & { statusCode: number };

async function failure(pending: Promise<unknown>): Promise<HttpFailure> {
  try { await pending; }
  catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as HttpFailure;
  }
  throw new Error('Expected the provider to reject');
}

async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('HTTP request/socket did not settle promptly')), 1000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe('A9-49 bounded HTTP error receipt (loopback only)', () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: (res: http.ServerResponse, attempt: number) => void;
  let hits: number;
  let sockets: Set<Socket>;
  let closures: Promise<void>[];
  let timers: Set<NodeJS.Timeout>;
  let controllers: AbortController[];

  beforeEach(async () => {
    hits = 0;
    sockets = new Set();
    closures = [];
    timers = new Set();
    controllers = [];
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => handler(res, ++hits));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      closures.push(new Promise<void>((resolve) => socket.once('close', () => { sockets.delete(socket); resolve(); })));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    for (const socket of sockets) socket.destroy();
    jest.restoreAllMocks();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  function later(callback: () => void, delay = 15) {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  }

  function send(config: Partial<OpenAIProviderConfig> = {}) {
    const controller = new AbortController();
    controllers.push(controller);
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const onChunk = jest.fn();
    const provider = new OpenAICompatibleProvider({ baseUrl, model: 'fixture', apiKey: API_KEY,
      noDataTimeoutMs: 2000, totalTimeoutMs: 4000,
      retryConfig: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 }, ...config });
    const pending = provider.sendStreamRequest(request, onChunk, { signal: controller.signal });
    return { pending, controller, remove, onChunk };
  }

  async function cleaned(call: ReturnType<typeof send>) {
    await within(Promise.all(closures));
    expect(sockets.size).toBe(0);
    expect(call.remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(call.onChunk).not.toHaveBeenCalled();
  }

  it.each([400, 401, 403, 422, 429, 503])('preserves normal HTTP %i classification, redaction and retry policy', async (status) => {
    handler = (res) => { res.writeHead(status); res.end(`upstream says ${API_KEY}`); };
    const call = send({ retryConfig: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 } });
    const error = await within(failure(call.pending));
    expect(error.statusCode).toBe(status);
    expect(error.code).toBe(status === 401 || status === 403 ? ErrorCode.AUTH_INVALID_CREDENTIALS : ErrorCode.INVALID_FRAME);
    expect(error.message).toBe(`Server returned status ${status}: upstream says ***redacted-api-key***`);
    expect(hits).toBe(status === 429 || status === 503 ? 2 : 1);
    await cleaned(call);
  });

  it.each([LIMIT - 1, LIMIT, LIMIT + 1])('uses received bytes, not characters or chunk framing, at %i bytes', async (bytes) => {
    // 21845 three-byte characters = 65535 bytes; cross the budget with ASCII.
    const body = Buffer.from('中'.repeat(21845) + 'x'.repeat(bytes - (LIMIT - 1)), 'utf8');
    expect(body.length).toBe(bytes);
    handler = (res) => {
      res.writeHead(400);
      res.write(body.subarray(0, LIMIT - 2));
      later(() => res.end(body.subarray(LIMIT - 2)));
    };
    const call = send();
    const error = await within(failure(call.pending));
    expect(error.statusCode).toBe(400);
    const diagnostic = error.message.split(': ').slice(1).join(': ');
    expect(diagnostic).toHaveLength(500);
    expect(diagnostic.includes('[truncated: 64 KiB limit]')).toBe(bytes > LIMIT);
    expect(diagnostic).not.toContain('\ufffd');
    await cleaned(call);
  });

  it('bounds an oversized Content-Length response as well as chunked responses', async () => {
    handler = (res) => {
      res.writeHead(401, { 'Content-Length': LIMIT * 4 });
      res.end(Buffer.alloc(LIMIT * 4, 'x'));
    };
    const call = send();
    const error = await within(failure(call.pending));
    expect(error).toMatchObject({ statusCode: 401, code: ErrorCode.AUTH_INVALID_CREDENTIALS });
    expect(error.message).toMatch(/\[truncated: 64 KiB limit\]$/);
    await cleaned(call);
  });

  it('decodes split Unicode and a split secret once, then redacts before the 500-character bound', async () => {
    const text = `中🙂é ${'x'.repeat(480)}${API_KEY} trailing`;
    const bytes = Buffer.from(text, 'utf8');
    // Deliver the initial multibyte characters one byte at a time, and split the key.
    const fragments = [...bytes.subarray(0, 9)].map((byte) => Buffer.from([byte]));
    fragments.push(bytes.subarray(9, 500), bytes.subarray(500));
    handler = (res) => {
      res.writeHead(401);
      let index = 0;
      const next = () => {
        if (index === fragments.length) { res.end(); return; }
        res.write(fragments[index++]);
        later(next);
      };
      next();
    };
    const call = send();
    const error = await within(failure(call.pending));
    expect(error.message).toBe(`Server returned status 401: ${text.replace(API_KEY, '***redacted-api-key***').slice(0, 500)}`);
    expect(error.message).not.toContain('\ufffd');
    expect(error.message).not.toContain(API_KEY.slice(0, 10));
    await cleaned(call);
  });

  it.each([400, 401, 403, 429, 503])('stops an oversized incomplete HTTP %i promptly without losing status or retry policy', async (status) => {
    handler = (res) => {
      res.writeHead(status);
      res.write(`${API_KEY} ${'x'.repeat(32768)}`);
      later(() => res.write(Buffer.from('🙂'.repeat(8192), 'utf8')));
      // No end: the client must close immediately on exceeding the byte limit.
    };
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const call = send({ retryConfig: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 } });
    const error = await within(failure(call.pending));
    expect(error.statusCode).toBe(status);
    expect(error.code).toBe(status === 401 || status === 403 ? ErrorCode.AUTH_INVALID_CREDENTIALS : ErrorCode.INVALID_FRAME);
    expect(error.message).toContain('***redacted-api-key***');
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toMatch(/\[truncated: 64 KiB limit\]$/);
    expect(error.message.length).toBe(`Server returned status ${status}: `.length + 500);
    expect(hits).toBe(status === 429 || status === 503 ? 2 : 1);
    await cleaned(call);
    // Provider's long timers (including rearmed no-data timers) must all be cleared.
    const providerTimers = timeoutSpy.mock.calls.map((args, index) =>
      Number(args[1]) > 1000 ? timeoutSpy.mock.results[index].value : undefined).filter(Boolean);
    expect(providerTimers.length).toBeGreaterThanOrEqual(2);
    for (const timer of providerTimers) expect(clearSpy).toHaveBeenCalledWith(timer);
    call.controller.abort(); // A late cancellation must not replace the HTTP result.
    expect(await failure(call.pending)).toBe(error);
  });

  it('cancels an incomplete HTTP error at exactly the byte budget and releases the connection and abort listener', async () => {
    let abort: () => void;
    handler = (res) => { res.writeHead(401); res.write(Buffer.alloc(LIMIT, 'x')); later(() => abort()); };
    const call = send();
    abort = () => call.controller.abort();
    expect((await within(failure(call.pending))).code).toBe(ErrorCode.REQUEST_CANCELLED);
    expect(hits).toBe(1);
    await cleaned(call);
  });

  it.each(['idle', 'total'])('enforces %s timeout on an incomplete HTTP error', async (kind) => {
    handler = (res) => {
      res.writeHead(400);
      res.write('partial');
      if (kind === 'total') {
        const timer = setInterval(() => res.write('.'), 10);
        timers.add(timer);
      }
    };
    const call = send({ noDataTimeoutMs: 60, totalTimeoutMs: kind === 'total' ? 180 : 4000 });
    const error = await within(failure(call.pending));
    expect(error.code).toBe(ErrorCode.CONNECTION_TIMEOUT);
    expect(error.message).toMatch(kind === 'total' ? /Total timeout/ : /No SSE data/);
    expect(hits).toBe(1);
    await cleaned(call);
  });

  it.each([401, 403, 503])('handles a real interrupted HTTP %i response without hanging or masking classification', async (status) => {
    handler = (res) => { res.writeHead(status); res.write(`partial ${API_KEY}`); later(() => res.destroy()); };
    const call = send({ retryConfig: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 } });
    const error = await within(failure(call.pending));
    expect(error.statusCode).toBe(status);
    expect(error.code).toBe(status === 503 ? ErrorCode.INVALID_FRAME : ErrorCode.AUTH_INVALID_CREDENTIALS);
    expect(error.message).toContain('partial ***redacted-api-key*** [response interrupted]');
    expect(error.message).not.toContain(API_KEY);
    expect(hits).toBe(status === 503 ? 2 : 1);
    await cleaned(call);
  });

  it('can retry an oversized 503 into the unchanged successful SSE path', async () => {
    handler = (res, attempt) => {
      if (attempt === 1) { res.writeHead(503); res.write('x'.repeat(LIMIT + 1)); return; }
      // The successful SSE path retains its existing keep-alive policy; this fixture
      // closes the success connection so the assertion only tests error cleanup.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      res.end('data: {"choices":[{"delta":{"content":"recovered 中"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    };
    const call = send({ retryConfig: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 } });
    expect(await within(call.pending)).toMatchObject({ content: 'recovered 中', finishReason: FinishReason.STOP });
    expect(hits).toBe(2);
    expect(call.remove).toHaveBeenCalledTimes(2);
    await within(Promise.all(closures));
    expect(sockets.size).toBe(0);
  });
});
