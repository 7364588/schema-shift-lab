import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const { assertNewOutputs, readRegularText, writeNewOutputs } = await import(process.env.SCHEMA_SHIFT_LAB_PACKAGE_ROOT
  ? pathToFileURL(path.join(process.env.SCHEMA_SHIFT_LAB_PACKAGE_ROOT, 'src/io.js'))
  : new URL('../src/io.js', import.meta.url));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-shift-io-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('UTF-8 reads stay bounded and reject malformed bytes', (t) => {
  const directory = fixture(t);
  const filename = path.join(directory, 'input.json');
  fs.writeFileSync(filename, '{"title":"café"}');
  assert.equal(readRegularText(filename, 100), '{"title":"café"}');
  assert.throws(() => readRegularText(filename, 4), { code: 'INPUT_TOO_LARGE' });
  fs.writeFileSync(filename, Buffer.from([0xc3, 0x28]));
  assert.throws(() => readRegularText(filename, 100), { code: 'INPUT_UTF8' });
});

test('directory and absent inputs fail with sanitized errors', (t) => {
  const directory = fixture(t);
  assert.throws(() => readRegularText(directory, 100), { code: 'INPUT_NOT_REGULAR' });
  assert.throws(() => readRegularText(path.join(directory, 'private-marker'), 100), (error) => error.code === 'INPUT_IO' && !error.message.includes(directory));
});

test('symbolic-link input and dangling output are never followed', (t) => {
  const directory = fixture(t);
  const source = path.join(directory, 'source');
  const linked = path.join(directory, 'linked');
  fs.writeFileSync(source, '{}');
  try { fs.symlinkSync(source, linked, 'file'); } catch (error) {
    if (error.code === 'EPERM') return t.skip('Symlink creation unavailable');
    throw error;
  }
  assert.throws(() => readRegularText(linked, 100), { code: 'INPUT_NOT_REGULAR' });
  const dangling = path.join(directory, 'dangling');
  fs.symlinkSync(path.join(directory, 'missing'), dangling, 'file');
  assert.throws(() => writeNewOutputs([{ filename: dangling, text: 'replace' }], 100), { code: 'OUTPUT_EXISTS' });
  assert.ok(fs.lstatSync(dangling).isSymbolicLink());
  assert.equal(fs.readFileSync(source, 'utf8'), '{}');
});

test('FIFO input is rejected before opening', { skip: process.platform === 'win32' }, (t) => {
  const directory = fixture(t);
  const fifo = path.join(directory, 'fifo');
  const command = spawnSync('mkfifo', [fifo]);
  if (command.error?.code === 'ENOENT') return t.skip('mkfifo unavailable');
  assert.equal(command.status, 0);
  assert.throws(() => readRegularText(fifo, 100), { code: 'INPUT_NOT_REGULAR' });
});

test('output files are complete, no-clobber, and temporary files are removed', (t) => {
  const directory = fixture(t);
  const first = path.join(directory, 'first.json');
  const second = path.join(directory, 'second.html');
  writeNewOutputs([{ filename: first, text: 'one\n' }, { filename: second, text: 'two\n' }], 100);
  assert.equal(fs.readFileSync(first, 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(second, 'utf8'), 'two\n');
  assert.throws(() => writeNewOutputs([{ filename: first, text: 'replacement' }], 100), { code: 'OUTPUT_EXISTS' });
  assert.deepEqual(fs.readdirSync(directory).sort(), ['first.json', 'second.html']);
});

test('duplicate outputs and later oversized data leave no files behind', (t) => {
  const directory = fixture(t);
  const filename = path.join(directory, 'result');
  assert.throws(() => assertNewOutputs([filename, path.join(directory, '.', 'result')]), { code: 'OUTPUT_DUPLICATE' });
  assert.throws(() => writeNewOutputs([{ filename, text: 'small' }, { filename: path.join(directory, 'large'), text: 'a'.repeat(101) }], 100), { code: 'OUTPUT_TOO_LARGE' });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('an existing later output prevents any earlier output from being created', (t) => {
  const directory = fixture(t);
  const first = path.join(directory, 'new');
  const existing = path.join(directory, 'existing');
  fs.writeFileSync(existing, 'keep');
  assert.throws(() => writeNewOutputs([{ filename: first, text: 'new' }, { filename: existing, text: 'replace' }], 100), { code: 'OUTPUT_EXISTS' });
  assert.deepEqual(fs.readdirSync(directory), ['existing']);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');
});
