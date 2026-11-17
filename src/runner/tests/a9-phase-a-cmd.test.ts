/**
 * Phase A5（H-P2-04、H-P2-05）：
 * - CMD 输出按 auto 解码（严格 UTF-8 → CP936），不再固定 CP936；
 * - cmd /d /s /c 在命令以引号开头时外层再包一对引号，helper 的 command 与 argv[3] 保持一致。
 */
import { SafeOutputStream, TrustedShellRunner, buildTrustedShellInvocation } from '../src';
import type { HelperTransport } from '../src/native-transport';

const identity = (s: string) => s;
const temporaryRoots: string[] = [];
afterEach(() => {
  const fs = require('fs');
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function projectAt(bytes: Buffer, split: number) {
  const stream = new SafeOutputStream('auto', [], identity);
  const text = stream.push(bytes.subarray(0, split)) + stream.push(bytes.subarray(split)) + stream.finish();
  return { text, stream };
}

describe('Phase A5: SafeOutputStream auto decoding', () => {
  const utf8 = Buffer.from('提交 中文 tick\r\n下一行');
  const cp936 = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x20, 0x74, 0x69, 0x63, 0x6b, 0x0d, 0x0a]);

  it('decodes UTF-8 output at every split point and reports utf-8', () => {
    for (let n = 0; n <= utf8.length; n += 1) {
      const { text, stream } = projectAt(utf8, n);
      expect(text).toBe('提交 中文 tick\r\n下一行');
      expect(stream.warning).toBeUndefined();
      expect(stream.detectedEncoding).toBe('utf-8');
    }
  });

  it('falls back to CP936 at every split point and reports gbk', () => {
    for (let n = 0; n <= cp936.length; n += 1) {
      const { text, stream } = projectAt(cp936, n);
      expect(text).toBe('中文 tick\r\n');
      expect(stream.warning).toBeUndefined();
      expect(stream.detectedEncoding).toBe('gbk');
    }
  });

  it('keeps an ASCII prefix emitted before the first non-UTF-8 byte', () => {
    const bytes = Buffer.concat([Buffer.from('ok: '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]);
    for (let n = 0; n <= bytes.length; n += 1) expect(projectAt(bytes, n).text).toBe('ok: 中文');
  });

  it('does not mistake valid UTF-8 Chinese for GBK even when split inside a character', () => {
    const bytes = Buffer.from('中文');
    for (let n = 0; n <= bytes.length; n += 1) expect(projectAt(bytes, n).text).toBe('中文');
  });

  it('reports an encoding warning instead of fabricating text when bytes are neither UTF-8 nor CP936', () => {
    const stream = new SafeOutputStream('auto', [], identity);
    const text = stream.push(Buffer.from([0x81, 0x20, 0x81, 0x20])) + stream.finish();
    expect(text).toBe('');
    expect(stream.warning).toBe('A9_OUTPUT_ENCODING_ERROR');
  });

  it('still redacts secrets in auto mode for CP936 output', () => {
    const secret = 'sentinel-secret-xyz';
    const bytes = Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x20]), Buffer.from(`token=${secret}\n`)]);
    const stream = new SafeOutputStream('auto', [secret], identity);
    const text = stream.push(bytes) + stream.finish();
    expect(text).toContain('中文');
    expect(text).not.toContain(secret);
  });
});

describe('Phase A5: CMD /d /s /c quoting', () => {
  it('wraps a command that starts with a quote so /s strips only the added pair', () => {
    const command = '"C:\\Program Files\\Git\\cmd\\git.exe" log --oneline';
    const invocation = buildTrustedShellInvocation('cmd', 'cmd.exe', command);
    expect(invocation.args).toEqual(['/d', '/s', '/c', `"${command}"`]);
    expect(invocation.verbatim).toBe(true);
  });

  it('leaves commands that do not start with a quote unchanged', () => {
    expect(buildTrustedShellInvocation('cmd', 'cmd.exe', 'echo "a b"').args[3]).toBe('echo "a b"');
    expect(buildTrustedShellInvocation('cmd', 'cmd.exe', 'dir').args[3]).toBe('dir');
  });
});

