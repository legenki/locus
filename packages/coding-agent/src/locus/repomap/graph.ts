/**
 * locus: dependency graph and ranking.
 *
 * Rebuilt from stored tags after every batch of file changes; no file is
 * re-parsed here. Steps:
 *
 * 1. Resolve every import to repo files and build per-file name bindings.
 * 2. Resolve references (calls, constructors, macros, types) to symbols,
 *    trying, in order: an import binding, a namespace-qualified binding, a
 *    `this.`/`Type::` member, the same file, the same Go package, Rust glob
 *    imports, and (TS only) a unique ambient `.d.ts` global. Anything else
 *    stays unresolved: we do not guess. In particular there is no
 *    "unique name anywhere" fallback — all three languages require an import
 *    for a cross-file name, so such a match is almost always a different
 *    symbol (across languages, it always is).
 * 3. File edges: `import` (weight 1 per resolved import) plus `ref`
 *    (Σ √count · name multiplier over resolved references).
 * 4. PageRank (d = 0.85) over the weighted file graph.
 */
import * as path from "node:path";
import type { ImportName } from "@oh-my-pi/pi-natives";
import type { ProjectConfig } from "./project";
import { buildGoPackages, type ResolveContext, resolveImport } from "./resolve";
import type { CallRow, FileRow, ImportRow, IndexStore, RefRow, SymbolRow } from "./store";

export const PAGERANK_DAMPING = 0.85;
export const PAGERANK_MAX_ITERATIONS = 30;
export const PAGERANK_EPSILON = 1e-9;

interface Binding {
	/** Name in the target module; `*` binds the module namespace. */
	imported: string;
	targets: number[];
}

interface GraphInputs {
	files: FileRow[];
	symbols: SymbolRow[];
	imports: ImportRow[];
	refs: RefRow[];
}

export interface GraphStats {
	/** `"full"` or the number of files recomputed. */
	scope: "full" | number;
	files: number;
	symbols: number;
	imports: number;
	resolvedImports: number;
	refs: number;
	resolvedRefs: number;
	edges: number;
}

/** Name weight multiplier (after Aider's repo map). */
function nameMultiplier(name: string, definers: number): number {
	let mul = 1;
	if (name.length >= 8 && (/[a-z][A-Z]/.test(name) || name.includes("_"))) mul *= 2;
	if (name.startsWith("_")) mul *= 0.1;
	if (definers > 5) mul *= 0.1;
	return mul;
}

function isJsLang(lang: string | null): boolean {
	return lang === "typescript" || lang === "tsx" || lang === "javascript";
}

function lastSegment(qualifier: string): string {
	const parts = qualifier.split(/::|\./);
	return parts[parts.length - 1] ?? qualifier;
}

function goPackageName(specifier: string): string {
	const last = specifier.split("/").pop() ?? specifier;
	// `gopkg.in/yaml.v3` → `yaml`; `example.com/x/v2` keeps the version-less parent.
	if (/^v\d+$/.test(last)) return specifier.split("/").slice(-2, -1)[0] ?? last;
	return last.split(".")[0] ?? last;
}

/**
 * Rebuild the graph. With `scope`, only imports, references, calls and edges
 * that originate in those files are recomputed (the caller widens the scope
 * to every file whose resolution may depend on what changed); everything else
 * keeps its stored resolution.
 */
