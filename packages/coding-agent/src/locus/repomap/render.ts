/**
 * locus: rendering the repository map for the model.
 *
 * - `renderMap` — ranked slice of files and symbols within a token budget,
 *   personalized towards `focus` paths/symbols (and session boosts);
 * - `renderImporters` — who imports a file, with the names they use;
 * - `renderCallers` — who calls a symbol.
 *
 * Token counts are estimated at 3.5 characters per token; the binary search
 * keeps the rendered text at or under the estimate for `budget`.
 */
import { computePageRank, loadRankGraph, type RankGraph } from "./graph";
import type { FileRow, IndexStore, SymbolRow } from "./store";

export const DEFAULT_MAP_BUDGET = 2000;
export const MIN_MAP_BUDGET = 256;
export const MAX_MAP_BUDGET = 8000;
const CHARS_PER_TOKEN = 3.5;
/** Members shown per focus file before the budget search takes over. */
const FOCUS_SYMBOL_CAP = 40;
/** Ranked candidates kept for the budget pass; far above what 8k tokens can show. */
const MAX_RANKED = 4000;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface MapOptions {
	/** Repo-relative paths, `path::Symbol` targets or `*` globs to center on. */
	focus?: string[];
	budget?: number;
	includePrivate?: boolean;
	/** Extra teleport boosts by repo-relative path (edited files: 5, read: 3). */
	boosts?: Map<string, number>;
	/** Shown in the footer, e.g. "partial". */
	status?: string;
}

interface FileInfo {
	id: number;
	path: string;
	rank: number;
	dependents: number;
}

export class SymbolTargetError extends Error {}

/** Parse `path::Qual.Name` into its parts. */
export function parseTarget(target: string): { file: string; qname: string } | null {
	const sep = target.indexOf("::");
	if (sep <= 0) return null;
	const file = target.slice(0, sep).replace(/^\.\//, "");
	const qname = target.slice(sep + 2).replaceAll("::", ".");
	return qname ? { file, qname } : null;
}

function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

function lineSpan(s: SymbolRow): string {
	return s.start_line === s.end_line ? `L${s.start_line}` : `L${s.start_line}-${s.end_line}`;
}

function depthOf(sym: SymbolRow, byId: Map<number, SymbolRow>): number {
	let d = 0;
	let cur = sym.parent_id === null ? undefined : byId.get(sym.parent_id);
	while (cur && d < 8) {
		d++;
		cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id);
	}
	// Go methods and Rust impl members whose type lives elsewhere still nest once.
	if (d === 0 && sym.qname.includes(".")) d = 1;
	return d;
}

/** Query-independent data for rendering, reused until the graph is rebuilt. */
interface RenderData {
	version: string;
	files: FileRow[];
	byPath: Map<string, FileRow>;
	symbols: SymbolRow[];
	byId: Map<number, SymbolRow>;
	perFileCount: Map<number, number>;
	dependents: Map<number, number>;
	callCaller: Int32Array;
	/** Callee position in `symbols` (-1 when unknown). */
	callCalleeIdx: Int32Array;
	indexById: Map<number, number>;
	symbolsByFile: Map<number, number[]>;
	/** Positions of exported symbols in `symbols`. */
	exportedIdx: Int32Array;
	callCount: Float64Array;
	outCalls: Map<number, number>;
	graph: RankGraph;
}

const renderCache = new WeakMap<IndexStore, RenderData>();

