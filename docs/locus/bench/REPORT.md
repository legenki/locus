# locus edit benchmark: hashline (A) vs hashline + edit_symbol (B)

Generated 2026-11-09T09:07:46.378Z from `results.jsonl` (1258 runs). Each model runs both variants on the same tasks; compare within a row group, never across models.

| model | set | var | runs | success | tok/run (mean) | tok/run (median) | out tok/run | edits/run | edit fails | edit_symbol share | med time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | A | 13 | 100% (13) | 1057 | 595 | 321 | 1.31 | 4 | — | 8.9s |
| gemini-2.5-flash | sym | B | 13 | 100% (13) | 268 | 142 | 145 | 1.00 | 0 | 92% | 3.6s |
| gemini-3-flash-preview | sym | A | 6 | 100% (6) | 3081 | 1932 | 1069 | 1.00 | 0 | — | 35.3s |
| gemini-3-flash-preview | sym | B | 6 | 100% (6) | 1262 | 1681 | 397 | 1.00 | 0 | 100% | 7.1s |
| gemini-3.1-flash-lite | std | A | 106 | 99% (105) | 8811 | 3706 | 2054 | 1.25 | 22 | — | 22.4s |
| gemini-3.1-flash-lite | std | B | 106 | 99% (105) | 6066 | 3304 | 1601 | 1.24 | 22 | 0% | 13.7s |
| gemini-3.1-flash-lite | sym | A | 48 | 94% (45) | 8545 | 1412 | 1383 | 1.17 | 7 | — | 18.3s |
| gemini-3.1-flash-lite | sym | B | 48 | 100% (48) | 1772 | 937 | 1052 | 1.02 | 1 | 69% | 17.1s |
| gemini-3.5-flash-lite | std | A | 96 | 96% (92) | 11478 | 3420 | 1418 | 1.18 | 16 | — | 9.0s |
| gemini-3.5-flash-lite | std | B | 94 | 99% (93) | 11698 | 2734 | 1498 | 1.18 | 14 | 0% | 36.7s |
| gemini-3.5-flash-lite | sym | A | 48 | 92% (44) | 15275 | 3244 | 2003 | 1.15 | 6 | — | 24.3s |
| gemini-3.5-flash-lite | sym | B | 48 | 96% (46) | 6820 | 1750 | 1472 | 1.06 | 1 | 35% | 8.8s |
| gemini-3.6-flash | sym | A | 6 | 100% (6) | 6455 | 4924 | 1166 | 1.00 | 0 | — | 56.2s |
| gemini-3.6-flash | sym | B | 6 | 100% (6) | 3019 | 2831 | 742 | 1.00 | 0 | 100% | 40.2s |
| gemma-4-26b-a4b-it | std | A | 105 | 96% (101) | 13987 | 9680 | 2370 | 1.32 | 30 | — | 190.0s |
| gemma-4-26b-a4b-it | std | B | 106 | 94% (100) | 17744 | 11230 | 2492 | 1.28 | 31 | 1% | 204.8s |
| gemma-4-26b-a4b-it | sym | A | 48 | 100% (48) | 4041 | 4206 | 461 | 1.19 | 9 | — | 174.8s |
| gemma-4-26b-a4b-it | sym | B | 48 | 98% (47) | 8686 | 6053 | 751 | 1.25 | 12 | 34% | 239.1s |
| gemma-4-31b-it | std | A | 105 | 99% (104) | 9808 | 6154 | 1786 | 1.08 | 6 | — | 202.9s |
| gemma-4-31b-it | std | B | 106 | 97% (103) | 10449 | 6453 | 1564 | 1.07 | 6 | 0% | 219.3s |
| gemma-4-31b-it | sym | A | 48 | 100% (48) | 6158 | 4453 | 1167 | 1.19 | 9 | — | 296.4s |
| gemma-4-31b-it | sym | B | 48 | 100% (48) | 4783 | 4038 | 573 | 1.00 | 0 | 56% | 246.8s |

## Paired outcomes (same task and run, both variants finished)

| model | set | pairs | both ok | A only | B only | neither |
|---|---|---|---|---|---|---|
| gemini-2.5-flash | sym | 12 | 12 | 0 | 0 | 0 |
| gemini-3-flash-preview | sym | 5 | 5 | 0 | 0 | 0 |
| gemini-3.1-flash-lite | std | 106 | 104 | 1 | 1 | 0 |
| gemini-3.1-flash-lite | sym | 48 | 45 | 0 | 3 | 0 |
| gemini-3.5-flash-lite | std | 94 | 90 | 0 | 3 | 1 |
| gemini-3.5-flash-lite | sym | 48 | 44 | 0 | 2 | 2 |
| gemini-3.6-flash | sym | 5 | 5 | 0 | 0 | 0 |
| gemma-4-26b-a4b-it | std | 105 | 96 | 5 | 3 | 1 |
| gemma-4-26b-a4b-it | sym | 48 | 47 | 1 | 0 | 0 |
| gemma-4-31b-it | std | 105 | 101 | 3 | 1 | 0 |
| gemma-4-31b-it | sym | 48 | 48 | 0 | 0 | 0 |