export function rebuildGraph(store: IndexStore, config: ProjectConfig, scope?: Set<number>): GraphStats {
	const db = store.db;
	// The scope lives in a temp table: SQLite plans `IN (temp table)` as an
	// index probe, while `IN (json_each(?))` degrades to a scan per row.
	const scoped = scope !== undefined;
	if (scoped) {
		db.run("CREATE TEMP TABLE IF NOT EXISTS graph_scope (id INTEGER PRIMARY KEY)");
		db.run("DELETE FROM graph_scope");
		const ins = db.prepare("INSERT INTO graph_scope (id) VALUES (?)");
		store.transaction(() => {
			for (const id of scope) ins.run(id);
		});
	}
	const inScope = "file_id IN (SELECT id FROM graph_scope)";
	const inputs: GraphInputs = {
		files: store.allFiles(),
		symbols: db.query<SymbolRow, []>("SELECT * FROM symbols").all(),
		imports: db.query<ImportRow, []>(`SELECT * FROM imports${scoped ? ` WHERE ${inScope}` : ""}`).all(),
		refs: db.query<RefRow, []>(`SELECT * FROM refs${scoped ? ` WHERE ${inScope}` : ""}`).all(),
	};
	const fileById = new Map(inputs.files.map(f => [f.id, f]));
	const idByPath = new Map(inputs.files.map(f => [f.path, f.id]));
	const fileSet = new Set(idByPath.keys());
	const goPackages = buildGoPackages(fileSet);
	const ctx: ResolveContext = { config, files: fileSet, goPackages };

	// ── 1. Imports and bindings ─────────────────────────────────────────
	const bindings = new Map<number, Map<string, Binding>>();
	const importTargets = new Map<number, Set<number>>();
	const importUpdates: Array<[number | null, string | null, number]> = [];
	let resolvedImports = 0;

	const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
		const list = map.get(key);
		if (list) list.push(value);
		else map.set(key, [value]);
	};
	const reexports = new Map<number, Array<{ names: ImportName[]; targets: number[] }>>();
	const bind = (fileId: number, local: string, binding: Binding) => {
		let map = bindings.get(fileId);
		if (!map) bindings.set(fileId, (map = new Map()));
		map.set(local, binding);
	};

	for (const imp of inputs.imports) {
		const file = fileById.get(imp.file_id);
		if (!file) continue;
		const names = JSON.parse(imp.names) as ImportName[];
		const targets = new Set<number>();
		const toIds = (paths: Array<string | null>) =>
			paths.flatMap(p => {
				const id = p === null ? undefined : idByPath.get(p);
				return id === undefined || id === file.id ? [] : [id];
			});

		if (file.lang === "rust" && imp.kind === "use") {
			// `use a::b::{c}`: `a::b::c` may itself be a module; else `c` is an item of `a::b`.
			const base = resolveImport(ctx, file.path, file.lang, imp.specifier, imp.kind).file;
			for (const n of names) {
				if (n.imported === "*") {
					for (const id of toIds([base])) {
						targets.add(id);
						bind(file.id, `*${id}`, { imported: "*", targets: [id] });
					}
					continue;
				}
				const spec = imp.specifier === "" ? n.imported : `${imp.specifier}::${n.imported}`;
				const asModule = resolveImport(ctx, file.path, file.lang, spec, imp.kind).file;
				if (asModule && asModule !== base) {
					const ids = toIds([asModule]);
					ids.forEach(id => targets.add(id));
					bind(file.id, n.local, { imported: "*", targets: ids });
				} else {
					const ids = toIds([base]);
					ids.forEach(id => targets.add(id));
					bind(file.id, n.local, { imported: n.imported, targets: ids });
				}
			}
		} else {
			const resolved = resolveImport(ctx, file.path, file.lang, imp.specifier, imp.kind);
			const ids = toIds([resolved.file, ...resolved.extra]);
			ids.forEach(id => targets.add(id));
			if (file.lang === "rust" && imp.kind === "mod") {
				// `mod foo;` binds `foo::` in the declaring file.
				if (ids.length > 0) bind(file.id, imp.specifier, { imported: "*", targets: ids });
			} else if (file.lang === "go") {
				const local =
					imp.alias && imp.alias !== "_" && imp.alias !== "." ? imp.alias : goPackageName(imp.specifier);
				if (ids.length > 0) bind(file.id, local, { imported: "*", targets: ids });
			} else {
				for (const n of names) bind(file.id, n.local, { imported: n.imported, targets: ids });
				if (imp.kind === "reexport" && ids.length > 0) push(reexports, file.id, { names, targets: ids });
			}
		}

		const list = [...targets];
		if (list.length > 0) resolvedImports++;
		importUpdates.push([list[0] ?? null, list.length > 1 ? JSON.stringify(list.slice(1)) : null, imp.id]);
		let set = importTargets.get(file.id);
		if (!set) importTargets.set(file.id, (set = new Set()));
		for (const t of list) set.add(t);
	}

	// Barrels outside the scope keep their stored resolution.
	if (scoped) {
		const stored = db
			.query<{ file_id: number; names: string; resolved_file_id: number | null; resolved_extra: string | null }, []>(
				`SELECT file_id, names, resolved_file_id, resolved_extra FROM imports
				 WHERE kind = 'reexport' AND resolved_file_id IS NOT NULL AND file_id NOT IN (SELECT id FROM graph_scope)`,
			)
			.all();
		for (const r of stored) {
			const targets = [r.resolved_file_id!, ...((r.resolved_extra ? JSON.parse(r.resolved_extra) : []) as number[])];
			push(reexports, r.file_id, { names: JSON.parse(r.names) as ImportName[], targets });
		}
	}

	// ── 2. Reference resolution ─────────────────────────────────────────
	const symbolById = new Map(inputs.symbols.map(s => [s.id, s]));
	const topByFile = new Map<number, Map<string, SymbolRow[]>>();
	const qnameByFile = new Map<number, Map<string, SymbolRow[]>>();
	const exportedByName = new Map<string, SymbolRow[]>();
	const definersByName = new Map<string, Set<number>>();
	for (const s of inputs.symbols) {
		let q = qnameByFile.get(s.file_id);
		if (!q) qnameByFile.set(s.file_id, (q = new Map()));
		push(q, s.qname, s);
		if (s.parent_id === null && !s.qname.includes(".")) {
			let t = topByFile.get(s.file_id);
			if (!t) topByFile.set(s.file_id, (t = new Map()));
			push(t, s.name, s);
			if (s.exported) push(exportedByName, s.name, s);
		}
		let d = definersByName.get(s.name);
		if (!d) definersByName.set(s.name, (d = new Set()));
		d.add(s.file_id);
	}

	/** Top-level `name` in `fileIds`, following `export … from` chains (barrels). */
	const findTop = (fileIds: number[], name: string, depth = 0): SymbolRow | null => {
		for (const id of fileIds) {
			const hit = topByFile.get(id)?.get(name);
			if (hit && hit.length > 0) return hit[0] ?? null;
		}
		if (depth >= 6) return null;
		for (const id of fileIds) {
			for (const re of reexports.get(id) ?? []) {
				for (const n of re.names) {
					if (n.local === name && n.imported !== "*") {
						const hit = findTop(re.targets, n.imported, depth + 1);
						if (hit) return hit;
					} else if (n.imported === "*" && n.local === "*") {
						const hit = findTop(re.targets, name, depth + 1);
						if (hit) return hit;
					}
				}
			}
		}
		return null;
	};
	const findQname = (fileIds: number[], qname: string): SymbolRow | null => {
		for (const id of fileIds) {
			const hit = qnameByFile.get(id)?.get(qname);
			if (hit && hit.length > 0) return hit[0] ?? null;
		}
		return null;
	};

	const calls = new Map<string, CallRow>();
	const refEdges = new Map<string, number>();
	let resolvedRefs = 0;

	for (const ref of inputs.refs) {
		const file = fileById.get(ref.file_id);
		if (!file) continue;
		const fileBindings = bindings.get(file.id);
		let target: SymbolRow | null = null;
		let confidence: CallRow["confidence"] = "import";

		if (ref.qualifier === null) {
			const b = fileBindings?.get(ref.name);
			if (b && b.imported !== "*") {
				target = findTop(b.targets, b.imported === "default" ? ref.name : b.imported);
				if (!target && b.imported === "default") {
					// Default export: the exported symbol of the target, if exactly one is default-like.
					target = findTop(b.targets, ref.name);
				}
			}
			if (!target) {
				confidence = "local";
				target = findTop([file.id], ref.name);
			}
			if (!target && file.lang === "go") {
				const dir = path.posix.dirname(file.path);
				const pkgFiles = (goPackages.get(dir === "." ? "" : dir) ?? []).map(p => idByPath.get(p) ?? -1);
				target = findTop(pkgFiles, ref.name);
			}
			if (!target) {
				// Rust glob imports.
				const globs = fileBindings ? [...fileBindings].filter(([k]) => k.startsWith("*")).map(([, v]) => v) : [];
				for (const g of globs) {
					target = findTop(g.targets, ref.name);
					if (target) break;
				}
				confidence = "import";
			}
			if (!target && isJsLang(file.lang)) {
				// TS/JS, Go and Rust all require an import for a cross-file name, so a bare
				// name is local, same-package, or a global. Only TS ambient globals
				// (`.d.ts`, same language family) may resolve by a unique name.
				const candidates = exportedByName.get(ref.name)?.filter(c => {
					const f = fileById.get(c.file_id);
					return f !== undefined && f.path.endsWith(".d.ts") && isJsLang(f.lang);
				});
				if (candidates?.length === 1 && candidates[0]?.file_id !== file.id) {
					target = candidates[0] ?? null;
					confidence = "unique";
				}
			}
		} else {
			const q = ref.qualifier;
			if (q === "this" || q === "self" || q === "Self") {
				const enclosing = ref.enclosing_symbol_id === null ? null : symbolById.get(ref.enclosing_symbol_id);
				const container = enclosing?.qname.includes(".")
					? enclosing.qname.slice(0, enclosing.qname.lastIndexOf("."))
					: null;
				if (container) {
					target = findQname([file.id], `${container}.${ref.name}`);
					confidence = "local";
				}
			} else {
				const head = q.split(/::|\./)[0] ?? q;
				const b = fileBindings?.get(head);
				if (b?.imported === "*") {
					// `ns.fn()`, `pkg.Func()`, `module::fn()`.
					target = findTop(b.targets, ref.name);
				} else if (b) {
					// `Type::method()` / `Type.staticMethod()` on an imported type.
					target = findQname(b.targets, `${b.imported}.${ref.name}`);
				}
				if (!target && file.lang === "rust") {
					// `crate::a::b::f()` and other path-qualified calls.
					const resolved = resolveImport(ctx, file.path, file.lang, q, "use").file;
					const id = resolved ? idByPath.get(resolved) : undefined;
					if (id !== undefined) target = findTop([id], ref.name);
				}
				if (!target) {
					// `Type.method` / `Type::method` defined in this file.
					target = findQname([file.id], `${lastSegment(q)}.${ref.name}`);
					if (target) confidence = "local";
				}
			}
		}

		if (!target || target.id === ref.enclosing_symbol_id) continue;
		resolvedRefs++;
		if (ref.kind !== "type") {
			const key = `${ref.enclosing_symbol_id ?? `f${file.id}`}:${target.id}`;
			const existing = calls.get(key);
			if (existing) existing.count += ref.count;
			else
				calls.set(key, {
					caller_symbol_id: ref.enclosing_symbol_id,
					caller_file_id: file.id,
					callee_symbol_id: target.id,
					callee_file_id: target.file_id,
					count: ref.count,
					confidence,
				});
		}
		if (target.file_id !== file.id) {
			const key = `${file.id}:${target.file_id}`;
			const definers = definersByName.get(target.name)?.size ?? 1;
			const w = Math.sqrt(ref.count) * nameMultiplier(target.name, definers);
			refEdges.set(key, (refEdges.get(key) ?? 0) + w);
		}
	}

	// ── 3. Persist imports, calls, edges ────────────────────────────────
	const edgeCount = store.transaction(() => {
		const upd = db.prepare("UPDATE imports SET resolved_file_id = ?, resolved_extra = ? WHERE id = ?");
		for (const u of importUpdates) upd.run(...u);
		if (scoped) db.run("DELETE FROM calls WHERE caller_file_id IN (SELECT id FROM graph_scope)");
		else db.run("DELETE FROM calls");
		const insCall = db.prepare(
			"INSERT INTO calls (caller_symbol_id, caller_file_id, callee_symbol_id, callee_file_id, count, confidence) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const c of calls.values()) {
			insCall.run(c.caller_symbol_id, c.caller_file_id, c.callee_symbol_id, c.callee_file_id, c.count, c.confidence);
		}
		if (scoped) db.run("DELETE FROM edges WHERE src_file IN (SELECT id FROM graph_scope)");
		else db.run("DELETE FROM edges");
		const insEdge = db.prepare("INSERT INTO edges (src_file, dst_file, weight, kind) VALUES (?, ?, ?, ?)");
		let n = 0;
		for (const [src, dsts] of importTargets) {
			for (const dst of dsts) {
				insEdge.run(src, dst, 1, "import");
				n++;
			}
		}
		for (const [key, w] of refEdges) {
			const [src, dst] = key.split(":").map(Number);
			insEdge.run(src, dst, w, "ref");
			n++;
		}
		return n;
	});

	// ── 4. Global PageRank ──────────────────────────────────────────────
	const ranks = computePageRank(store, entryPointBoosts(inputs.files, config));
	store.transaction(() => {
		const upd = db.prepare("UPDATE files SET pagerank = ? WHERE id = ?");
		for (const [id, r] of ranks) upd.run(r, id);
	});

	return {
		scope: scope ? scope.size : "full",
		files: inputs.files.length,
		symbols: inputs.symbols.length,
		imports: inputs.imports.length,
		resolvedImports,
		refs: inputs.refs.length,
		resolvedRefs,
		edges: scoped ? (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM edges").get()?.n ?? 0) : edgeCount,
	};
}