function getRenderData(store: IndexStore): RenderData {
	const version = `${store.getMeta("graph_built_at") ?? ""}`;
	const cached = renderCache.get(store);
	if (cached && cached.version === version) return cached;
	const db = store.db;
	const files = store.allFiles();
	const symbols = db.query<SymbolRow, []>("SELECT * FROM symbols").all();
	const perFileCount = new Map<number, number>();
	for (const s of symbols) perFileCount.set(s.file_id, (perFileCount.get(s.file_id) ?? 0) + 1);
	const callRows = db
		.query<{ caller_file_id: number; callee_symbol_id: number; count: number }, []>(
			"SELECT caller_file_id, callee_symbol_id, count FROM calls",
		)
		.all();
	const indexById = new Map<number, number>();
	const symbolsByFile = new Map<number, number[]>();
	const exported: number[] = [];
	symbols.forEach((sym, i) => {
		indexById.set(sym.id, i);
		const list = symbolsByFile.get(sym.file_id);
		if (list) list.push(i);
		else symbolsByFile.set(sym.file_id, [i]);
		if (sym.exported) exported.push(i);
	});
	const callCaller = new Int32Array(callRows.length);
	const callCalleeIdx = new Int32Array(callRows.length);
	const callCount = new Float64Array(callRows.length);
	const outCalls = new Map<number, number>();
	callRows.forEach((c, i) => {
		callCaller[i] = c.caller_file_id;
		callCalleeIdx[i] = indexById.get(c.callee_symbol_id) ?? -1;
		callCount[i] = c.count;
		outCalls.set(c.caller_file_id, (outCalls.get(c.caller_file_id) ?? 0) + c.count);
	});
	const data: RenderData = {
		version,
		files,
		byPath: new Map(files.map(f => [f.path, f])),
		symbols,
		byId: new Map(symbols.map(s => [s.id, s])),
		perFileCount,
		dependents: new Map(
			db
				.query<{ dst_file: number; n: number }, []>(
					"SELECT dst_file, COUNT(DISTINCT src_file) AS n FROM edges WHERE kind = 'import' GROUP BY dst_file",
				)
				.all()
				.map(r => [r.dst_file, r.n]),
		),
		callCaller,
		callCalleeIdx,
		indexById,
		symbolsByFile,
		exportedIdx: Int32Array.from(exported),
		callCount,
		outCalls,
		graph: loadRankGraph(store),
	};
	renderCache.set(store, data);
	return data;
}

