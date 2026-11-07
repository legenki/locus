/**
 * locus: long-running, quota-aware driver for the hashline vs `edit_symbol`
 * comparison, built to stretch over days on free-tier model quotas.
 *
 * - Every model runs BOTH variants on the SAME tasks: A = hashline only,
 *   B = hashline + `edit_symbol`. Models are independent replications; the
 *   comparison never mixes models.
 * - Work items are (model, set, task, run, variant); A and B of one
 *   (task, run) are scheduled together, alternating which goes first.
 * - Results append to `docs/locus/bench/results.jsonl` (one line per finished
 *   run), so a lost container loses nothing that was written; done items are
 *   never re-run.
 * - A run that failed on quota or a provider error is NOT a result: it goes
 *   back to the queue. On a 429 the model's quota is probed with one tiny
 *   request: per-minute limits wait, per-day limits park the model until the
 *   reset (`retryDelay`), recorded in `state.json`.
 *
 * Usage (from packages/metaharness, GEMINI_API_KEY set):
 *   bun adapters/edit/locus-bench.ts run [--minutes 110] [--models a,b]
 *   bun adapters/edit/locus-bench.ts report
 *   bun adapters/edit/locus-bench.ts status
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const REPO = path.resolve(import.meta.dir, "../../../..");
const OUT_DIR = path.join(REPO, "docs/locus/bench");
const RESULTS = path.join(OUT_DIR, "results.jsonl");
const STATE = path.join(OUT_DIR, "state.json");
const REPORT = path.join(OUT_DIR, "REPORT.md");
const CLI = path.join(import.meta.dir, "cli.ts");
const SYMBOL_FIXTURES = path.join(REPO, "packages/typescript-edit-benchmark/locus-symbol-fixtures.tar.gz");
const SCRATCH = path.join(REPO, "runs", "locus-bench");

type Variant = "A" | "B";
type SetName = "sym" | "std";

interface ModelPlan {
	id: string;
	concurrency: number;
	timeoutMs: number;
	sets: Partial<Record<SetName, number>>; // set → runs per task
}

/** Free-tier plan (see docs/locus/spec-v0.md §8). */
const MODELS: ModelPlan[] = [
	{ id: "gemma-4-31b-it", concurrency: 4, timeoutMs: 420_000, sets: { sym: 2, std: 1 } },
	{ id: "gemma-4-26b-a4b-it", concurrency: 4, timeoutMs: 420_000, sets: { sym: 2, std: 1 } },
	{ id: "gemini-3.5-flash-lite", concurrency: 2, timeoutMs: 180_000, sets: { sym: 2, std: 1 } },
	{ id: "gemini-3.1-flash-lite", concurrency: 2, timeoutMs: 180_000, sets: { sym: 2, std: 1 } },
	{ id: "gemini-3.6-flash", concurrency: 1, timeoutMs: 240_000, sets: { sym: 1 } },
	{ id: "gemini-3.8-flash", concurrency: 1, timeoutMs: 240_000, sets: { sym: 1 } },
	{ id: "gemini-3-flash-preview", concurrency: 1, timeoutMs: 240_000, sets: { sym: 1 } },
	{ id: "gemini-2.5-flash", concurrency: 1, timeoutMs: 240_000, sets: { sym: 1 } },
];

interface Item {
	model: string;
	set: SetName;
	task: string;
	run: number;
	variant: Variant;
}

interface ResultLine extends Item {
	success: boolean;
	tokensTotal: number;
	tokensOutput: number;
	durationMs: number;
	reads: number;
	edits: number;
	editFailures: number;
	tools: Record<string, number>;
	category: string;
	at: string;
}

interface State {
	parkedUntil: Record<string, string>;
	failures: Record<string, number>;
}