/** Files the program starts from get a teleport boost. */
function entryPointBoosts(files: FileRow[], config: ProjectConfig): Map<number, number> {
	const entries = new Set<string>();
	for (const pkg of config.packages.values()) for (const e of pkg.entries) entries.add(e);
	for (const crate of config.rustCrates.values())
		for (const r of crate.roots) if (r.endsWith("main.rs")) entries.add(r);
	const boosts = new Map<number, number>();
	for (const f of files) {
		const base = path.posix.basename(f.path);
		if (entries.has(f.path) || base === "main.go") boosts.set(f.id, 4);
	}
	return boosts;
}

/** Edge arrays for PageRank, loaded once per graph build. */
export interface RankGraph {
	ids: number[];
	index: Map<number, number>;
	src: Int32Array;
	dst: Int32Array;
	weight: Float64Array;
	outWeight: Float64Array;
}

export function loadRankGraph(store: IndexStore): RankGraph {
	const ids = store.db
		.query<{ id: number }, []>("SELECT id FROM files ORDER BY id")
		.all()
		.map(r => r.id);
	const index = new Map(ids.map((id, i) => [id, i]));
	const rows = store.db
		.query<{ src_file: number; dst_file: number; w: number }, []>(
			"SELECT src_file, dst_file, SUM(weight) AS w FROM edges GROUP BY src_file, dst_file",
		)
		.all();
	const src = new Int32Array(rows.length);
	const dst = new Int32Array(rows.length);
	const weight = new Float64Array(rows.length);
	const outWeight = new Float64Array(ids.length);
	rows.forEach((r, k) => {
		const s = index.get(r.src_file) ?? -1;
		const d = index.get(r.dst_file) ?? -1;
		src[k] = s;
		dst[k] = d;
		const w = s < 0 || d < 0 ? 0 : r.w;
		weight[k] = w;
		if (s >= 0) outWeight[s] = (outWeight[s] ?? 0) + w;
	});
	return { ids, index, src, dst, weight, outWeight };
}

