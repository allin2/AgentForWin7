/// <reference path="./better-sqlite3.d.ts" />
/**
 * Phase B / B3 + B8（shell）：
 * - 常见网络/模型错误的中文“原因 + 下一步”映射（含原始错误折叠标记）；
 * - Provider 上下文窗口与总/空闲超时设置的校验、持久化、恢复；
 * - 失败 Turn 的最终消息/事件携带指引；
 * - lint 动态枚举全部 product JS；
 * - 非致命失败进入持久化诊断而不是被吞掉。
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import Database from 'better-sqlite3';

const { createA9AgentRuntime, describeModelFailure, presentModelFailureText } = require('../../product/a9-agent-runtime') as any;
const { listProductJsFiles, checkFiles } = require('../../scripts/check-product-js') as any;

describe('B3 model failure guidance', () => {
  it.each([
    ['401', 'Server returned status 401: {"error":{"message":"Incorrect API key provided"}}', 'A9_ERR_AUTH', 'API Key', '重新输入'],
    ['407', 'Network request failed: Proxy CONNECT failed with status 407', 'A9_ERR_PROXY_AUTH', '代理', '企业网络'],
    ['ENOTFOUND', 'Network request failed: getaddrinfo ENOTFOUND api.example.internal', 'A9_ERR_DNS', '域名', 'Base URL'],
    ['expired certificate', 'Network request failed: certificate has expired (CERT_HAS_EXPIRED)', 'A9_ERR_TLS_EXPIRED', '过期', '系统日期'],
    ['self-signed', 'Network request failed: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)', 'A9_ERR_TLS_UNTRUSTED', '自签名', 'CA bundle'],
    ['untrusted chain', 'Network request failed: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)', 'A9_ERR_TLS_UNTRUSTED', '证书', '根 CA'],
    ['hostname mismatch', "Network request failed: Hostname/IP does not match certificate's altnames (ERR_TLS_CERT_ALTNAME_INVALID)", 'A9_ERR_TLS_HOSTNAME', '不匹配', '域名'],
    ['ETIMEDOUT', 'Network request failed: connect ETIMEDOUT 10.1.2.3:443', 'A9_ERR_TIMEOUT', '超时', '网络连通性'],
    ['idle timeout', 'No SSE data received for 120000ms; request cancelled', 'A9_ERR_IDLE_TIMEOUT', '空闲超时 120 秒', '调大'],
    ['total timeout', 'Total timeout of 300000ms exhausted; request cancelled', 'A9_ERR_TOTAL_TIMEOUT', '300 秒', '总超时'],
    ['stream truncated', 'Gateway stream ended without a finish_reason', 'A9_ERR_STREAM_TRUNCATED', '截断', 'SSE'],
    ['socket reset', 'Network request failed: socket hang up (ECONNRESET)', 'A9_ERR_STREAM_TRUNCATED', '中断', '重试'],
    ['connection refused', 'Network request failed: connect ECONNREFUSED 127.0.0.1:8000', 'A9_ERR_REFUSED', '拒绝', '端口'],
    ['429', 'Server returned status 429: rate limit reached', 'A9_ERR_RATE_LIMIT', '频繁', '额度'],
    ['5xx', 'Server returned status 503: upstream unavailable', 'A9_ERR_SERVER', '不可用', '稍后'],
  ])('maps %s to a Chinese reason and next step', (_label, raw, code, reasonText, adviceText) => {
    const guidance = describeModelFailure(raw);
    expect(guidance.code).toBe(code);
    expect(guidance.title).toContain(reasonText);
    expect(guidance.advice).toContain(adviceText);
    expect(`${guidance.title}${guidance.advice}`).toMatch(/[一-鿿]/);
  });

  it('keeps the original English error after a fold marker and never invents guidance for unknown errors', () => {
    const raw = 'Network request failed: getaddrinfo ENOTFOUND api.example.internal';
    const text = presentModelFailureText(raw);
    const [head, detail] = text.split('\n\n原始错误：');
    expect(head).toContain('下一步：');
    expect(detail).toBe(raw);
    expect(describeModelFailure('something unexpected happened')).toBeNull();
    expect(presentModelFailureText('something unexpected happened')).toBe('something unexpected happened');
    expect(describeModelFailure(undefined)).toBeNull();
  });

  it('prefers the specific TLS/status classification over the generic timeout or truncation wording', () => {
    expect(describeModelFailure('Network request failed: certificate has expired (CERT_HAS_EXPIRED) after timed out retry').code)
      .toBe('A9_ERR_TLS_EXPIRED');
    expect(describeModelFailure('Server returned status 401: connection aborted').code).toBe('A9_ERR_AUTH');
  });
});

describe('B8 shell lint coverage', () => {
  it('enumerates every product JS file, including those missing from the old hand-written list', () => {
    const onDisk: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.name.endsWith('.js')) onDisk.push(path.relative(path.join(__dirname, '../..'), target).split(path.sep).join('/'));
      }
    };
    walk(path.join(__dirname, '../../product'));
    expect(listProductJsFiles()).toEqual(onDisk.sort());
    for (const file of ['product/a9-workspace-registry.js', 'product/a9-history.js', 'product/security-policy.js',
      'product/renderer/conversation-projector.js', 'product/rc-composition.js']) {
      expect(listProductJsFiles()).toContain(file);
    }
  });

  it('package.json lint delegates to the enumerating script instead of a hand-written file list', () => {
    const lint = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).scripts.lint as string;
    expect(lint).toBe('tsc --noEmit && node scripts/check-product-js.js');
  });

  it('reports a syntax error in a product file instead of passing silently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8-lint-'));
    try {
      fs.mkdirSync(path.join(dir, 'product'));
      fs.writeFileSync(path.join(dir, 'product', 'ok.js'), "'use strict';\nmodule.exports = 1;\n", 'utf8');
      fs.writeFileSync(path.join(dir, 'product', 'bad.js'), 'function (\n', 'utf8');
      const files = listProductJsFiles(path.join(dir, 'product'));
      expect(files).toEqual(['product/bad.js', 'product/ok.js']);
      const failures = checkFiles(files, dir);
      expect(failures.map((failure: any) => failure.file)).toEqual(['product/bad.js']);
      expect(failures[0].detail.length).toBeGreaterThan(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('B2/B3 Provider settings and failure presentation', () => {
  let root: string;
  let workspaceRoot: string;
  let dataRoot: string;
  let server: http.Server;
  let baseUrl: string;
  let warnSpy: jest.SpyInstance;
  const runtimes: any[] = [];
  const openDatabase = (databasePath: string, options?: { readonly?: boolean }) =>
    new Database(databasePath, options?.readonly ? { readonly: true } : {});
  const makeRuntime = (extra: Record<string, unknown> = {}) => {
    const runtime = createA9AgentRuntime({ workspaceRoot, dataRoot, openDatabase, ...extra });
    runtimes.push(runtime);
    return runtime;
  };
  const configPath = () => path.join(dataRoot, 'a9-provider-config.v1.json');

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-b-shell-'));
    workspaceRoot = path.join(root, 'ws');
    dataRoot = path.join(root, 'data');
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(dataRoot);
    warnSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"Incorrect API key provided"}}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  });
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.shutdown();
    warnSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists, restores, snapshots and resets the optional window and timeout settings', async () => {
    const runtime = makeRuntime();
    await runtime.configureProvider({ baseUrl, model: 'm', skipProbe: true,
      contextWindowTokens: 64_000, requestTimeoutMs: 900_000, idleTimeoutMs: 600_000 });
    expect(runtime.getSnapshot().provider).toMatchObject({ contextWindowTokens: 64_000, requestTimeoutMs: 900_000, idleTimeoutMs: 600_000 });
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8'))).toMatchObject({
      contextWindowTokens: 64_000, requestTimeoutMs: 900_000, idleTimeoutMs: 600_000 });
    runtime.shutdown();

    const restored = makeRuntime();
    expect(restored.getSnapshot().provider).toMatchObject({ contextWindowTokens: 64_000, requestTimeoutMs: 900_000, idleTimeoutMs: 600_000 });
    // 省略 = 保留；null = 恢复默认。
    await restored.configureProvider({ baseUrl, model: 'm', skipProbe: true });
    expect(restored.getSnapshot().provider.idleTimeoutMs).toBe(600_000);
    await restored.configureProvider({ baseUrl, model: 'm', skipProbe: true, idleTimeoutMs: null, requestTimeoutMs: null, contextWindowTokens: null });
    const provider = restored.getSnapshot().provider;
    expect(provider.idleTimeoutMs).toBeUndefined();
    expect(provider.requestTimeoutMs).toBeUndefined();
    expect(provider.contextWindowTokens).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8')).idleTimeoutMs).toBeUndefined();
  });

  it.each([
    ['requestTimeoutMs', 59_999], ['requestTimeoutMs', 1_800_001], ['idleTimeoutMs', 30_000], ['idleTimeoutMs', 120_000.5],
    ['idleTimeoutMs', '120000'], ['contextWindowTokens', 7_999], ['contextWindowTokens', 2_000_001],
  ])('rejects %s=%p without changing the saved configuration', async (key, value) => {
    const runtime = makeRuntime();
    await expect(runtime.configureProvider({ baseUrl, model: 'm', skipProbe: true, [key]: value }))
      .rejects.toMatchObject({ code: 'A9_PROVIDER_CONFIG_INVALID', message: expect.stringContaining(key) });
    expect(runtime.getSnapshot().provider.configured).toBe(false);
  });

  it('accepts the boundary values 60s and 1800s', async () => {
    const runtime = makeRuntime();
    await runtime.configureProvider({ baseUrl, model: 'm', skipProbe: true, requestTimeoutMs: 1_800_000, idleTimeoutMs: 60_000 });
    expect(runtime.getSnapshot().provider).toMatchObject({ requestTimeoutMs: 1_800_000, idleTimeoutMs: 60_000 });
  });

  it('falls back to defaults with a diagnostic when saved values are out of range', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ schemaVersion: 1, baseUrl, model: 'm', customHeaderNames: [],
      requestTimeoutMs: 5_000, idleTimeoutMs: 9_999_999, contextWindowTokens: 12 }), 'utf8');
    const provider = makeRuntime().getSnapshot().provider;
    expect(provider.requestTimeoutMs).toBeUndefined();
    expect(provider.idleTimeoutMs).toBeUndefined();
    expect(provider.contextWindowTokens).toBeUndefined();
    expect(provider.diagnostics.code).toBe('A9_PROVIDER_SETTING_INVALID');
  });

  it('presents a 401 turn failure as Chinese guidance in the result, checkpoint and event, keeping the raw error', async () => {
    const runtime = makeRuntime();
    runtime.setMode('full_access');
    await runtime.configureProvider({ baseUrl, model: 'm', skipProbe: true });
    const response = await runtime.submitTurn('hello');
    const message: string = response.result.finalMessage;
    expect(response.result.outcome).toBe('failed');
    expect(message).toContain('API Key 无效或已过期（HTTP 401）');
    expect(message).toContain('下一步：');
    expect(message.split('\n\n原始错误：')[1]).toContain('Server returned status 401');

    const snapshot = runtime.getSnapshot();
    expect(snapshot.conversation[0].finalMessage).toContain('API Key 无效或已过期（HTTP 401）');
    expect(snapshot.conversation[0].finalMessage).toContain('原始错误：Server returned status 401');
    const failed = snapshot.timeline.filter((event: any) => event.type === 'turn_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data.guidance).toMatchObject({ code: 'A9_ERR_AUTH', title: expect.stringContaining('401') });
    expect(failed[0].data.error).toContain('Server returned status 401');
  });

  it('surfaces a throwing status observer as a structured diagnostic instead of swallowing it', async () => {
    const runtime = makeRuntime({ agentStatusObserver: () => { throw Object.assign(new Error('observer boom'), { code: 'EOBSERVER' }); } });
    runtime.setMode('full_access');
    await runtime.configureProvider({ baseUrl, model: 'm', skipProbe: true });
    await runtime.submitTurn('hello');
    const diagnostics = runtime.getSnapshot().persistenceDiagnostics;
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'A9_STATUS_OBSERVER_FAILED', detail: expect.stringContaining('EOBSERVER') }),
    ]));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('A9_STATUS_OBSERVER_FAILED'),
      expect.objectContaining({ code: 'A9_STATUS_OBSERVER_FAILED' }));
  });
});

describe('B3 renderer folds the original error into a details element', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../product/renderer/a9-workbench.js'), 'utf8');
  const source = script.slice(script.indexOf('  function setOutcomeText('), script.indexOf('  function formatElapsed('));
  const makeNode = (tag: string): any => ({
    tag, className: '', children: [] as any[], _text: '',
    get textContent() { return this._text; },
    set textContent(value: string) { this._text = value; if (value === '') this.children = []; },
    appendChild(child: any) { this.children.push(child); return child; },
  });
  const document = { createElement: makeNode, createTextNode: (text: string) => ({ tag: '#text', _text: text }) };
  const render = (text: string) => {
    const context: any = { document, DETAIL_MARKER: '\n\n原始错误：' };
    vm.runInNewContext(`${source};this.setOutcomeText = setOutcomeText;`, context);
    const container = makeNode('div');
    context.setOutcomeText(container, text);
    return container;
  };

  it('shows the Chinese guidance inline and the raw error only inside the folded details', () => {
    const container = render('原因说明\n下一步：检查 API Key\n\n原始错误：Server returned status 401: bad key');
    expect(container.children[0]._text).toBe('原因说明\n下一步：检查 API Key');
    const details = container.children[1];
    expect(details.tag).toBe('details');
    expect(details.children[0]._text).toBe('详情（原始错误）');
    expect(details.children[1]._text).toBe('Server returned status 401: bad key');
  });

  it('renders plain text unchanged when there is no marker', () => {
    const container = render('普通最终答复');
    expect(container._text).toBe('普通最终答复');
    expect(container.children).toHaveLength(0);
  });
});