const key = (i: Item) => `${i.model}|${i.set}|${i.task}|${i.run}|${i.variant}`;
const log = (msg: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

async function readResults(): Promise<ResultLine[]> {
	try {
		const text = await Bun.file(RESULTS).text();
		return text
			.split("\n")
			.filter(Boolean)
			.map(l => JSON.parse(l) as ResultLine);
	} catch {
		return [];
	}
}

async function readState(): Promise<State> {
	try {
		return (await Bun.file(STATE).json()) as State;
	} catch {
		return { parkedUntil: {}, failures: {} };
	}
}

async function listTasks(set: SetName): Promise<string[]> {
	const args = set === "sym" ? ["--fixtures", SYMBOL_FIXTURES] : [];
	const out = await $`bun ${CLI} --list ${args}`.quiet().text();
	return (JSON.parse(out.slice(out.indexOf("["))) as Array<{ id: string }>).map(t => t.id).sort();
}

/** Pending items per model, paired by (task, run), A/B order alternating. */
async function pending(models: ModelPlan[], done: Set<string>): Promise<Map<string, Item[][]>> {
	const tasks: Record<SetName, string[]> = { sym: await listTasks("sym"), std: await listTasks("std") };
	const out = new Map<string, Item[][]>();
	for (const m of models) {
		const pairs: Item[][] = [];
		// Symbol set first: it is the informative one.
		for (const set of ["sym", "std"] as const) {
			const runs = m.sets[set];
			if (!runs) continue;
			for (let run = 0; run < runs; run++) {
				tasks[set].forEach((task, ti) => {
					const order: Variant[] = (ti + run) % 2 === 0 ? ["A", "B"] : ["B", "A"];
					const pair = order
						.map(variant => ({ model: m.id, set, task, run, variant }))
						.filter(i => !done.has(key(i)));
					if (pair.length > 0) pairs.push(pair);
				});
			}
		}
		out.set(m.id, pairs);
	}
	return out;
}

interface QuotaProbe {
	kind: "ok" | "minute" | "day" | "other";
	retrySeconds: number;
}

async function probeQuota(model: string): Promise<QuotaProbe> {
	const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-goog-api-key": Bun.env.GEMINI_API_KEY ?? "" },
		body: JSON.stringify({ contents: [{ parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 1 } }),
	}).catch(() => null);
	if (!res) return { kind: "other", retrySeconds: 60 };
	if (res.ok) return { kind: "ok", retrySeconds: 0 };
	const text = await res.text();
	const retry = Number(/"retryDelay":\s*"(\d+)s"/.exec(text)?.[1] ?? 60);
	if (res.status !== 429) return { kind: "other", retrySeconds: 60 };
	return { kind: /PerDay/.test(text) ? "day" : "minute", retrySeconds: retry };
}