/**
 * Weighted PageRank over the file graph.
 *
 * `boosts` maps file id → extra teleport weight in units of the uniform
 * weight (5 means "six times as likely as an average file"). Dangling mass
 * follows the teleport distribution. `warm` seeds the iteration, so a
 * personalization close to the stored ranking converges in a few rounds.
 */
export function computePageRank(
	source: IndexStore | RankGraph,
	boosts: Map<number, number> = new Map(),
	warm?: Map<number, number>,
): Map<number, number> {
	const g = "db" in source ? loadRankGraph(source) : source;
	const n = g.ids.length;
	const result = new Map<number, number>();
	if (n === 0) return result;

	const teleport = new Float64Array(n).fill(1);
	for (const [id, b] of boosts) {
		const i = g.index.get(id);
		if (i !== undefined) teleport[i] = (teleport[i] ?? 1) + b;
	}
	let tSum = 0;
	for (const t of teleport) tSum += t;
	for (let i = 0; i < n; i++) teleport[i] = (teleport[i] ?? 0) / tSum;

	let rank = new Float64Array(n);
	let warmSum = 0;
	if (warm) for (const id of g.ids) warmSum += warm.get(id) ?? 0;
	if (warm && warmSum > 0) g.ids.forEach((id, i) => (rank[i] = (warm.get(id) ?? 0) / warmSum));
	else rank.set(teleport);

	let next = new Float64Array(n);
	const edges = g.src.length;
	for (let iter = 0; iter < PAGERANK_MAX_ITERATIONS; iter++) {
		let dangling = 0;
		for (let i = 0; i < n; i++) if ((g.outWeight[i] ?? 0) === 0) dangling += rank[i] ?? 0;
		const base = 1 - PAGERANK_DAMPING + PAGERANK_DAMPING * dangling;
		for (let i = 0; i < n; i++) next[i] = base * (teleport[i] ?? 0);
		for (let k = 0; k < edges; k++) {
			const s = g.src[k] ?? -1;
			const d = g.dst[k] ?? -1;
			if (s < 0 || d < 0) continue;
			next[d] = (next[d] ?? 0) + (PAGERANK_DAMPING * (rank[s] ?? 0) * (g.weight[k] ?? 0)) / (g.outWeight[s] || 1);
		}
		let delta = 0;
		for (let i = 0; i < n; i++) delta += Math.abs((next[i] ?? 0) - (rank[i] ?? 0));
		[rank, next] = [next, rank];
		if (delta < PAGERANK_EPSILON) break;
	}
	g.ids.forEach((id, i) => result.set(id, rank[i] ?? 0));
	return result;
}
