import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareSchemas, parseJsonText } from '../src/index.js';
import { renderReport } from '../src/report.js';

const example = new URL('../examples/support-ticket/', import.meta.url);
const read = (name) => parseJsonText(fs.readFileSync(new URL(name, example), 'utf8'));
const report = await compareSchemas(read('before.schema.json'), read('after.schema.json'), read('corpus.json'), {
  mode: 'compare', title: 'Synthetic support-ticket schema comparison',
});
assert.equal(report.status, 'complete');
assert.equal(report.outcome, 'changed');
assert.deepEqual([report.summary.acceptedBoth, report.summary.rejectedBoth, report.summary.widened, report.summary.narrowed], [3, 2, 2, 1]);
report.demo = true;
const docs = new URL('../docs/', import.meta.url);
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(new URL('demo.json', docs), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
fs.writeFileSync(new URL('index.html', docs), renderReport(report), 'utf8');
fs.writeFileSync(new URL('.nojekyll', docs), '', 'utf8');
console.log('Generated synthetic demo: 8 fixtures, 2 widened, 1 narrowed; no equivalence claim.');
