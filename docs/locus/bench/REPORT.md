# locus edit benchmark: hashline (A) vs hashline + edit_symbol (B)

Generated 2026-11-08T08:24:49.706Z from `results.jsonl` (676 runs). Each model runs both variants on the same tasks; compare within a row group, never across models.

| model | set | var | runs | success | tok/run | out tok/run | edits/run | edit fails | edit_symbol share | med time |
|---|---|---|---|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | A | 5 | 100% (5) | 1183 | 295 | 1.60 | 3 | — | 8.9s |
| gemini-2.5-flash | sym | B | 6 | 100% (6) | 112 | 112 | 1.00 | 0 | 100% | 3.6s |
| gemini-3-flash-preview | sym | A | 3 | 100% (3) | 937 | 598 | 1.00 | 0 | — | 7.1s |
| gemini-3-flash-preview | sym | B | 4 | 100% (4) | 1397 | 326 | 1.00 | 0 | 100% | 7.1s |
| gemini-3.1-flash-lite | std | A | 10 | 100% (10) | 3225 | 716 | 1.00 | 0 | — | 25.4s |
| gemini-3.1-flash-lite | std | B | 10 | 100% (10) | 4416 | 642 | 1.20 | 2 | 0% | 8.8s |
| gemini-3.1-flash-lite | sym | A | 48 | 94% (45) | 8545 | 1383 | 1.17 | 7 | — | 18.3s |
| gemini-3.1-flash-lite | sym | B | 48 | 100% (48) | 1772 | 1052 | 1.02 | 1 | 69% | 17.1s |
| gemini-3.5-flash-lite | sym | A | 42 | 90% (38) | 17349 | 2180 | 1.17 | 6 | — | 24.3s |
| gemini-3.5-flash-lite | sym | B | 44 | 95% (42) | 7319 | 1516 | 1.07 | 1 | 32% | 9.8s |
| gemini-3.6-flash | sym | A | 3 | 100% (3) | 8522 | 1234 | 1.00 | 0 | — | 55.4s |
| gemini-3.6-flash | sym | B | 3 | 100% (3) | 960 | 649 | 1.00 | 0 | 100% | 31.5s |
| gemma-4-26b-a4b-it | std | A | 83 | 95% (79) | 13520 | 1815 | 1.31 | 21 | — | 182.3s |
| gemma-4-26b-a4b-it | std | B | 83 | 94% (78) | 18074 | 1896 | 1.25 | 21 | 0% | 199.4s |
| gemma-4-26b-a4b-it | sym | A | 48 | 100% (48) | 4041 | 461 | 1.19 | 9 | — | 174.8s |
| gemma-4-26b-a4b-it | sym | B | 48 | 98% (47) | 8686 | 751 | 1.25 | 12 | 34% | 239.1s |
| gemma-4-31b-it | std | A | 45 | 98% (44) | 9172 | 773 | 1.09 | 2 | — | 188.3s |
| gemma-4-31b-it | std | B | 47 | 98% (46) | 12118 | 814 | 1.06 | 1 | 0% | 194.0s |
| gemma-4-31b-it | sym | A | 48 | 100% (48) | 6158 | 1167 | 1.19 | 9 | — | 296.4s |
| gemma-4-31b-it | sym | B | 48 | 100% (48) | 4783 | 573 | 1.00 | 0 | 56% | 246.8s |

## Paired outcomes (same task and run, both variants finished)

| model | set | pairs | both ok | A only | B only | neither |
|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | 5 | 5 | 0 | 0 | 0 |
| gemini-3-flash-preview | sym | 3 | 3 | 0 | 0 | 0 |
| gemini-3.1-flash-lite | std | 10 | 10 | 0 | 0 | 0 |
| gemini-3.1-flash-lite | sym | 48 | 45 | 0 | 3 | 0 |
| gemini-3.5-flash-lite | sym | 42 | 38 | 0 | 2 | 2 |
| gemini-3.6-flash | sym | 3 | 3 | 0 | 0 | 0 |
| gemma-4-26b-a4b-it | std | 83 | 75 | 4 | 3 | 1 |
| gemma-4-26b-a4b-it | sym | 48 | 47 | 1 | 0 | 0 |
| gemma-4-31b-it | std | 45 | 43 | 1 | 1 | 0 |
| gemma-4-31b-it | sym | 48 | 48 | 0 | 0 | 0 |