function countTools(logText: string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const line of logText.split("\n")) {
		if (!line.includes('"tool_execution_start"')) continue;
		const name = /"toolName":"([a-z_]+)"/.exec(line)?.[1];
		if (name) counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

/** Run one variant over a batch of tasks; return finished results and whether quota was hit. */
async function runBatch(
	m: ModelPlan,
	set: SetName,
	variant: Variant,
	items: Item[],
): Promise<{ results: ResultLine[]; quotaHit: boolean; broken: boolean }> {
	await fs.mkdir(SCRATCH, { recursive: true });
	const out = path.join(SCRATCH, `${m.id}-${set}-${variant}-${Date.now()}.json`);
	const args = [
		"--model", `google/${m.id}`,
		"--edit-variant", "hashline",
		"--task-concurrency", String(m.concurrency),
		"--tasks", items.map(i => i.task).join(","),
		"--runs", "1",
		"--timeout", String(m.timeoutMs),
		"--max-provider-retries", "1",
		"--output", out,
		...(set === "sym" ? ["--fixtures", SYMBOL_FIXTURES] : []),
		...(variant === "B" ? ["--extra-tools", "edit_symbol"] : []),
	];
	const proc = await $`bun ${CLI} ${args}`.cwd(path.dirname(CLI)).quiet().nothrow();
	const stdout = proc.stdout.toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	const logs = new Map<string, string>();
	for (const match of stdout.matchAll(/Log: (runs\/rb-[a-z0-9]+\/run-(.+)-\d+\.jsonl)/g)) logs.set(match[2]!, path.join(REPO, match[1]!));

	let report: { tasks: Array<{ id: string; runs: Array<Record<string, unknown>> }> };
	try {
		report = await Bun.file(out).json();
	} catch {
		const stderr = proc.stderr.toString();
		const quotaHit = /429|quota/i.test(stdout + stderr);
		log(`${m.id} ${set}/${variant}: no report (exit ${proc.exitCode}): ${stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? ""}`);
		return { results: [], quotaHit, broken: !quotaHit };
	}
	const results: ResultLine[] = [];
	let quotaHit = false;
	for (const item of items) {
		const run = report.tasks.find(t => t.id === item.task)?.runs[0] as
			| {
					success: boolean;
					error?: string;
					tokens: { total: number; output: number };
					duration: number;
					toolCalls: { read: number; edit: number; editFailures: number };
					mutationType?: string;
					mutationCategory?: string;
			  }
			| undefined;
		if (!run) continue;
		const error = String(run.error ?? "");
		if (/429|quota|rate.?limit/i.test(error)) {
			quotaHit = true;
			continue;
		}
		const ghost = run.tokens.total === 0 && run.toolCalls.read === 0 && run.toolCalls.edit === 0;
		if (/provider failure/i.test(error) || ghost) continue; // provider trouble, not a result
		const logPath = logs.get(item.task);
		const tools = logPath ? countTools(await Bun.file(logPath).text().catch(() => "")) : {};
		results.push({
			...item,
			success: run.success,
			tokensTotal: run.tokens.total,
			tokensOutput: run.tokens.output,
			durationMs: run.duration,
			reads: run.toolCalls.read,
			edits: run.toolCalls.edit,
			editFailures: run.toolCalls.editFailures,
			tools,
			category: run.mutationType?.startsWith("symbol-") ? run.mutationType : (run.mutationCategory ?? "?"),
			at: new Date().toISOString(),
		});
	}
	return { results, quotaHit, broken: false };
}

async function runModel(m: ModelPlan, pairs: Item[][], deadline: number, state: State): Promise<void> {
	const parked = state.parkedUntil[m.id];
	if (parked && Date.parse(parked) > Date.now()) {
		log(`${m.id}: parked until ${parked}`);
		return;
	}
	let cursor = 0;
	let brokenStreak = 0;
	const batchPairs = Math.max(1, m.concurrency);
	while (cursor < pairs.length && Date.now() < deadline) {
		const chunk = pairs.slice(cursor, cursor + batchPairs);
		// Same set inside a batch (the CLI takes one fixture source).
		const set = chunk[0]![0]!.set;
		const sameSet = chunk.filter(p => p[0]!.set === set);
		const first = sameSet[0]![0]!.variant;
		let parkedNow = false;
		for (const variant of [first, first === "A" ? "B" : "A"] as Variant[]) {
			const items = sameSet.flatMap(p => p.filter(i => i.variant === variant));
			if (items.length === 0) continue;
			const { results, quotaHit, broken } = await runBatch(m, set, variant, items);
			brokenStreak = broken ? brokenStreak + 1 : 0;
			if (brokenStreak >= 2) {
				log(`${m.id}: the CLI fails without a report twice in a row; stopping this model`);
				return;
			}
			if (broken) continue;
			for (const r of results) await fs.appendFile(RESULTS, `${JSON.stringify(r)}\n`);
			log(`${m.id} ${set}/${variant}: +${results.length}/${items.length} (${results.filter(r => r.success).length} ok)`);
			if (quotaHit || results.length < items.length) {
				const probe = await probeQuota(m.id);
				if (probe.kind === "day") {
					state.parkedUntil[m.id] = new Date(Date.now() + probe.retrySeconds * 1000).toISOString();
					await Bun.write(STATE, `${JSON.stringify(state, null, 2)}\n`);
					log(`${m.id}: daily quota exhausted; parked until ${state.parkedUntil[m.id]}`);
					parkedNow = true;
					break;
				}
				if (probe.kind === "minute" || probe.kind === "other") {
					log(`${m.id}: ${probe.kind} limit; waiting ${probe.retrySeconds}s`);
					await Bun.sleep(Math.min(probe.retrySeconds, 300) * 1000);
				}
				for (const i of items) {
					if (!results.some(r => key(r) === key(i))) {
						state.failures[key(i)] = (state.failures[key(i)] ?? 0) + 1;
					}
				}
			}
		}
		if (parkedNow) return;
		// Items that keep failing for non-quota reasons are skipped after 3 tries.
		cursor += sameSet.length;
	}
}

async function run(minutes: number, only: string[] | null): Promise<void> {
	await fs.mkdir(OUT_DIR, { recursive: true });
	const deadline = Date.now() + minutes * 60_000;
	const state = await readState();
	const done = new Set((await readResults()).map(key));
	for (const [k, n] of Object.entries(state.failures)) if (n >= 3) done.add(k);
	const models = MODELS.filter(m => !only || only.includes(m.id));
	const queue = await pending(models, done);
	for (const m of models) log(`${m.id}: ${queue.get(m.id)?.reduce((a, p) => a + p.length, 0) ?? 0} runs pending`);
	await Promise.all(models.map(m => runModel(m, queue.get(m.id) ?? [], deadline, state)));
	await Bun.write(STATE, `${JSON.stringify(state, null, 2)}\n`);
	await writeReport();
	log("run finished");
}

// ── report ──────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

async function writeReport(): Promise<string> {
	const results = await readResults();
	const lines: string[] = [
		"# locus edit benchmark: hashline (A) vs hashline + edit_symbol (B)",
		"",
		`Generated ${new Date().toISOString()} from \`results.jsonl\` (${results.length} runs). Each model runs both variants on the same tasks; compare within a row group, never across models.`,
		"",
		"| model | set | var | runs | success | tok/run | out tok/run | edits/run | edit fails | edit_symbol share | med time |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
	];
	const paired: string[] = ["", "## Paired outcomes (same task and run, both variants finished)", "", "| model | set | pairs | both ok | A only | B only | neither |", "|---|---|---|---|---|---|---|"];
	const groups = new Map<string, ResultLine[]>();
	for (const r of results) {
		const g = `${r.model}|${r.set}`;
		const list = groups.get(g);
		if (list) list.push(r);
		else groups.set(g, [r]);
	}
	for (const [g, rs] of [...groups].sort()) {
		const [model, set] = g.split("|");
		for (const v of ["A", "B"] as Variant[]) {
			const vs = rs.filter(r => r.variant === v);
			if (vs.length === 0) continue;
			const ok = vs.filter(r => r.success).length;
			const editCalls = vs.reduce((a, r) => a + (r.tools.edit ?? 0) + (r.tools.edit_symbol ?? 0), 0);
			const symCalls = vs.reduce((a, r) => a + (r.tools.edit_symbol ?? 0), 0);
			lines.push(
				`| ${model} | ${set} | ${v} | ${vs.length} | ${((100 * ok) / vs.length).toFixed(0)}% (${ok}) | ${Math.round(mean(vs.map(r => r.tokensTotal)))} | ${Math.round(mean(vs.map(r => r.tokensOutput)))} | ${mean(vs.map(r => r.edits)).toFixed(2)} | ${vs.reduce((a, r) => a + r.editFailures, 0)} | ${v === "B" ? `${editCalls ? ((100 * symCalls) / editCalls).toFixed(0) : 0}%` : "—"} | ${(median(vs.map(r => r.durationMs)) / 1000).toFixed(1)}s |`,
			);
		}
		const byPair = new Map<string, Partial<Record<Variant, boolean>>>();
		for (const r of rs) {
			const k = `${r.task}|${r.run}`;
			byPair.set(k, { ...byPair.get(k), [r.variant]: r.success });
		}
		const full = [...byPair.values()].filter(p => p.A !== undefined && p.B !== undefined);
		paired.push(
			`| ${model} | ${set} | ${full.length} | ${full.filter(p => p.A && p.B).length} | ${full.filter(p => p.A && !p.B).length} | ${full.filter(p => !p.A && p.B).length} | ${full.filter(p => !p.A && !p.B).length} |`,
		);
	}
	const text = `${[...lines, ...paired].join("\n")}\n`;
	await fs.mkdir(OUT_DIR, { recursive: true });
	await Bun.write(REPORT, text);
	return text;
}

async function status(): Promise<void> {
	const state = await readState();
	const done = new Set((await readResults()).map(key));
	const queue = await pending(MODELS, done);
	for (const m of MODELS) {
		const n = queue.get(m.id)?.reduce((a, p) => a + p.length, 0) ?? 0;
		process.stdout.write(`${m.id.padEnd(24)} pending ${String(n).padStart(4)}  parked ${state.parkedUntil[m.id] ?? "-"}\n`);
	}
}

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { minutes: { type: "string", default: "110" }, models: { type: "string" } },
});
const cmd = positionals[0] ?? "status";
if (cmd === "run") await run(Number(values.minutes), values.models ? values.models.split(",") : null);
else if (cmd === "report") process.stdout.write(await writeReport());
else await status();
