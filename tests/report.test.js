import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renderReport } from '../src/report.js';

const fixture = () => ({
  format: 'schema-shift-lab/report/v1', title: 'Synthetic report', demo: true,
  status: 'complete', mode: 'compare', outcome: 'changed',
  inputs: { before: { schema: false, sha256: 'a'.repeat(64) }, after: { schema: true, sha256: 'b'.repeat(64) }, corpus: { sha256: 'c'.repeat(64) } },
  cases: [{ id: 'one', value: null, classification: 'widened', expected: 'widened', expectation: 'matched', before: { valid: false, errors: [], truncated: false }, after: { valid: true, errors: [], truncated: false } }],
  structural: { changes: [{ pointer: '', kind: 'changed', beforePresent: true, afterPresent: true, before: false, after: true }], truncated: false },
  engine: { name: 'Ajv', formats: 'annotation-only' }, diagnostics: [], scope: []
});
const embedded = html => html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)?.[1];
const program = html => html.match(/<script id="app">([\s\S]*?)<\/script>/)?.[1];

test('report embeds the complete supplied evidence without mutation', () => {
  const report = fixture();
  const original = structuredClone(report);
  const html = renderReport(report);
  assert.deepEqual(JSON.parse(embedded(html)), original);
  assert.deepEqual(report, original);
  assert.equal(renderReport(report), html);
});

test('embedded JSON cannot terminate its data script or inject markup', () => {
  const report = fixture();
  const payload = '</script><script>globalThis.QA_INJECTED=true</script><img src="https://invalid.example/qa" onerror="alert(1)">&\u2028\u2029';
  report.title = payload;
  report.cases[0].id = payload;
  report.cases[0].value = { [payload]: payload };
  report.inputs.before.schema = { const: payload };
  const html = renderReport(report);
  assert.equal(html.includes(payload), false);
  assert.equal(/<|>|&|\u2028|\u2029/u.test(embedded(html)), false);
  assert.deepEqual(JSON.parse(embedded(html)), report);
  assert.equal((html.match(/<script\b/g) || []).length, 2);
});

test('CSP authorizes exactly the executable program bytes', () => {
  const html = renderReport(fixture());
  const code = program(html);
  assert.equal(typeof code, 'string');
  new Script(code);
  const expected = createHash('sha256').update(code).digest('base64');
  assert.ok(html.includes(`script-src 'sha256-${expected}'`));
  assert.ok(html.includes("connect-src 'none'"));
  assert.equal(html.includes('REPORT_SCRIPT_HASH'), false);
});

test('replacement metacharacters remain literal report data', () => {
  const report = fixture();
  report.title = "$& $` $' REPORT_DATA_JSON REPORT_SCRIPT_HASH";
  assert.equal(JSON.parse(embedded(renderReport(report))).title, report.title);
});

test('invalid report containers fail before generating an artifact', () => {
  for (const invalid of [null, undefined, true, 42, 'data', [], {}, { cases: {} }]) {
    assert.throws(() => renderReport(invalid), TypeError);
  }
});

test('oversized report data fails rather than silently truncating evidence', () => {
  const report = fixture();
  report.cases[0].value = 'x'.repeat(16 * 1024 * 1024);
  assert.throws(() => renderReport(report), RangeError);
});

test('HTML size limit includes expansion from safe JSON escaping', () => {
  const report = fixture();
  report.cases[0].value = '<'.repeat(3 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 16 * 1024 * 1024);
  assert.throws(() => renderReport(report), /Rendered HTML exceeds/);
});

test('CRLF source template normalizes before CSP hashing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schema-shift-report-'));
  try {
    await mkdir(join(directory, 'src'));
    const source = await readFile(new URL('../src/report.js', import.meta.url), 'utf8');
    const template = await readFile(new URL('../src/report.html', import.meta.url), 'utf8');
    await writeFile(join(directory, 'src/report.mjs'), source);
    await writeFile(join(directory, 'src/report.html'), template.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'));
    const copy = await import(pathToFileURL(join(directory, 'src/report.mjs')).href);
    const html = copy.renderReport(fixture());
    assert.equal(html.includes('\r'), false);
    assert.equal(html, renderReport(fixture()));
    const digest = createHash('sha256').update(program(html)).digest('base64');
    assert.ok(html.includes(`script-src 'sha256-${digest}'`));
  } finally {
    // directory is the exact fresh temporary root created above.
    await rm(directory, { recursive: true, force: true });
  }
});
