/**
 * locus: import specifier → repo file resolution for TS/JS, Go and Rust.
 *
 * Resolution is purely lexical over the indexed file set; nothing is read
 * from disk. An import that does not land on an indexed file stays
 * unresolved (external package, generated file, unsupported layout) and adds
 * no edge.
 */
import * as path from "node:path";
import type { ProjectConfig, TsPackage } from "./project";

const posix = path.posix;

export interface ResolveContext {
	config: ProjectConfig;
	/** Every indexed repo-relative path. */
	files: Set<string>;
	/** Directory → indexed `.go` files in it (tests excluded). */
	goPackages: Map<string, string[]>;
}

export interface ResolvedImport {
	/** Primary target file. */
	file: string | null;
	/** Additional targets (every file of a Go package). */
	extra: string[];
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
	".js": [".ts", ".tsx"],
	".jsx": [".tsx"],
	".mjs": [".mts"],
	".cjs": [".cts"],
};

const NONE: ResolvedImport = { file: null, extra: [] };

function norm(p: string): string {
	const n = posix.normalize(p);
	return n === "." ? "" : n.replace(/^\.\//, "");
}

function dirOf(relPath: string): string {
	const dir = posix.dirname(relPath);
	return dir === "." ? "" : dir;
}

export function isGoTestFile(relPath: string): boolean {
	return relPath.endsWith("_test.go");
}

/** Build the directory → Go files map used for package-level imports. */
export function buildGoPackages(files: Iterable<string>): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const f of files) {
		if (!f.endsWith(".go") || isGoTestFile(f)) continue;
		const dir = dirOf(f);
		const list = out.get(dir);
		if (list) list.push(f);
		else out.set(dir, [f]);
	}
	for (const list of out.values()) list.sort();
	return out;
}

export function resolveImport(
	ctx: ResolveContext,
	importer: string,
	lang: string | null,
	specifier: string,
	kind: string,
): ResolvedImport {
	switch (lang) {
		case "typescript":
		case "tsx":
		case "javascript":
			return { file: resolveTs(ctx, importer, specifier), extra: [] };
		case "go":
			return resolveGo(ctx, specifier);
		case "rust":
			return { file: resolveRust(ctx, importer, specifier, kind), extra: [] };
		default:
			return NONE;
	}
}

// ── TypeScript / JavaScript ─────────────────────────────────────────────

/** Try `base` as a file, with extensions, `.js`→`.ts` swaps and `/index`. */
function probeTs(files: Set<string>, base: string): string | null {
	const b = norm(base);
	if (files.has(b)) return b;
	const ext = posix.extname(b);
	const swaps = JS_TO_TS[ext];
	if (swaps) {
		const stem = b.slice(0, -ext.length);
		for (const s of swaps) if (files.has(stem + s)) return stem + s;
	}
	for (const e of TS_EXTENSIONS) if (files.has(b + e)) return b + e;
	for (const e of TS_EXTENSIONS) if (files.has(`${b}/index${e}`)) return `${b}/index${e}`;
	return null;
}

function resolveTs(ctx: ResolveContext, importer: string, specifier: string): string | null {
	if (specifier.startsWith(".")) return probeTs(ctx.files, posix.join(dirOf(importer), specifier));
	if (specifier.startsWith("/")) return null;

	// tsconfig `paths` of the nearest config that has them.
	for (const tc of ctx.config.tsconfigs) {
		if (tc.dir !== "" && !importer.startsWith(`${tc.dir}/`)) continue;
		for (const { pattern, targets } of tc.paths) {
			const star = pattern.indexOf("*");
			let captured: string | null = null;
			if (star < 0) {
				if (pattern === specifier) captured = "";
			} else {
				const prefix = pattern.slice(0, star);
				const suffix = pattern.slice(star + 1);
				if (
					specifier.startsWith(prefix) &&
					specifier.endsWith(suffix) &&
					specifier.length >= prefix.length + suffix.length
				) {
					captured = specifier.slice(prefix.length, specifier.length - suffix.length);
				}
			}
			if (captured === null) continue;
			for (const t of targets) {
				const hit = probeTs(ctx.files, posix.join(tc.baseUrl, t.replace("*", captured)));
				if (hit) return hit;
			}
		}
		break;
	}

	// Workspace packages: `@scope/name/sub` or `name/sub`.
	const parts = specifier.split("/");
	const nameLen = specifier.startsWith("@") ? 2 : 1;
	const name = parts.slice(0, nameLen).join("/");
	const pkg = ctx.config.packages.get(name);
	if (!pkg) return null;
	const sub = parts.slice(nameLen).join("/");
	return resolvePackageEntry(ctx.files, pkg, sub);
}

/** Pick a file path out of an `exports` condition object or string. */
function exportTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const v of value) {
			const t = exportTarget(v);
			if (t) return t;
		}
		return null;
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		for (const key of ["types", "import", "bun", "default", "require", "node"]) {
			if (key in record) {
				const t = exportTarget(record[key]);
				if (t) return t;
			}
		}
	}
	return null;
}

