/**
 * @module async-tree
 * @description A9-66 F-011/F-012: cooperative, cancellable directory work for
 * the Electron main thread. Every helper here is the asynchronous counterpart
 * of an existing synchronous reference and must keep its observable result:
 *
 * - hashDirectoryTreeAsync: byte-for-byte the same digest stream as
 *   CheckpointManager.hashDirectoryTree (L/D/F/O records, sorted readdir,
 *   '/'-normalized relative names starting at '.').
 * - copyTreeAsync: the subset of fs.cpSync({ recursive: true, force }) used by
 *   the workspace (no dereference, absolute-resolved symlink targets, mode
 *   propagation, same path conflict errors).
 * - removeTreeAsync: fs.rmSync({ recursive: true, force: true }) without
 *   following links.
 *
 * Cancellation is only observed between filesystem entries (and between
 * chunks of one large file). Callers decide how a partial side effect is
 * recorded; these helpers never claim completion.
 *
 * Identity binding (A9-66/67 repair): every filesystem call is preceded, in the
 * same synchronous turn, by IoGuard.check(target) and is itself a small
 * synchronous call or an operation on an already opened descriptor. The
 * event loop is yielded only between such steps, so a root/parent/ancestor
 * replacement during a yield is rejected before the next read, write, delete
 * or recovery write. Large file contents move through verified descriptors.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IoGuard, identityChanged } from './directory-identity';

const TREE_YIELD_SLICE_MS = 16;
const TREE_YIELD_MAX_STEPS = 64;
const TREE_READ_CHUNK_BYTES = 1024 * 1024;

export class TreeOperationCancelled extends Error {
  readonly code = 'A9_TREE_OPERATION_CANCELLED';
  constructor(message = '目录操作已取消') {
    super(message);
    this.name = 'TreeOperationCancelled';
  }
}

export interface TreeOptions {
  signal?: AbortSignal;
  /** Identity guard consulted right before each filesystem call. */
  guard?: IoGuard;
}

const FILE_COPY_SYNC_LIMIT_BYTES = 1024 * 1024;

function guardCheck(options: TreeOptions, target: string): void {
  options.guard?.check(target);
}

function readChunk(fd: number, buffer: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, buffer.length, null, (error, bytesRead) => (error ? reject(error) : resolve(bytesRead)));
  });
}

function writeChunk(fd: number, buffer: Buffer, length: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let offset = 0;
    const next = (): void => {
      fs.write(fd, buffer, offset, length - offset, null, (error, written) => {
        if (error) { reject(error); return; }
        offset += written;
        if (offset >= length) resolve(); else next();
      });
    };
    next();
  });
}

/** Yields with setImmediate after a step or time bound; never a fake Promise.resolve. */
export class TreeSlice {
  private started = Date.now();
  private steps = 0;
  constructor(private readonly signal?: AbortSignal) {}

  check(): void {
    if (this.signal?.aborted) throw new TreeOperationCancelled();
  }

  async step(): Promise<void> {
    this.check();
    this.steps += 1;
    if (this.steps >= TREE_YIELD_MAX_STEPS || Date.now() - this.started >= TREE_YIELD_SLICE_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.started = Date.now();
      this.steps = 0;
      this.check();
    }
  }
}

