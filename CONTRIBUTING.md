# Contributing

Use Node 22 or 24 and `npm ci --ignore-scripts`. Run the development commands in
the README before proposing a change. Changes to semantics need a small explicit
schema pair and corpus demonstrating the old and intended outcomes. Test both
comparison and expectation-check modes when their behavior differs.

Keep example data synthetic and minimal. Never include credentials, private
schemas, customer records or absolute filesystem paths in fixtures or logs.
Do not attach reports without reviewing the schemas and values they contain.

Resource or unsupported-keyword failures must not become successful agreement.
Keep structural observations distinct from semantic witnesses. A fixture suite
cannot establish universal equivalence. Avoid network access, executable
adapters, silent coercion and schema rewriting in this project's v1 scope.

Dependency changes should update the lockfile, pass `npm audit --omit=dev`, and
be checked through an actual packed installation. CI covers Windows and Ubuntu;
do not assume POSIX-only shell utilities for ordinary CLI operation.
