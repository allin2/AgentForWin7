'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { Readable, Writable, Transform } = require('stream');
const { parentPort, workerData } = require('worker_threads');
const yazl = require('../office-lite/node_modules/yazl');

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function sameIdentity(actual, expected) {
  return Boolean(actual && expected)
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs;
}

function verifyZip32Tail(fd, archiveBytes, expectedEntryCount) {
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 22 || archiveBytes >= 0xffffffff) {
    throw fail('ARCHIVE_ZIP32_LIMIT');
  }
  if (expectedEntryCount >= 0xffff) throw fail('ARCHIVE_ZIP32_LIMIT');
  const tailLen = Math.min(archiveBytes, 65557 + 76);
  const tailStart = archiveBytes - tailLen;
  const tail = Buffer.alloc(tailLen);
  let readTotal = 0;
  while (readTotal < tailLen) {
    const n = fs.readSync(fd, tail, readTotal, tailLen - readTotal, tailStart + readTotal);
    if (!n) throw fail('ARCHIVE_INVALID_OUTPUT');
    readTotal += n;
  }
  let eocdOffset = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tailLen) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw fail('ARCHIVE_INVALID_OUTPUT');
  if (eocdOffset >= 20 && tail.readUInt32LE(eocdOffset - 20) === 0x07064b50) {
    throw fail('ARCHIVE_ZIP32_LIMIT');
  }
  const disk = tail.readUInt16LE(eocdOffset + 4);
  const cdDisk = tail.readUInt16LE(eocdOffset + 6);
  const entriesDisk = tail.readUInt16LE(eocdOffset + 8);
  const entriesTotal = tail.readUInt16LE(eocdOffset + 10);
  const cdSize = tail.readUInt32LE(eocdOffset + 12);
  const cdOffset = tail.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesDisk !== expectedEntryCount || entriesTotal !== expectedEntryCount
    || entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw fail('ARCHIVE_ZIP32_LIMIT');
  }
}

function createFdWriteStream(fd) {
  let offset = 0;
  let writing = false;
  let pendingCloseCb = null;
  const stream = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let written = 0;
      writing = true;
      const step = () => {
        if (stream.destroyed) {
          writing = false;
          if (pendingCloseCb) { const cb = pendingCloseCb; pendingCloseCb = null; cb(); }
          callback(fail('ARCHIVE_WORKER_FAILED'));
          return;
        }
        fs.write(fd, buf, written, buf.length - written, offset, (err, count) => {
          if (err) {
            writing = false;
            if (pendingCloseCb) { const cb = pendingCloseCb; pendingCloseCb = null; cb(); }
            callback(err);
            return;
          }
          if (!count) {
            writing = false;
            if (pendingCloseCb) { const cb = pendingCloseCb; pendingCloseCb = null; cb(); }
            callback(fail('ARCHIVE_COPY_INCOMPLETE'));
            return;
          }
          written += count;
          offset += count;
          if (written < buf.length) step();
          else {
            writing = false;
            if (pendingCloseCb) { const cb = pendingCloseCb; pendingCloseCb = null; cb(); }
            callback();
          }
        });
      };
      step();
    },
    destroy(err, callback) {
      if (!writing) callback(err);
      else pendingCloseCb = () => callback(err);
    },
  });
  return stream;
}

function createVerifiedEntryStream(entry, activeSourceFds) {
  let srcFd;
  let closed = false;
  let reading = false;
  let pendingDestroyCb = null;
  let offset = 0;
  const entryHash = crypto.createHash('sha256');

  const closeSrc = () => {
    if (closed || srcFd === undefined) return;
    closed = true;
    activeSourceFds.delete(srcFd);
    try { fs.closeSync(srcFd); } catch (_ignored) {}
  };

  const currentLstat = fs.lstatSync(entry.absolutePath);
  if (!currentLstat.isFile() || currentLstat.isSymbolicLink()) {
    throw fail('ARCHIVE_SOURCE_DRIFT');
  }
  srcFd = fs.openSync(entry.absolutePath, 'r');
  activeSourceFds.add(srcFd);
  try {
    const openedStat = fs.fstatSync(srcFd);
    if (!sameIdentity(openedStat, entry.sourceIdentity)) {
      throw fail('ARCHIVE_SOURCE_DRIFT');
    }
  } catch (err) {
    closeSrc();
    throw err;
  }

  const stream = new Readable({
    highWaterMark: 64 * 1024,
    read(size) {
      if (reading || closed || stream.destroyed) return;
      reading = true;
      const chunkSize = Math.min(64 * 1024, Math.max(1024, size || 64 * 1024));
      const buf = Buffer.allocUnsafe(chunkSize);
      fs.read(srcFd, buf, 0, chunkSize, offset, (err, bytesRead) => {
        reading = false;
        if (stream.destroyed) {
          closeSrc();
          if (pendingDestroyCb) { const cb = pendingDestroyCb; pendingDestroyCb = null; cb(); }
          return;
        }
        if (err) {
          closeSrc();
          stream.destroy(err);
          return;
        }
        if (bytesRead > 0) {
          offset += bytesRead;
          if (offset > entry.sizeBytes) {
            closeSrc();
            stream.destroy(fail('ARCHIVE_SOURCE_DRIFT'));
            return;
          }
          const slice = buf.subarray(0, bytesRead);
          entryHash.update(slice);
          stream.push(slice);
          return;
        }
        try {
          if (offset !== entry.sizeBytes) throw fail('ARCHIVE_SOURCE_DRIFT');
          const digestHex = entryHash.digest('hex');
          const endStat = fs.fstatSync(srcFd);
          const endLstat = fs.lstatSync(entry.absolutePath);
          closeSrc();
          if (digestHex !== entry.sha256
            || !sameIdentity(endStat, entry.sourceIdentity)
            || !sameIdentity(endLstat, entry.sourceIdentity)) {
            throw fail('ARCHIVE_SOURCE_DRIFT');
          }
          stream.push(null);
        } catch (verifyErr) {
          closeSrc();
          stream.destroy(verifyErr && verifyErr.code && /^ARCHIVE_/.test(verifyErr.code) ? verifyErr : fail('ARCHIVE_SOURCE_DRIFT'));
        }
      });
    },
    destroy(err, callback) {
      if (!reading) {
        closeSrc();
        callback(err);
      } else {
        pendingDestroyCb = () => { closeSrc(); callback(err); };
      }
    },
  });
  return stream;
}

