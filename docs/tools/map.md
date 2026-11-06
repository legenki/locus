# map

> locus: ranked repository map — files, exported symbols with signatures and line ranges, importers and callers. Use it to find where things live before grepping.

## Source

- Entry: `packages/coding-agent/src/locus/map-tool.ts`
- Model-facing prompt: `packages/coding-agent/src/locus/prompts/map.md`
- Key collaborators:
   - `crates/pi-ast/src/tags.rs` — tree-sitter walk extracting symbols, imports and references (TS/TSX/JS, Go, Rust); exposed as `extractTags`/`extractTagsAsync` from `crates/pi-natives/src/tags.rs`.
   - `packages/coding-agent/src/locus/repomap/repo-index.ts` — incremental reconcile with the working tree.
   - `packages/coding-agent/src/locus/repomap/store.ts` — SQLite index under `~/.omp/locus/index/`.
   - `packages/coding-agent/src/locus/repomap/resolve.ts`, `project.ts` — import resolution (relative paths, `tsconfig` paths, workspace `exports`, Go modules, Rust `mod`/`use`).
   - `packages/coding-agent/src/locus/repomap/graph.ts` — reference resolution, file edges, PageRank.
   - `packages/coding-agent/src/locus/repomap/render.ts` — budgeted map, importers, callers.
   - `packages/coding-agent/src/locus/repomap/registry.ts` — one index per repository root, reconcile throttling.
   - `packages/coding-agent/src/tools/index.ts` — register the built-in.

## Inputs

| Field             | Type       | Required | Description                                                                                                     |
| ----------------- | ---------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `focus`           | `string[]` | No       | Paths, directories, globs or `path::Symbol` targets to center the ranking on. Focus files are always shown.     |
| `budget`          | `number`   | No       | Token budget for the map, clamped to `256..8000`. Defaults to `2000`. Estimated at 3.5 characters per token.    |
| `importers`       | `string`   | No       | Repo-relative path: list files importing it with the names each binds and resolved reference counts.            |
| `callers`         | `string`   | No       | `path::Qual.Name[#N]`: list resolved callers. Ambiguous or unknown targets fail with candidates / closest names. |
| `depth`           | `1 \| 2`   | No       | For `importers`, follow re-exports one hop; for `callers`, add callers of callers. Defaults to `1`.             |
| `include_private` | `boolean`  | No       | Also list non-exported symbols outside focus files.                                                             |

`importers` and `callers` are mutually exclusive. `map` is always enabled.

## Outputs

- Map: one line per file (`path  ←N`, N = files importing it), then symbols as `signature  Lstart-end`, members indented under their container, ending with `[map: shown/total files, ~tokens/budget tok]`.
- Importers: `importers of <path> (<files> files, <refs> refs)` then one line per importer.
- Callers: `callers of <path>::<qname> (<n>)` then `path::qname` per caller; `(by unique name)` marks calls resolved through a TS ambient global.
- `details`: `mode`, `files` (indexed file count), `indexMs` (reconcile time of this call).

## Indexing

- The index for the session's repository root (nearest ancestor with `.git`) is reconciled before a query, at most every 3 s: unchanged `(size, mtime)` files are skipped, changed stats are confirmed by content hash, changed content is re-parsed.
- Edits that touch few files recompute only the files whose resolution depends on them; added or removed files, config changes, or a scope over 10% of the repo rebuild the whole graph.
- References resolve only through imports, `this.`/`self.` members, the same file, the same Go package, Rust glob imports, and TS ambient `.d.ts` globals. There is no "unique name anywhere" fallback; unresolvable calls (method calls on values, calls inside Rust macros) are left out rather than guessed.
