# API, CLI and limits

## Library

```js
import { compareSchemas, parseJsonText } from 'schema-shift-lab';

const before = parseJsonText('{"type":"number","maximum":8}');
const after = parseJsonText('{"type":"number"}');
const report = await compareSchemas(before, after, {
  cases: [{ id: 'large-value', value: 13, expect: 'widened' }]
}, { mode: 'check', timeoutMs: 3000, memoryMb: 64 });

console.log(report.outcome); // expectations-met
```

`compareSchemas` returns a promise. Invalid input or schema throws `LabError`
with a controlled `code`. Worker timeout or resource failure returns an incomplete
report with unknown case outcomes. Do not reduce `valid: null` to false. Unknown
never satisfies an expectation or implies no change.

Optional options are `mode`, `timeoutMs`, `memoryMb`, and `title`. Unknown options
are rejected. The library also exports `LIMITS`. CLI flags do not expose the
memory setting or accept executable configuration. Reports use
`format: "schema-shift-lab/report/v1"`.

Canonical hashes recursively sort object keys and serialize compact JSON using
ordinary binary64 number serialization. This is not a claim of RFC 8785
canonicalization. Input order is retained for cases and arrays. No timestamp,
absolute source filename or machine runtime version is added to demo data.

## Supported boundary

Draft 2020-12 is used when `$schema` is absent, or when the canonical HTTPS
dialect URI is supplied (with optional final `#`). Other dialects fail. Local
`$ref` accepts root JSON Pointer fragments, including pointer escapes. External
refs, `$id`, anchors, dynamic refs and custom `$vocabulary` are rejected. Unknown
schema keywords fail instead of silently passing. Instance data inside `const`,
`default` and `examples` is kept as data, unless explicitly referenced as a schema.
Schema maps such as `properties`, `$defs` and `dependentSchemas` cannot contain a
key named `__proto__`: that validator limitation fails closed. Ordinary instance
data with that key remains ordinary JSON and is not silently removed.

Formats and content keywords are annotations. No format assertion, content
decoding or provider-specific enforcement is performed. Defaults, type coercion,
property removal and user-defined keywords are disabled.

Strict JSON text rejects duplicate keys, non-finite numbers, unsafe integral
values, numeric overflow and nonzero numeric underflow. Ordinary fractional
numbers use JavaScript binary64 approximations, including validator arithmetic.
Pass file text through `parseJsonText` to retain duplicate-key and numeric-token
checks; information already lost by an earlier JSON parser cannot be recovered.

## Bounds

| Resource | Limit |
| --- | --- |
| Each UTF-8 JSON input | 1 MiB |
| Nesting | 64 |
| Nodes per input | 50,000 |
| Corpus cases | 256, nonempty |
| Case ID length | 128 |
| Reported errors per case per side | 20; truncation is explicit |
| Structural changes | 500; truncation is explicit |
| Each JSON/HTML output | 16 MiB |
| Worker deadline | 3,000 ms default; configurable 10–10,000 ms |
| Worker V8 old-generation heap | 64 MiB default; API configurable 32–256 MiB |

The worker deadline covers compilation and all validation work. Expiration makes
the comparison incomplete; it does not return partial results as success. The
`memoryMb` bound applies to the V8 old generation; the worker additionally allows
16 MiB for its young generation and 4 MiB for its stack. These are worker resource
limits, not total process or native-memory limits. Strict parsing and report construction occur in the parent with input and
output bounds. Do not use this process as an unisolated public execution service.

## File handling

Files are UTF-8, without a byte-order mark. The CLI reads only the three supplied
inputs; there is no directory scanning. Inputs must be ordinary files, not
symlinks, directories, sockets or FIFOs. Output paths must not exist, including
dangling symlinks. Their parent directories must already exist. The tool does not
create parent directories. Filesystems must support hard links for report output.

`--json` and `--html` may be combined. Both are prepared before publication;
existing destinations are preserved. Standard output must be writable before
requested report files are published. I/O or diagnostic-stream failures exit 2.
No promise is made of transactional multi-file updates during concurrent hostile
filesystem changes or process termination.

Exit codes: 0 means the selected mode passed, 1 means observed changes or
expectation mismatches, 2 means invalid usage/input/schema or I/O failure, and
3 means worker execution was incomplete. See the mode table in the README.