function resolvePackageEntry(files: Set<string>, pkg: TsPackage, sub: string): string | null {
	const key = sub === "" ? "." : `./${sub}`;
	const exportsField = pkg.exports;
	if (typeof exportsField === "object" && exportsField !== null && !Array.isArray(exportsField)) {
		const map = exportsField as Record<string, unknown>;
		const isSubpathMap = Object.keys(map).some(k => k.startsWith("."));
		if (isSubpathMap) {
			const direct = key in map ? exportTarget(map[key]) : null;
			if (direct) return probeTs(files, posix.join(pkg.dir, direct));
			// Longest wildcard pattern first, as Node does.
			const patterns = Object.keys(map)
				.filter(k => k.includes("*"))
				.sort((a, b) => b.length - a.length);
			for (const pattern of patterns) {
				const star = pattern.indexOf("*");
				const prefix = pattern.slice(0, star);
				const suffix = pattern.slice(star + 1);
				if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
				const captured = key.slice(prefix.length, key.length - suffix.length);
				const target = exportTarget(map[pattern]);
				if (target) {
					const hit = probeTs(files, posix.join(pkg.dir, target.replaceAll("*", captured)));
					if (hit) return hit;
				}
			}
		} else if (sub === "") {
			const target = exportTarget(map);
			if (target) return probeTs(files, posix.join(pkg.dir, target));
		}
	} else if (typeof exportsField === "string" && sub === "") {
		return probeTs(files, posix.join(pkg.dir, exportsField));
	}
	if (sub === "") {
		for (const entry of pkg.entries) {
			const hit = probeTs(files, entry);
			if (hit) return hit;
		}
		return probeTs(files, posix.join(pkg.dir, "src/index")) ?? probeTs(files, posix.join(pkg.dir, "index"));
	}
	return probeTs(files, posix.join(pkg.dir, sub)) ?? probeTs(files, posix.join(pkg.dir, "src", sub));
}

// ── Go ──────────────────────────────────────────────────────────────────

function resolveGo(ctx: ResolveContext, specifier: string): ResolvedImport {
	for (const mod of ctx.config.goModules) {
		if (specifier !== mod.module && !specifier.startsWith(`${mod.module}/`)) continue;
		const rest = specifier.slice(mod.module.length).replace(/^\//, "");
		const dir = norm(posix.join(mod.dir, rest));
		const files = ctx.goPackages.get(dir);
		if (!files || files.length === 0) return NONE;
		return { file: files[0] ?? null, extra: files.slice(1) };
	}
	return NONE;
}

// ── Rust ────────────────────────────────────────────────────────────────

/** Directory that holds a Rust file's child modules. */
function rustChildDir(relPath: string): string {
	const base = posix.basename(relPath);
	if (base === "mod.rs" || base === "lib.rs" || base === "main.rs") return dirOf(relPath);
	return relPath.slice(0, -".rs".length);
}

function probeRustModule(files: Set<string>, dir: string, name: string): string | null {
	const a = norm(posix.join(dir, `${name}.rs`));
	if (files.has(a)) return a;
	const b = norm(posix.join(dir, name, "mod.rs"));
	return files.has(b) ? b : null;
}

/** Crate that owns `relPath`: the deepest crate directory containing it. */
function owningCrate(ctx: ResolveContext, relPath: string) {
	let best: { dir: string; roots: string[] } | null = null;
	for (const crate of ctx.config.rustCrates.values()) {
		if (crate.dir !== "" && !relPath.startsWith(`${crate.dir}/`)) continue;
		if (!best || crate.dir.length > best.dir.length) best = crate;
	}
	return best;
}

/** Walk `segments` as module path from module file `start`; return the
 * deepest module file reached (an item path stops at its module). */
function walkRustPath(files: Set<string>, start: string, segments: string[]): string {
	let current = start;
	for (const seg of segments) {
		const next = probeRustModule(files, rustChildDir(current), seg);
		if (!next) break;
		current = next;
	}
	return current;
}

/** Parent module file of a Rust module file (for `super::`). */
function rustParentModule(ctx: ResolveContext, relPath: string): string | null {
	const base = posix.basename(relPath);
	if (base === "lib.rs" || base === "main.rs") return null;
	// Module `a/b` lives in `a/b.rs` or `a/b/mod.rs`; its parent is module `a`.
	const moduleDir = base === "mod.rs" ? dirOf(relPath) : relPath.slice(0, -".rs".length);
	const parentDir = dirOf(moduleDir);
	for (const c of [
		`${parentDir}.rs`,
		posix.join(parentDir, "mod.rs"),
		posix.join(parentDir, "lib.rs"),
		posix.join(parentDir, "main.rs"),
	]) {
		const n = norm(c);
		if (ctx.files.has(n)) return n;
	}
	return null;
}

function resolveRust(ctx: ResolveContext, importer: string, specifier: string, kind: string): string | null {
	if (kind === "mod") return probeRustModule(ctx.files, rustChildDir(importer), specifier);

	// `use` tags store the path minus the last bound name; `names` carry the
	// rest. A module that exists for the full path is resolved by the caller
	// retrying with the bound name appended.
	const segments = specifier.split("::").filter(s => s !== "");
	if (segments.length === 0) return null;
	const [head, ...rest] = segments;
	let start: string | null = null;
	if (head === "crate") {
		start = owningCrate(ctx, importer)?.roots[0] ?? null;
	} else if (head === "self") {
		start = importer;
	} else if (head === "super") {
		start = rustParentModule(ctx, importer);
		while (rest[0] === "super" && start) {
			rest.shift();
			start = rustParentModule(ctx, start);
		}
	} else if (head) {
		start = ctx.config.rustCrates.get(head)?.roots[0] ?? null;
	}
	if (!start) return null;
	return walkRustPath(ctx.files, start, rest);
}
