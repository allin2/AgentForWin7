jest.mock('child_process', () => {
  const real = jest.requireActual('child_process');
  return {
    ...real,
    execFile: (file: string, ...args: any[]) => {
      const mapped = file === 'wmic' ? (globalThis as any).__a9Wmic : file === 'taskkill' ? (globalThis as any).__a9Taskkill : file;
      return real.execFile(mapped, ...args);
    },
  };
});

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { killWindowsProcessTree } from '../src/process-cleanup';

describe('A9-63 process cleanup deadlines', () => {
  it('times out a non-exiting WMIC helper and leaves no helper process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-63-runner-'));
    const wmic = path.join(root, 'wmic');
    const taskkill = path.join(root, 'taskkill');
    const helperPidFile = path.join(root, 'wmic.pid');
    fs.writeFileSync(wmic, `#!/bin/sh\necho $$ > ${JSON.stringify(helperPidFile)}\nexec sleep 20\n`);
    fs.writeFileSync(taskkill, '#!/bin/sh\npid=""\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "/PID" ]; then shift; pid="$1"; fi; shift; done\n[ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true\n');
    fs.chmodSync(wmic, 0o755);
    fs.chmodSync(taskkill, 0o755);
    const target = spawn('sleep', ['20'], { stdio: 'ignore' });
    try {
      (globalThis as any).__a9Wmic = wmic;
      (globalThis as any).__a9Taskkill = taskkill;
      const started = Date.now();
      const result = await killWindowsProcessTree(target.pid!);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/wmic timed out|unable to prove cleanup/i);
      const helperPid = Number(fs.readFileSync(helperPidFile, 'utf8'));
      expect(() => process.kill(helperPid, 0)).toThrow();
      expect(() => process.kill(target.pid!, 0)).toThrow();
    } finally {
      try { target.kill('SIGKILL'); } catch (_err) { /* already gone */ }
      delete (globalThis as any).__a9Wmic;
      delete (globalThis as any).__a9Taskkill;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

  it('times out a non-exiting taskkill helper and leaves no helper process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-63-runner-'));
    const wmic = path.join(root, 'wmic');
    const taskkill = path.join(root, 'taskkill');
    const helperPidFile = path.join(root, 'taskkill.pid');
    fs.writeFileSync(wmic, '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(taskkill, `#!/bin/sh\necho $$ > ${JSON.stringify(helperPidFile)}\nexec sleep 20\n`);
    fs.chmodSync(wmic, 0o755);
    fs.chmodSync(taskkill, 0o755);
    const target = spawn('sleep', ['20'], { stdio: 'ignore' });
    try {
      (globalThis as any).__a9Wmic = wmic;
      (globalThis as any).__a9Taskkill = taskkill;
      const result = await killWindowsProcessTree(target.pid!);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/taskkill timed out|unable to prove cleanup/i);
      const helperPid = Number(fs.readFileSync(helperPidFile, 'utf8'));
      expect(() => process.kill(helperPid, 0)).toThrow();
    } finally {
      try { target.kill('SIGKILL'); } catch (_err) { /* already gone */ }
      delete (globalThis as any).__a9Wmic;
      delete (globalThis as any).__a9Taskkill;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
});
