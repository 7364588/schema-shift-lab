export class LabError extends Error {
  constructor(code, message) { super(message); this.name = 'LabError'; this.code = code; }
}
export const LIMITS = Object.freeze({ inputBytes: 1048576, depth: 64, nodes: 50000, cases: 256, idLength: 128, errorsPerSide: 20, changes: 500, outputBytes: 16777216, defaultTimeoutMs: 3000, minTimeoutMs: 10, maxTimeoutMs: 10000, defaultMemoryMb: 64, minMemoryMb: 32, maxMemoryMb: 256 });
export const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export const OUTCOMES = Object.freeze(['accepted-both', 'rejected-both', 'widened', 'narrowed']);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (message, code = 'invalid-input') => { throw new LabError(code, message); };
function numeric(value) { if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('JSON numbers must be finite and integral numbers must be safe integers.', 'invalid-number'); }

export function assertJson(value) {
  let nodes = 0; const active = new WeakSet();
  function walk(item, depth) {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('JSON input exceeds the node or nesting limit.', 'input-limit');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') { numeric(item); return; }
    if (typeof item !== 'object' || !(Array.isArray(item) ? Object.getPrototypeOf(item) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(item)))) fail('Inputs must contain only plain JSON values.');
    if (active.has(item)) fail('Cyclic input is not JSON.'); active.add(item);
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item)) {
      if (item.length > LIMITS.nodes || keys.length !== item.length + 1) fail('JSON arrays must be dense and have no custom properties.');
      for (let i = 0; i < item.length; i++) if (!has(item, String(i))) fail('JSON arrays must be dense.');
    }
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string') fail('Symbol keys are not JSON.');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor.enumerable || !has(descriptor, 'value')) fail('JSON input must not contain accessors or hidden properties.');
      walk(descriptor.value, depth + 1);
    }
    active.delete(item);
  }
  walk(value, 0);
}
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export function snapshotJson(value) {
  assertJson(value); const text = canonicalJson(value);
  if (Buffer.byteLength(text, 'utf8') > LIMITS.inputBytes) fail('JSON input exceeds the byte limit.', 'input-limit');
  return { value: JSON.parse(text), canonical: text };
}
export function parseJsonText(text) {
  if (typeof text !== 'string') fail('JSON input must be text.');
  if (Buffer.byteLength(text, 'utf8') > LIMITS.inputBytes) fail('JSON input exceeds the byte limit.', 'input-limit');
  let value; try { value = JSON.parse(text); } catch { fail('Input must be valid JSON.', 'invalid-json'); }
  const stack = []; let nodes = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') {
      stack.push(text[i] === '{' ? new Set() : null);
      if (stack.length > LIMITS.depth + 1) fail('JSON input exceeds the nesting limit.', 'input-limit');
    } else if (text[i] === '}' || text[i] === ']') stack.pop();
    else if (text[i] === '"') {
      const start = i++; for (; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') break; }
      let next = i + 1; while (/\s/u.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') { const key = JSON.parse(text.slice(start, i + 1)); if (stack.at(-1).has(key)) fail('JSON input contains duplicate object keys.', 'duplicate-key'); stack.at(-1).add(key); }
      if (++nodes > LIMITS.nodes * 2) fail('JSON input exceeds the token limit.', 'input-limit');
    } else if (text[i] === '-' || (text[i] >= '0' && text[i] <= '9')) {
      const start = i; while (i + 1 < text.length && /[0-9eE+.-]/u.test(text[i + 1])) i++;
      const token = text.slice(start, i + 1); const number = Number(token); numeric(number);
      if (number === 0 && /[1-9]/u.test(token.split(/[eE]/u)[0])) fail('Nonzero JSON numbers must not underflow to zero.', 'invalid-number');
    }
  }
  assertJson(value); return value;
}

export function validateCorpus(corpus, mode) {
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus) || Object.keys(corpus).some(key => key !== 'cases') || !Array.isArray(corpus.cases) || corpus.cases.length < 1 || corpus.cases.length > LIMITS.cases) fail(`Corpus must contain 1 to ${LIMITS.cases} cases and no unknown fields.`);
  const ids = new Set();
  for (const item of corpus.cases) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'value', 'expect'].includes(key)) || !has(item, 'value')) fail('Each case must contain id and value, with optional expect only.');
    if (typeof item.id !== 'string' || !item.id.length || item.id.length > LIMITS.idLength || /[\u0000-\u001f\u007f]/u.test(item.id) || ids.has(item.id)) fail('Case IDs must be unique nonempty strings without controls, within the length limit.');
    ids.add(item.id);
    if (has(item, 'expect') && !OUTCOMES.includes(item.expect)) fail('Case expectations must name a concrete acceptance classification.');
    if (mode === 'check' && !has(item, 'expect')) fail('Check mode requires an expectation for every case.', 'missing-expectation');
  }
  return corpus;
}
export function validateOptions(options = {}) {
  assertJson(options);
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['mode', 'timeoutMs', 'memoryMb', 'title'].includes(key))) fail('Unsupported comparison options.');
  const mode = options.mode ?? 'compare', timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs, memoryMb = options.memoryMb ?? LIMITS.defaultMemoryMb, title = options.title ?? 'Schema comparison';
  if (!['compare', 'check'].includes(mode)) fail('mode must be compare or check.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < LIMITS.minTimeoutMs || timeoutMs > LIMITS.maxTimeoutMs) fail('timeoutMs must be an integer from 10 to 10000.');
  if (!Number.isInteger(memoryMb) || memoryMb < LIMITS.minMemoryMb || memoryMb > LIMITS.maxMemoryMb) fail('memoryMb must be an integer from 32 to 256.');
  if (typeof title !== 'string' || !title.length || title.length > 160 || /[\u0000-\u001f\u007f]/u.test(title)) fail('title must be a short nonempty string without controls.');
  return { mode, timeoutMs, memoryMb, title };
}

