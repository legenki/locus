# locus edit benchmark: hashline (A) vs hashline + edit_symbol (B)

Generated 2026-11-08T19:02:59.947Z from `results.jsonl` (1044 runs). Each model runs both variants on the same tasks; compare within a row group, never across models.

| model | set | var | runs | success | tok/run | out tok/run | edits/run | edit fails | edit_symbol share | med time |
|---|---|---|---|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | A | 8 | 100% (8) | 1482 | 291 | 1.50 | 4 | — | 8.9s |
| gemini-2.5-flash | sym | B | 8 | 100% (8) | 228 | 121 | 1.00 | 0 | 100% | 4.1s |
| gemini-3-flash-preview | sym | A | 5 | 100% (5) | 3261 | 889 | 1.00 | 0 | — | 12.0s |
| gemini-3-flash-preview | sym | B | 6 | 100% (6) | 1262 | 397 | 1.00 | 0 | 100% | 7.1s |
| gemini-3.1-flash-lite | std | A | 58 | 100% (58) | 8415 | 1490 | 1.21 | 11 | — | 26.4s |
| gemini-3.1-flash-lite | std | B | 56 | 98% (55) | 7623 | 1142 | 1.21 | 11 | 0% | 13.0s |
| gemini-3.1-flash-lite | sym | A | 48 | 94% (45) | 8545 | 1383 | 1.17 | 7 | — | 18.3s |
| gemini-3.1-flash-lite | sym | B | 48 | 100% (48) | 1772 | 1052 | 1.02 | 1 | 69% | 17.1s |
| gemini-3.5-flash-lite | std | A | 47 | 94% (44) | 13970 | 1070 | 1.11 | 6 | — | 41.6s |
| gemini-3.5-flash-lite | std | B | 46 | 98% (45) | 11198 | 989 | 1.04 | 2 | 0% | 7.1s |
| gemini-3.5-flash-lite | sym | A | 48 | 92% (44) | 15275 | 2003 | 1.15 | 6 | — | 24.3s |
| gemini-3.5-flash-lite | sym | B | 48 | 96% (46) | 6820 | 1472 | 1.06 | 1 | 35% | 8.8s |
| gemini-3.6-flash | sym | A | 5 | 100% (5) | 7493 | 1206 | 1.00 | 0 | — | 55.4s |
| gemini-3.6-flash | sym | B | 4 | 100% (4) | 2756 | 834 | 1.00 | 0 | 100% | 40.2s |
| gemma-4-26b-a4b-it | std | A | 105 | 96% (101) | 13987 | 2370 | 1.32 | 30 | — | 190.0s |
| gemma-4-26b-a4b-it | std | B | 106 | 94% (100) | 17744 | 2492 | 1.28 | 31 | 1% | 204.8s |
| gemma-4-26b-a4b-it | sym | A | 48 | 100% (48) | 4041 | 461 | 1.19 | 9 | — | 174.8s |
| gemma-4-26b-a4b-it | sym | B | 48 | 98% (47) | 8686 | 751 | 1.25 | 12 | 34% | 239.1s |
| gemma-4-31b-it | std | A | 102 | 99% (101) | 9796 | 1782 | 1.08 | 6 | — | 205.5s |
| gemma-4-31b-it | std | B | 104 | 97% (101) | 10588 | 1585 | 1.07 | 6 | 0% | 219.3s |
| gemma-4-31b-it | sym | A | 48 | 100% (48) | 6158 | 1167 | 1.19 | 9 | — | 296.4s |
| gemma-4-31b-it | sym | B | 48 | 100% (48) | 4783 | 573 | 1.00 | 0 | 56% | 246.8s |

## Paired outcomes (same task and run, both variants finished)

| model | set | pairs | both ok | A only | B only | neither |
|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | 8 | 8 | 0 | 0 | 0 |
| gemini-3-flash-preview | sym | 5 | 5 | 0 | 0 | 0 |
| gemini-3.1-flash-lite | std | 56 | 55 | 1 | 0 | 0 |
| gemini-3.1-flash-lite | sym | 48 | 45 | 0 | 3 | 0 |
| gemini-3.5-flash-lite | std | 46 | 44 | 0 | 1 | 1 |
| gemini-3.5-flash-lite | sym | 48 | 44 | 0 | 2 | 2 |
| gemini-3.6-flash | sym | 4 | 4 | 0 | 0 | 0 |
| gemma-4-26b-a4b-it | std | 105 | 96 | 5 | 3 | 1 |
| gemma-4-26b-a4b-it | sym | 48 | 47 | 1 | 0 | 0 |
| gemma-4-31b-it | std | 102 | 98 | 3 | 1 | 0 |
| gemma-4-31b-it | sym | 48 | 48 | 0 | 0 | 0 |
