import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

export class FileError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FileError';
    this.code = code;
  }
}

// Open nonblocking so a regular file replaced by a FIFO cannot block the CLI.
// O_NOFOLLOW is additional protection where supported; identity is checked too.
export function readRegularText(filename, maximumBytes) {
  let fd;
  try {
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink()) throw new FileError('INPUT_NOT_REGULAR');
    if (before.size > maximumBytes) throw new FileError('INPUT_TOO_LARGE');
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new FileError('INPUT_CHANGED');
    const chunks = [];
    let total = 0;
    while (true) {
      const block = Buffer.alloc(Math.min(65536, maximumBytes + 1 - total));
      const count = fs.readSync(fd, block, 0, block.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) throw new FileError('INPUT_TOO_LARGE');
      chunks.push(block.subarray(0, count));
    }
    const final = fs.fstatSync(fd);
    if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || total !== final.size) throw new FileError('INPUT_CHANGED');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new FileError('INPUT_UTF8');
    }
  } catch (error) {
    throw error instanceof FileError ? error : new FileError('INPUT_IO');
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* The original error takes precedence. */ }
    }
  }
}

export function assertNewOutputs(filenames) {
  const unique = new Set();
  for (const filename of filenames) {
    const resolved = path.resolve(filename);
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (unique.has(identity)) throw new FileError('OUTPUT_DUPLICATE');
    unique.add(identity);
    try {
      fs.lstatSync(resolved);
      throw new FileError('OUTPUT_EXISTS');
    } catch (error) {
      if (error instanceof FileError) throw error;
      if (error.code !== 'ENOENT') throw new FileError('OUTPUT_IO');
    }
    try {
      if (!fs.statSync(path.dirname(resolved)).isDirectory()) throw new FileError('OUTPUT_PARENT');
    } catch {
      throw new FileError('OUTPUT_PARENT');
    }
  }
}

// Files are written completely, then linked into place without replacing a path.
// A filesystem without hard-link support fails closed; there is no overwrite fallback.
export function writeNewOutputs(outputs, maximumBytes) {
  assertNewOutputs(outputs.map(({ filename }) => filename));
  const staged = [];
  const linked = [];
  try {
    for (const { filename, text } of outputs) {
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length > maximumBytes) throw new FileError('OUTPUT_TOO_LARGE');
      const destination = path.resolve(filename);
      const temporary = path.join(path.dirname(destination), `.schema-shift-lab-${randomUUID()}.tmp`);
      let fd;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        staged.push({ temporary, destination });
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
    for (const item of staged) {
      fs.linkSync(item.temporary, item.destination);
      linked.push(item);
    }
  } catch (error) {
    for (const item of linked) {
      try {
        const stagedStat = fs.lstatSync(item.temporary);
        const installedStat = fs.lstatSync(item.destination);
        if (stagedStat.dev === installedStat.dev && stagedStat.ino === installedStat.ino) fs.unlinkSync(item.destination);
      } catch { /* Preserve any replacement created by another process. */ }
    }
    throw error instanceof FileError ? error : new FileError('OUTPUT_IO');
  } finally {
    for (const item of staged) {
      try { fs.unlinkSync(item.temporary); } catch { /* Do not hide an earlier error. */ }
    }
  }
}

export function writeStream(stream, text) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = () => {
      if (!finished) { finished = true; reject(new FileError('OUTPUT_IO')); }
    };
    // Retain the listener: Node may emit 'error' after the write callback.
    stream.on('error', fail);
    try {
      stream.write(text, (error) => {
        if (error) return fail();
        if (!finished) { finished = true; resolve(); }
      });
    } catch { fail(); }
  });
}
