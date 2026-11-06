/**
 * locus: project configuration the import resolver needs — workspace
 * `package.json` packages, `tsconfig.json` path aliases, Go modules and Cargo
 * crates. Read from the files the scan already listed.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

export interface TsPackage {
	name: string;
	/** Repo-relative package directory ("" for the root). */
	dir: string;
	/** `exports` field as written. */
	exports: unknown;
	/** Entry candidates from `types`/`module`/`main`, repo-relative. */
	entries: string[];
}

export interface TsConfigPaths {
	/** Repo-relative directory of the tsconfig that declares `paths`. */
	dir: string;
	/** Repo-relative base for path targets. */
	baseUrl: string;
	paths: Array<{ pattern: string; targets: string[] }>;
}

export interface GoModule {
	dir: string;
	module: string;
}

export interface RustCrate {
	/** Crate name as used in paths (`pi_ast`). */
	name: string;
	dir: string;
	/** Repo-relative `lib.rs`/`main.rs` roots that exist. */
	roots: string[];
}

export interface ProjectConfig {
	packages: Map<string, TsPackage>;
	tsconfigs: TsConfigPaths[];
	goModules: GoModule[];
	rustCrates: Map<string, RustCrate>;
}

/** Config file basenames the scan must list. */
export const PROJECT_CONFIG_FILES = new Set(["package.json", "tsconfig.json", "go.mod", "Cargo.toml"]);

const posix = path.posix;

function dirOf(relPath: string): string {
	const dir = posix.dirname(relPath);
	return dir === "." ? "" : dir;
}

function join(...parts: string[]): string {
	const joined = posix.normalize(posix.join(...parts.filter(p => p !== "")));
	return joined === "." ? "" : joined.replace(/^\.\//, "");
}

async function readJsonc(absPath: string): Promise<unknown> {
	const text = await Bun.file(absPath).text();
	try {
		return Bun.JSON5.parse(text);
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the project config from the repo-relative paths of config files. */
export async function loadProjectConfig(
	root: string,
	configPaths: string[],
	fileSet: Set<string>,
): Promise<ProjectConfig> {
	const config: ProjectConfig = { packages: new Map(), tsconfigs: [], goModules: [], rustCrates: new Map() };
	await Promise.all(
		configPaths.map(async rel => {
			const abs = path.join(root, rel);
			const base = posix.basename(rel);
			const dir = dirOf(rel);
			try {
				if (base === "package.json") {
					const pkg = await readJsonc(abs);
					if (!isRecord(pkg) || typeof pkg.name !== "string") return;
					const entries = ["types", "typings", "module", "main"]
						.map(k => pkg[k])
						.filter((v): v is string => typeof v === "string")
						.map(v => join(dir, v));
					config.packages.set(pkg.name, { name: pkg.name, dir, exports: pkg.exports, entries });
				} else if (base === "tsconfig.json") {
					const paths = await loadTsconfigPaths(root, rel, 0);
					if (paths) config.tsconfigs.push(paths);
				} else if (base === "go.mod") {
					const text = await Bun.file(abs).text();
					const match = /^module\s+(\S+)/m.exec(text);
					if (match?.[1]) config.goModules.push({ dir, module: match[1] });
				} else if (base === "Cargo.toml") {
					const text = await Bun.file(abs).text();
					const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
					const pkg = parsed.package;
					if (!isRecord(pkg) || typeof pkg.name !== "string") return;
					const lib =
						isRecord(parsed.lib) && typeof parsed.lib.path === "string" ? join(dir, parsed.lib.path) : null;
					const roots = [lib, join(dir, "src/lib.rs"), join(dir, "src/main.rs")].filter(
						(p): p is string => p !== null && fileSet.has(p),
					);
					const name = (
						isRecord(parsed.lib) && typeof parsed.lib.name === "string" ? parsed.lib.name : pkg.name
					).replaceAll("-", "_");
					config.rustCrates.set(name, { name, dir, roots: [...new Set(roots)] });
				}
			} catch (error) {
				logger.debug("locus: skipping unreadable project config", { path: rel, error: String(error) });
			}
		}),
	);
	// Longest directory first: the nearest config wins.
	config.tsconfigs.sort((a, b) => b.dir.length - a.dir.length);
	config.goModules.sort((a, b) => b.module.length - a.module.length);
	return config;
}

async function loadTsconfigPaths(root: string, rel: string, depth: number): Promise<TsConfigPaths | null> {
	if (depth > 4) return null;
	const json = await readJsonc(path.join(root, rel));
	if (!isRecord(json)) return null;
	const dir = dirOf(rel);
	const options = isRecord(json.compilerOptions) ? json.compilerOptions : {};
	if (isRecord(options.paths)) {
		const baseUrl = typeof options.baseUrl === "string" ? join(dir, options.baseUrl) : dir;
		const paths = Object.entries(options.paths).flatMap(([pattern, targets]) =>
			Array.isArray(targets)
				? [{ pattern, targets: targets.filter((t): t is string => typeof t === "string") }]
				: [],
		);
		return { dir, baseUrl, paths };
	}
	// Inherit `paths` through a relative `extends`; the inherited targets stay
	// relative to the base config, as tsc resolves them.
	if (typeof json.extends === "string" && json.extends.startsWith(".")) {
		const target = join(dir, json.extends.endsWith(".json") ? json.extends : `${json.extends}.json`);
		const inherited = await loadTsconfigPaths(root, target, depth + 1);
		return inherited ? { ...inherited, dir } : null;
	}
	return null;
}
