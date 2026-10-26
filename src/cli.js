#!/usr/bin/env node
import { compareSchemas, parseJsonText, LabError, LIMITS } from './index.js';
import { renderReport } from './report.js';
import { assertNewOutputs, FileError, readRegularText, writeNewOutputs, writeStream } from './io.js';

const VERSION = '0.1.0';
const HELP = `Schema Shift Lab ${VERSION}
Compare two JSON Schema files with an explicit nonempty fixture corpus.

Usage:
  schema-shift-lab compare --before FILE --after FILE --corpus FILE [options]
  schema-shift-lab check   --before FILE --after FILE --corpus FILE [options]

Options:
  --format text|json    Stdout format (default: text)
  --json FILE           Write a new JSON report; never overwrite
  --html FILE           Write a new offline HTML report; never overwrite
  --timeout-ms INTEGER  Worker deadline, ${LIMITS.minTimeoutMs}..${LIMITS.maxTimeoutMs} ms (default: ${LIMITS.defaultTimeoutMs})
  --help               Show this help
  --version            Show version

Exit codes:
  0  No change observed (compare), or all expectations matched (check)
  1  Observed change (compare), or an expectation mismatch (check)
  2  Usage, input, unsupported schema, or I/O error
  3  Incomplete worker execution; unknown is never a successful comparison

Check requires an explicit expect value on every case. Format is annotation
only. Reports include supplied data. A finite corpus cannot prove equivalence.
`;

function usage() { throw new FileError('USAGE'); }

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--version') return { information: `${VERSION}\n` };
  if ((args.length === 1 && args[0] === '--help') || (args.length === 2 && ['compare', 'check'].includes(args[0]) && args[1] === '--help')) return { information: HELP };
  const [mode, ...rest] = args;
  if (!['compare', 'check'].includes(mode)) usage();
  const options = { mode, format: 'text', timeoutMs: LIMITS.defaultTimeoutMs };
  const seen = new Set();
  const names = new Map([
    ['--before', 'before'], ['--after', 'after'], ['--corpus', 'corpus'],
    ['--format', 'format'], ['--json', 'json'], ['--html', 'html'], ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!names.has(flag) || seen.has(flag)) usage();
    const value = rest[i + 1];
    if (!value || value.startsWith('--') || value.includes('\0')) usage();
    seen.add(flag);
    options[names.get(flag)] = value;
  }
  if (!options.before || !options.after || !options.corpus || !['text', 'json'].includes(options.format)) usage();
  if (typeof options.timeoutMs === 'string') {
    if (!/^[0-9]+$/.test(options.timeoutMs)) usage();
    options.timeoutMs = Number(options.timeoutMs);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < LIMITS.minTimeoutMs || options.timeoutMs > LIMITS.maxTimeoutMs) usage();
  }
  return options;
}

function textReport(report) {
  const s = report.summary;
  return [
    `Schema Shift Lab: ${report.outcome} (${report.mode})`,
    `Cases: ${s.caseCount}; accepted both: ${s.acceptedBoth}; rejected both: ${s.rejectedBoth}`,
    `Widened: ${s.widened}; narrowed: ${s.narrowed}; unknown: ${s.unknown}`,
    `Expectations matched: ${s.expectationsMatched}; mismatched: ${s.expectationMismatches}`,
    'Format is annotation only. No observed difference is not proof of equivalence.',
    'Reports contain the supplied schemas and fixture values.',
    '',
  ].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.information) {
    await writeStream(process.stdout, options.information);
    return 0;
  }
  assertNewOutputs([options.json, options.html].filter(Boolean));
  const before = parseJsonText(readRegularText(options.before, LIMITS.inputBytes));
  const after = parseJsonText(readRegularText(options.after, LIMITS.inputBytes));
  const corpus = parseJsonText(readRegularText(options.corpus, LIMITS.inputBytes));
  const report = await compareSchemas(before, after, corpus, { mode: options.mode, timeoutMs: options.timeoutMs });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(json) > LIMITS.outputBytes) throw new FileError('OUTPUT_TOO_LARGE');
  const outputs = [];
  if (options.json) outputs.push({ filename: options.json, text: json });
  if (options.html) {
    const html = renderReport(report);
    if (Buffer.byteLength(html) > LIMITS.outputBytes) throw new FileError('OUTPUT_TOO_LARGE');
    outputs.push({ filename: options.html, text: html });
  }
  // Confirm stdout is writable before publishing any requested files.
  await writeStream(process.stdout, options.format === 'json' ? json : textReport(report));
  writeNewOutputs(outputs, LIMITS.outputBytes);
  if (report.status !== 'complete' || report.outcome === 'unknown') return 3;
  return ['changed', 'expectation-mismatch'].includes(report.outcome) ? 1 : 0;
}

// Stream errors can arrive after a write callback. Keep them handled through exit.
process.stdout.on('error', () => { process.exitCode = 2; });
process.stderr.on('error', () => { process.exitCode = 2; });
try {
  const code = await main();
  if (process.exitCode !== 2) process.exitCode = code;
} catch (error) {
  process.exitCode = 2;
  const code = (error instanceof FileError || error instanceof LabError) && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(error.code) ? error.code : 'OPERATION_FAILED';
  const messages = {
    USAGE: 'Use --help for usage.', INPUT_NOT_REGULAR: 'Inputs must be ordinary files, not symlinks or special files.',
    INPUT_IO: 'An input file could not be read.', INPUT_TOO_LARGE: 'An input exceeds the byte limit.',
    INPUT_CHANGED: 'An input changed while being read; retry with a stable file.', INPUT_UTF8: 'Inputs must be valid UTF-8.',
    OUTPUT_EXISTS: 'A report destination already exists; choose a new filename.', OUTPUT_DUPLICATE: 'JSON and HTML need distinct destinations.',
    OUTPUT_PARENT: 'Report parent directories must already exist.', OUTPUT_IO: 'Output could not be written.',
    OUTPUT_TOO_LARGE: 'A report exceeds the output byte limit.',
  };
  const explanation = error instanceof LabError ? error.message : (messages[code] ?? 'Comparison could not be completed.');
  try { await writeStream(process.stderr, `schema-shift-lab: ${code}. ${explanation}\n`); } catch { /* Exit 2 also covers a closed diagnostic stream. */ }
}
