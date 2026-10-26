import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = process.env.SCHEMA_SHIFT_LAB_PACKAGE_ROOT
  ? path.join(process.env.SCHEMA_SHIFT_LAB_PACKAGE_ROOT, 'src/cli.js')
  : fileURLToPath(new URL('../src/cli.js', import.meta.url));
function fixture(t, before = { type: 'number', maximum: 8 }, after = { type: 'number' }, corpus = { cases: [{ id: 'large', value: 13, expect: 'widened' }] }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-shift-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({ before, after, corpus })) fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value));
  const args = ['--before', path.join(directory, 'before.json'), '--after', path.join(directory, 'after.json'), '--corpus', path.join(directory, 'corpus.json')];
  return { directory, args, write: (name, value) => fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value)) };
}
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 20 * 1024 * 1024 });

test('help and version are usable without reading inputs', () => {
  for (const args of [['--help'], ['--version'], ['check', '--help']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length > 0);
    assert.equal(result.stderr, '');
  }
});

test('comparison and check have deliberately different success criteria', (t) => {
  const { args } = fixture(t);
  const compare = run(['compare', ...args, '--format', 'json']);
  assert.equal(compare.status, 1, compare.stderr);
  assert.equal(JSON.parse(compare.stdout).cases[0].classification, 'widened');
  const check = run(['check', ...args, '--format', 'json']);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).outcome, 'expectations-met');
});

test('no observed acceptance change exits zero without claiming equivalence', (t) => {
  const { args } = fixture(t, true, true);
  const result = run(['compare', ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no-observed-change/);
  assert.match(result.stdout, /not proof of equivalence/);
});

test('expectation mismatch exits one; missing expectation exits two', (t) => {
  const f = fixture(t, true, true);
  assert.equal(run(['check', ...f.args]).status, 1);
  f.write('corpus', { cases: [{ id: 'no-expect', value: 1 }] });
  const result = run(['check', ...f.args]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing-expectation/);
  assert.match(result.stderr, /every case/);
  assert.equal(result.stdout, '');
});

test('empty corpus cannot pass vacuously', (t) => {
  const { args } = fixture(t, true, true, { cases: [] });
  for (const mode of ['compare', 'check']) assert.equal(run([mode, ...args]).status, 2);
});

test('JSON and HTML contain the same comparison, without filesystem paths', (t) => {
  const { directory, args } = fixture(t);
  const json = path.join(directory, 'report.json');
  const html = path.join(directory, 'report.html');
  const result = run(['compare', ...args, '--format', 'json', '--json', json, '--html', html]);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), JSON.parse(result.stdout));
  const output = fs.readFileSync(html, 'utf8');
  assert.match(output, /Content-Security-Policy/);
  assert.ok(!output.includes(directory));
  assert.ok(!result.stdout.includes(directory));
});

test('existing output, input collision, and duplicate destinations remain untouched', (t) => {
  const { directory, args } = fixture(t);
  const existing = path.join(directory, 'existing');
  fs.writeFileSync(existing, 'preserve');
  assert.equal(run(['compare', ...args, '--json', existing]).status, 2);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'preserve');
  const original = fs.readFileSync(args[1]);
  assert.equal(run(['compare', ...args, '--html', args[1]]).status, 2);
  assert.deepEqual(fs.readFileSync(args[1]), original);
  const fresh = path.join(directory, 'fresh');
  assert.equal(run(['compare', ...args, '--json', fresh, '--html', fresh]).status, 2);
  assert.ok(!fs.existsSync(fresh));
});

test('malformed JSON and invalid UTF-8 do not echo content or source path', (t) => {
  const { directory, args } = fixture(t);
  for (const bytes of [Buffer.from('{"secret-marker":'), Buffer.from([0xc3, 0x28])]) {
    fs.writeFileSync(args[1], bytes);
    const result = run(['compare', ...args]);
    assert.equal(result.status, 2);
    assert.ok(!result.stderr.includes(directory) && !result.stderr.includes('secret-marker'));
    assert.equal(result.stdout, '');
  }
});

test('duplicate keys, unsafe numbers and BOM are rejected at CLI boundary', (t) => {
  const { args } = fixture(t);
  for (const text of ['{"type":"number","type":"string"}', '{"maximum":9007199254740993}', '\ufeff{}']) {
    fs.writeFileSync(args[1], text);
    assert.equal(run(['compare', ...args]).status, 2);
  }
});

test('unsupported schema policies return useful safe diagnostics', (t) => {
  const f = fixture(t);
  for (const schema of [{ $ref: 'https://private-marker.example/schema' }, { $schema: 'http://json-schema.org/draft-07/schema#' }, { customSecretKeyword: true }]) {
    f.write('before', schema);
    const result = run(['compare', ...f.args]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unsupported/);
    assert.ok(!result.stderr.includes('private-marker') && !result.stderr.includes('customSecretKeyword'));
  }
});

test('bad arguments do not echo arbitrary text', () => {
  for (const args of [[], ['secret-marker'], ['compare', '--unknown', 'secret-marker'], ['compare', '--before']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /USAGE/);
    assert.ok(!result.stderr.includes('secret-marker'));
  }
});

test('duplicate options, invalid mode format and deadlines fail usage', (t) => {
  const { args } = fixture(t);
  for (const extra of [['--format', 'xml'], ['--before', args[1]], ['--timeout-ms', '9'], ['--timeout-ms', '10001'], ['--timeout-ms', '1e3']]) {
    assert.equal(run(['compare', ...args, ...extra]).status, 2);
  }
});

test('catastrophic regex is terminated and remains an unknown exit three', (t) => {
  const { args } = fixture(t, { type: 'string', pattern: '^(a+)+$' }, true, { cases: [{ id: 'slow', value: `${'a'.repeat(5000)}!`, expect: 'widened' }] });
  const result = run(['check', ...args, '--timeout-ms', '100', '--format', 'json']);
  assert.equal(result.status, 3, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.cases[0].classification, 'unknown');
  assert.equal(report.cases[0].before.valid, null);
});

async function closedPipe(args, closed) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let other = '';
    child[closed].destroy();
    child[closed === 'stdout' ? 'stderr' : 'stdout'].on('data', (chunk) => { other += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Closed-pipe child timed out')); }, 10000);
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, other }); });
  });
}

test('closed stdout handles help, version and reports without stack traces', async (t) => {
  const { args } = fixture(t);
  for (const command of [['--help'], ['--version'], ['compare', ...args]]) {
    const result = await closedPipe(command, 'stdout');
    assert.equal(result.code, 2);
    assert.ok(!result.other.includes('Error:') && !result.other.includes('node:'));
  }
});

test('closed stderr on usage and input error exits two', async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.args[1]);
  for (const args of [['invalid-command'], ['compare', ...f.args]]) {
    const result = await closedPipe(args, 'stderr');
    assert.equal(result.code, 2);
    assert.equal(result.other, '');
  }
});
