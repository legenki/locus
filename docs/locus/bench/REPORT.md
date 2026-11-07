# locus edit benchmark: hashline (A) vs hashline + edit_symbol (B)

Generated 2026-11-07T12:13:04.908Z from `results.jsonl` (8 runs). Each model runs both variants on the same tasks; compare within a row group, never across models.

| model | set | var | runs | success | tok/run | out tok/run | edits/run | edit fails | edit_symbol share | med time |
|---|---|---|---|---|---|---|---|---|---|---|
| gemini-3.5-flash-lite | sym | A | 4 | 50% (2) | 51186 | 5029 | 1.25 | 0 | — | 106.7s |
| gemini-3.5-flash-lite | sym | B | 4 | 75% (3) | 27431 | 3380 | 1.00 | 0 | 50% | 102.8s |

## Paired outcomes (same task and run, both variants finished)

| model | set | pairs | both ok | A only | B only | neither |
|---|---|---|---|---|---|---|
| gemini-3.5-flash-lite | sym | 4 | 2 | 0 | 1 | 1 |
