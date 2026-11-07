# locus edit benchmark: hashline (A) vs hashline + edit_symbol (B)

Generated 2026-11-07T23:21:00.460Z from `results.jsonl` (489 runs). Each model runs both variants on the same tasks; compare within a row group, never across models.

| model | set | var | runs | success | tok/run | out tok/run | edits/run | edit fails | edit_symbol share | med time |
|---|---|---|---|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | A | 4 | 100% (4) | 1189 | 290 | 1.75 | 3 | — | 10.2s |
| gemini-2.5-flash | sym | B | 4 | 100% (4) | 111 | 111 | 1.00 | 0 | 100% | 3.5s |
| gemini-3-flash-preview | sym | A | 3 | 100% (3) | 937 | 598 | 1.00 | 0 | — | 7.1s |
| gemini-3-flash-preview | sym | B | 2 | 100% (2) | 988 | 423 | 1.00 | 0 | 100% | 50.2s |
| gemini-3.1-flash-lite | std | A | 9 | 100% (9) | 3156 | 719 | 1.00 | 0 | — | 25.4s |
| gemini-3.1-flash-lite | std | B | 8 | 100% (8) | 4854 | 697 | 1.25 | 2 | 0% | 9.1s |
| gemini-3.1-flash-lite | sym | A | 48 | 94% (45) | 8545 | 1383 | 1.17 | 7 | — | 18.3s |
| gemini-3.1-flash-lite | sym | B | 47 | 100% (47) | 1775 | 1051 | 1.02 | 1 | 69% | 17.1s |
| gemini-3.5-flash-lite | sym | A | 40 | 90% (36) | 18013 | 2235 | 1.15 | 5 | — | 26.6s |
| gemini-3.5-flash-lite | sym | B | 42 | 95% (40) | 7625 | 1545 | 1.07 | 1 | 31% | 11.2s |
| gemini-3.6-flash | sym | A | 3 | 100% (3) | 8522 | 1234 | 1.00 | 0 | — | 55.4s |
| gemini-3.6-flash | sym | B | 2 | 100% (2) | 1023 | 557 | 1.00 | 0 | 100% | 40.2s |
| gemma-4-26b-a4b-it | std | A | 32 | 94% (30) | 13297 | 1026 | 1.28 | 9 | — | 170.2s |
| gemma-4-26b-a4b-it | std | B | 29 | 97% (28) | 19734 | 1439 | 1.38 | 10 | 0% | 219.4s |
| gemma-4-26b-a4b-it | sym | A | 48 | 100% (48) | 4041 | 461 | 1.19 | 9 | — | 174.8s |
| gemma-4-26b-a4b-it | sym | B | 48 | 98% (47) | 8686 | 751 | 1.25 | 12 | 34% | 239.1s |
| gemma-4-31b-it | std | A | 12 | 100% (12) | 7501 | 714 | 1.08 | 0 | — | 181.9s |
| gemma-4-31b-it | std | B | 12 | 92% (11) | 9333 | 956 | 1.08 | 1 | 0% | 175.4s |
| gemma-4-31b-it | sym | A | 48 | 100% (48) | 6158 | 1167 | 1.19 | 9 | — | 296.4s |
| gemma-4-31b-it | sym | B | 48 | 100% (48) | 4783 | 573 | 1.00 | 0 | 56% | 246.8s |

## Paired outcomes (same task and run, both variants finished)

| model | set | pairs | both ok | A only | B only | neither |
|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | 4 | 4 | 0 | 0 | 0 |
| gemini-3-flash-preview | sym | 2 | 2 | 0 | 0 | 0 |
| gemini-3.1-flash-lite | std | 8 | 8 | 0 | 0 | 0 |
| gemini-3.1-flash-lite | sym | 47 | 44 | 0 | 3 | 0 |
| gemini-3.5-flash-lite | sym | 40 | 36 | 0 | 2 | 2 |
| gemini-3.6-flash | sym | 2 | 2 | 0 | 0 | 0 |
| gemma-4-26b-a4b-it | std | 29 | 26 | 1 | 2 | 0 |
| gemma-4-26b-a4b-it | sym | 48 | 47 | 1 | 0 | 0 |
| gemma-4-31b-it | std | 11 | 10 | 1 | 0 | 0 |
| gemma-4-31b-it | sym | 48 | 48 | 0 | 0 | 0 |
