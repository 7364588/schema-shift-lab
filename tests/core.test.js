import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compareSchemas, parseJsonText, LabError, LIMITS } from '../src/index.js';
const corpus = (...values) => ({ cases: values.map((value, i) => ({ id: `case-${i}`, value })) });
const classify = async (before, after, value) => (await compareSchemas(before, after, corpus(value))).cases[0].classification;

test('boolean schemas give all four concrete classifications', async () => {
  assert.equal(await classify(true, true, null), 'accepted-both');
  assert.equal(await classify(false, false, 42), 'rejected-both');
  assert.equal(await classify(false, true, {}), 'widened');
  assert.equal(await classify(true, false, []), 'narrowed');
});
test('numeric and string constraints produce concrete widening witnesses', async () => {
  const report = await compareSchemas({ type: 'object', properties: { n: { type: 'number', maximum: 5 }, s: { type: 'string', minLength: 3 } } }, { type: 'object', properties: { n: { type: 'number' }, s: { type: 'string' } } }, corpus({ n: 9 }, { s: 'x' }));
  assert.equal(report.summary.widened, 2); assert.equal(report.outcome, 'changed');
  assert.equal(report.cases[0].before.errors[0].instancePath, '/n');
  assert.equal(report.cases[0].before.errors[0].schemaPath, '#/properties/n/maximum');
});
test('required nullable property distinguishes absent from null', async () => {
  const before = { type: 'object', properties: { note: { type: ['string', 'null'] } } };
  const after = { ...before, required: ['note'] };
  const report = await compareSchemas(before, after, corpus({}, { note: null }, { note: 'ok' }));
  assert.deepEqual(report.cases.map(c => c.classification), ['narrowed', 'accepted-both', 'accepted-both']);
});
test('standard composition and unevaluatedProperties use actual validator semantics', async () => {
  const schema = { type: 'object', allOf: [{ properties: { a: { type: 'integer' } } }, { properties: { b: { type: 'string' } } }], unevaluatedProperties: false };
  const report = await compareSchemas(schema, schema, corpus({ a: 1, b: 'x' }, { a: 1, extra: true }));
  assert.deepEqual(report.cases.map(c => c.classification), ['accepted-both', 'rejected-both']);
});
test('oneOf, contains, prefixItems and dependentSchemas are enforced', async () => {
  const schema = { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'integer' }, contains: { const: 2 }, minContains: 1 };
  const report = await compareSchemas(schema, schema, corpus(['x', 2], ['x', 3], [2, 2]));
  assert.deepEqual(report.cases.map(c => c.classification), ['accepted-both', 'rejected-both', 'rejected-both']);
  const object = { type: 'object', dependentSchemas: { a: { required: ['b'] } }, properties: { b: { oneOf: [{ const: 'x' }, { const: 'y' }] } } };
  assert.equal(await classify(object, object, { a: true }), 'rejected-both');
});
test('if then else validation works; standalone conditions follow the specification', async () => {
  const schema = { type: 'object', properties: { kind: { type: 'string' }, count: { type: 'number' } }, if: { properties: { kind: { const: 'large' } }, required: ['kind'] }, then: { properties: { count: { minimum: 10 } } }, else: { properties: { count: { maximum: 5 } } } };
  const report = await compareSchemas(schema, schema, corpus({ kind: 'large', count: 9 }, { kind: 'small', count: 4 }));
  assert.deepEqual(report.cases.map(c => c.classification), ['rejected-both', 'accepted-both']);
  assert.equal(await classify({ if: { type: 'string' } }, { then: false }, 'x'), 'accepted-both');
  assert.equal(await classify({ type: 'array', contains: { type: 'integer' }, minContains: 0 }, true, ['x']), 'accepted-both');
});
test('format and content keywords are annotations, even unknown formats', async () => {
  const schema = { type: 'string', format: 'email', contentEncoding: 'base64', contentMediaType: 'application/json', contentSchema: { type: 'number' } };
  const report = await compareSchemas(schema, { type: 'string', format: 'not-a-custom-assertion' }, corpus('not email or base64'));
  assert.equal(report.cases[0].classification, 'accepted-both'); assert.equal(report.engine.formats, 'annotation-only'); assert.equal(report.engine.options.validateFormats, false);
});
test('default and const data are not interpreted as schema keywords', async () => {
  const data = { $ref: 'https://invalid.example/schema', $id: 'data-only', futureKeyword: true };
  const report = await compareSchemas({ const: data }, { const: data, default: data, examples: [data] }, corpus(data));
  assert.equal(report.cases[0].classification, 'accepted-both');
});
test('local references support escaped pointers and percent encoding', async () => {
  const schema = { $defs: { 'a/b~c': { type: 'integer' }, 'with space': { type: 'string' } }, type: 'object', properties: { 'x/y': { $ref: '#/$defs/a~1b~0c' }, s: { $ref: '#/$defs/with%20space' } } };
  const report = await compareSchemas(schema, schema, corpus({ 'x/y': 'bad' }, { 'x/y': 1, s: 'ok' }));
  assert.equal(report.cases[0].before.errors[0].instancePath, '/x~1y'); assert.equal(report.cases[1].classification, 'accepted-both');
});
test('local recursive schema validates finite values without resolving files or network', async () => {
  const schema = { type: 'object', properties: { value: { type: 'integer' }, next: { $ref: '#' } }, additionalProperties: false };
  const report = await compareSchemas(schema, schema, corpus({ value: 1, next: { value: 2 } }, { next: { value: 'bad' } }));
  assert.deepEqual(report.cases.map(c => c.classification), ['accepted-both', 'rejected-both']);
});
test('refs to data positions are inspected when explicitly used as schemas', async () => {
  const schema = { default: { $ref: 'https://invalid.example/schema' }, $ref: '#/default' };
  await assert.rejects(compareSchemas(schema, true, corpus(1)), error => error.code === 'unsupported-reference');
});
test('validator-unsupported prototype schema-map keys fail closed without a witness', async () => {
  for (const key of ['properties', '$defs', 'patternProperties', 'dependentSchemas', 'dependentRequired']) {
    const schema = JSON.parse(`{"${key}":{"__proto__":${key === 'dependentRequired' ? '[]' : '{"type":"integer"}'}}}`);
    await assert.rejects(compareSchemas(schema, true, corpus(JSON.parse('{"__proto__":3}'))), error => error.code === 'unsupported-prototype-key');
  }
  const data = JSON.parse('{"__proto__":3}'); assert.equal(await classify({ const: data }, { const: data }, data), 'accepted-both');
});
test('external, anchor, broken and malformed pointer refs rejected', async () => {
  for (const ref of ['other.json', 'file:///schema.json', 'https://invalid.example/a', '#anchor', '#/missing', '#/%ff', '#/bad~9']) await assert.rejects(compareSchemas({ $ref: ref }, true, corpus(1)), LabError);
});
test('draft explicitly declared or defaulted; other dialects and vocabularies rejected', async () => {
  const report = await compareSchemas({ $schema: 'https://json-schema.org/draft/2020-12/schema#' }, {}, corpus(1));
  assert.equal(report.inputs.before.declaredDialect, true); assert.equal(report.inputs.after.declaredDialect, false);
  for (const schema of [{ $schema: 'http://json-schema.org/draft-07/schema#' }, { $id: 'https://invalid.example/id' }, { $anchor: 'x' }, { $dynamicRef: '#x' }, { $dynamicAnchor: 'x' }, { $vocabulary: {} }, { futureKeyword: true }, { nullable: true }, { $async: true }]) await assert.rejects(compareSchemas(schema, true, corpus(1)), LabError);
});
test('schema meta-validation rejects invalid constraints before evaluating corpus', async () => {
  for (const schema of [{ type: 'not-a-type' }, { minimum: '5' }, { required: 'x' }, { properties: [] }, { anyOf: [] }, { pattern: '[' }]) await assert.rejects(compareSchemas(schema, true, corpus(1)), LabError);
});
test('schemas compile independently, and validation never mutates supplied inputs', async () => {
  const before = { type: 'object', properties: { n: { type: 'integer', default: 1 } }, required: ['n'], additionalProperties: false };
  const after = { type: 'object', properties: { n: { type: 'string', default: 'x' } }, required: ['n'], additionalProperties: false };
  const cases = corpus({}, { n: '1' }, { n: 1, extra: true }); const original = structuredClone({ before, after, cases });
  const report = await compareSchemas(before, after, cases);
  assert.deepEqual({ before, after, cases }, original); assert.deepEqual(report.cases.map(c => c.classification), ['rejected-both', 'widened', 'rejected-both']);
});
test('check mode requires all expectations and differentiates expectation mismatch', async () => {
  await assert.rejects(compareSchemas(true, true, corpus(1), { mode: 'check' }), error => error.code === 'missing-expectation');
  const cases = { cases: [{ id: 'x', value: 1, expect: 'widened' }] };
  assert.equal((await compareSchemas(false, true, cases, { mode: 'check' })).outcome, 'expectations-met');
  const wrong = await compareSchemas(true, true, cases, { mode: 'check' }); assert.equal(wrong.outcome, 'expectation-mismatch'); assert.equal(wrong.summary.expectationMismatches, 1);
  assert.equal((await compareSchemas(true, true, cases)).outcome, 'no-observed-change');
});
test('empty, duplicate, unknown expectation and extra fields rejected', async () => {
  for (const cases of [{ cases: [] }, { cases: [{ id: 'x', value: 1 }, { id: 'x', value: 2 }] }, { cases: [{ id: 'x', value: 1, expect: 'unknown' }] }, { cases: [{ id: 'x', value: 1, extra: true }] }, { cases: [{ id: 'x' }] }, { cases: [{ id: 'x', value: 1 }], extra: true }]) await assert.rejects(compareSchemas(true, true, cases), LabError);
});
test('duplicate JSON keys reject literal and escape-equivalent names', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}']) assert.throws(() => parseJsonText(text), error => error.code === 'duplicate-key');
  assert.deepEqual(parseJsonText('{"a":"quoted \\\" key","b":{"a":2}}'), { a: 'quoted \" key', b: { a: 2 } });
});
test('unsafe integers overflow underflow rejected; ordinary decimals use binary64', () => {
  for (const text of ['9007199254740992', '9007199254740993', '-9007199254740993', '1e20', '1e309', '1e-400', '-0.0001e-9999']) assert.throws(() => parseJsonText(text), error => error.code === 'invalid-number');
  assert.equal(parseJsonText('9007199254740991'), Number.MAX_SAFE_INTEGER); assert.equal(parseJsonText('0.1'), 0.1); assert.equal(parseJsonText('0e-9999'), 0);
  for (const text of ['NaN', 'Infinity', 'undefined']) assert.throws(() => parseJsonText(text), LabError);
});
test('library inputs reject cycles sparse arrays accessors and non-JSON values', async () => {
  const cycle = {}; cycle.self = cycle; const accessor = {}; Object.defineProperty(accessor, 'x', { get() { throw new Error('must not invoke'); }, enumerable: true });
  for (const value of [cycle, accessor, new Date(), [,,], undefined, 1n, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(compareSchemas(true, true, corpus(value)), LabError);
});
test('input byte nesting node case and option limits enforced', async () => {
  assert.throws(() => parseJsonText(`"${'x'.repeat(LIMITS.inputBytes)}"`), error => error.code === 'input-limit');
  assert.throws(() => parseJsonText(`${'['.repeat(70)}0${']'.repeat(70)}`), error => error.code === 'input-limit');
  await assert.rejects(compareSchemas(true, true, corpus(...Array(257).fill(0))), LabError);
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 10001 }, { memoryMb: 31 }, { memoryMb: 257 }, { extra: true }]) await assert.rejects(compareSchemas(true, true, corpus(1), options), LabError);
});
test('validation error retention has a disclosed cap', async () => {
  const schema = { type: 'object', required: Array.from({ length: 40 }, (_, i) => `p${i}`) };
  const report = await compareSchemas(schema, schema, corpus({}));
  assert.equal(report.cases[0].before.errors.length, 20); assert.equal(report.cases[0].before.errorCount, 40); assert.equal(report.cases[0].before.truncated, true);
});
test('structural differences use escaped pointers and a disclosed cap', async () => {
  const before = { $defs: Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`p${i}`, { title: 'before' }])) };
  const after = { $defs: Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`p${i}`, { title: 'after' }])) };
  const report = await compareSchemas(before, after, corpus(1), { timeoutMs: 10000 }); assert.equal(report.structural.changes.length, 500); assert.equal(report.structural.truncated, true); assert.equal(report.outcome, 'no-observed-change');
  const escaped = await compareSchemas({ properties: { 'a/b~c': { type: 'string' } } }, {}, corpus(1)); assert.equal(escaped.structural.changes[0].pointer, '/properties');
});
test('canonical hashes and reports are deterministic under object-key reordering', async () => {
  const left = await compareSchemas({ minimum: 0, type: 'number' }, true, corpus(1));
  const right = await compareSchemas({ type: 'number', minimum: 0 }, true, corpus(1));
  assert.deepEqual(left, right); assert.match(left.inputs.before.sha256, /^[0-9a-f]{64}$/u);
  const require = createRequire(import.meta.url); assert.equal(left.engine.version, require('ajv/package.json').version); assert.equal(left.engine.options.strictNumbers, true);
});
test('a compile deadline yields incomplete unknown without vacuous success', async () => {
  const report = await compareSchemas(true, true, corpus(1), { timeoutMs: 10 });
  assert.equal(report.status, 'incomplete'); assert.equal(report.outcome, 'unknown'); assert.equal(report.summary.evaluatedCount, 0); assert.equal(report.cases[0].before.valid, null);
});
test('catastrophic validation regex is terminated outside parent event loop', async () => {
  let ticked = false; const timer = setTimeout(() => { ticked = true; }, 50);
  const report = await compareSchemas({ type: 'string', pattern: '^(a+)+$' }, true, corpus(`${'a'.repeat(40)}!`), { timeoutMs: 1000, memoryMb: 32 }); clearTimeout(timer);
  assert.equal(ticked, true); assert.equal(report.outcome, 'unknown'); assert.equal(report.summary.unknown, 1); assert.ok(report.diagnostics.some(item => item.code === 'worker-timeout'));
});
test('synthetic support-ticket fixture has expected bidirectional witnesses', async () => {
  const load = name => parseJsonText(readFileSync(new URL(`../examples/support-ticket/${name}.json`, import.meta.url), 'utf8'));
  const report = await compareSchemas(load('before.schema'), load('after.schema'), load('corpus'), { mode: 'check' });
  assert.equal(report.outcome, 'expectations-met'); assert.equal(report.summary.widened, 2); assert.equal(report.summary.narrowed, 1); assert.equal(report.summary.acceptedBoth, 3); assert.equal(report.summary.rejectedBoth, 2);
});
