/**
 * @module directory-identity
 * @description A9-66/67 repair: identity binding for directories that
 * cooperative (awaiting) filesystem work depends on.
 *
 * The asynchronous copy/move/delete and snapshot paths yield to the event
 * loop between filesystem entries. Anything that happens during such a yield
 * (the workspace root, a parent directory or a recovery store being renamed
 * away and replaced by a link or another directory) must never let a later
 * read, write, delete or recovery write keep the old ownership.
 *
 * Rule implemented here: an IoGuard is consulted immediately before every
 * filesystem call, and that call is then issued synchronously in the same
 * JavaScript turn, so no in-process interleaving can occur between the check
 * and the call. Directory anchors (path, canonical path, dev/ino) are captured
 * before the first await of an operation.
 *
 * Boundary (unchanged from A9-64): this is not an atomic sandbox. A different
 * process can still race between the kernel path lookup and a check; Full
 * Access remains a trusted workspace. What is closed is every in-process
 * interleaving introduced by awaiting.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceError } from './types';

export interface DirectoryAnchor {
  /** Lexical path the operation uses. */
  path: string;
  /** Canonical path captured with the identity. */
  real: string;
  dev: number;
  ino: number;
}

export function identityChanged(label: string, code?: string): WorkspaceError {
  return new WorkspaceError(
    'DIRECTORY_IDENTITY_CHANGED',
    `${label}的目录身份已变化或无法确认${code ? `（${code}）` : ''}；已在执行读写、删除或恢复写入前拒绝，没有沿用旧归属。`,
  );
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

function isWithinLexically(parent: string, child: string): boolean {
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Captures the identity of an existing directory; throws if it cannot be established. */
export function captureAnchor(dir: string, label = '路径'): DirectoryAnchor {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) throw identityChanged(label, 'NOT_DIRECTORY');
    return { path: dir, real: fs.realpathSync.native(dir), dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw identityChanged(label, String((error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'));
  }
}

/** Nearest existing ancestor (or the directory itself) as an anchor. */
export function captureNearestAnchor(dir: string, label = '路径'): DirectoryAnchor {
  let probe = path.resolve(dir);
  for (;;) {
    try {
      fs.statSync(probe);
      return captureAnchor(probe, label);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (error instanceof WorkspaceError) throw error;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw identityChanged(label, String(code ?? 'UNKNOWN'));
      const parent = path.dirname(probe);
      if (parent === probe) throw identityChanged(label, 'NO_EXISTING_ANCESTOR');
      probe = parent;
    }
  }
}

export function assertAnchor(anchor: DirectoryAnchor, label = '路径'): void {
  let stat: fs.Stats;
  let real: string;
  try {
    stat = fs.statSync(anchor.path);
    real = fs.realpathSync.native(anchor.path);
  } catch (error) {
    throw identityChanged(label, String((error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'));
  }
  if (!stat.isDirectory() || !samePath(real, anchor.real) || stat.ino !== anchor.ino || stat.dev !== anchor.dev) {
    throw identityChanged(label);
  }
}

export type AnchorSource = DirectoryAnchor | undefined | (() => DirectoryAnchor | undefined);

/**
 * Verifies, immediately before a filesystem call on `target`, that every bound
 * anchor still has its captured identity and that the target's parent
 * directory still resolves through the anchor that contains it.
 */
export class IoGuard {
  private readonly sources: AnchorSource[];

  constructor(sources: AnchorSource[] = []) {
    this.sources = sources;
  }

  with(extra: AnchorSource[]): IoGuard {
    return new IoGuard([...this.sources, ...extra]);
  }

  private anchors(): DirectoryAnchor[] {
    const found: DirectoryAnchor[] = [];
    for (const source of this.sources) {
      const anchor = typeof source === 'function' ? source() : source;
      if (anchor) found.push(anchor);
    }
    return found;
  }

  /** Throws unless every anchor is unchanged. */
  assertAnchors(): void {
    for (const anchor of this.anchors()) assertAnchor(anchor);
  }

  /** Must be called synchronously right before the filesystem call on `target`. */
  check(target: string): void {
    const anchors = this.anchors();
    for (const anchor of anchors) assertAnchor(anchor);
    const parent = path.dirname(path.resolve(target));
    let owner: DirectoryAnchor | undefined;
    for (const anchor of anchors) {
      if (isWithinLexically(anchor.path, parent) && (!owner || anchor.path.length > owner.path.length)) owner = anchor;
    }
    if (!owner) throw identityChanged('目标路径', 'UNBOUND');
    const expected = path.join(owner.real, path.relative(path.resolve(owner.path), parent));
    let actual: string;
    try {
      actual = fs.realpathSync.native(parent);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      // A parent that does not exist cannot redirect the call; the call itself fails.
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw identityChanged('目标父目录', String(code ?? 'UNKNOWN'));
    }
    if (!samePath(actual, expected)) throw identityChanged('目标父目录');
  }

  /** Verifies that `dir` itself (not only its parent) still resolves through its anchor. */
  checkInside(dir: string): void {
    this.check(path.join(path.resolve(dir), '_'));
  }

  /**
   * mkdir -p below the nearest existing ancestor, which is verified first.
   * Used instead of a bare recursive mkdir so a redirected ancestor is never
   * extended.
   */
  ensureDirectory(dir: string): void {
    const absolute = path.resolve(dir);
    const missing: string[] = [];
    let probe = absolute;
    for (;;) {
      try {
        if (!fs.statSync(probe).isDirectory()) throw identityChanged('目标父目录', 'NOT_DIRECTORY');
        break;
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') throw identityChanged('目标父目录', String(code ?? 'UNKNOWN'));
        missing.unshift(probe);
        const next = path.dirname(probe);
        if (next === probe) throw identityChanged('目标父目录', 'NO_EXISTING_ANCESTOR');
        probe = next;
      }
    }
    for (const part of missing) {
      this.check(path.join(part, '.'));
      try {
        fs.mkdirSync(part);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
    }
    this.checkInside(absolute);
  }
}