export function renderMap(store: IndexStore, options: MapOptions = {}): string {
	const budget = Math.min(MAX_MAP_BUDGET, Math.max(MIN_MAP_BUDGET, options.budget ?? DEFAULT_MAP_BUDGET));
	const db = store.db;
	const data = getRenderData(store);
	const { files, byPath, symbols, byId, perFileCount } = data;
	if (files.length === 0) return `[map: index is empty${options.status ? `, ${options.status}` : ""}]`;

	// Focus resolution: files, globs, symbol targets.
	const focusFiles = new Set<number>();
	const focusSymbols = new Set<number>();
	for (const raw of options.focus ?? []) {
		const target = parseTarget(raw);
		if (target) {
			const f = byPath.get(target.file);
			if (!f) continue;
			focusFiles.add(f.id);
			for (const s of db
				.query<{ id: number }, [number, string, string]>(
					"SELECT id FROM symbols WHERE file_id = ? AND (qname = ? OR qname LIKE ? || '.%')",
				)
				.all(f.id, target.qname, target.qname)) {
				focusSymbols.add(s.id);
			}
			continue;
		}
		const rel = raw.replace(/^\.\//, "").replace(/\/$/, "");
		if (/[*?]/.test(rel)) {
			const re = globToRegExp(rel);
			for (const f of files) if (re.test(f.path)) focusFiles.add(f.id);
		} else if (byPath.has(rel)) {
			focusFiles.add(byPath.get(rel)!.id);
		} else {
			for (const f of files) if (f.path.startsWith(`${rel}/`)) focusFiles.add(f.id);
		}
	}

	// Personalized PageRank, warm-started from the stored global rank.
	const boosts = new Map<number, number>();
	for (const [p, b] of options.boosts ?? []) {
		const f = byPath.get(p);
		if (f) boosts.set(f.id, (boosts.get(f.id) ?? 0) + b);
	}
	for (const id of focusFiles) boosts.set(id, (boosts.get(id) ?? 0) + 3);
	if (focusSymbols.size > 0) {
		const callerFiles = db
			.query<{ caller_file_id: number }, []>(
				`SELECT DISTINCT caller_file_id FROM calls WHERE callee_symbol_id IN (${[...focusSymbols].join(",")})`,
			)
			.all();
		for (const r of callerFiles) boosts.set(r.caller_file_id, (boosts.get(r.caller_file_id) ?? 0) + 1);
	}
	const rank =
		boosts.size > 0 ? computePageRank(data.graph, boosts, new Map(files.map(f => [f.id, f.pagerank]))) : null;
	const dependents = data.dependents;
	const info = new Map<number, FileInfo>(
		files.map(f => [
			f.id,
			{ id: f.id, path: f.path, rank: rank?.get(f.id) ?? f.pagerank, dependents: dependents.get(f.id) ?? 0 },
		]),
	);

	// Symbol score: file rank flowing through calls into it, plus a share of
	// its own file's rank (exported symbols only, unless private allowed).
	const inflow = new Float64Array(symbols.length);
	for (let i = 0; i < data.callCaller.length; i++) {
		const caller = data.callCaller[i] ?? 0;
		const callee = data.callCalleeIdx[i] ?? -1;
		if (callee < 0) continue;
		const r = info.get(caller)?.rank ?? 0;
		inflow[callee] = (inflow[callee] ?? 0) + (r * (data.callCount[i] ?? 0)) / (data.outCalls.get(caller) ?? 1);
	}

	// Candidates: exported symbols, plus every symbol of focus files (and all
	// symbols with includePrivate). Scores in a typed array; no per-symbol objects.
	const focusSymbolIdx = [...focusSymbols].flatMap(id => data.indexById.get(id) ?? []);
	let candidates: Int32Array;
	if (options.includePrivate) {
		candidates = Int32Array.from({ length: symbols.length }, (_, i) => i);
	} else {
		const extra: number[] = [...focusSymbolIdx];
		for (const id of focusFiles)
			for (const i of data.symbolsByFile.get(id) ?? []) if (!symbols[i]!.exported) extra.push(i);
		const merged = new Int32Array(data.exportedIdx.length + extra.length);
		merged.set(data.exportedIdx);
		merged.set(extra, data.exportedIdx.length);
		candidates = merged;
	}
	const fileRank = (fileId: number) => info.get(fileId)?.rank ?? 0;
	const scores = new Float64Array(candidates.length);
	const forced = new Uint8Array(candidates.length);
	const forcedPerFile = new Map<number, number>();
	const focusSymbolSet = new Set(focusSymbolIdx);
	const seen = new Set<number>();
	for (let c = 0; c < candidates.length; c++) {
		const i = candidates[c]!;
		if (seen.has(i)) {
			scores[c] = -1;
			continue;
		}
		seen.add(i);
		const s = symbols[i]!;
		let score = (inflow[i] ?? 0) + fileRank(s.file_id) / Math.max(1, perFileCount.get(s.file_id) ?? 1);
		if (!s.exported) score /= 2;
		scores[c] = score;
		if (focusSymbolSet.has(i)) forced[c] = 1;
		else if (focusFiles.has(s.file_id) && focusSymbols.size === 0) {
			const n = forcedPerFile.get(s.file_id) ?? 0;
			if (n < FOCUS_SYMBOL_CAP && (s.exported || options.includePrivate || s.parent_id === null)) {
				forced[c] = 1;
				forcedPerFile.set(s.file_id, n + 1);
			}
		}
	}

	// Keep the top MAX_RANKED by score (typed-array sort for the threshold),
	// plus everything forced; only those get an object sort.
	let threshold = -Infinity;
	if (candidates.length > MAX_RANKED) {
		const sortedScores = Float64Array.from(scores).sort();
		threshold = sortedScores[sortedScores.length - MAX_RANKED] ?? -Infinity;
	}
	const picked: number[] = [];
	for (let c = 0; c < candidates.length; c++) {
		if ((scores[c] ?? -1) < 0) continue;
		if (forced[c] || (scores[c] ?? 0) >= threshold) picked.push(c);
	}
	picked.sort(
		(a, b) =>
			(forced[b] ?? 0) - (forced[a] ?? 0) || (scores[b] ?? 0) - (scores[a] ?? 0) || candidates[a]! - candidates[b]!,
	);

	const symbolLine = (i: number) => {
		const s = symbols[i]!;
		return `${"  ".repeat(1 + depthOf(s, byId))}${s.signature || `${s.kind} ${s.name}`}  ${lineSpan(s)}`;
	};
	const header = (fileId: number) => {
		const f = info.get(fileId)!;
		return f.dependents > 0 ? `${f.path}  ←${f.dependents}` : f.path;
	};

	// One pass of prefix sums: each pick costs its line, plus its file header
	// the first time the file appears. Focus headers are always paid.
	const budgetChars = (budget - 16) * CHARS_PER_TOKEN;
	const headerPaid = new Set<number>(focusFiles);
	let chars = -1;
	for (const id of focusFiles) chars += header(id).length + 1;
	let k = 0;
	const lineCache = new Map<number, string>();
	for (const c of picked) {
		const i = candidates[c]!;
		const fileId = symbols[i]!.file_id;
		const line = symbolLine(i);
		const cost = line.length + 1 + (headerPaid.has(fileId) ? 0 : header(fileId).length + 1);
		if (chars + cost > budgetChars) break;
		chars += cost;
		headerPaid.add(fileId);
		lineCache.set(i, line);
		k++;
	}

	const groups = new Map<number, number[]>();
	for (const id of focusFiles) groups.set(id, []);
	for (const c of picked.slice(0, k)) {
		const i = candidates[c]!;
		const fileId = symbols[i]!.file_id;
		const list = groups.get(fileId);
		if (list) list.push(i);
		else groups.set(fileId, [i]);
	}
	const ordered = [...groups.keys()].sort((a, b) => {
		const fa = focusFiles.has(a) ? 1 : 0;
		const fb = focusFiles.has(b) ? 1 : 0;
		return fb - fa || fileRank(b) - fileRank(a) || a - b;
	});
	const lines: string[] = [];
	for (const id of ordered) {
		lines.push(header(id));
		const list = (groups.get(id) ?? []).sort(
			(a, b) => symbols[a]!.start_line - symbols[b]!.start_line || symbols[a]!.id - symbols[b]!.id,
		);
		for (const i of list) lines.push(lineCache.get(i) ?? symbolLine(i));
	}
	const text = lines.join("\n");
	const footer = `[map: ${ordered.length}/${files.length} files, ~${estimateTokens(text)}/${budget} tok${options.status ? `, index: ${options.status}` : ""}]`;
	return `${text}\n${footer}`;
}

// ── importers ───────────────────────────────────────────────────────────

export function renderImporters(store: IndexStore, relPath: string, depth: 1 | 2 = 1): string {
	const rel = relPath.replace(/^\.\//, "");
	const target = store.fileByPath(rel);
	if (!target) throw new SymbolTargetError(`map: file is not indexed: ${rel}`);
	const db = store.db;

	interface ImporterRow {
		path: string;
		file_id: number;
		kind: string;
		names: string;
	}
	const direct = (fileId: number) =>
		db
			.query<ImporterRow, [number]>(
				`SELECT f.path, f.id AS file_id, i.kind, i.names FROM imports i JOIN files f ON f.id = i.file_id
				 WHERE i.resolved_file_id = ?1
				    OR (i.resolved_extra IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(i.resolved_extra) WHERE value = ?1))
				 ORDER BY f.path`,
			)
			.all(fileId);
	const refCounts = new Map(
		db
			.query<{ caller_file_id: number; n: number }, [number]>(
				"SELECT caller_file_id, SUM(count) AS n FROM calls WHERE callee_file_id = ? GROUP BY caller_file_id",
			)
			.all(target.id)
			.map(r => [r.caller_file_id, r.n]),
	);

	const rows = direct(target.id);
	const byFile = new Map<string, { names: Set<string>; reexport: boolean; fileId: number }>();
	for (const r of rows) {
		let entry = byFile.get(r.path);
		if (!entry) byFile.set(r.path, (entry = { names: new Set(), reexport: false, fileId: r.file_id }));
		for (const n of JSON.parse(r.names) as Array<{ imported: string }>) {
			if (n.imported !== "*") entry.names.add(n.imported);
			else entry.names.add("*");
		}
		if (r.kind === "reexport") entry.reexport = true;
	}

	const total = [...byFile.values()].reduce((sum, e) => sum + (refCounts.get(e.fileId) ?? 0), 0);
	const width = Math.max(0, ...[...byFile.keys()].map(p => p.length));
	const lines = [`importers of ${rel} (${byFile.size} files, ${total} refs)`];
	for (const [p, e] of byFile) {
		const names = [...e.names].sort().join(", ") || "(module)";
		const refs = refCounts.get(e.fileId);
		lines.push(`  ${p.padEnd(width)}  ${names}${e.reexport ? "  (re-export)" : ""}${refs ? `  ×${refs}` : ""}`);
	}
	if (depth === 2) {
		for (const [p, e] of byFile) {
			if (!e.reexport) continue;
			const second = new Set(direct(e.fileId).map(r => r.path));
			second.delete(rel);
			if (second.size > 0) {
				lines.push(`  via re-export in ${p}: ${second.size} more`);
				for (const s of [...second].sort()) lines.push(`    ${s}`);
			}
		}
	}
	if (byFile.size === 0) lines.push("  (no importers)");
	return lines.join("\n");
}

// ── callers ─────────────────────────────────────────────────────────────

/** Resolve `path::Qual.Name[#N]` to exactly one symbol, or throw with candidates. */
export function resolveSymbolTarget(store: IndexStore, target: string): SymbolRow {
	const ordinal = /#(\d+)$/.exec(target);
	const parsed = parseTarget(ordinal ? target.slice(0, ordinal.index) : target);
	if (!parsed) throw new SymbolTargetError(`invalid target "${target}": expected path::Name or path::Class.method`);
	const file = store.fileByPath(parsed.file);
	if (!file) throw new SymbolTargetError(`file is not indexed: ${parsed.file}`);
	const candidates = store.db
		.query<SymbolRow, [number, string]>("SELECT * FROM symbols WHERE file_id = ? AND qname = ? ORDER BY start_line")
		.all(file.id, parsed.qname);
	if (ordinal) {
		const hit = candidates[Number(ordinal[1]) - 1];
		if (hit) return hit;
	} else if (candidates.length === 1) {
		return candidates[0]!;
	}
	if (candidates.length > 1 || ordinal) {
		const list = candidates.map(
			(s, i) =>
				`  ${parsed.file}::${s.qname}#${i + 1}  ${s.kind}  ${lineSpan(s)}  ${s.signature}${s.detail ? `  [${s.detail}]` : ""}`,
		);
		throw new SymbolTargetError(
			`"${target}" is ambiguous (${candidates.length} candidates):\n${list.join("\n")}\nUse a qualified target or #N.`,
		);
	}
	const names = store.db
		.query<{ qname: string }, [number]>("SELECT DISTINCT qname FROM symbols WHERE file_id = ?")
		.all(file.id)
		.map(r => r.qname);
	const close = closestNames(parsed.qname, names, 5);
	throw new SymbolTargetError(
		`symbol not found "${target}".${close.length > 0 ? ` Closest: ${close.join(", ")}` : ""}`,
	);
}

export function closestNames(needle: string, haystack: string[], limit: number): string[] {
	const lower = needle.toLowerCase();
	return haystack
		.map(h => ({ h, d: levenshtein(lower, h.toLowerCase()) }))
		.filter(x => x.d <= Math.max(2, Math.floor(needle.length / 3)) || x.h.toLowerCase().endsWith(`.${lower}`))
		.sort((a, b) => a.d - b.d || a.h.localeCompare(b.h))
		.slice(0, limit)
		.map(x => x.h);
}

function levenshtein(a: string, b: string): number {
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0]!;
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j]!;
			prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length]!;
}