async function runArchive(input) {
  if (!input || typeof input.tempZipPath !== 'string' || !input.tempIdentity || !Array.isArray(input.entries)) {
    throw fail('ARCHIVE_INPUT_INVALID');
  }
  const maxArchiveBytes = Number.isSafeInteger(input.maxArchiveBytes) && input.maxArchiveBytes > 0 && input.maxArchiveBytes < 0xffffffff
    ? input.maxArchiveBytes
    : 128 * 1024 * 1024;
  if (input.entries.length === 0 || input.entries.length >= 0xffff) throw fail('ARCHIVE_ZIP32_LIMIT');

  const lstat = fs.lstatSync(input.tempZipPath);
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw fail('ARCHIVE_TEMP_IDENTITY_CHANGED');
  const tempFd = fs.openSync(input.tempZipPath, 'r+');
  const activeSourceFds = new Set();

  const closeSources = () => {
    for (const fd of activeSourceFds) {
      activeSourceFds.delete(fd);
      try { fs.closeSync(fd); } catch (_ignored) {}
    }
  };

  try {
    const tempStat = fs.fstatSync(tempFd);
    if (tempStat.dev !== input.tempIdentity.dev || tempStat.ino !== input.tempIdentity.ino || tempStat.size !== 0) {
      throw fail('ARCHIVE_TEMP_IDENTITY_CHANGED');
    }

    const zipfile = new yazl.ZipFile();
    const outStream = createFdWriteStream(tempFd);
    const outputHash = crypto.createHash('sha256');
    let archiveBytes = 0;

    const hashCounter = new Transform({
      transform(chunk, _encoding, callback) {
        archiveBytes += chunk.length;
        if (archiveBytes > maxArchiveBytes || archiveBytes >= 0xffffffff) {
          callback(fail('ARCHIVE_ZIP32_LIMIT'));
          return;
        }
        outputHash.update(chunk);
        callback(null, chunk);
      },
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const failOnce = (err) => {
        if (settled) return;
        settled = true;
        try { zipfile.outputStream.unpipe(hashCounter); } catch (_ignored) {}
        try { hashCounter.destroy(); } catch (_ignored) {}
        const finishReject = () => {
          closeSources();
          reject(err);
        };
        if (outStream.closed || outStream.destroyed) finishReject();
        else {
          outStream.once('close', finishReject);
          outStream.destroy();
        }
      };

      zipfile.on('error', failOnce);
      zipfile.outputStream.on('error', failOnce);
      hashCounter.on('error', failOnce);
      outStream.on('error', failOnce);
      outStream.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      zipfile.outputStream.pipe(hashCounter).pipe(outStream);

      try {
        for (const entry of input.entries) {
          zipfile.addReadStreamLazy(
            entry.archivePath,
            { mtime: new Date(entry.mtimeMs), compress: true, size: entry.sizeBytes },
            (cb) => {
              try {
                const entryStream = createVerifiedEntryStream(entry, activeSourceFds);
                entryStream.on('error', (err) => {
                  zipfile.emit('error', err);
                });
                cb(null, entryStream);
              } catch (err) {
                cb(err && err.code && /^ARCHIVE_/.test(err.code) ? err : fail('ARCHIVE_SOURCE_DRIFT'));
              }
            },
          );
        }
        zipfile.end();
      } catch (err) {
        failOnce(err);
      }
    });

    fs.fsyncSync(tempFd);
    verifyZip32Tail(tempFd, archiveBytes, input.entries.length);
    const archiveSha256 = outputHash.digest('hex');
    return {
      entryCount: input.entries.length,
      archiveBytes,
      archiveSha256,
      zipFormat: 'ZIP32',
      workerExitCode: 0,
    };
  } finally {
    closeSources();
    try { fs.closeSync(tempFd); } catch (_ignored) {}
  }
}

(async () => {
  try {
    const result = await runArchive(workerData);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    const code = /^ARCHIVE_[A-Z0-9_]+$/.test(String(error && error.code ? error.code : ''))
      ? error.code
      : 'ARCHIVE_WORKER_FAILED';
    parentPort.postMessage({ ok: false, error: { code, message: code } });
  } finally {
    parentPort.close();
  }
})();
