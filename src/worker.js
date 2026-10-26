import { parentPort, workerData } from 'node:worker_threads';
import Ajv2020 from 'ajv/dist/2020.js';
import { ENGINE_OPTIONS } from './engine.js';

function run() {
  const validators = [];
  for (const side of ['before', 'after']) {
    try {
      const ajv = new Ajv2020({ ...ENGINE_OPTIONS, logger: false });
      if (!ajv.validateSchema(workerData[side])) { parentPort.postMessage({ type: 'schema-error', side }); return; }
      validators.push(ajv.compile(workerData[side]));
    } catch { parentPort.postMessage({ type: 'schema-error', side }); return; }
  }
  const cases = workerData.corpus.cases.map(item => {
    const results = validators.map(validate => {
      const valid = validate(item.value); const errors = validate.errors ?? [];
      return { valid, errors: errors.slice(0, workerData.errorsPerSide).map(error => ({ keyword: error.keyword, instancePath: error.instancePath, schemaPath: error.schemaPath, message: error.message ?? 'Validation failed.' })), errorCount: errors.length, truncated: errors.length > workerData.errorsPerSide };
    });
    return { before: results[0], after: results[1] };
  });
  parentPort.postMessage({ type: 'complete', cases });
}
if (parentPort) { try { run(); } catch { parentPort.postMessage({ type: 'worker-failed' }); } }
