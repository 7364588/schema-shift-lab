# Security and privacy

Only submit synthetic, minimized reproductions in public issues. If an issue
requires sensitive data, describe its category without uploading that data;
there is no promise of a private intake service or response deadline.

The CLI reads explicitly named regular UTF-8 JSON files. It rejects symlink file
inputs and special files, enforces byte limits, and never resolves references
through the network or filesystem. Path metadata checks reduce accidental and
common race hazards; a concurrently hostile filesystem is outside the threat
model. Reports are not redacted: supplied schemas and case values are included.

Schema compilation and validation execute in a worker with a deadline and a
V8 heap limit. Heap limits do not cap all native allocations or the whole process.
The worker does not load user modules or keyword functions. It is not an OS
sandbox for arbitrary code and should not be deployed as an anonymous public
validation service without additional process, memory and request isolation.

Outputs are written to temporary files and linked into new destinations; existing
files and symlink destinations are never intentionally overwritten. Filesystems
without hard-link support fail rather than falling back to overwrite. Diagnostic
messages contain controlled codes, not raw parser/validator stacks or filenames.

Format annotations are not assertions. A report saying a case is accepted does
not mean an email address, URL, timestamp or provider response was verified.