const KNOWN = new Set(['$schema', '$ref', '$defs', '$comment', 'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains', 'maxProperties', 'minProperties', 'required', 'dependentRequired', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'properties', 'patternProperties', 'additionalProperties', 'propertyNames', 'dependentSchemas', 'items', 'prefixItems', 'contains', 'unevaluatedItems', 'unevaluatedProperties', 'title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples', 'format', 'contentEncoding', 'contentMediaType', 'contentSchema']);
const MAPS = new Set(['$defs', 'properties', 'patternProperties', 'dependentSchemas']);
const ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SINGLE = new Set(['not', 'if', 'then', 'else', 'additionalProperties', 'propertyNames', 'items', 'contains', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema']);
const pointerEscape = value => value.replaceAll('~', '~0').replaceAll('/', '~1');
export { pointerEscape };
export function inspectSchema(schema) {
  const visited = new Set(); const stack = [{ value: schema, pointer: '' }];
  const lookup = ref => {
    if (typeof ref !== 'string' || !ref.startsWith('#')) fail('Only local root JSON Pointer references are supported.', 'unsupported-reference');
    let fragment; try { fragment = decodeURIComponent(ref.slice(1)); } catch { fail('Reference fragment is not valid URI encoding.', 'unsupported-reference'); }
    if (fragment !== '' && !fragment.startsWith('/')) fail('Anchor references are not supported; use root JSON Pointers.', 'unsupported-reference');
    let target = schema;
    for (const raw of fragment === '' ? [] : fragment.slice(1).split('/')) {
      if (/~(?:[^01]|$)/u.test(raw)) fail('Reference contains invalid JSON Pointer escaping.', 'unsupported-reference');
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!target || typeof target !== 'object' || !has(target, key)) fail('Local reference target does not exist.', 'unresolved-reference');
      target = target[key];
    }
    return { value: target, pointer: fragment };
  };
  while (stack.length) {
    const { value, pointer } = stack.pop(); if (visited.has(pointer)) continue; visited.add(pointer);
    if (typeof value === 'boolean') continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Schema locations must be objects or booleans.', 'invalid-schema');
    for (const [key, child] of Object.entries(value)) {
      if (['$id', '$anchor', '$dynamicRef', '$dynamicAnchor', '$vocabulary'].includes(key)) fail('Schema IDs, anchors, dynamic references and custom vocabularies are outside the supported subset.', 'unsupported-schema');
      if (!KNOWN.has(key)) fail('Schema contains a keyword outside the supported Draft 2020-12 subset.', 'unsupported-keyword');
      if (key === '$schema' && (pointer !== '' || ![DIALECT, `${DIALECT}#`].includes(child))) fail('Only a root Draft 2020-12 dialect declaration is supported.', 'unsupported-dialect');
      if (key === '$ref') stack.push(lookup(child));
      const childPointer = `${pointer}/${pointerEscape(key)}`;
      if (MAPS.has(key)) {
        if (!child || typeof child !== 'object' || Array.isArray(child)) fail('Schema map keyword must contain an object.', 'invalid-schema');
        if (has(child, '__proto__')) fail('The __proto__ key in schema maps is not supported by this validator boundary.', 'unsupported-prototype-key');
        for (const [name, sub] of Object.entries(child)) stack.push({ value: sub, pointer: `${childPointer}/${pointerEscape(name)}` });
      } else if (ARRAYS.has(key)) {
        if (!Array.isArray(child)) fail('Schema applicator keyword must contain an array.', 'invalid-schema');
        child.forEach((sub, index) => stack.push({ value: sub, pointer: `${childPointer}/${index}` }));
      } else if (SINGLE.has(key)) stack.push({ value: child, pointer: childPointer });
      else if (key === 'dependentRequired' && child && typeof child === 'object' && has(child, '__proto__')) fail('The __proto__ key in schema maps is not supported by this validator boundary.', 'unsupported-prototype-key');
    }
  }
  return { dialect: DIALECT, declaredDialect: typeof schema === 'object' && has(schema, '$schema') };
}