export function renderCallers(store: IndexStore, target: string, depth: 1 | 2 = 1): string {
	const sym = resolveSymbolTarget(store, target);
	const db = store.db;
	interface CallerRow {
		path: string;
		qname: string | null;
		symbol_id: number | null;
		count: number;
		confidence: string;
	}
	const callersOf = (symbolId: number) =>
		db
			.query<CallerRow, [number]>(
				`SELECT f.path, s.qname, s.id AS symbol_id, c.count, c.confidence FROM calls c
				 JOIN files f ON f.id = c.caller_file_id
				 LEFT JOIN symbols s ON s.id = c.caller_symbol_id
				 WHERE c.callee_symbol_id = ? ORDER BY f.path, s.start_line`,
			)
			.all(symbolId);
	const rows = callersOf(sym.id);
	const file = db.query<{ path: string }, [number]>("SELECT path FROM files WHERE id = ?").get(sym.file_id)!;
	const lines = [`callers of ${file.path}::${sym.qname} (${rows.length})`];
	const fmt = (r: CallerRow, indent: string) =>
		`${indent}${r.path}::${r.qname ?? "<module>"}${r.count > 1 ? `  ×${r.count}` : ""}${r.confidence === "unique" ? "  (by unique name)" : ""}`;
	for (const r of rows) {
		lines.push(fmt(r, "  "));
		if (depth === 2 && r.symbol_id !== null) for (const r2 of callersOf(r.symbol_id)) lines.push(fmt(r2, "    ← "));
	}
	if (rows.length === 0) lines.push("  (no resolved callers; dynamic or method calls on values are not tracked)");
	return lines.join("\n");
}