async function hashFileContentAsync(filePath: string, slice: TreeSlice, options: TreeOptions): Promise<string> {
  const digest = crypto.createHash('sha256');
  guardCheck(options, filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(TREE_READ_CHUNK_BYTES);
    for (;;) {
      const bytesRead = await readChunk(fd, buffer);
      if (bytesRead <= 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      await slice.step();
    }
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest('hex');
}

/** Same digest stream as the synchronous CheckpointManager.hashDirectoryTree. */
export async function hashDirectoryTreeAsync(root: string, options: TreeOptions = {}): Promise<string> {
  const slice = new TreeSlice(options.signal);
  const digest = crypto.createHash('sha256');
  const visit = async (absolute: string, relative: string): Promise<void> => {
    await slice.step();
    guardCheck(options, absolute);
    const stat = fs.lstatSync(absolute);
    const normalized = relative.replace(/\\/g, '/');
    if (stat.isSymbolicLink()) {
      digest.update(`L\0${normalized}\0${fs.readlinkSync(absolute)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      digest.update(`D\0${normalized}\0`);
      guardCheck(options, path.join(absolute, '_'));
      for (const name of fs.readdirSync(absolute).sort()) {
        await visit(path.join(absolute, name), path.join(relative, name));
      }
      return;
    }
    if (stat.isFile()) {
      digest.update(`F\0${normalized}\0${stat.size}\0${await hashFileContentAsync(absolute, slice, options)}\0`);
      return;
    }
    digest.update(`O\0${normalized}\0${stat.mode}\0${stat.size}\0`);
  };
  await visit(root, '.');
  return digest.digest('hex');
}

/** Visits every regular file with its full content, e.g. for secret checks. */
export async function forEachTreeFileAsync(
  root: string,
  relativeRoot: string,
  onEntry: (relative: string, content: Buffer | undefined) => void,
  options: TreeOptions = {},
): Promise<void> {
  const slice = new TreeSlice(options.signal);
  const visit = async (absolute: string, relative: string): Promise<void> => {
    await slice.step();
    onEntry(relative, undefined);
    guardCheck(options, absolute);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      guardCheck(options, path.join(absolute, '_'));
      for (const name of fs.readdirSync(absolute)) {
        await visit(path.join(absolute, name), path.join(relative, name));
      }
    } else if (stat.isFile()) {
      guardCheck(options, absolute);
      const fd = fs.openSync(absolute, 'r');
      let content: Buffer;
      try {
        content = await new Promise<Buffer>((resolve, reject) => {
          fs.readFile(fd, (error, data) => (error ? reject(error) : resolve(data)));
        });
      } finally {
        fs.closeSync(fd);
      }
      onEntry(relative, content);
    }
  };
  await visit(root, relativeRoot);
}

function cpError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function lstatOrUndefined(options: TreeOptions, target: string): fs.Stats | undefined {
  guardCheck(options, target);
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isSubPath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Copies one regular file; contents above the sync limit move through bound descriptors. */
async function copyFileBound(
  from: string,
  to: string,
  fromStat: fs.Stats,
  slice: TreeSlice,
  options: TreeOptions,
  sideEffect: () => void,
): Promise<void> {
  if (fromStat.size <= FILE_COPY_SYNC_LIMIT_BYTES) {
    guardCheck(options, from);
    guardCheck(options, to);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    sideEffect();
    guardCheck(options, to);
    fs.chmodSync(to, fromStat.mode);
    return;
  }
  guardCheck(options, from);
  const rfd = fs.openSync(from, 'r');
  let wfd: number | undefined;
  let createdIdentity: fs.Stats | undefined;
  try {
    guardCheck(options, to);
    wfd = fs.openSync(to, 'wx');
    createdIdentity = fs.fstatSync(wfd);
    sideEffect();
    const buffer = Buffer.allocUnsafe(TREE_READ_CHUNK_BYTES);
    try {
      for (;;) {
        const bytesRead = await readChunk(rfd, buffer);
        if (bytesRead <= 0) break;
        await writeChunk(wfd, buffer, bytesRead);
        await slice.step();
      }
      guardCheck(options, to);
      const current = fs.lstatSync(to);
      if (current.dev !== createdIdentity.dev || current.ino !== createdIdentity.ino ||
          current.birthtimeMs !== createdIdentity.birthtimeMs) throw identityChanged('Copy destination');
      fs.fchmodSync(wfd, fromStat.mode);
    } catch (error) {
      // A half-copied file must never look like a finished copy.
      try {
        fs.closeSync(wfd);
        wfd = undefined;
        guardCheck(options, to);
        const remaining = fs.lstatSync(to);
        // Cleanup owns only the file opened by this operation, never a leaf
        // another in-process action installed while an async read was pending.
        if (createdIdentity && remaining.dev === createdIdentity.dev && remaining.ino === createdIdentity.ino &&
            remaining.birthtimeMs === createdIdentity.birthtimeMs) fs.unlinkSync(to);
      } catch (_cleanupError) { /* the caller records the real post-state */ }
      throw error;
    }
  } finally {
    fs.closeSync(rfd);
    if (wfd !== undefined) fs.closeSync(wfd);
  }
}

/**
 * Asynchronous counterpart of fs.cpSync(src, dest, { recursive: true, force }).
 * onSideEffect fires after each created/replaced entry so a caller can tell
 * whether any side effect happened before a failure or cancellation.
 */
export async function copyTreeAsync(
  src: string,
  dest: string,
  options: TreeOptions & { force: boolean; onSideEffect?: () => void },
): Promise<void> {
  const slice = new TreeSlice(options.signal);
  guardCheck(options, src);
  const srcStat = fs.lstatSync(src);
  const destStat = lstatOrUndefined(options, dest);
  if (destStat) {
    if (srcStat.dev === destStat.dev && srcStat.ino === destStat.ino) {
      throw cpError('ERR_FS_CP_EINVAL', 'src and dest cannot be the same');
    }
    if (srcStat.isDirectory() && !destStat.isDirectory()) {
      throw cpError('ERR_FS_CP_DIR_TO_NON_DIR', `cannot overwrite non-directory ${dest} with directory ${src}`);
    }
    if (!srcStat.isDirectory() && destStat.isDirectory()) {
      throw cpError('ERR_FS_CP_NON_DIR_TO_DIR', `cannot overwrite directory ${dest} with non-directory ${src}`);
    }
  }
  if (srcStat.isDirectory() && isSubPath(src, dest)) {
    throw cpError('ERR_FS_CP_EINVAL', `cannot copy ${src} to a subdirectory of self ${dest}`);
  }
  const sideEffect = options.onSideEffect ?? (() => undefined);
  const copyEntry = async (from: string, to: string, fromStat: fs.Stats): Promise<void> => {
    await slice.step();
    // A leaf can change while its parent directories remain bound. Never use
    // a pre-yield regular-file classification to follow a newly installed link.
    guardCheck(options, from);
    const current = fs.lstatSync(from);
    if (current.dev !== fromStat.dev || current.ino !== fromStat.ino ||
        current.mode !== fromStat.mode || current.birthtimeMs !== fromStat.birthtimeMs ||
        current.size !== fromStat.size || current.mtimeMs !== fromStat.mtimeMs) {
      throw identityChanged('Copy source');
    }
    fromStat = current;
    const toStat = lstatOrUndefined(options, to);
    if (fromStat.isDirectory()) {
      if (toStat && !toStat.isDirectory()) {
        throw cpError('ERR_FS_CP_DIR_TO_NON_DIR', `cannot overwrite non-directory ${to} with directory ${from}`);
      }
      if (!toStat) {
        guardCheck(options, to);
        fs.mkdirSync(to);
        sideEffect();
      }
      guardCheck(options, to);
      const destinationIdentity = fs.lstatSync(to);
      guardCheck(options, path.join(from, '_'));
      for (const name of fs.readdirSync(from)) {
        const child = path.join(from, name);
        guardCheck(options, child);
        await copyEntry(child, path.join(to, name), fs.lstatSync(child));
      }
      guardCheck(options, to);
      const destinationNow = fs.lstatSync(to);
      if (!destinationNow.isDirectory() || destinationNow.dev !== destinationIdentity.dev ||
          destinationNow.ino !== destinationIdentity.ino || destinationNow.birthtimeMs !== destinationIdentity.birthtimeMs) {
        throw identityChanged('Copy directory destination');
      }
      if (!toStat) fs.chmodSync(to, fromStat.mode);
      return;
    }
    if (toStat && toStat.isDirectory()) {
      throw cpError('ERR_FS_CP_NON_DIR_TO_DIR', `cannot overwrite directory ${to} with non-directory ${from}`);
    }
    if (fromStat.isSymbolicLink()) {
      guardCheck(options, from);
      let target = fs.readlinkSync(from);
      if (!path.isAbsolute(target)) target = path.resolve(path.dirname(from), target);
      if (toStat) {
        if (!options.force) return;
        guardCheck(options, to);
        fs.unlinkSync(to);
        sideEffect();
      }
      guardCheck(options, to);
      fs.symlinkSync(target, to);
      sideEffect();
      return;
    }
    if (fromStat.isFile() || fromStat.isCharacterDevice() || fromStat.isBlockDevice()) {
      if (toStat) {
        if (!options.force) return;
        guardCheck(options, to);
        fs.unlinkSync(to);
        sideEffect();
      }
      await copyFileBound(from, to, fromStat, slice, options, sideEffect);
      return;
    }
    if (fromStat.isSocket()) throw cpError('ERR_FS_CP_SOCKET', `cannot copy a socket file: ${from}`);
    if (fromStat.isFIFO()) throw cpError('ERR_FS_CP_FIFO_PIPE', `cannot copy a FIFO pipe: ${from}`);
    throw cpError('ERR_FS_CP_UNKNOWN', `cannot copy an unknown file type: ${from}`);
  };
  await copyEntry(src, dest, srcStat);
}

/** Asynchronous counterpart of fs.rmSync(target, { recursive: true, force: true }). */
export async function removeTreeAsync(
  target: string,
  options: TreeOptions & { onSideEffect?: () => void } = {},
): Promise<void> {
  const slice = new TreeSlice(options.signal);
  const sideEffect = options.onSideEffect ?? (() => undefined);
  const remove = async (absolute: string): Promise<void> => {
    await slice.step();
    const stat = lstatOrUndefined(options, absolute);
    if (!stat) return;
    if (stat.isDirectory()) {
      guardCheck(options, path.join(absolute, '_'));
      for (const name of fs.readdirSync(absolute)) await remove(path.join(absolute, name));
      guardCheck(options, absolute);
      fs.rmdirSync(absolute);
    } else {
      guardCheck(options, absolute);
      fs.unlinkSync(absolute);
    }
    sideEffect();
  };
  await remove(target);
}
