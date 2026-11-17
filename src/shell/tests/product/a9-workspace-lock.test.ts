import * as fs from 'fs';
import * as path from 'path';

const { LOCK_STATE, createWorkspaceLock } = require('../../product/a9-workspace-lock');

function port(results: Array<{ acquired?: boolean; holder?: string }>) {
  const acquire = jest.fn(() => results.shift() || { acquired: false, holder: 'other' });
  const release = jest.fn();
  return { acquire, release };
}

describe('A9 workspace lock lifecycle', () => {
  test('acquires on creation and stays acquired without re-reading persistence', () => {
    const p = port([{ acquired: true, holder: 'me' }]);
    const lock = createWorkspaceLock(p);
    expect(lock.state).toBe(LOCK_STATE.ACQUIRED);
    expect(lock.isHeld()).toBe(true);
    expect(lock.holder).toBe('me');
    expect(lock.retry()).toBe(true);
    expect(p.acquire).toHaveBeenCalledTimes(1);
  });

  test('unlocked retries until another holder lets go, then holds', () => {
    const p = port([{ acquired: false, holder: 'other' }, { acquired: false, holder: 'other' }, { acquired: true, holder: 'me' }]);
    const lock = createWorkspaceLock(p);
    expect(lock.state).toBe(LOCK_STATE.UNLOCKED);
    expect(lock.isHeld()).toBe(false);
    expect(lock.holder).toBe('other');
    expect(lock.retry()).toBe(false);
    expect(lock.retry()).toBe(true);
    expect(lock.state).toBe(LOCK_STATE.ACQUIRED);
    expect(lock.holder).toBe('me');
    expect(p.acquire).toHaveBeenCalledTimes(3);
  });

  test('a missing acquisition result reads as unlocked', () => {
    const lock = createWorkspaceLock({ acquire: () => undefined, release: jest.fn() });
    expect(lock.state).toBe(LOCK_STATE.UNLOCKED);
    expect(lock.holder).toBeUndefined();
  });

  test('release gives a held lock back exactly once and is terminal', () => {
    const p = port([{ acquired: true, holder: 'me' }]);
    const lock = createWorkspaceLock(p);
    lock.release(); lock.release();
    expect(p.release).toHaveBeenCalledTimes(1);
    expect(lock.state).toBe(LOCK_STATE.RELEASED);
    expect(lock.isHeld()).toBe(false);
    expect(lock.isReleased()).toBe(true);
    // Historic retry answer after release: the last acquisition result, without re-acquiring.
    expect(lock.retry()).toBe(true);
    expect(p.acquire).toHaveBeenCalledTimes(1);
  });

  test('releasing a lock that was never held does not touch persistence or re-acquire', () => {
    const p = port([{ acquired: false, holder: 'other' }]);
    const lock = createWorkspaceLock(p);
    lock.release();
    expect(p.release).not.toHaveBeenCalled();
    expect(lock.isReleased()).toBe(true);
    expect(lock.retry()).toBe(false);
    expect(p.acquire).toHaveBeenCalledTimes(1);
  });

  test('a failed persistence release keeps the lock held so shutdown can retry', () => {
    let fail = true;
    const release = jest.fn(() => { if (fail) throw new Error('disk'); });
    const lock = createWorkspaceLock({ acquire: () => ({ acquired: true }), release });
    expect(() => lock.release()).toThrow('disk');
    expect(lock.isHeld()).toBe(true);
    expect(lock.isReleased()).toBe(false);
    fail = false;
    lock.release();
    expect(lock.isReleased()).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  test('the runtime keeps no loose lock flags', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../product/a9-agent-runtime.js'), 'utf8');
    expect(source).not.toMatch(/\blockHeld\b|\bworkspaceLockReleased\b|\bretryWorkspaceLock\b/);
    expect(source.match(/persistence\.(acquire|release)WorkspaceLock\(/g)).toEqual([
      'persistence.acquireWorkspaceLock(', 'persistence.releaseWorkspaceLock(',
    ]);
  });
});
