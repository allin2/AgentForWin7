/// <reference path="./better-sqlite3.d.ts" />
/**
 * Phase A10（H-P2-18）：凭据（API Key 等）清除失败必须显式失败并留下脱敏诊断，不得静默吞掉。
 * 使用注入式 fake safeStorage（非 Windows 环境，不宣称真实 DPAPI PASS）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const { createA9AgentRuntime } = require('../../product/a9-agent-runtime') as any;
// `import * as fs` 的命名空间不可被 spy；credential-vault.js 通过同一 CommonJS 模块对象调用 unlinkSync。
const fsModule = require('fs') as typeof fs;

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (cipher: Buffer) => {
      const text = cipher.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
      return Buffer.from(text.slice(4), 'base64').toString('utf8');
    },
  };
}

function vaultFiles(dataRoot: string, slot: string): string[] {
  const dir = path.join(dataRoot, slot);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('Phase A10: credential clearing fails loudly', () => {
  const secret = 'sk-phase-a10-secret-4242';
  let root: string, workspaceRoot: string, dataRoot: string, runtime: any;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-a10-'));
    workspaceRoot = path.join(root, 'ws'); dataRoot = path.join(root, 'data');
    fs.mkdirSync(workspaceRoot); fs.mkdirSync(dataRoot);
    runtime = createA9AgentRuntime({
      workspaceRoot, dataRoot, safeStorage: fakeSafeStorage(), vaultPlatform: 'win32',
      openDatabase: (p: string, o?: { readonly?: boolean }) => new Database(p, o?.readonly ? { readonly: true } : {}),
    });
    runtime.setMode('full_access');
    await runtime.configureProvider({ baseUrl: 'http://127.0.0.1:9', model: 'model-a', apiKey: secret, rememberApiKey: true, skipProbe: true });
    expect(vaultFiles(dataRoot, 'a9-vault-apikey')).toHaveLength(1);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    try { await runtime.shutdown(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  function failUnlink() {
    const real = fsModule.unlinkSync;
    return jest.spyOn(fsModule, 'unlinkSync').mockImplementation((target: any, ...rest: any[]) => {
      if (String(target).includes('a9-vault-')) throw Object.assign(new Error(`EBUSY: resource busy, unlink '${target}' ${secret}`), { code: 'EBUSY' });
      return (real as any)(target, ...rest);
    });
  }

  it('rejects "do not remember" when the saved key cannot be removed, keeps the old config and records a redacted diagnostic', async () => {
    const before = runtime.getSnapshot().provider;
    failUnlink();
    await expect(runtime.configureProvider({ baseUrl: 'http://127.0.0.1:9', model: 'model-a', rememberApiKey: false, skipProbe: true }))
      .rejects.toMatchObject({ code: 'A9_PROVIDER_CREDENTIAL_CLEAR_FAILED' });
    expect(vaultFiles(dataRoot, 'a9-vault-apikey')).toHaveLength(1);

    const after = runtime.getSnapshot().provider;
    expect(after.baseUrl).toBe(before.baseUrl);
    expect(after.apiKey.remembered).toBe(true);
    expect(after.diagnostics).toMatchObject({ code: 'A9_PROVIDER_CREDENTIAL_CLEAR_FAILED' });
    expect(after.diagnostics.detail).toContain('apiKey:CREDENTIAL_STORE_CLEAR_FAILED');
    expect(JSON.stringify(after)).not.toContain(secret);
  });

  it('rejects an endpoint change when the old endpoint credential cannot be removed, without switching endpoint', async () => {
    const before = runtime.getSnapshot().provider;
    failUnlink();
    let thrown: any;
    try {
      await runtime.configureProvider({ baseUrl: 'http://127.0.0.1:10', model: 'model-b', skipProbe: true });
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: 'A9_PROVIDER_CREDENTIAL_CLEAR_FAILED' });
    expect(thrown.diagnostics.map((item: any) => item.vault).sort()).toEqual(['apiKey', 'secrets']);
    expect(thrown.diagnostics.every((item: any) => item.code === 'CREDENTIAL_STORE_CLEAR_FAILED')).toBe(true);
    expect(String(thrown.message)).not.toContain(secret);
    expect(runtime.getSnapshot().provider.baseUrl).toBe(before.baseUrl);
    expect(vaultFiles(dataRoot, 'a9-vault-apikey')).toHaveLength(1);
  });

  it('removes the saved key and applies the config when clearing succeeds', async () => {
    await runtime.configureProvider({ baseUrl: 'http://127.0.0.1:9', model: 'model-a', rememberApiKey: false, skipProbe: true });
    expect(vaultFiles(dataRoot, 'a9-vault-apikey')).toHaveLength(0);
    expect(runtime.getSnapshot().provider.apiKey.remembered).toBe(false);
  });
});