describe('Phase A5: TrustedShellRunner helper request for CMD', () => {
  const sha = 'a'.repeat(64);
  const cmdPath = 'C:\\Windows\\System32\\cmd.exe';

  function makeRunner(dir: string, payload: Buffer, captured: any[]): TrustedShellRunner {
    const helper: HelperTransport = {
      invoke: async (req, _signal, _env, output) => {
        captured.push(req);
        await output!({ schemaVersion: 3, type: 'output_chunk', requestId: req.requestId,
          profileId: 'a9-trusted-shell-current-user-v2', seq: 1, stream: 'stdout', streamOffset: 0,
          byteLength: payload.length, dataBase64: payload.toString('base64') });
        return { kind: 'response', response: { schemaVersion: 3, type: 'execution_result', requestId: req.requestId,
          profileId: 'a9-trusted-shell-current-user-v2', status: 'completed', exitCode: 0, executionTimeMs: 1,
          timedOut: false, idleTimedOut: false, canceled: false, outputTruncated: false, containmentVerified: true,
          inputDetached: true, cleanupConfirmed: true, workDirAclModified: false,
          hostJob: { detected: false, breakaway: 'none', limitFlags: 0, childJobAssignmentVerified: true },
          tokenAudit: { source: 'suspended_child_process_token', verified: true, tokenMode: 'current_user', restrictedToken: false,
            tokenType: 'primary', sameUser: true, lowIntegrity: false, integritySid: 'S-1-16-8192', integrityRid: 8192 },
          lastOutputSeq: 1, stdout: { rawBytesRead: payload.length, emittedBytes: payload.length, omittedBytes: 0 },
          stderr: { rawBytesRead: 0, emittedBytes: 0, omittedBytes: 0 } } } as any;
      },
    };
    return new TrustedShellRunner({
      platform: 'win32', helperTransport: helper, helperProtocolVersion: 3, logDir: dir,
      resolveShellIdentity: () => ({ canonicalPath: cmdPath, sha256: sha, fileId: 'id' }),
      getConfiguredShellIdentity: () => ({ canonicalPath: cmdPath, sha256: sha, fileId: 'id' }),
    });
  }

  async function runCmd(command: string, payload: Buffer) {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-a-cmd-'));
    temporaryRoots.push(dir);
    const captured: any[] = [];
    const result = await makeRunner(dir, payload, captured).execute({ command, cwd: dir, shellKind: 'cmd', shellPath: cmdPath });
    return { result, request: captured[0] };
  }

  it('decodes UTF-8 output from a CMD child (git/node/python) without CP936 garbling', async () => {
    const { result, request } = await runCmd('git log --oneline', Buffer.from('abc1234 修复 中文路径\r\n'));
    expect(result.status).toBe('exited');
    expect(result.stdout).toContain('修复 中文路径');
    expect(result.encoding).toBe('utf-8');
    // helper 协议值保持不变，不需要重建原生 helper。
    expect(request.outputEncoding).toEqual({ stdout: 'cp936', stderr: 'cp936' });
  });

  it('still decodes native CP936 console output', async () => {
    const { result } = await runCmd('ver', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]));
    expect(result.stdout).toContain('中文');
    expect(result.encoding).toBe('gbk');
  });

  it('sends the wrapped command line to the helper with argv[3] === command for a quote-leading command', async () => {
    const command = '"C:\\Program Files\\Git\\cmd\\git.exe" status';
    const { request } = await runCmd(command, Buffer.from('ok\r\n'));
    expect(request.argv).toEqual(['/d', '/s', '/c', `"${command}"`]);
    expect(request.command).toBe(request.argv[3]);
  });

  it('keeps command equal to the original for commands without a leading quote', async () => {
    const { request } = await runCmd('echo hi', Buffer.from('hi\r\n'));
    expect(request.argv).toEqual(['/d', '/s', '/c', 'echo hi']);
    expect(request.command).toBe('echo hi');
  });
});
