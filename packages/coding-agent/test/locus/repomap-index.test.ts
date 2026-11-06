import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	cachedStaticMap,
	estimateTokens,
	rebuildGraph,
	RepoIndex,
	renderCallers,
	renderImporters,
	renderMap,
} from "../../src/locus/repomap";

let tmp: TempDir;
let root: string;
let index: RepoIndex;

async function write(rel: string, content: string): Promise<void> {
	await Bun.write(path.join(root, rel), content);
}

/** Importers of `rel`: files with an edge into it. */
function importers(rel: string): string[] {
	return index.store.db
		.query<{ path: string }, [string]>(
			`SELECT DISTINCT f.path FROM edges e JOIN files f ON f.id = e.src_file
			 WHERE e.dst_file = (SELECT id FROM files WHERE path = ?) ORDER BY f.path`,
		)
		.all(rel)
		.map(r => r.path);
}

/** `caller qname → callee path::qname` pairs. */
function calls(): string[] {
	return index.store.db
		.query<{ c: string }, []>(
			`SELECT COALESCE(cs.qname, '<file>') || ' -> ' || tf.path || '::' || ts.qname AS c
			 FROM calls k
			 LEFT JOIN symbols cs ON cs.id = k.caller_symbol_id
			 JOIN symbols ts ON ts.id = k.callee_symbol_id
			 JOIN files tf ON tf.id = k.callee_file_id
			 ORDER BY c`,
		)
		.all()
		.map(r => r.c);
}

function rank(rel: string): number {
	return index.store.fileByPath(rel)?.pagerank ?? -1;
}

beforeEach(async () => {
	tmp = await TempDir.create(path.join(os.tmpdir(), "locus-index-"));
	root = tmp.path();
	await write(".gitignore", "dist/\n");
	// TS workspace: package with wildcard exports, tsconfig paths, .js→.ts imports.
	await write("package.json", JSON.stringify({ name: "root", private: true }));
	await write(
		"packages/core/package.json",
		JSON.stringify({
			name: "@acme/core",
			exports: { ".": "./src/index.ts", "./util/*": { types: "./src/util/*.ts" } },
		}),
	);
	await write("packages/core/src/index.ts", 'export { parseConfig } from "./config.js";\n');
	await write(
		"packages/core/src/config.ts",
		"export function parseConfig(raw: string): Config { return JSON.parse(raw); }\nexport interface Config { name: string }\n",
	);
	await write("packages/core/src/util/strings.ts", "export function slug(s: string): string { return s; }\n");
	await write(
		"packages/app/tsconfig.json",
		'{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["src/*"] } } }',
	);
	await write(
		"packages/app/src/main.ts",
		[
			'import { parseConfig, type Config } from "@acme/core";',
			'import { slug } from "@acme/core/util/strings";',
			'import * as log from "~/log";',
			"export function main(raw: string): Config {",
			"  log.info(slug(raw));",
			"  return parseConfig(raw);",
			"}",
			"",
		].join("\n"),
	);
	await write("packages/app/src/log.ts", "export function info(msg: string): void {}\n");
	await write("dist/bundle.js", "export const ignored = 1;\n");
	// Go module: aliased import, same-package call across files.
	await write("svc/go.mod", "module example.com/svc\n\ngo 1.22\n");
	await write(
		"svc/main.go",
		'package main\n\nimport st "example.com/svc/store"\n\nfunc main() {\n\ts := st.New()\n\trun(s)\n}\n',
	);
	await write("svc/run.go", 'package main\n\nimport "example.com/svc/store"\n\nfunc run(s *store.Store) {}\n');
	await write("svc/store/store.go", "package store\n\ntype Store struct{}\n\nfunc New() *Store { return &Store{} }\n");
	// Rust crate: `mod`, `use crate::`, path-qualified call.
	await write("rs/Cargo.toml", '[package]\nname = "my-crate"\nversion = "0.1.0"\n');
	await write("rs/src/lib.rs", "pub mod graph;\nmod util;\n\npub fn run() { graph::rank(); util::helper(); }\n");
	await write("rs/src/graph.rs", "use crate::util::helper;\n\npub fn rank() { helper(); }\n");
	await write("rs/src/util.rs", "pub fn helper() {}\n");
	// The index directory does not exist yet, as `~/.omp/locus/index/` on first use.
	index = RepoIndex.open(root, path.join(root, ".cache/locus/index/test.db"));
});

