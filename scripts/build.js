import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const directory of ['src', 'scripts', 'tests']) {
  for (const name of fs.readdirSync(path.join(root, directory)).filter((name) => name.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, name)], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`JavaScript syntax check failed: ${directory}/${name}`);
  }
}
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.bin['schema-shift-lab'], 'src/cli.js');
assert.ok(packageJson.files.includes('src'));
assert.ok(fs.statSync(path.join(root, 'src/report.html')).isFile());
const api = await import(new URL('../src/index.js', import.meta.url));
assert.equal(typeof api.compareSchemas, 'function');
assert.equal(typeof api.parseJsonText, 'function');
assert.equal(typeof api.LabError, 'function');
console.log('ES modules, package entry points, and report template verified. No transpilation required.');
