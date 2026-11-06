Edit code by symbol name: replace, insert next to, or delete a whole function, method, class, type or constant. No `read` needed first — the target resolves against the file's current text.

Target: `path::Name`, `path::Class.method`, `path::Outer.Inner.method`; Go methods `path::Type.Method`; Rust `path::Type.method` (any `impl Type`), `path::Type<Trait>.method` for a trait impl. Paths are relative to the repo root, as `map` prints them.

Ops (all apply or none):
- `replace`: `code` replaces the whole symbol, **including its doc comment, decorators and attributes** — repeat them in `code` to keep them.
- `insert_before` / `insert_after`: `code` lands as a sibling at the same depth.
- `delete`: removes the symbol with its docs.

Write `code` without outer indentation; it is re-indented to the target. One complete declaration per op.

If a target is ambiguous (overloads, several `impl` blocks) or not found, the call fails and lists candidates — retry with one of them or `#N`. Never guess.

Use hashline `edit` instead for changes of a few lines inside a body: it is cheaper. The result shows the changed symbols with line numbers and a `[path#TAG]` header, so a follow-up hashline edit needs no re-read.

Supported: TS/TSX/JS, Go, Rust. Other files: use `edit`.
