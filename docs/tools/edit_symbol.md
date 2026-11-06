# edit_symbol

> locus: replace, insert next to, or delete whole symbols (functions, methods, classes, types, constants) by name. Use hashline `edit` for small changes inside a body.

## Source

- Entry: `packages/coding-agent/src/locus/edit-symbol/tool.ts`
- Model-facing prompt: `packages/coding-agent/src/locus/prompts/edit-symbol.md`
- Key collaborators:
   - `packages/coding-agent/src/locus/edit-symbol/plan.ts` — pure planning: target resolution, re-indentation, overlap and syntax checks.
   - `crates/pi-ast/src/tags.rs` (`extractTags`) — symbols with qualified names and edit ranges.
   - `packages/coding-agent/src/tools/write.ts` — every write goes through the built-in `write` tool (plan-mode guard, LSP format/diagnostics, ACP bridge, checkpoints).
   - `packages/coding-agent/src/tools/read-summary.ts` (`routeReadThroughBridge`) — current text from the ACP editor buffer when attached.
   - `packages/coding-agent/src/edit/store.ts` — snapshot tag and seen lines for the hashline handoff.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ops` | `Array<{ op, target, code? }>` | Yes | Applied together: every target in every file is planned before anything is written. |
| `ops[].op` | `"replace" \| "insert_before" \| "insert_after" \| "delete"` | Yes | `replace` swaps the whole symbol range; inserts add a sibling at the same depth; `delete` removes it. |
| `ops[].target` | `string` | Yes | `path::Name`, `path::Class.method`, `path::Outer.Inner.m`, Go `path::Type.Method`, Rust `path::Type.method` or `path::Type<Trait>.method`; optional `#N` picks among listed candidates. Paths resolve against the session cwd, then the repository root. |
| `ops[].code` | `string` | For replace/insert | One complete declaration, written without outer indentation. |

`edit_symbol` is enabled whenever `edit` is. Approval uses the `write` tier of each target file.

## Behavior

- Targets resolve against the file's current text (ACP buffer or disk), never against the cached index. Exactly one candidate applies; ambiguity or a missing symbol fails with the candidates (kind, lines, signature) or the closest names.
- A symbol's range includes its doc comment, decorators and attributes; `replace` code must repeat them to keep them.
- Code is re-indented to the target's indentation. Inserts copy the sibling blank-line style; deletes collapse the blank lines around the hole.
- Symbols that share a line with other code are refused (use `edit`). Overlapping ops are refused. A result that introduces syntax errors into an error-free file is refused.
- Files are normalized to LF for planning; `write` restores the file's own line-ending and BOM conventions.

## Outputs

Per file: a summary line, then a `[path#TAG]` header and the changed symbols as numbered lines (up to 120 lines each). Those lines are recorded as seen for the tag, so a hashline `edit` inside them needs no re-read. When the LSP formatter reshapes the file, symbols are re-located; anything that cannot be re-located is reported without line numbers. Diagnostics and notes from `write` follow.

`details.files`: `{ path, ops, resolvedPath }` per written file.
