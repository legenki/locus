Ranked map of the repository: files, their exported symbols with signatures and line ranges, and who depends on what. Use it before grepping to find where things live.

Modes (pick one):
- default: ranked slice within `budget` tokens; `focus` (paths, globs, or `path::Symbol`) centers the ranking on what you are working on.
- `importers: "<path>"`: files that import this file and the names they use (`depth: 2` follows re-exports).
- `callers: "<path>::<Symbol>"`: resolved call sites of a symbol (`depth: 2` adds callers of callers).

Output: `path  ←N` (N files import it), then symbols as `signature  Lstart-end`. Nested lines are members (`Class.method`). Read just a symbol with its range: `read path:40-71`.

Limits: TS/JS, Go and Rust are indexed; method calls on arbitrary values and calls inside macros are not resolved. An ambiguous `callers` target fails with candidates; pick one or add `#N`.