afterEach(async () => {
	index.close();
	await tmp.remove();
});

describe("repository index", () => {
	test("resolves imports across TS workspaces, Go packages and Rust modules", async () => {
		const result = await index.reconcile();
		expect(result.added).toBe(11);
		expect(index.store.fileByPath("dist/bundle.js")).toBeNull();

		// TS: package root re-export, wildcard subpath export, tsconfig alias.
		expect(importers("packages/core/src/index.ts")).toEqual(["packages/app/src/main.ts"]);
		expect(importers("packages/core/src/config.ts")).toContain("packages/core/src/index.ts");
		expect(importers("packages/core/src/util/strings.ts")).toEqual(["packages/app/src/main.ts"]);
		expect(importers("packages/app/src/log.ts")).toEqual(["packages/app/src/main.ts"]);
		// Go: both importers of the store package, alias or not.
		expect(importers("svc/store/store.go")).toEqual(["svc/main.go", "svc/run.go"]);
		// Rust: `mod` items and `use crate::…`.
		expect(importers("rs/src/util.rs")).toEqual(["rs/src/graph.rs", "rs/src/lib.rs"]);

		expect(calls()).toEqual(
			expect.arrayContaining([
				"main -> packages/app/src/log.ts::info",
				// Through the package barrel's `export { parseConfig } from "./config.js"`.
				"main -> packages/core/src/config.ts::parseConfig",
				"main -> packages/core/src/util/strings.ts::slug",
				"main -> svc/run.go::run",
				"main -> svc/store/store.go::New",
				"rank -> rs/src/util.rs::helper",
				"run -> rs/src/graph.rs::rank",
				"run -> rs/src/util.rs::helper",
			]),
		);
	});

	test("ranks a shared dependency above the files that use it", async () => {
		await index.reconcile();
		expect(rank("rs/src/util.rs")).toBeGreaterThan(rank("rs/src/graph.rs"));
		expect(rank("svc/store/store.go")).toBeGreaterThan(rank("svc/run.go"));
	});

	test("re-indexes only what changed, and re-ranks only on content change", async () => {
		await index.reconcile();
		const idle = await index.reconcile();
		expect({ ...idle, durationMs: 0 }).toMatchObject({
			added: 0,
			updated: 0,
			removed: 0,
			unchanged: 11,
			graph: null,
		});

		// Same bytes, new mtime: stat refresh only, no graph rebuild.
		const util = path.join(root, "rs/src/util.rs");
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(util, later, later);
		const touched = await index.reconcile();
		expect(touched).toMatchObject({ touched: 1, updated: 0, graph: null });

		// New content: graph follows the edit.
		await write("rs/src/graph.rs", "pub fn rank() {}\n");
		const edited = await index.reconcile();
		expect(edited).toMatchObject({ updated: 1 });
		expect(edited.graph).not.toBeNull();
		expect(importers("rs/src/util.rs")).toEqual(["rs/src/lib.rs"]);

		// Deletion drops the file and its edges.
		await fs.rm(path.join(root, "packages/app/src/log.ts"));
		const removed = await index.reconcile();
		expect(removed.removed).toBe(1);
		expect(calls().some(c => c.includes("log.ts"))).toBe(false);
	});

	test("a reopened index (new process) does not rebuild an unchanged graph", async () => {
		await index.reconcile();
		const dbPath = path.join(root, ".cache/locus/index/test.db");
		index.close();
		index = RepoIndex.open(root, dbPath);
		const result = await index.reconcile();
		expect(result).toMatchObject({ unchanged: 11, graph: null });
	});

	test("editing tsconfig paths re-resolves imports", async () => {
		await index.reconcile();
		expect(importers("packages/app/src/log.ts")).toEqual(["packages/app/src/main.ts"]);
		await write("packages/app/src/logging/log.ts", "export function info(msg: string): void {}\n");
		await index.reconcile();
		await write(
			"packages/app/tsconfig.json",
			'{ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["src/logging/*"] } } }',
		);
		const result = await index.reconcile();
		expect(result.graph?.scope).toBe("full");
		expect(importers("packages/app/src/log.ts")).toEqual([]);
		expect(importers("packages/app/src/logging/log.ts")).toEqual(["packages/app/src/main.ts"]);
	});

	test("a scoped rebuild after edits matches a full rebuild", async () => {
		await index.reconcile();
		// Behind the barrel: rename the export the app calls, add a new one.
		await write(
			"packages/core/src/config.ts",
			"export function loadConfig(raw: string): Config { return JSON.parse(raw); }\nexport interface Config { name: string }\n",
		);
		await write("packages/core/src/index.ts", 'export { loadConfig as parseConfig } from "./config.js";\n');
		// A Go callee changes too.
		await write(
			"svc/store/store.go",
			"package store\n\ntype Store struct{}\n\n// New makes a store.\nfunc New() *Store { return nil }\n",
		);
		const edited = await index.reconcile();
		expect(edited.graph?.scope).not.toBe("full");
		const scoped = {
			calls: calls(),
			edges: index.store.db.query("SELECT * FROM edges ORDER BY src_file, dst_file, kind").all(),
		};
		expect(scoped.calls).toContain("main -> packages/core/src/config.ts::loadConfig");

		rebuildGraph(index.store, index.config!);
		const full = {
			calls: calls(),
			edges: index.store.db.query("SELECT * FROM edges ORDER BY src_file, dst_file, kind").all(),
		};
		expect(scoped).toEqual(full);
	});

	test("does not guess between same-named exports", async () => {
		await write("packages/app/src/a.ts", "export function format(x: number) { return x; }\n");
		await write("packages/app/src/b.ts", "export function format(x: string) { return x; }\n");
		// `helper` is also unique among exports — in the Rust crate. Bare names never
		// resolve across files without an import, let alone across languages.
		await write("packages/app/src/use.ts", "export function useIt() { helper(); return format(1); }\n");
		await index.reconcile();
		expect(calls().filter(c => c.startsWith("useIt"))).toEqual([]);
		expect(importers("packages/app/src/a.ts")).toEqual([]);
	});
});

