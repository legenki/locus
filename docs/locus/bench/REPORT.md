# locus edit benchmark: hashline (A) vs hashline + edit_symbol (B)

Generated 2026-11-07T14:13:02.924Z from `results.jsonl` (302 runs). Each model runs both variants on the same tasks; compare within a row group, never across models.

| model | set | var | runs | success | tok/run | out tok/run | edits/run | edit fails | edit_symbol share | med time |
|---|---|---|---|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | A | 4 | 100% (4) | 1189 | 290 | 1.75 | 3 | — | 10.2s |
| gemini-2.5-flash | sym | B | 4 | 100% (4) | 111 | 111 | 1.00 | 0 | 100% | 3.5s |
| gemini-3.1-flash-lite | std | A | 9 | 100% (9) | 3156 | 719 | 1.00 | 0 | — | 25.4s |
| gemini-3.1-flash-lite | std | B | 8 | 100% (8) | 4854 | 697 | 1.25 | 2 | 0% | 9.1s |
| gemini-3.1-flash-lite | sym | A | 48 | 94% (45) | 8545 | 1383 | 1.17 | 7 | — | 18.3s |
| gemini-3.1-flash-lite | sym | B | 47 | 100% (47) | 1775 | 1051 | 1.02 | 1 | 69% | 17.1s |
| gemini-3.5-flash-lite | sym | A | 40 | 90% (36) | 18013 | 2235 | 1.15 | 5 | — | 26.6s |
| gemini-3.5-flash-lite | sym | B | 42 | 95% (40) | 7625 | 1545 | 1.07 | 1 | 31% | 11.2s |
| gemini-3.6-flash | sym | A | 3 | 100% (3) | 8522 | 1234 | 1.00 | 0 | — | 55.4s |
| gemini-3.6-flash | sym | B | 2 | 100% (2) | 1023 | 557 | 1.00 | 0 | 100% | 40.2s |
| gemma-4-26b-a4b-it | sym | A | 32 | 100% (32) | 4330 | 498 | 1.19 | 6 | — | 174.8s |
| gemma-4-26b-a4b-it | sym | B | 35 | 97% (34) | 10324 | 898 | 1.31 | 11 | 23% | 261.0s |
| gemma-4-31b-it | sym | A | 12 | 100% (12) | 5344 | 986 | 1.08 | 1 | — | 378.5s |
| gemma-4-31b-it | sym | B | 16 | 100% (16) | 5252 | 558 | 1.00 | 0 | 44% | 273.1s |

## Paired outcomes (same task and run, both variants finished)

| model | set | pairs | both ok | A only | B only | neither |
|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | 4 | 4 | 0 | 0 | 0 |
| gemini-3.1-flash-lite | std | 8 | 8 | 0 | 0 | 0 |
| gemini-3.1-flash-lite | sym | 47 | 44 | 0 | 3 | 0 |
| gemini-3.5-flash-lite | sym | 40 | 36 | 0 | 2 | 2 |
| gemini-3.6-flash | sym | 2 | 2 | 0 | 0 | 0 |
| gemma-4-26b-a4b-it | sym | 32 | 31 | 1 | 0 | 0 |
| gemma-4-31b-it | sym | 9 | 9 | 0 | 0 | 0 |
