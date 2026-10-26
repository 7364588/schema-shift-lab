import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--artifacts')) throw new Error('Use --artifacts DIRECTORY');
const destination = args[1] ? path.resolve(args[1]) : path.join(root, '.package-check/artifacts');
const npmCli = process.env.npm_execpath;
if (!npmCli || !fs.existsSync(npmCli)) throw new Error('Run this script with npm run verify-package');
fs.mkdirSync(destination, { recursive: true });
const staging = fs.mkdtempSync(path.join(destination, 'installed-'));
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Package command failed: ${args[0]} (exit ${result.status})`);
  return result.stdout;
}
try {
  const packResult = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', destination]));
  // npm 10/11 return an array; npm 12 keys the result by package name.
  const packed = Array.isArray(packResult) ? packResult : Object.values(packResult);
  assert.equal(packed.length, 1);
  const archive = path.join(destination, packed[0].filename);
  const names = packed[0].files.map(({ path: name }) => name);
  for (const required of ['src/index.js', 'src/cli.js', 'src/report.js', 'src/report.html', 'examples/support-ticket/corpus.json', 'LICENSE']) assert.ok(names.includes(required), `Archive missing ${required}`);
  assert.ok(names.some((name) => /worker.*\.js$/.test(name)), 'Archive missing worker');
  assert.ok(!names.some((name) => name.startsWith('node_modules/') || name.startsWith('.git/') || name.startsWith('work/') || name.startsWith('.package-check/')));
  fs.writeFileSync(path.join(staging, 'package.json'), '{"private":true,"type":"module"}\n');
  run(['install', '--prefix', staging, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive], staging);
  const installed = path.join(staging, 'node_modules/schema-shift-lab');
  fs.writeFileSync(path.join(staging, 'exports-smoke.mjs'), `import assert from 'node:assert/strict';\nimport { compareSchemas } from 'schema-shift-lab';\nimport { renderReport } from 'schema-shift-lab/report';\nconst report = await compareSchemas(true, false, { cases: [{ id: 'package-export', value: null }] });\nassert.equal(report.outcome, 'changed');\nassert.match(renderReport(report), /Content-Security-Policy/);\n`);
  const exported = spawnSync(process.execPath, [path.join(staging, 'exports-smoke.mjs')], { cwd: staging, encoding: 'utf8', timeout: 15000 });
  assert.equal(exported.status, 0, exported.stderr);
  const smoke = spawnSync(process.execPath, [path.join(root, 'scripts/smoke.js'), '--package-root', installed], { cwd: staging, encoding: 'utf8', timeout: 90000 });
  assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
  const bin = path.join(staging, 'node_modules/.bin', process.platform === 'win32' ? 'schema-shift-lab.cmd' : 'schema-shift-lab');
  assert.ok(fs.existsSync(bin));
  // npm executes the installed platform wrapper without constructing shell text.
  assert.equal(run(['exec', '--offline', '--prefix', staging, '--', 'schema-shift-lab', '--version'], staging).trim(), '0.1.0');
  assert.match(run(['exec', '--offline', '--prefix', staging, '--', 'schema-shift-lab', '--help'], staging), /Usage:/);
  const cliTests = spawnSync(process.execPath, ['--test', path.join(root, 'tests/cli.test.js'), path.join(root, 'tests/io.test.js')], {
    cwd: staging, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, SCHEMA_SHIFT_LAB_PACKAGE_ROOT: installed },
  });
  assert.equal(cliTests.status, 0, cliTests.stderr || cliTests.stdout);
  fs.writeFileSync(path.join(path.dirname(destination), 'installed-cli-tests.log'), cliTests.stdout);
  const report = {
    status: 'passed', archive: path.basename(archive), bytes: fs.statSync(archive).size,
    sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    installedSmoke: JSON.parse(smoke.stdout), installedBin: true, packageExports: true,
    installedCliAndIoSuite: true,
    lifecycleScriptsDisabled: true, archiveFiles: names,
  };
  fs.writeFileSync(path.join(path.dirname(destination), 'package-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