describe("map rendering", () => {
	test("stays within the token budget and always keeps focus files", async () => {
		await index.reconcile();
		const full = renderMap(index.store, { budget: 8000 });
		expect(full).toContain("rs/src/util.rs");
		expect(full).toMatch(/pub fn helper\(\)  L1/);

		const tiny = renderMap(index.store, { budget: 256, focus: ["svc/run.go"] });
		const body = tiny.slice(0, tiny.lastIndexOf("\n[map:"));
		expect(estimateTokens(body)).toBeLessThanOrEqual(256);
		expect(body.split("\n")[0]).toBe("svc/run.go");
	});

	test("the static prompt map follows graph rebuilds and is reused otherwise", async () => {
		await index.reconcile();
		const first = cachedStaticMap(index.store);
		expect(first).toContain("rs/src/util.rs");
		expect(cachedStaticMap(index.store)).toBe(first);
		await write("rs/src/extra.rs", "pub fn extra() {}\n");
		await write(
			"rs/src/lib.rs",
			"pub mod graph;\nmod util;\npub mod extra;\n\npub fn run() { graph::rank(); util::helper(); extra::extra(); }\n",
		);
		await index.reconcile();
		expect(cachedStaticMap(index.store)).toContain("rs/src/extra.rs");
	});

	test("importers lists the names each importer binds", async () => {
		await index.reconcile();
		const out = renderImporters(index.store, "packages/core/src/index.ts");
		expect(out).toContain("importers of packages/core/src/index.ts (1 files");
		expect(out).toMatch(/packages\/app\/src\/main\.ts\s+Config, parseConfig/);
	});

	test("callers resolves a qualified target and rejects ambiguous ones", async () => {
		await index.reconcile();
		expect(renderCallers(index.store, "rs/src/util.rs::helper")).toContain("rs/src/graph.rs::rank");
		await write(
			"packages/app/src/dup.ts",
			"export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: unknown) {}\n",
		);
		await index.reconcile();
		expect(() => renderCallers(index.store, "packages/app/src/dup.ts::f")).toThrow(/ambiguous \(3 candidates\)/);
		expect(renderCallers(index.store, "packages/app/src/dup.ts::f#3")).toContain(
			"callers of packages/app/src/dup.ts::f",
		);
		expect(() => renderCallers(index.store, "rs/src/util.rs::helpr")).toThrow(/Closest: helper/);
	});
});
