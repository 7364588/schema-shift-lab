import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { LabError, LIMITS, DIALECT, canonicalJson, snapshotJson, validateCorpus, validateOptions, inspectSchema, pointerEscape } from './input.js';
import { ENGINE_OPTIONS, ENGINE_VERSION } from './engine.js';

const sha = text => createHash('sha256').update(text).digest('hex');
function structuralDiff(before, after) {
  const changes = []; let truncated = false;
  const walk = (left, right, pointer, beforePresent = true, afterPresent = true) => {
    if (canonicalJson(left) === canonicalJson(right) && beforePresent === afterPresent) return;
    if (changes.length >= LIMITS.changes) { truncated = true; return; }
    const objects = beforePresent && afterPresent && left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right);
    if (objects) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        const lp = Object.prototype.hasOwnProperty.call(left, key), rp = Object.prototype.hasOwnProperty.call(right, key);
        walk(lp ? left[key] : null, rp ? right[key] : null, `${pointer}/${pointerEscape(key)}`, lp, rp);
      }
    } else changes.push({ pointer, kind: !beforePresent ? 'added' : !afterPresent ? 'removed' : 'changed', beforePresent, afterPresent, before: beforePresent ? left : null, after: afterPresent ? right : null });
  };
  walk(before, after, ''); return { changes, truncated, limit: LIMITS.changes };
}
function evaluate(before, after, corpus, options) {
  return new Promise(resolve => {
    let settled = false, timer; let worker;
    const finish = value => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (worker) { worker.removeAllListeners(); worker.on('error', () => {}); void worker.terminate(); }
      resolve(value);
    };
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { before, after, corpus, errorsPerSide: LIMITS.errorsPerSide }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: options.memoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      timer = setTimeout(() => finish({ type: 'worker-timeout' }), options.timeoutMs);
      worker.on('message', message => finish(message)); worker.on('error', () => finish({ type: 'worker-failed' })); worker.on('exit', () => finish({ type: 'worker-failed' }));
    } catch { finish({ type: 'worker-failed' }); }
  });
}
export async function compareSchemas(beforeInput, afterInput, corpusInput, optionInput = {}) {
  const options = validateOptions(optionInput);
  const before = snapshotJson(beforeInput), after = snapshotJson(afterInput), corpus = snapshotJson(corpusInput);
  validateCorpus(corpus.value, options.mode); const beforeDialect = inspectSchema(before.value), afterDialect = inspectSchema(after.value);
  const structural = structuralDiff(before.value, after.value);
  const evaluated = await evaluate(before.value, after.value, corpus.value, options);
  if (evaluated.type === 'schema-error') throw new LabError('invalid-schema', `The ${evaluated.side} schema could not be validated or compiled under the supported Draft 2020-12 policy.`);
  const complete = evaluated.type === 'complete';
  const unknown = () => ({ valid: null, errors: [], errorCount: 0, truncated: false });
  const cases = corpus.value.cases.map((item, index) => {
    const validation = complete ? evaluated.cases[index] : { before: unknown(), after: unknown() };
    const classification = !complete ? 'unknown' : validation.before.valid ? validation.after.valid ? 'accepted-both' : 'narrowed' : validation.after.valid ? 'widened' : 'rejected-both';
    const expected = item.expect ?? null, expectation = expected === null ? 'undeclared' : !complete ? 'unknown' : classification === expected ? 'matched' : 'mismatched';
    return { id: item.id, value: item.value, classification, expected, expectation, ...validation };
  });
  const summary = { caseCount: cases.length, evaluatedCount: complete ? cases.length : 0, acceptedBoth: 0, rejectedBoth: 0, widened: 0, narrowed: 0, unknown: 0, expectationsDeclared: 0, expectationsMatched: 0, expectationMismatches: 0 };
  for (const item of cases) {
    summary[{ 'accepted-both': 'acceptedBoth', 'rejected-both': 'rejectedBoth', widened: 'widened', narrowed: 'narrowed', unknown: 'unknown' }[item.classification]]++;
    if (item.expected !== null) summary.expectationsDeclared++;
    if (item.expectation === 'matched') summary.expectationsMatched++;
    if (item.expectation === 'mismatched') summary.expectationMismatches++;
  }
  const outcome = !complete ? 'unknown' : options.mode === 'check' ? summary.expectationMismatches ? 'expectation-mismatch' : 'expectations-met' : summary.widened + summary.narrowed ? 'changed' : 'no-observed-change';
  const report = {
    format: 'schema-shift-lab/report/v1', title: options.title, status: complete ? 'complete' : 'incomplete', mode: options.mode, outcome,
    engine: { name: 'Ajv', version: ENGINE_VERSION, dialect: DIALECT, formats: 'annotation-only', options: { ...ENGINE_OPTIONS } },
    inputs: { before: { sha256: sha(before.canonical), ...beforeDialect, schema: before.value }, after: { sha256: sha(after.canonical), ...afterDialect, schema: after.value }, corpus: { sha256: sha(corpus.canonical), caseCount: cases.length } },
    summary, cases, structural,
    limits: { inputBytes: LIMITS.inputBytes, depth: LIMITS.depth, nodes: LIMITS.nodes, cases: LIMITS.cases, idLength: LIMITS.idLength, errorsPerSide: LIMITS.errorsPerSide, changes: LIMITS.changes, outputBytes: LIMITS.outputBytes, timeoutMs: options.timeoutMs, memoryMb: options.memoryMb },
    diagnostics: [{ code: 'formats-annotation-only', message: 'Formats and content keywords are annotations; no format assertion was performed.' }, { code: 'binary64-numbers', message: 'Numbers use JavaScript binary64 semantics; fractional values can be approximations. Hashes use key-sorted JSON serialization, not an RFC 8785 certification.' }],
    scope: ['Only the supplied corpus was evaluated; no difference is not a proof of schema equivalence.', 'Reports contain supplied schemas and cases and are not redacted.', 'This compares local JSON Schema validation, not a provider\'s enforcement.', 'The worker resource limits bound this validator task; they are not a sandbox for arbitrary executable code.'], demo: false
  };
  if (!complete) report.diagnostics.push({ code: evaluated.type === 'worker-timeout' ? 'worker-timeout' : 'worker-failed', message: evaluated.type === 'worker-timeout' ? 'The compile-and-validation worker exceeded its deadline. No case result is claimed.' : 'The compile-and-validation worker failed or exhausted resources. No case result is claimed.' });
  if (structural.truncated) report.diagnostics.push({ code: 'structural-truncation', message: 'The structural change list reached its display limit; schema inputs remain available for inspection.' });
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > LIMITS.outputBytes) throw new LabError('output-limit', 'The report exceeds the output byte limit.');
  return report;
}
